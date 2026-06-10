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
    await page.waitForSelector("#kpi-strip .card", { timeout: 15000 });
    await page.waitForSelector("#chart-graph canvas", { timeout: 20000 }); // Radar graph rendered
    await page.waitForTimeout(1800); // force layout + count-up settle

    const updated = await page.textContent("#meta-updated");
    const kpis = await page.$$eval("#kpi-strip [data-count]", (els) => els.map((e) => e.textContent));
    console.log(`Updated badge: ${updated}`);
    console.log(`KPI numbers: ${JSON.stringify(kpis)}`);

    // Radar (graph + treemap + timeline).
    await page.screenshot({ path: join(OUT, "dash-radar.png"), fullPage: true });
    console.log("→ dash-radar.png");

    // Click the biggest fund node region is hard; instead emphasize via legend chip.
    const leg = await page.$("#graph-legend [data-leg]");
    if (leg) { await leg.click(); await page.waitForTimeout(900); }
    await page.screenshot({ path: join(OUT, "dash-radar-emphasis.png"), fullPage: true });
    console.log("→ dash-radar-emphasis.png");

    // Funds grid.
    await page.click('[data-tab="funds"]');
    await page.waitForSelector("#funds-grid [data-fund-tile]", { timeout: 10000 });
    await page.waitForTimeout(500);
    const tiles = await page.$$eval("#funds-grid [data-fund-tile]", (els) => els.length);
    console.log(`Fund tiles rendered: ${tiles}`);
    await page.screenshot({ path: join(OUT, "dash-funds.png"), fullPage: true });
    console.log("→ dash-funds.png");

    // Drill panel.
    await page.click("#funds-grid [data-fund-tile]");
    await page.waitForSelector("#drill-donut canvas", { timeout: 8000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, "dash-drill.png"), fullPage: true });
    console.log("→ dash-drill.png");

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
