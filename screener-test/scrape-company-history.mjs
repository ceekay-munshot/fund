// scrape-company-history.mjs — Fund Tracker — MGA · 4-quarter backfill
// ---------------------------------------------------------------------------
// Screener's Market Pulse → Concalls list only surfaces ~2.5 months of concalls.
// To reach a full 4 quarters, this step visits each company we ALREADY track and
// reads its company-page concall HISTORY (which lists transcripts back several
// quarters), then MERGES those older concalls into output/concalls-index.json so
// the normal transcripts → match → enrich → store pipeline picks them up.
//
// Scope note: it deepens companies already in our universe (current concalls-index
// + committed company-meta.json). A company with a fund sighting 3 quarters ago but
// no concall in the recent window won't be known yet — most active names have
// quarterly calls, so coverage is high; this is documented as a v1 limitation.
//
// ONLY runs on a FULL sweep (FULL=1 / FORCE=1) — it's heavy. Otherwise it exits 0.
//
// Run: SCREENER_EMAIL=.. SCREENER_PASSWORD=.. FULL=1 node screener-test/scrape-company-history.mjs
// Env: COMPANY_LIMIT (cap companies for testing), HEADFUL=1, DEBUG=1.
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://www.screener.in";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");
const INDEX_PATH = join(OUTPUT_DIR, "concalls-index.json");
const COMPANY_META_PATH = join(__dirname, "..", "public", "data", "company-meta.json");

const WINDOW_DAYS = 365; // ~4 quarters
const FULL = process.env.FULL === "1" || process.env.FORCE === "1";
const COMPANY_LIMIT = Number(process.env.COMPANY_LIMIT || 0);
const HEADFUL = process.env.HEADFUL === "1";
const DEBUG = process.env.DEBUG === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginViaBrowser(page) {
  await page.goto(`${ORIGIN}/login/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[name="username"]', process.env.SCREENER_EMAIL);
  await page.fill('input[name="password"]', process.env.SCREENER_PASSWORD);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(1500);
  if (!/\/logout\//.test(await page.content())) throw new Error("Login failed — check SCREENER_EMAIL / SCREENER_PASSWORD.");
}

function abs(href, base = ORIGIN) {
  if (!href) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Screener concall rows show dates like "May 2026" / "10 May 2026" / "May 2026".
function parseHistoryDate(raw) {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").trim();
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/\b(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})\b/); // 10 May 2026
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo != null) return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`; }
  m = t.match(/\b([A-Za-z]{3,})\.?\s+(\d{4})\b/); // May 2026 → day unknown → 01
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo != null) return `${m[2]}-${String(mo + 1).padStart(2, "0")}-01`; }
  return null;
}

const slugId = (company, date) =>
  `${(company || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}_${date}`;

const TODAY = new Date().toISOString().slice(0, 10);

// Resolve a transcript anchor's concall date, most-trustworthy source first:
//   1. the anchor's OWN text — rich announcement rows carry "29 May 2026" (exact day);
//   2. the tightest row container (li / tr) — Screener's concall list shows "May 2026";
//   3. a minimal parent walk (≤3) for div-based layouts.
// Greedy walks up into wrapper divs were grabbing a neighbouring month (the May→Jun
// drift) or Screener's ESTIMATED upcoming-results date (a future date), so we stop
// tight and reject anything dated after today.
function resolveAnchorDate($, $a) {
  let date = parseHistoryDate($a.text());
  if (!date) {
    const $row = $a.closest("li, tr");
    if ($row.length) date = parseHistoryDate($row.text());
  }
  if (!date) {
    let $p = $a.parent();
    for (let i = 0; i < 3 && $p.length; i++) {
      date = parseHistoryDate($p.text());
      if (date) break;
      $p = $p.parent();
    }
  }
  if (date && date > TODAY) return null; // estimated/upcoming results date — not a real concall
  return date;
}

