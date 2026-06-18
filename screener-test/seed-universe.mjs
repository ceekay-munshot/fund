// seed-universe.mjs — Fund Tracker — MGA · full-directory seed (one-time, resumable)
// ---------------------------------------------------------------------------
// "Grow daily" only learns about a company once it reports a concall in the recent
// window. To cover EVERY concall-holding company from day one, this enumerates
// Screener's full company directory (via a match-all screen, paginated) and merges
// every company → url into public/data/company-universe.json — the same queue the
// hourly history-backfill drains. Companies that never hold a concall just return
// nothing there and get marked done; nothing is wasted downstream.
//
// Screener blocks the IP after ~50 page hits per session, so this is BLOCK-SAFE and
// RESUMABLE: it reads up to SEED_MAX_PAGES list pages per run and stores a page cursor
// (seed_next_page) in company-universe.json, so successive runs continue paginating
// until the whole directory is covered (seed_complete:true), then no-op.
//
// Run: SCREENER_EMAIL=.. SCREENER_PASSWORD=.. node screener-test/seed-universe.mjs
// Env: SEED_SCREEN_URL (override listing), SEED_MAX_PAGES (default 40), HEADFUL, DEBUG.
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
const UNIVERSE_PATH = join(__dirname, "..", "public", "data", "company-universe.json");

// A match-all screen: every listed company has a market cap > 0. Results are an HTML
// table of company links, paginated via ?page=N — exactly what we enumerate.
const SCREEN_URL = process.env.SEED_SCREEN_URL || `${ORIGIN}/screen/raw/?query=Market+Capitalization+%3E+0`;
const MAX_PAGES = Number(process.env.SEED_MAX_PAGES || 40); // block-safe per run
const PAGE_TIMEOUT = Number(process.env.SEED_PAGE_TIMEOUT_MS || 15000);
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

function abs(href) {
  if (!href) return null;
  try { return new URL(href, ORIGIN).href; } catch { return null; }
}

function pageUrl(n) {
  const u = new URL(SCREEN_URL);
  u.searchParams.set("page", String(n));
  return u.href;
}

// Parse a screen results page → [{ company, url }] from the results table's company links.
function parseCompanies(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  // Prefer rows inside the results table; fall back to page-wide /company/ links.
  const $scope = $("table").length ? $("table a[href^='/company/']") : $("a[href^='/company/']");
  $scope.each((_, a) => {
    const href = $(a).attr("href") || "";
    const name = $(a).text().trim();
    if (!/^\/company\//.test(href) || !name) return;
    const url = abs(href);
    if (!url || seen.has(name)) return;
    seen.add(name);
    out.push({ company: name, url });
  });
  return out;
}

async function run() {
  if (!process.env.SCREENER_EMAIL || !process.env.SCREENER_PASSWORD) throw new Error("Missing SCREENER_EMAIL / SCREENER_PASSWORD.");
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Load existing universe + cursor.
  let uni = { companies: {}, seed_next_page: 1, seed_complete: false };
  if (existsSync(UNIVERSE_PATH)) {
    try { uni = { companies: {}, seed_next_page: 1, seed_complete: false, ...JSON.parse(await readFile(UNIVERSE_PATH, "utf8")) }; } catch { /* fresh */ }
  }
  uni.companies = uni.companies || {};

  if (uni.seed_complete) {
    console.log(`Seed already complete — ${Object.keys(uni.companies).length} companies in the universe. Nothing to do.`);
    return;
  }

  const startPage = Number(uni.seed_next_page || 1);
  console.log(`Seeding company universe from ${SCREEN_URL}`);
  console.log(`Resuming at page ${startPage}; ${Object.keys(uni.companies).length} companies known so far. This run: up to ${MAX_PAGES} pages.`);

  const browser = await chromium.launch({ headless: !HEADFUL });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  let pagesRead = 0, addedTotal = 0, lastPage = startPage - 1, completed = false, blocked = false, consecEmptyOrFail = 0;
  try {
    console.log("Logging in to Screener…");
    await loginViaBrowser(page);
    console.log("Login OK.\n");
    await sleep(400);

    for (let p = startPage; p < startPage + MAX_PAGES; p++) {
      let rows = [];
      try {
        await page.goto(pageUrl(p), { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
        await sleep(350);
        const html = await page.content();
        rows = parseCompanies(html);
        if (DEBUG && pagesRead === 0) {
          console.log(`  ── dump page ${p}: ${rows.length} company links; first 8: ${JSON.stringify(rows.slice(0, 8).map((r) => r.company))}`);
        }
      } catch (err) {
        consecEmptyOrFail++;
        console.log(`  page ${p} — error: ${err.message.split("\n")[0]}`);
        if (consecEmptyOrFail >= 3) { blocked = true; console.log("  ✗ repeated failures — stopping; next run resumes here."); break; }
        await sleep(3000);
        continue;
      }

      pagesRead++;
      lastPage = p;
      let addedThisPage = 0;
      for (const r of rows) if (!uni.companies[r.company]) { uni.companies[r.company] = r.url; addedThisPage++; }
      addedTotal += addedThisPage;
      console.log(`  page ${p}: ${rows.length} companies (+${addedThisPage} new), universe ${Object.keys(uni.companies).length}`);

      // End of directory: an (almost) empty results page, twice in a row to be safe.
      if (rows.length < 5) {
        consecEmptyOrFail++;
        if (consecEmptyOrFail >= 2) { completed = true; console.log("  ✓ reached end of directory."); break; }
      } else {
        consecEmptyOrFail = 0;
      }
      await sleep(700 + Math.floor(Math.random() * 400));
    }
  } finally {
    await browser.close();
  }

  uni.seed_next_page = completed ? lastPage : lastPage + 1;
  uni.seed_complete = completed;
  uni.count = Object.keys(uni.companies).length;
  uni.updated_at = new Date().toISOString();
  await writeFile(UNIVERSE_PATH, JSON.stringify(uni, null, 2) + "\n", "utf8");

  console.log("─".repeat(60));
  console.log(
    `Seed run: read ${pagesRead} pages (+${addedTotal} new companies), universe now ${uni.count}. ` +
      `${completed ? "DIRECTORY COMPLETE." : blocked ? `blocked — resume at page ${uni.seed_next_page}.` : `resume at page ${uni.seed_next_page}.`}`
  );
}

run().catch((err) => { console.error("FATAL:", err.message); process.exit(1); });
