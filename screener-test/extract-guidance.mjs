// extract-guidance.mjs — Fund Tracker — MGA · forward-guidance extraction (free-tier LLM)
// ---------------------------------------------------------------------------
// For each fund-tracked company's MOST RECENT concall, pull the transcript and ask a
// free-tier LLM (Gemini/Groq/Mistral, rotated) to extract forward guidance — revenue /
// margin / capex / EBITDA targets — each flagged specific | vague | refused. Output is
// merged into public/data/guidance.json and rendered as cards on the dashboard.
//
// Block-safe + incremental + free-tier-friendly: processes GUIDANCE_LIMIT companies per
// run (default 12), skips companies whose latest transcript already has guidance, and is
// meant to run on a cron so it chips through the ~480 tracked names over time.
//
// Fetches PDFs straight from BSE/NSE (no Screener login needed). Needs at least one of
// GEMINI_API_KEY / GROQ_API_KEY / MISTRAL_API_KEY.
//   Env: GUIDANCE_LIMIT, GUIDANCE_SCOPE (tracked|all, default tracked), HEADFUL, DEBUG.
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callLLM, extractJson, llmAvailable, llmProviderNames } from "./llm.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DATA = join(__dirname, "..", "public", "data");
const SIGHTINGS_PATH = join(PUBLIC_DATA, "fund-sightings.json");
const PROCESSED_PATH = join(PUBLIC_DATA, "processed-concalls.json");
const GUIDANCE_PATH = join(PUBLIC_DATA, "guidance.json");

const LIMIT = Number(process.env.GUIDANCE_LIMIT || 12);
const SCOPE = (process.env.GUIDANCE_SCOPE || "tracked").toLowerCase(); // tracked = fund-followed names only
const HEADFUL = process.env.HEADFUL === "1";
const DEBUG = process.env.DEBUG === "1";
const MAX_CHARS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripDate = (id) => id.replace(/_\d{4}-\d{2}-\d{2}$/, "");

function hostKind(url) {
  let h = ""; try { h = new URL(url).host; } catch { return "other"; }
  if (/bseindia\.com/i.test(h)) return "bse";
  if (/nseindia\.com/i.test(h)) return "nse";
  return "other";
}
const refererFor = (k) => (k === "bse" ? "https://www.bseindia.com/" : k === "nse" ? "https://www.nseindia.com/" : undefined);

let pdfjsLib = null;
async function extractPdfText(buffer) {
  if (!pdfjsLib) pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjsLib.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      parts.push(tc.items.map((it) => it.str ?? "").join(" "));
    }
    return parts.join("\n").replace(/[ \t]+\n/g, "\n").trim();
  } finally { try { await task.destroy(); } catch { /* ignore */ } }
}

async function fetchPdf(context, page, url, kind, ensureNsePrimed) {
  const headers = { "User-Agent": UA, Accept: "application/pdf,application/octet-stream,*/*", "Accept-Language": "en-US,en;q=0.9" };
  const ref = refererFor(kind); if (ref) headers.Referer = ref;
  try {
    if (kind === "nse") await ensureNsePrimed();
    const resp = await context.request.get(url, { headers, timeout: 30000 });
    if (resp.ok()) { const b = Buffer.from(await resp.body()); if (b.length) return b; }
  } catch { /* fall through */ }
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (resp && resp.ok()) { const b = Buffer.from(await resp.body()); if (b.length) return b; }
  } catch { /* fall through */ }
  return null;
}

const SYSTEM = "You are a sell-side equity analyst. From an Indian company's earnings concall transcript, extract ONLY management's FORWARD-LOOKING guidance (future periods), and flag how specific each item is. Respond with STRICT JSON only — no prose, no markdown.";

function buildPrompt(company, text) {
  return `Company: ${company}\n\nReturn JSON with EXACTLY this shape:\n` +
    `{\n  "summary": "one sentence on the overall forward outlook",\n` +
    `  "guidance": [ { "metric": "Revenue|EBITDA margin|PAT|Capex|Volume|Order book|Other (name it)", "horizon": "e.g. FY27, Q1FY27, medium-term", "statement": "concise paraphrase of the guidance", "specificity": "specific|vague|refused", "direction": "up|down|flat|unclear" } ],\n` +
    `  "refused_to_guide": ["topics management explicitly declined to guide on"],\n  "margin_drivers": ["named drivers of margin/profitability mentioned"]\n}\n` +
    `Rules: include ONLY forward-looking statements (ignore past results). "specific" = a number/range/clear target; "vague" = directional words only; "refused" = explicitly declined. Empty arrays if none. Max 12 guidance items.\n\n` +
    `TRANSCRIPT (may be truncated):\n"""${text.slice(0, MAX_CHARS)}"""`;
}