// Parse a company page's concall history → [{ concall_date, transcript_url }].
// Anchors whose text is "Transcript" link to the exchange PDF; the row also holds
// a month/year date. Scope to the concalls area when detectable, else page-wide.
function parseCompanyConcalls(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $("a").each((_, a) => {
    const $a = $(a);
    const txt = $a.text().trim().toLowerCase();
    if (!/transcript/.test(txt)) return;
    const href = $a.attr("href") || "";
    if (!/\.pdf|AnnPdfOpen|nseindia|bseindia|nsearchives/i.test(href)) return; // real transcript doc
    const date = resolveAnchorDate($, $a);
    if (!date) return;
    const url = abs(href);
    const key = url || `${date}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ concall_date: date, transcript_url: url });
  });
  return out;
}

async function run() {
  if (!FULL) { console.log("Not a FULL sweep — skipping company-history backfill."); return; }
  if (!process.env.SCREENER_EMAIL || !process.env.SCREENER_PASSWORD) throw new Error("Missing SCREENER_EMAIL / SCREENER_PASSWORD.");
  if (!existsSync(INDEX_PATH)) throw new Error(`Input not found: ${INDEX_PATH}. Run scrape-concalls.mjs first.`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const index = JSON.parse(await readFile(INDEX_PATH, "utf8"));
  index.concalls = index.concalls || [];

  // Company universe = companies in this run's index + committed company-meta cache.
  const companyUrl = new Map();
  for (const c of index.concalls) if (c.company && c.company_url) companyUrl.set(c.company, c.company_url);
  if (existsSync(COMPANY_META_PATH)) {
    try {
      const meta = JSON.parse(await readFile(COMPANY_META_PATH, "utf8")).companies || {};
      for (const [name, m] of Object.entries(meta)) if (m.company_url && !companyUrl.has(name)) companyUrl.set(name, m.company_url);
    } catch { /* ignore */ }
  }
  let companies = [...companyUrl.entries()].map(([company, url]) => ({ company, url }));
  if (COMPANY_LIMIT > 0) companies = companies.slice(0, COMPANY_LIMIT);

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  // Existing transcript URLs in the index → avoid dupes.
  const haveUrl = new Set(index.concalls.map((c) => c.transcript_url).filter(Boolean));
  const haveId = new Set(index.concalls.map((c) => slugId(c.company, c.concall_date)));

  console.log(`Company-history backfill: ${companies.length} companies, window ≥ ${cutoff}`);

  const browser = await chromium.launch({ headless: !HEADFUL });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  let added = 0, scanned = 0, firstDumped = false;
  try {
    console.log("Logging in to Screener…");
    await loginViaBrowser(page);
    console.log("Login OK.\n");
    await sleep(400);

    for (let i = 0; i < companies.length; i++) {
      const { company, url } = companies[i];
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await sleep(350);
        const html = await page.content();

        if ((!firstDumped || DEBUG)) {
          if (!firstDumped) await page.screenshot({ path: join(OUTPUT_DIR, "company-history-page.png"), fullPage: true }).catch(() => {});
          const dump = parseCompanyConcalls(html).map((r) => `${r.concall_date} ⇐ ${(r.transcript_url || "").slice(-40)}`);
          console.log(`  ── dump ${company} (${url}) — resolved concalls (date ⇐ url): ${JSON.stringify(dump.slice(0, 10))}`);
          firstDumped = true;
        }

        const rows = parseCompanyConcalls(html).filter((r) => r.concall_date >= cutoff);
        let coAdded = 0;
        for (const r of rows) {
          const id = slugId(company, r.concall_date);
          if ((r.transcript_url && haveUrl.has(r.transcript_url)) || haveId.has(id)) continue;
          haveUrl.add(r.transcript_url); haveId.add(id);
          index.concalls.push({ company, company_url: url, concall_date: r.concall_date, transcript_url: r.transcript_url, has_transcript: true });
          coAdded++; added++;
        }
        scanned++;
        console.log(`[${i + 1}/${companies.length}] ${company}: ${rows.length} historical concalls in window (+${coAdded} new)`);
      } catch (err) {
        console.log(`[${i + 1}/${companies.length}] ${company} — error: ${err.message}`);
      }
      await sleep(450 + Math.floor(Math.random() * 350));
    }
  } finally {
    await browser.close();
  }

  index.count = index.concalls.length;
  index.window_days = WINDOW_DAYS;
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log("─".repeat(60));
  console.log(`Backfill: scanned ${scanned} company pages, added ${added} historical concalls. Index now ${index.concalls.length}.`);
}

run().catch((err) => { console.error("FATAL:", err.message); process.exit(1); });
