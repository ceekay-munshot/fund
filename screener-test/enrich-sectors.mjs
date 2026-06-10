// enrich-sectors.mjs — Fund Tracker — MGA · Sector/industry enrichment
// ---------------------------------------------------------------------------
// For every company that has a fund sighting, visit its Screener company page
// and capture ticker + sector + industry, then attach those to each sighting.
// Powers the later "By Sector" theme view. No dashboard / public/data yet (P6).
//
// Inputs:
//   screener-test/output/fund-matches.json     (sightings → which companies)
//   screener-test/output/concalls-index.json   (company → Screener company_url)
// Outputs:
//   screener-test/output/company-meta.json            (reusable company map)
//   screener-test/output/fund-matches-enriched.json   (sightings + ticker/sector/industry)
//
// Run:
//   npm install playwright@1 cheerio@1 --no-save
//   npx playwright install chromium
//   SCREENER_EMAIL=... SCREENER_PASSWORD=... node screener-test/enrich-sectors.mjs
//
// Env knobs: HEADFUL=1 (visible browser), DEBUG=1 (dump markup for every company).
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://www.screener.in";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");
const PUBLIC_DATA = join(__dirname, "..", "public", "data");
const MATCHES_PATH = join(OUTPUT_DIR, "fund-matches.json");
const INDEX_PATH = join(OUTPUT_DIR, "concalls-index.json");
// company-meta is a COMMITTED, persistent cache: enrich reuses already-resolved
// companies across runs and only fetches new/unresolved ones (keeps each run light
// and lets a throttled run's nulls fill in over subsequent runs).
const META_PATH = join(PUBLIC_DATA, "company-meta.json");
const STORE_PATH = join(PUBLIC_DATA, "fund-sightings.json");
const ENRICHED_PATH = join(OUTPUT_DIR, "fund-matches-enriched.json");

// Cap company-page fetches per run so we never re-throttle Screener; any leftover
// unresolved companies are picked up on the next run (cache makes it converge).
const ENRICH_MAX = Number(process.env.ENRICH_MAX || 75);

const HEADFUL = process.env.HEADFUL === "1";
const DEBUG = process.env.DEBUG === "1";
// Re-resolve a cached company only if FRESH (force a full re-fetch ignoring cache).
const FRESH = process.env.FRESH === "1";
const GOTO_TIMEOUT = 20000; // fail fast (was 45s) so a dead page doesn't burn the run
const PER_COMPANY_DELAY = 1500; // polite gap between company pages

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- login helper (same proven flow as Prompts 2/3) -----------------------
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

