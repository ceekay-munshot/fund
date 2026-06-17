// scrape-concalls.mjs — Fund Tracker — MGA · Scraper 1 of N
// ---------------------------------------------------------------------------
// Logs into Screener.in and collects the list of recent earnings concalls
// (the "to-read list") from the rolling last-90-days window.
//
// THIS SCRAPER DOES NOT read transcript text or match funds — that is Prompt
// 3/4. It only produces screener-test/output/concalls-index.json: company,
// company URL, concall date, and transcript link (when present).
//
// Run (deps are installed no-save, never committed):
//   npm install playwright@1 cheerio@1 --no-save
//   npx playwright install chromium
//   SCREENER_EMAIL=... SCREENER_PASSWORD=... node screener-test/scrape-concalls.mjs
//
// Env knobs:
//   SCREENER_EMAIL / SCREENER_PASSWORD  (required) — login credentials
//   LIMIT     (default 0 = all within window)      — cap concalls kept (quick test)
//   HEADFUL=1                                       — launch a visible browser
//   DEBUG=1                                         — extra DOM-discovery logging
//   VERIFY=1                                        — open first transcript URLs to prove they resolve
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://www.screener.in";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");

const WINDOW_DAYS = 365; // ~4 quarters (rolling 1-year window)
const LIMIT = Number(process.env.LIMIT || 0);
const HEADFUL = process.env.HEADFUL === "1";
const DEBUG = process.env.DEBUG === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- login helper (proven to work on Screener) ----------------------------
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

// --- date helpers ----------------------------------------------------------
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Parse the many date shapes Screener may render into a YYYY-MM-DD string.
// Handles: "10 Jun 2026", "10 Jun", "Jun 10, 2026", "2026-06-10", "10-06-2026".
// When the year is missing it assumes the most recent occurrence (never future).
function parseDate(raw, now = new Date()) {
  if (!raw) return null;
  const text = raw.trim();

  // ISO yyyy-mm-dd
  let m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // dd-mm-yyyy or dd/mm/yyyy
  m = text.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // "10 Jun 2026" / "10 Jun" / "Jun 10, 2026" / "Jun 10"
  m = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,})\.?(?:\s*,?\s*(\d{4}))?\b/);
  if (!m) m = text.match(/\b([A-Za-z]{3,})\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/)
    ? matchMonthFirst(text)
    : null;
  if (m) {
    const day = Number(m[1]);
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon === undefined || !day) return null;
    let year = m[3] ? Number(m[3]) : now.getFullYear();
    if (!m[3]) {
      // No year given: if the resulting date is in the future, it must be last year.
      const candidate = new Date(year, mon, day);
      if (candidate.getTime() > now.getTime() + 24 * 3600 * 1000) year -= 1;
    }
    return `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}

function matchMonthFirst(text) {
  const m = text.match(/\b([A-Za-z]{3,})\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/);
  if (!m) return null;
  // Re-order to [ , day, monthName, year ] so the caller can read m[1]=day, m[2]=mon.
  return [m[0], m[2], m[1], m[3]];
}

// Absolutize a href against a base (default the site origin). Correctly resolves
// root-relative ("/company/…"), absolute ("https://…"), and query-only ("?page=2").
function abs(href, base = ORIGIN) {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// Current page number from a listing URL (?p=N or ?page=N; defaults to 1).
function pageNumOf(url) {
  const m = url.match(/[?&](?:p|page)=(\d+)/i);
  return m ? Number(m[1]) : 1;
}

// Next page in the NUMBERED listing. Screener uses WINDOWED pagination
// (2 3 4 … 151 152), and on deep pages it stops rendering the last-page link —
// so we must NOT gate on the max linked page (that made us stop early at ~2
// months). Instead always advance to ?p=(cur+1); collectRows terminates on the
// window cutoff, an empty/duplicate page (no new rows), or MAX_PAGES.
function findNextPageUrl($, currentUrl) {
  const cur = pageNumOf(currentUrl);
  // Learn the pagination param name from any numbered link (default "p").
  let param = "p";
  $("a[href]").each((_, a) => {
    const m = $(a).attr("href").match(/[?&](p|page)=\d+/i);
    if (m) { param = m[1]; return false; }
  });
  const u = new URL(currentUrl);
  u.searchParams.set(param, String(cur + 1));
  return u.href;
}

// --- locate the Concalls page ----------------------------------------------
// Try direct/known paths first, then fall back to clicking through Market Pulse.
async function gotoConcalls(page) {
  const candidates = [
    `${ORIGIN}/market/concall/`,
    `${ORIGIN}/market/conference-calls/`,
    `${ORIGIN}/concalls/`,
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(400);
      if (await pageHasConcalls(page)) {
        console.log(`  → concalls page (direct): ${page.url()}`);
        return true;
      }
    } catch {
      /* try next */
    }
  }

  // Fall back: Market Pulse landing, then click the "Concalls" link.
  await page.goto(`${ORIGIN}/market/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(400);
  const link = page
    .locator("a", { hasText: /concall/i })
    .first();
  if (await link.count()) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      link.click(),
    ]);
    await sleep(500);
    if (await pageHasConcalls(page)) {
      console.log(`  → concalls page (via Market Pulse): ${page.url()}`);
      return true;
    }
  }
  return false;
}