async function main() {
  if (!llmAvailable) { console.log("No LLM keys set — skipping guidance extraction."); return; }
  console.log(`Guidance extraction — providers: ${llmProviderNames.join(", ")}; scope=${SCOPE}; batch=${LIMIT}`);
  if (!existsSync(PROCESSED_PATH)) { console.log("No processed-concalls.json yet — nothing to do."); return; }

  const store = existsSync(SIGHTINGS_PATH) ? JSON.parse(await readFile(SIGHTINGS_PATH, "utf8")) : { sightings: [] };
  const processed = JSON.parse(await readFile(PROCESSED_PATH, "utf8")).concalls || {};

  // fund-tracked companies (slug -> display meta)
  const coMeta = new Map();
  for (const s of store.sightings || []) {
    const slug = stripDate(s.transcript_id || ""); if (!slug) continue;
    if (!coMeta.has(slug)) coMeta.set(slug, { company: s.company, ticker: s.ticker || null, sector: s.sector || null });
  }

  // most-recent concall per slug (only calls that actually have a transcript_url)
  const latest = new Map(); // slug -> { date, url }
  for (const [id, m] of Object.entries(processed)) {
    if (!m.transcript_url || !m.concall_date) continue;
    const slug = stripDate(id);
    const cur = latest.get(slug);
    if (!cur || m.concall_date > cur.date) latest.set(slug, { date: m.concall_date, url: m.transcript_url, id });
  }

  const guidance = existsSync(GUIDANCE_PATH) ? JSON.parse(await readFile(GUIDANCE_PATH, "utf8")) : { companies: {} };
  guidance.companies = guidance.companies || {};
  const doneUrl = new Set(Object.values(guidance.companies).map((g) => g.transcript_url).filter(Boolean));

  // build target list
  let targets = [];
  for (const [slug, meta] of coMeta) {
    if (SCOPE === "tracked" && !coMeta.has(slug)) continue;
    const l = latest.get(slug);
    if (!l || doneUrl.has(l.url)) continue;
    targets.push({ slug, ...meta, concall_date: l.date, transcript_url: l.url, transcript_id: l.id });
  }
  // freshest calls first; then cap to the batch
  targets.sort((a, b) => b.concall_date.localeCompare(a.concall_date));
  const total = targets.length;
  targets = targets.slice(0, LIMIT);
  console.log(`Targets: ${total} tracked companies missing guidance; processing ${targets.length} this run.`);
  if (!targets.length) { console.log("Nothing to extract — guidance up to date for tracked names."); return; }

  const browser = await chromium.launch({ headless: !HEADFUL });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  let nsePrimed = false;
  const ensureNsePrimed = async () => { if (nsePrimed) return; await page.goto("https://www.nseindia.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); await sleep(1200); nsePrimed = true; };

  let added = 0, failed = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      try {
        const buf = await fetchPdf(context, page, t.transcript_url, hostKind(t.transcript_url), ensureNsePrimed);
        if (!buf) throw new Error("fetch failed");
        const text = await extractPdfText(buf);
        if (!text || text.length < 1500) throw new Error(`thin text (${text ? text.length : 0} chars)`);
        const { text: out, provider } = await callLLM(SYSTEM, buildPrompt(t.company, text));
        const parsed = extractJson(out);
        if (!parsed || !Array.isArray(parsed.guidance)) throw new Error("unparseable LLM JSON");
        guidance.companies[t.company] = {
          company: t.company, ticker: t.ticker, sector: t.sector,
          concall_date: t.concall_date, transcript_url: t.transcript_url, transcript_id: t.transcript_id,
          provider, generated_at: new Date().toISOString(),
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          guidance: parsed.guidance.slice(0, 12),
          refused_to_guide: Array.isArray(parsed.refused_to_guide) ? parsed.refused_to_guide.slice(0, 10) : [],
          margin_drivers: Array.isArray(parsed.margin_drivers) ? parsed.margin_drivers.slice(0, 10) : [],
        };
        added++;
        console.log(`[${i + 1}/${targets.length}] ${t.company} → ${parsed.guidance.length} guidance items (${provider})`);
        if (DEBUG) console.log("   ", JSON.stringify(parsed).slice(0, 300));
      } catch (err) {
        failed++;
        console.log(`[${i + 1}/${targets.length}] ${t.company} — ${err.message.split("\n")[0]}`);
      }
      await sleep(1500); // gentle on free-tier rate limits
    }
  } finally { await browser.close(); }

  await mkdir(PUBLIC_DATA, { recursive: true });
  guidance.generated_at = new Date().toISOString();
  guidance.count = Object.keys(guidance.companies).length;
  await writeFile(GUIDANCE_PATH, JSON.stringify(guidance, null, 2) + "\n", "utf8");
  console.log("─".repeat(60));
  console.log(`Guidance: +${added} companies this run (${failed} failed), ${guidance.count} total, ~${Math.max(total - added, 0)} still to go.`);
}

main().catch((err) => { console.error("FATAL:", err.message); process.exit(1); });
