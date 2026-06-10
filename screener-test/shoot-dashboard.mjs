// shoot-dashboard.mjs — render the static dashboard and screenshot it (CI only).
// Serves ./public over http, loads it in chromium, asserts no console errors,
// logs the live KPI/DOM numbers, and writes screenshots to screener-test/output/.
//
//   npm install playwright@1 --no-save && npx playwright install chromium
//   node screener-test/shoot-dashboard.mjs

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const OUT = join(__dirname, "output");
const PORT = 8799;

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".png": "image/png",
};

function serve() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      let p = decodeURIComponent((req.url || "/").split("?")[0]);
      if (p === "/") p = "/index.html";
      const file = join(PUBLIC, p);
      if (!existsSync(file)) { res.writeHead(404); return res.end("nf"); }
      try {
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(500); res.end("err");
      }
    });
    srv.listen(PORT, () => resolve(srv));
  });
}

async function run() {
  const srv = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 }, deviceScaleFactor: 2 });

  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector("#kpi-strip .glass", { timeout: 15000 });
    await page.waitForSelector("#fund-list .glass", { timeout: 15000 });
    await page.waitForTimeout(1200); // count-up + icons settle

    // Log live DOM numbers for verification.
    const updated = await page.textContent("#meta-updated");
    const kpis = await page.$$eval("#kpi-strip [data-count]", (els) => els.map((e) => e.textContent));
    const fundCards = await page.$$eval("#fund-list > div", (els) => els.length);
    console.log(`Updated badge: ${updated}`);
    console.log(`KPI numbers: ${JSON.stringify(kpis)}`);
    console.log(`By Fund cards rendered: ${fundCards}`);

    // By Fund: expand the top two funds, then screenshot.
    const heads = await page.$$("#fund-list [data-fund-toggle]");
    if (heads[0]) await heads[0].click();
    if (heads[1]) await heads[1].click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, "dash-byfund.png"), fullPage: true });
    console.log("→ dash-byfund.png");

    // By Fund with a search term.
    await page.fill("#fund-search", "sapphire");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, "dash-byfund-search.png"), fullPage: true });
    console.log("→ dash-byfund-search.png");
    await page.fill("#fund-search", "");

    // Recent Flags tab.
    await page.click('[data-tab="flags"]');
    await page.waitForSelector("#flags-list .glass", { timeout: 10000 });
    await page.waitForTimeout(500);
    const flagCards = await page.$$eval("#flags-list .glass", (els) => els.length);
    console.log(`Recent Flags cards rendered: ${flagCards}`);
    await page.screenshot({ path: join(OUT, "dash-flags.png"), fullPage: true });
    console.log("→ dash-flags.png");

    console.log("─".repeat(50));
    if (errors.length) {
      console.error(`CONSOLE ERRORS (${errors.length}):`);
      errors.forEach((e) => console.error("  " + e));
      process.exitCode = 1;
    } else {
      console.log("No console errors. ✓");
    }
  } finally {
    await browser.close();
    srv.close();
  }
}

run().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