function tickerFromUrl(url) {
  const m = (url || "").match(/\/company\/([^/]+)\//);
  return m ? m[1] : null;
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

// --- parse a company page --------------------------------------------------
// Screener classifies companies by Sector/Industry. The exact markup is
// discovered live (see the dump below); these selectors target the labeled
// values Screener renders near the header / peers area, with several fallbacks.
function parseCompanyPage(html, url) {
  const $ = cheerio.load(html);

  const name = clean($("h1").first().text()) || null;
  const urlCode = tickerFromUrl(url);

  // On-page exchange symbols (NSE preferred for ticker, then BSE, then URL code).
  const headerText = clean($("#top, .company-info, .company-links, body").first().text());
  const nse = (headerText.match(/\bNSE\s*:?\s*([A-Z][A-Z0-9&-]{1,20})\b/) || [])[1] || null;
  const bse = (headerText.match(/\bBSE\s*:?\s*(\d{4,6})\b/) || [])[1] || null;
  const ticker = nse || (urlCode && /[A-Za-z]/.test(urlCode) ? urlCode : null) || bse || urlCode || null;

  // Sector / Industry from Screener's classification breadcrumb. Screener renders
  // a broad→specific chain as /market/IN.. links (e.g. Industrials → Capital Goods
  // → Industrial Products → Castings & Forgings). Path depth tells the levels:
  // sector = shallowest (level 1), industry = most-specific leaf (deepest).
  let sector = null;
  let industry = null;
  const crumbs = [];
  const seenHref = new Set();
  $('a[href*="/market/IN"]').each((_, a) => {
    const href = $(a).attr("href") || "";
    const label = clean($(a).text());
    const m = href.match(/\/market\/(IN[0-9A-Za-z/]*)/);
    if (!label || !m || seenHref.has(href)) return;
    seenHref.add(href);
    crumbs.push({ label, href, depth: m[1].split("/").filter(Boolean).length });
  });
  if (crumbs.length) {
    crumbs.sort((a, b) => a.depth - b.depth);
    sector = crumbs[0].label;
    industry = crumbs[crumbs.length - 1].label;
  } else {
    // Fallback: explicit "Sector:" / "Industry:" labels if no breadcrumb present.
    const bodyText = clean($("body").text());
    const sm = bodyText.match(/\bSector\s*:?\s*([A-Za-z0-9 &,\/.\-]{2,50}?)(?:\s{2,}|Industry\b|$)/);
    const im = bodyText.match(/\bIndustry\s*:?\s*([A-Za-z0-9 &,\/.\-]{2,50}?)(?:\s{2,}|Sector\b|$)/);
    if (sm) sector = clean(sm[1]);
    if (im) industry = clean(im[1]);
  }

  return { name, ticker, sector: sector || null, industry: industry || null, urlCode, nse, bse };
}

// One-time discovery dump so we can confirm/tune selectors against the live DOM.
function dumpDiscovery($, url) {
  console.log(`  ── discovery dump for ${url} ──`);
  console.log(`  h1: ${clean($("h1").first().text())}`);
  const linksBlock = $('.company-links, .company-info').first();
  if (linksBlock.length) console.log(`  links block: ${clean(linksBlock.text()).slice(0, 200)}`);
  const hits = [];
  $("*").each((_, el) => {
    if (hits.length >= 8) return;
    const own = clean($(el).clone().children().remove().end().text());
    if (/\b(industry|sector)\b/i.test(own) && own.length < 80) {
      hits.push(`<${el.tagName}> ${own}`);
    }
  });
  console.log(`  industry/sector text nodes: ${JSON.stringify(hits)}`);
  const anchors = [];
  $('a[href*="/company/compare/"], a[href*="industry"], a[href*="/market/"]').each((_, a) => {
    if (anchors.length >= 10) return;
    anchors.push(`${clean($(a).text())} -> ${$(a).attr("href")}`);
  });
  console.log(`  classification anchors: ${JSON.stringify(anchors)}`);
}

// --- main ------------------------------------------------------------------
async function run() {
  if (!process.env.SCREENER_EMAIL || !process.env.SCREENER_PASSWORD) {
    throw new Error("Missing credentials — set SCREENER_EMAIL and SCREENER_PASSWORD.");
  }
  if (!existsSync(MATCHES_PATH)) {
    throw new Error(`Input not found: ${MATCHES_PATH}. Run match-funds.mjs first.`);
  }
  await mkdir(OUTPUT_DIR, { recursive: true });

  const matchesDoc = JSON.parse(await readFile(MATCHES_PATH, "utf8"));
  const sightings = matchesDoc.matches || [];

  // Map company → company_url (and transcript_url → company_url) from the index.
  const urlByCompany = new Map();
  const urlByTranscript = new Map();
  if (existsSync(INDEX_PATH)) {
    const index = JSON.parse(await readFile(INDEX_PATH, "utf8"));
    for (const c of index.concalls || []) {
      if (c.company && c.company_url && !urlByCompany.has(c.company)) {
        urlByCompany.set(c.company, c.company_url);
      }
      if (c.transcript_url && c.company_url) urlByTranscript.set(c.transcript_url, c.company_url);
    }
  }

  // Distinct companies that actually have a sighting (from this run's matches).
  const companies = new Map(); // company name -> company_url
  for (const s of sightings) {
    if (companies.has(s.company)) continue;
    const url = urlByCompany.get(s.company) || urlByTranscript.get(s.transcript_url) || null;
    companies.set(s.company, url);
  }

  // Self-heal: also (re)enrich companies already in the committed store that still
  // lack a sector — so ordinary runs gradually complete the store without a FULL
  // sweep. URLs come from the always-full concalls-index (90-day window).
  if (existsSync(STORE_PATH)) {
    try {
      const store = JSON.parse(await readFile(STORE_PATH, "utf8"));
      for (const s of store.sightings || []) {
        if (!s.sector && !companies.has(s.company)) {
          companies.set(s.company, urlByCompany.get(s.company) || null);
        }
      }
    } catch {
      /* ignore */
    }
  }
  console.log(`Distinct companies to enrich: ${companies.size} (this run's matches + store gaps)`);

  // Quiet day (no new sightings): write empty enriched output and skip login.
  // Leave company-meta.json untouched so the persistent cache survives.
  if (companies.size === 0) {
    const nowIso = new Date().toISOString();
    await writeFile(ENRICHED_PATH, JSON.stringify({ ...matchesDoc, generated_at: nowIso, matches: [] }, null, 2) + "\n", "utf8");
    console.log("Nothing to enrich — wrote empty enriched matches (cache preserved).");
    return;
  }

  // Load the committed cache and reuse already-resolved companies (industry set),
  // so we only fetch new/unresolved ones — keeps each run light and lets a
  // throttled run's nulls fill in over later runs. FRESH=1 ignores the cache.
  let cache = {};
  if (!FRESH && existsSync(META_PATH)) {
    try {
      cache = JSON.parse(await readFile(META_PATH, "utf8")).companies || {};
    } catch {
      cache = {};
    }
  }

  const meta = {}; // company -> { ticker, sector, industry, company_url }
  const toFetch = [];
  let reused = 0;
  for (const [company, companyUrl] of companies) {
    const c = cache[company];
    if (c && c.industry) {
      meta[company] = {
        ticker: c.ticker ?? null,
        sector: c.sector ?? null,
        industry: c.industry,
        company_url: c.company_url ?? companyUrl,
      };
      reused++;
    } else {
      toFetch.push([company, companyUrl]);
    }
  }
  let resolvedIndustry = reused;
  let deferred = 0;
  if (toFetch.length > ENRICH_MAX) {
    deferred = toFetch.length - ENRICH_MAX;
    toFetch.length = ENRICH_MAX; // cap; the rest resolve on the next run
  }
  console.log(
    `Cache: ${reused} reused, ${toFetch.length} to fetch${deferred ? `, ${deferred} deferred to next run` : ""}.`
  );

  if (toFetch.length > 0) {
    const browser = await chromium.launch({ headless: !HEADFUL });
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    let firstDumped = false;

    try {
      console.log("Logging in to Screener…");
      await loginViaBrowser(page);
      console.log("Login OK.\n");
      await sleep(400);

      for (let i = 0; i < toFetch.length; i++) {
        const [company, companyUrl] = toFetch[i];
        const entry = { ticker: null, sector: null, industry: null, company_url: companyUrl };
        if (!companyUrl) {
          console.log(`[${i + 1}/${toFetch.length}] ${company} — no company_url, skipping`);
          meta[company] = entry;
          continue;
        }
        try {
          // Screener occasionally serves a partial page (no classification block)
          // under rapid sequential hits — reload once before giving up.
          let parsed = null;
          let $ = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            await page.goto(companyUrl, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT });
            await page.waitForSelector('a[href*="/market/IN"]', { timeout: 6000 }).catch(() => {});
            await sleep(300);
            const html = await page.content();
            $ = cheerio.load(html);
            parsed = parseCompanyPage(html, companyUrl);
            if (parsed.industry || parsed.sector) break;
            if (attempt < 2) {
              console.log(`    ${company}: no classification yet — reloading…`);
              await sleep(1500);
            }
          }

          // Discovery: screenshot + dump the first company (and all, if DEBUG).
          if (!firstDumped || DEBUG) {
            if (!firstDumped) {
              await page
                .screenshot({ path: join(OUTPUT_DIR, "company-page.png"), fullPage: true })
                .catch(() => {});
            }
            dumpDiscovery($, companyUrl);
            firstDumped = true;
          }

          entry.ticker = parsed.ticker;
          entry.sector = parsed.sector;
          entry.industry = parsed.industry;
          if (entry.industry) resolvedIndustry++;
          console.log(
            `[${i + 1}/${toFetch.length}] ${company} → ticker ${entry.ticker ?? "—"}, sector ${entry.sector ?? "—"}, industry ${entry.industry ?? "—"}`
          );
          meta[company] = entry;
          await sleep(PER_COMPANY_DELAY);
        } catch (err) {
          console.log(`[${i + 1}/${toFetch.length}] ${company} — error: ${err.message}`);
          meta[company] = entry;
          // Back off harder when Screener is throttling (timeouts / connection resets).
          const throttled = /timeout|timed out|ERR_|net::/i.test(err.message);
          await sleep(throttled ? 5000 : PER_COMPANY_DELAY);
        }
      }
    } finally {
      await browser.close();
    }
  }

  // Write company-meta.json — MERGE into the prior cache so resolved companies
  // persist across runs even when they're not in this run's working set (FRESH
  // rebuilds from scratch).
  await mkdir(PUBLIC_DATA, { recursive: true });
  const mergedCompanies = FRESH ? meta : { ...cache, ...meta };
  await writeFile(
    META_PATH,
    JSON.stringify({ generated_at: new Date().toISOString(), companies: mergedCompanies }, null, 2) + "\n",
    "utf8"
  );

  // Write fund-matches-enriched.json (carry everything through + ticker/sector/industry).
  const enriched = {
    ...matchesDoc,
    generated_at: new Date().toISOString(),
    matches: sightings.map((s) => {
      const m = meta[s.company] || {};
      return { ...s, ticker: m.ticker ?? null, sector: m.sector ?? null, industry: m.industry ?? null };
    }),
  };
  await writeFile(ENRICHED_PATH, JSON.stringify(enriched, null, 2) + "\n", "utf8");

  // Console summary table.
  console.log("\nCompany → ticker / sector / industry:");
  for (const [company, m] of Object.entries(meta)) {
    console.log(
      `  ${company.padEnd(26)} ${String(m.ticker ?? "—").padEnd(11)} ${String(m.sector ?? "—").padEnd(24)} ${m.industry ?? "—"}`
    );
  }
  console.log(
    `\nEnriched ${sightings.length} sightings; resolved industry for ${resolvedIndustry}/${companies.size} companies.`
  );
  console.log(`→ ${META_PATH}\n→ ${ENRICHED_PATH}`);
}

run().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