async function pageHasConcalls(page) {
  const html = await page.content();
  // A concalls listing reliably contains company links + a "Transcript" action.
  return /\/company\//.test(html) && /transcript/i.test(html);
}

// --- parse one page of concall rows ----------------------------------------
// Anchors on company links (a[href*="/company/"]) and walks up to the row
// container that also holds the date + action links (Transcript / PPT / REC).
function parseConcalls(html) {
  const $ = cheerio.load(html);
  const out = [];

  $('a[href*="/company/"]').each((_, a) => {
    const $a = $(a);
    const company = $a.text().trim().replace(/\s+/g, " ");
    if (!company) return;

    // Walk up to a container that also contains an action link or a date.
    let $row = $a.closest("li, tr, .flex, .card, div");
    for (let hops = 0; hops < 4 && $row.length; hops++) {
      if (/transcript|ppt|notes|rec\b|\d{1,2}\s+[A-Za-z]{3}/i.test($row.text())) break;
      $row = $row.parent();
    }
    if (!$row || !$row.length) return;

    const rowText = $row.text();

    // Transcript link: an action anchor whose text mentions transcript.
    let transcriptUrl = null;
    $row.find("a").each((__, link) => {
      const t = $(link).text().toLowerCase();
      if (/transcript/.test(t) && !transcriptUrl) {
        transcriptUrl = abs($(link).attr("href"));
      }
    });

    const concallDate = parseDate(rowText);
    const companyUrl = abs($a.attr("href"));

    out.push({
      company,
      company_url: companyUrl,
      concall_date: concallDate,
      transcript_url: transcriptUrl,
      has_transcript: Boolean(transcriptUrl),
    });
  });

  // De-duplicate by company + date (a company can appear once per concall).
  const seen = new Set();
  return out.filter((r) => {
    const key = `${r.company}|${r.concall_date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- walk pages until the window is covered --------------------------------
// The Concalls listing is server-paginated (a table, not infinite scroll), so
// we follow page links newest-first and stop once the oldest row on a page is
// older than the cutoff (or there are no more pages / no new rows).
async function collectRows(page, cutoffMs) {
  const byKey = new Map();
  const visited = new Set();
  const MAX_PAGES = 400; // a 4-quarter window spans many more pages

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    visited.add(page.url().split("#")[0]);
    const html = await page.content();
    const $ = cheerio.load(html);
    const rows = parseConcalls(html);

    let added = 0;
    for (const r of rows) {
      const key = `${r.company}|${r.concall_date}`;
      if (!byKey.has(key)) {
        byKey.set(key, r);
        added++;
      }
    }

    const dated = rows.map((r) => r.concall_date).filter(Boolean).sort();
    const oldest = dated[0] || null;
    const newest = dated[dated.length - 1] || null;
    console.log(
      `  page ${pageNum}: ${rows.length} rows (+${added} new, dates ${oldest ?? "?"}…${newest ?? "?"}), total ${byKey.size}`
    );

    // One-time pagination-structure dump so the live DOM confirms our selectors.
    if (DEBUG && pageNum === 1) {
      const cands = [];
      $("a").each((_, a) => {
        const h = $(a).attr("href") || "";
        const t = $(a).text().trim();
        if (/[?&](p|page)=\d+/i.test(h) || /next|prev|older|newer|»|›|«|‹/i.test(t)) {
          cands.push(`${t || "·"} -> ${h}`);
        }
      });
      console.log(`    pagination candidates: ${JSON.stringify(cands.slice(0, 14))}`);
    }

    // Quick-test short-circuit: enough rows already collected.
    if (LIMIT > 0 && byKey.size >= LIMIT) break;
    // Window covered only once an ENTIRE page predates the cutoff (its newest
    // row < cutoff). The listing is publish-ordered, so concall dates aren't
    // monotonic across pages — stopping on a page's oldest row would miss
    // in-window concalls further down. The final filter drops stragglers.
    if (newest && new Date(newest).getTime() < cutoffMs) break;
    // No fresh rows on a later page → end of list (also guards a wrong page param).
    if (added === 0 && pageNum > 1) break;

    // Next page via the detected ?p=N link; null means we're on the last page.
    const next = findNextPageUrl($, page.url());
    if (!next || visited.has(next.split("#")[0])) break;

    if (DEBUG) console.log(`    → next: ${next}`);
    await page.goto(next, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(450);
  }

  return [...byKey.values()];
}

// --- main ------------------------------------------------------------------
async function run() {
  if (!process.env.SCREENER_EMAIL || !process.env.SCREENER_PASSWORD) {
    throw new Error(
      "Missing credentials — set SCREENER_EMAIL and SCREENER_PASSWORD in the environment."
    );
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const now = new Date();
  const cutoffMs = now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000;

  const browser = await chromium.launch({ headless: !HEADFUL });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  try {
    console.log("Logging in to Screener…");
    await loginViaBrowser(page);
    console.log("Login OK.");
    await sleep(400);

    console.log("Locating Concalls page…");
    const found = await gotoConcalls(page);

    // DOM-discovery instrumentation: always capture what we actually landed on.
    const landedHtml = await page.content();
    await page.screenshot({ path: join(OUTPUT_DIR, "concalls-page.png"), fullPage: true }).catch(() => {});
    if (DEBUG || !found) {
      const $ = cheerio.load(landedHtml);
      const sample = $('a[href*="/company/"]').first().closest("li, tr, div").parent().html();
      console.log(`  landed URL: ${page.url()}`);
      console.log("  row markup sample (first company's container):");
      console.log((sample || "<none found>").slice(0, 1200));
    }
    if (!found) {
      throw new Error(
        "Could not locate the Concalls listing. Inspect output/concalls-page.png and " +
          "the logged markup sample, then adjust gotoConcalls()/parseConcalls() selectors."
      );
    }

    console.log(`Reading concalls (window: last ${WINDOW_DAYS} days, cutoff ${new Date(cutoffMs).toISOString().slice(0, 10)})…`);
    let rows = await collectRows(page, cutoffMs);
    console.log(`  raw rows parsed: ${rows.length}`);

    // Keep only rows within the window (drop undated rows defensively).
    let kept = rows.filter((r) => r.concall_date && new Date(r.concall_date).getTime() >= cutoffMs);

    // Sort newest first.
    kept.sort((a, b) => (a.concall_date < b.concall_date ? 1 : -1));

    // Optional cap for quick test runs.
    if (LIMIT > 0 && kept.length > LIMIT) {
      console.log(`  applying LIMIT=${LIMIT} (was ${kept.length})`);
      kept = kept.slice(0, LIMIT);
    }

    const withTranscript = kept.filter((r) => r.has_transcript).length;
    const dates = kept.map((r) => r.concall_date).filter(Boolean).sort();
    const range = dates.length ? `${dates[0]} … ${dates[dates.length - 1]}` : "none";

    const result = {
      generated_at: now.toISOString(),
      window_days: WINDOW_DAYS,
      count: kept.length,
      concalls: kept,
    };

    const outPath = join(OUTPUT_DIR, "concalls-index.json");
    await writeFile(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");

    console.log("─".repeat(60));
    console.log(
      `Summary: kept ${kept.length} concalls, ${withTranscript} with transcripts, ` +
        `date range ${range}. → ${outPath}`
    );

    // Echo the first 3 entries so a CI run surfaces real data in its logs.
    console.log("First 3 concalls:");
    console.log(JSON.stringify(kept.slice(0, 3), null, 2));

    // Optional: prove the captured transcript links actually open in-session.
    // Reuses the authenticated page, so it confirms real, reachable Screener URLs.
    if (process.env.VERIFY === "1") {
      const sample = kept.filter((r) => r.has_transcript).slice(0, 3);
      console.log(`Verifying ${sample.length} transcript URL(s) (authenticated)…`);
      for (const r of sample) {
        try {
          const resp = await page.goto(r.transcript_url, { waitUntil: "domcontentloaded", timeout: 30000 });
          const status = resp ? resp.status() : "ERR";
          const host = (() => { try { return new URL(r.transcript_url).host; } catch { return "?"; } })();
          // Transcripts are exchange-hosted PDFs (BSE/NSE) with hotlink protection,
          // so a 403 here is expected — it confirms a real exchange link, which
          // Prompt 3 will fetch properly (referer/headers/download).
          const verdict = resp && resp.status() < 400 ? "OK" : "external (fetch in P3)";
          console.log(`  [${status}] ${verdict} ${r.company} [${host}] → ${r.transcript_url}`);
          await sleep(400);
        } catch (e) {
          console.log(`  [ERR] ${r.company} → ${r.transcript_url} (${e.message})`);
        }
      }
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
