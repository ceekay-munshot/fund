// scrape-transcripts.mjs — Fund Tracker — MGA · Scraper 2 of N
// ---------------------------------------------------------------------------
// Reads screener-test/output/concalls-index.json (from scrape-concalls.mjs) and,
// for every concall WITH a transcript, fetches the exchange-hosted PDF (defeating
// BSE/NSE hotlink 403s) and extracts its full text to disk.
//
// THIS SCRAPER DOES NOT match fund names — that is Prompt 4. It only produces
// raw transcript text + a manifest.
//
// Why pdfjs-dist (not pdf-parse): ESM-native (matches our .mjs), maintained by
// Mozilla, robust on the varied/malformed PDFs the exchanges emit, gives an
// accurate per-page char count for needs_ocr detection, and avoids pdf-parse's
// read-test-file-on-import CommonJS gotcha.
//
// Run (deps installed no-save, never committed):
//   npm install playwright@1 cheerio@1 pdfjs-dist --no-save
//   npx playwright install chromium
//   SCREENER_EMAIL=... SCREENER_PASSWORD=... node screener-test/scrape-transcripts.mjs
//
// Env knobs:
//   SCREENER_EMAIL / SCREENER_PASSWORD  (required) — login (holds a real session)
//   LIMIT     (default 0 = all)                     — cap transcripts processed
//   FORCE=1                                         — re-fetch even if <id>.txt exists
//   HEADFUL=1                                       — visible browser for debugging
//   FIRECRAWL_API_KEY                               — optional last-resort fetch
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://www.screener.in";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");
const TRANSCRIPTS_DIR = join(OUTPUT_DIR, "transcripts");
const INDEX_PATH = join(OUTPUT_DIR, "concalls-index.json");
const MANIFEST_PATH = join(OUTPUT_DIR, "transcripts-manifest.json");
// Committed cross-run memory: which concalls we've already processed.
const PROCESSED_PATH = join(__dirname, "..", "public", "data", "processed-concalls.json");

const LIMIT = Number(process.env.LIMIT || 0);
const FORCE = process.env.FORCE === "1";
const HEADFUL = process.env.HEADFUL === "1";
// FULL (or FORCE) ignores the cross-run skip list → reprocess the whole 90-day
// window (used for the first run and the quarterly full sweep).
const FULL = process.env.FULL === "1" || FORCE;

