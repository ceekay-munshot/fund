// write-snapshot.mjs — Fund Tracker — MGA · Daily snapshot trail
// ---------------------------------------------------------------------------
// Reads public/data/fund-sightings.json and writes one small dated snapshot per
// IST day (public/data/snapshots/<YYYY-MM-DD>.json) plus an index manifest, so
// the dashboard can later show how fund interest evolves over time and support
// the quarter-end "patterns / repetitions" view.
//
// Pure JS, no network. Idempotent: same store in → byte-identical snapshot out
// (re-running on the same IST day overwrites today's file, never duplicates).
//
// Run: node screener-test/write-snapshot.mjs
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DATA = join(__dirname, "..", "public", "data");
const STORE_PATH = join(PUBLIC_DATA, "fund-sightings.json");
const SNAP_DIR = join(PUBLIC_DATA, "snapshots");
const INDEX_PATH = join(SNAP_DIR, "index.json");

// Date in IST (Asia/Kolkata), YYYY-MM-DD — Indian market context, consistent dating.
const IST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const istDate = (d) => IST.format(new Date(d));

// Build the snapshot body (everything except generated_at, so we can compare for
// idempotency without the timestamp).
function buildCore(store, today) {
  const sightings = store.sightings || [];

  const companies = new Set();
  const fundMap = new Map(); // fund_id -> { fund_id, fund_name, set<company> }
  const sectorMap = new Map(); // sector -> { sightings, set<company> }

  for (const s of sightings) {
    companies.add(s.company);

    let f = fundMap.get(s.fund_id);
    if (!f) {
      f = { fund_id: s.fund_id, fund_name: s.fund_name, companies: new Set(), sighting_count: 0 };
      fundMap.set(s.fund_id, f);
    }
    f.sighting_count++;
    f.companies.add(s.company);

    const sectorKey = s.sector || "Unknown";
    let sec = sectorMap.get(sectorKey);
    if (!sec) {
      sec = { sector: sectorKey, sighting_count: 0, companies: new Set() };
      sectorMap.set(sectorKey, sec);
    }
    sec.sighting_count++;
    sec.companies.add(s.company);
  }

  const per_fund = [...fundMap.values()]
    .map((f) => ({
      fund_id: f.fund_id,
      fund_name: f.fund_name,
      sighting_count: f.sighting_count,
      company_count: f.companies.size,
      companies: [...f.companies].sort(),
    }))
    .sort((a, b) => b.sighting_count - a.sighting_count || a.fund_name.localeCompare(b.fund_name));

  const per_sector = [...sectorMap.values()]
    .map((s) => ({ sector: s.sector, sighting_count: s.sighting_count, company_count: s.companies.size }))
    .sort((a, b) => b.sighting_count - a.sighting_count || a.sector.localeCompare(b.sector));

  const new_today = sightings
    .filter((s) => s.first_seen && istDate(s.first_seen) === today)
    .map((s) => ({
      fund_name: s.fund_name,
      company: s.company,
      sector: s.sector || "Unknown",
      concall_date: s.concall_date,
    }))
    .sort((a, b) => a.fund_name.localeCompare(b.fund_name) || a.company.localeCompare(b.company));

  return {
    date: today,
    totals: {
      sightings: sightings.length,
      companies: companies.size,
      active_funds: fundMap.size,
    },
    per_fund,
    per_sector,
    new_today,
  };
}

async function run() {
  if (!existsSync(STORE_PATH)) throw new Error(`Store not found: ${STORE_PATH}`);
  await mkdir(SNAP_DIR, { recursive: true });

  const store = JSON.parse(await readFile(STORE_PATH, "utf8"));
  const today = istDate(new Date());
  const core = buildCore(store, today);

  const snapPath = join(SNAP_DIR, `${today}.json`);

  // Idempotency: if today's file already has identical content (ignoring
  // generated_at), preserve its timestamp so the rerun is byte-identical.
  let generatedAt = new Date().toISOString();
  if (existsSync(snapPath)) {
    try {
      const prev = JSON.parse(await readFile(snapPath, "utf8"));
      const { generated_at: _omit, ...prevCore } = prev;
      if (JSON.stringify(prevCore) === JSON.stringify(core)) generatedAt = prev.generated_at;
    } catch {
      /* rewrite */
    }
  }

  const ordered = {
    date: core.date,
    generated_at: generatedAt,
    totals: core.totals,
    per_fund: core.per_fund,
    per_sector: core.per_sector,
    new_today: core.new_today,
  };
  await writeFile(snapPath, JSON.stringify(ordered, null, 2) + "\n", "utf8");

  // Rebuild the index from the snapshot files actually present on disk.
  const files = (await readdir(SNAP_DIR))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const entries = [];
  for (const f of files) {
    try {
      const snap = JSON.parse(await readFile(join(SNAP_DIR, f), "utf8"));
      entries.push({
        date: snap.date,
        sightings: snap.totals?.sightings ?? 0,
        companies: snap.totals?.companies ?? 0,
        active_funds: snap.totals?.active_funds ?? 0,
        new_today_count: (snap.new_today || []).length,
      });
    } catch {
      /* skip unreadable */
    }
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));

  // Preserve index updated_at when the entry list is unchanged (idempotent).
  let updatedAt = new Date().toISOString();
  if (existsSync(INDEX_PATH)) {
    try {
      const prevIdx = JSON.parse(await readFile(INDEX_PATH, "utf8"));
      if (JSON.stringify(prevIdx.snapshots) === JSON.stringify(entries)) updatedAt = prevIdx.updated_at;
    } catch {
      /* rewrite */
    }
  }
  await writeFile(
    INDEX_PATH,
    JSON.stringify({ updated_at: updatedAt, count: entries.length, snapshots: entries }, null, 2) + "\n",
    "utf8"
  );

  console.log(
    `Snapshot ${today}: ${core.totals.sightings} sightings, ${core.totals.companies} companies, ` +
      `${core.totals.active_funds} active funds, ${core.new_today.length} new today. ` +
      `Index now lists ${entries.length} snapshot(s).`
  );
}

run().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
