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
const MATCHES_PATH = join(OUTPUT_DIR, "fund-matches.json");
const INDEX_PATH = join(OUTPUT_DIR, "concalls-index.json");
const META_PATH = join(OUTPUT_DIR, "company-meta.json");
const ENRICHED_PATH = join(OUTPUT_DIR, "fund-matches-enriched.json");

const HEADFUL = process.env.HEADFUL === "1";
const DEBUG = process.env.DEBUG === "1";

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

  // Sector / Industry — labeled-value extraction with fallbacks.
  let sector = null;
  let industry = null;

  // Strategy A: explicit "Sector:" / "Industry:" labels anywhere on the page.
  const bodyText = clean($("body").text());
  const sectorLbl = bodyText.match(/\bSector\s*:?\s*([A-Za-z0-9 &,\/.\-]{2,60}?)(?:\s{2,}|Industry\b|\bCompare\b|$)/);
  const industryLbl = bodyText.match(/\bIndustry\s*:?\s*([A-Za-z0-9 &,\/.\-]{2,60}?)(?:\s{2,}|Sector\b|\bCompare\b|$)/);
  if (sectorLbl) sector = clean(sectorLbl[1]);
  if (industryLbl) industry = clean(industryLbl[1]);

  // Strategy B: classification anchors (industry/sector screens) near header/peers.
  if (!industry || !sector) {
    $('a[href*="/company/compare/"], a[href*="industry"], a[href*="/market/"]').each((_, a) => {
      const t = clean($(a).text());
      if (t && t.length <= 60 && !/compare|peers?|more|view/i.test(t)) {
        if (!industry) industry = t;
        else if (!sector) sector = t;
      }
    });
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

  // Distinct companies that actually have a sighting.
  const companies = new Map(); // company name -> company_url
  for (const s of sightings) {
    if (companies.has(s.company)) continue;
    const url = urlByCompany.get(s.company) || urlByTranscript.get(s.transcript_url) || null;
    companies.set(s.company, url);
  }
  console.log(`Distinct companies to enrich: ${companies.size} (from ${sightings.length} sightings)`);

  const browser = await chromium.launch({ headless: !HEADFUL });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  const meta = {}; // company -> { ticker, sector, industry, company_url }
  let resolvedIndustry = 0;
  let firstDumped = false;

  try {
    console.log("Logging in to Screener…");
    await loginViaBrowser(page);
    console.log("Login OK.\n");
    await sleep(400);

    let i = 0;
    for (const [company, companyUrl] of companies) {
      i++;
      const entry = { ticker: null, sector: null, industry: null, company_url: companyUrl };
      if (!companyUrl) {
        console.log(`[${i}/${companies.size}] ${company} — no company_url, skipping`);
        meta[company] = entry;
        continue;
      }
      try {
        await page.goto(companyUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        await sleep(400);
        const html = await page.content();
        const $ = cheerio.load(html);

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

        const parsed = parseCompanyPage(html, companyUrl);
        entry.ticker = parsed.ticker;
        entry.sector = parsed.sector;
        entry.industry = parsed.industry;
        if (entry.industry) resolvedIndustry++;
        console.log(
          `[${i}/${companies.size}] ${company} → ticker ${entry.ticker ?? "—"}, industry ${entry.industry ?? "—"}`
        );
      } catch (err) {
        console.log(`[${i}/${companies.size}] ${company} — error: ${err.message}`);
      }
      meta[company] = entry;
      await sleep(400);
    }
  } finally {
    await browser.close();
  }

  // Write company-meta.json.
  await writeFile(
    META_PATH,
    JSON.stringify({ generated_at: new Date().toISOString(), companies: meta }, null, 2) + "\n",
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
  console.log("\nCompany → ticker / industry:");
  for (const [company, m] of Object.entries(meta)) {
    console.log(`  ${company.padEnd(28)} ${String(m.ticker ?? "—").padEnd(12)} ${m.industry ?? "—"}`);
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