// Below this many extracted characters a PDF is treated as having no text layer
// (scanned image) → flagged needs_ocr rather than counted as a clean extraction.
const OCR_THRESHOLD = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- login helper (same proven flow as Prompt 2) ---------------------------
async function loginViaBrowser(page) {
  await page.goto(`${ORIGIN}/login/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[name="username"]', process.env.SCREENER_EMAIL);
  await page.fill('input[name="password"]', process.env.SCREENER_PASSWORD);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(1500);
  const html = await page.content();
  if (!/\/logout\//.test(html)) {
    throw new Error("Login failed — check SCREENER_EMAIL / SCREENER_PASSWORD.");
  }
}

// --- helpers ---------------------------------------------------------------
function hostKind(url) {
  let h = "";
  try {
    h = new URL(url).host;
  } catch {
    return "other";
  }
  if (/bseindia\.com/i.test(h)) return "bse";
  if (/nseindia\.com/i.test(h)) return "nse";
  return "other";
}

function refererFor(kind) {
  if (kind === "bse") return "https://www.bseindia.com/";
  if (kind === "nse") return "https://www.nseindia.com/";
  return undefined;
}

// Stable slug: "BEML Ltd" + "2026-06-10" → "beml-ltd_2026-06-10" ([a-z0-9-_]).
function slugify(company, date) {
  const c = (company || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const d = (date || "unknown").replace(/[^0-9-]/g, "");
  return `${c}_${d}`;
}

// --- PDF → text (lazy-loaded pdfjs) ----------------------------------------
let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsLib;
}

async function extractPdfText(buffer) {
  const pdfjs = await getPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const tc = await pg.getTextContent();
      parts.push(tc.items.map((it) => it.str ?? "").join(" "));
    }
    return parts.join("\n").replace(/[ \t]+\n/g, "\n").trim();
  } finally {
    // Cleanup lives on the loading task in this pdfjs version; never let a
    // cleanup error discard already-extracted text.
    try {
      await loadingTask.destroy();
    } catch {
      /* ignore */
    }
  }
}

// --- fetch strategies (defeat the 403) -------------------------------------
async function fetchViaFirecrawl(url) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data?.data?.markdown || data?.data?.content || "";
    return text || null;
  } catch {
    return null;
  }
}

// Returns { buffer?, text?, method } or null.
async function fetchTranscript(context, page, url, kind, ensureNsePrimed) {
  const headers = {
    "User-Agent": UA,
    Accept: "application/pdf,application/octet-stream,*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const referer = refererFor(kind);
  if (referer) headers.Referer = referer;

  // Strategy 1: authenticated browser-context request with the owning exchange's
  // referer. NSE rejects cookieless requests, so prime its anti-bot cookies first.
  try {
    if (kind === "nse") await ensureNsePrimed();
    const resp = await context.request.get(url, { headers, timeout: 30000 });
    if (resp.ok()) {
      const body = Buffer.from(await resp.body());
      if (body.length > 0) return { buffer: body, method: "context.request" };
    }
  } catch {
    /* fall through */
  }

  // Strategy 2: navigate a real page to the PDF and capture the response bytes.
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (resp && resp.ok()) {
      const body = Buffer.from(await resp.body());
      if (body.length > 0) return { buffer: body, method: "page.goto" };
    }
  } catch {
    /* fall through */
  }

  // Strategy 3 (optional): Firecrawl returns parsed text directly (no PDF bytes).
  const fc = await fetchViaFirecrawl(url);
  if (fc) return { text: fc, method: "firecrawl" };

  return null;
}

// --- main ------------------------------------------------------------------
async function run() {
  if (!process.env.SCREENER_EMAIL || !process.env.SCREENER_PASSWORD) {
    throw new Error(
      "Missing credentials — set SCREENER_EMAIL and SCREENER_PASSWORD in the environment."
    );
  }
  if (!existsSync(INDEX_PATH)) {
    throw new Error(`Input not found: ${INDEX_PATH}. Run scrape-concalls.mjs first.`);
  }

  await mkdir(TRANSCRIPTS_DIR, { recursive: true });

  const index = JSON.parse(await readFile(INDEX_PATH, "utf8"));
  const withTranscript = (index.concalls || []).filter((c) => c.has_transcript && c.transcript_url);

  // Cross-run incrementality: skip transcript_urls we've already processed in a
  // previous run (per the committed processed-concalls.json), unless FULL/FORCE.
  const processedUrls = new Set();
  if (!FULL && existsSync(PROCESSED_PATH)) {
    try {
      const prior = JSON.parse(await readFile(PROCESSED_PATH, "utf8"));
      for (const p of Object.values(prior.concalls || {})) {
        if (p.transcript_url) processedUrls.add(p.transcript_url);
      }
    } catch {
      /* treat as no prior memory */
    }
  }

  let queue = FULL ? withTranscript : withTranscript.filter((c) => !processedUrls.has(c.transcript_url));
  console.log(
    `${withTranscript.length} concalls with transcripts in window, ` +
      `${withTranscript.length - queue.length} already processed (skipped), ${queue.length} new to fetch.` +
      (FULL ? "  [FULL: skip list ignored]" : "")
  );
  if (LIMIT > 0 && queue.length > LIMIT) {
    queue = queue.slice(0, LIMIT);
    console.log(`Applying LIMIT=${LIMIT}`);
  }

  // Quiet day: nothing new to fetch — still write a manifest so downstream steps
  // run, and skip launching the browser entirely.
  if (queue.length === 0) {
    await writeFile(
      MANIFEST_PATH,
      JSON.stringify({ generated_at: new Date().toISOString(), count: 0, ok: 0, failed: 0, transcripts: [] }, null, 2) + "\n",
      "utf8"
    );
    console.log(`No new transcripts to fetch. Wrote empty manifest → ${MANIFEST_PATH}`);
    return;
  }

  const browser = await chromium.launch({ headless: !HEADFUL });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  let nsePrimed = false;
  const ensureNsePrimed = async () => {
    if (nsePrimed) return;
    console.log("  priming NSE anti-bot cookies…");
    await page
      .goto("https://www.nseindia.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await sleep(1200);
    nsePrimed = true;
  };

  const transcripts = [];
  let ok = 0;
  let failed = 0;
  let needsOcr = 0;

  try {
    console.log("Logging in to Screener…");
    await loginViaBrowser(page);
    console.log("Login OK.");
    await sleep(400);

    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      const id = slugify(c.company, c.concall_date);
      const kind = hostKind(c.transcript_url);
      const txtPath = join(TRANSCRIPTS_DIR, `${id}.txt`);
      const entry = {
        id,
        company: c.company,
        concall_date: c.concall_date,
        transcript_url: c.transcript_url,
        host: kind,
        fetch_method: null,
        char_count: 0,
        ok: false,
        needs_ocr: false,
        error: null,
      };

      try {
        // Incremental: skip already-extracted transcripts unless FORCE.
        if (!FORCE && existsSync(txtPath)) {
          const cached = await readFile(txtPath, "utf8");
          entry.fetch_method = "cached";
          entry.char_count = cached.length;
          entry.needs_ocr = cached.length < OCR_THRESHOLD;
          entry.ok = !entry.needs_ocr;
          console.log(`[${i + 1}/${queue.length}] ${id} — cached (${cached.length} chars)`);
        } else {
          console.log(`[${i + 1}/${queue.length}] ${id} [${kind}] fetching…`);
          const got = await fetchTranscript(context, page, c.transcript_url, kind, ensureNsePrimed);
          if (!got) throw new Error("all fetch strategies failed (still blocked)");

          const text = got.text != null ? got.text : await extractPdfText(got.buffer);
          entry.fetch_method = got.method;
          entry.char_count = text.length;
          entry.needs_ocr = text.length < OCR_THRESHOLD;
          entry.ok = !entry.needs_ocr;

          await writeFile(txtPath, text, "utf8");
          console.log(
            `    ✓ ${got.method} → ${text.length} chars${entry.needs_ocr ? " (needs_ocr)" : ""}`
          );
        }
      } catch (err) {
        entry.error = err.message;
        console.log(`    ✗ ${err.message}`);
      }

      if (entry.ok) ok++;
      else failed++;
      if (entry.needs_ocr) needsOcr++;

      transcripts.push(entry);
      await sleep(400 + Math.floor(Math.random() * 400)); // 400–800ms, polite
    }

    const manifest = {
      generated_at: new Date().toISOString(),
      count: transcripts.length,
      ok,
      failed,
      transcripts,
    };
    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    console.log("─".repeat(60));
    console.log(
      `Summary: attempted ${transcripts.length}, ok ${ok}, failed ${failed}, needs_ocr ${needsOcr}. → ${MANIFEST_PATH}`
    );

    // Proof: print a ~400-char snippet around participants/management/Q&A from one
    // successful transcript, so the real extracted text is visible in the logs.
    const sample = transcripts.find((t) => t.ok && t.fetch_method !== "cached") ||
      transcripts.find((t) => t.ok);
    if (sample) {
      const text = await readFile(join(TRANSCRIPTS_DIR, `${sample.id}.txt`), "utf8");
      const m = text.match(/(participants?|management|moderator|analyst|ladies and gentlemen)/i);
      const start = m ? Math.max(0, m.index - 80) : 0;
      console.log(`\nSnippet from ${sample.id} (around "${m ? m[1] : "start"}"):`);
      console.log("…" + text.slice(start, start + 400).replace(/\s+/g, " ").trim() + "…");
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
