// build-store.mjs — Fund Tracker — MGA · Store / merge step
// ---------------------------------------------------------------------------
// The screener-test/output/ working dir is NOT committed, so every CI run starts
// fresh. The COMMITTED files in public/data/ are the system's long-term memory.
// This step merges THIS run's results into that committed store so the dashboard
// always reads an accumulated, de-duplicated, rolling-90-day set of sightings —
// and so Prompt 7's orchestrator can skip concalls already processed.
//
// Pure JS, no network, no new deps.
//
// Reads:
//   screener-test/output/fund-matches-enriched.json   (this run's sightings)  [required]
//   screener-test/output/transcripts-manifest.json    (concalls processed this run)
//   screener-test/output/concalls-index.json          (this run's 90-day list)
//   screener-test/static/funds.json                   (fund_count)            [required]
//   public/data/fund-sightings.json                   (prior memory; may be placeholder)
//   public/data/processed-concalls.json               (prior dedup memory; optional)
// Writes:
//   public/data/fund-sightings.json
//   public/data/processed-concalls.json
//   public/data/metadata.json
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(__dirname, "output");
const STATIC_DIR = join(__dirname, "static");
const PUBLIC_DATA = join(ROOT, "public", "data");

const ENRICHED_PATH = join(OUTPUT_DIR, "fund-matches-enriched.json");
const MANIFEST_PATH = join(OUTPUT_DIR, "transcripts-manifest.json");
const INDEX_PATH = join(OUTPUT_DIR, "concalls-index.json");
const FUNDS_PATH = join(STATIC_DIR, "funds.json");

const SIGHTINGS_PATH = join(PUBLIC_DATA, "fund-sightings.json");
const PROCESSED_PATH = join(PUBLIC_DATA, "processed-concalls.json");
const META_PATH = join(PUBLIC_DATA, "metadata.json");
const COMPANY_META_PATH = join(PUBLIC_DATA, "company-meta.json");

const WINDOW_DAYS = 90;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function readJsonRequired(path, label) {
  if (!existsSync(path)) throw new Error(`Required input missing: ${label} (${path})`);
  return readJson(path);
}
async function readJsonOptional(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return await readJson(path);
  } catch {
    return fallback;
  }
}

const keyOf = (s) => `${s.fund_id}|${s.transcript_id}`;

async function run() {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoffStr = new Date(now.getTime() - WINDOW_DAYS * 86400000)
    .toISOString()
    .slice(0, 10); // YYYY-MM-DD; concall_date is the same shape, so string compare is safe
  const inWindow = (d) => !d || d >= cutoffStr;

  // --- required inputs -----------------------------------------------------
  const enriched = await readJsonRequired(ENRICHED_PATH, "fund-matches-enriched.json");
  const funds = await readJsonRequired(FUNDS_PATH, "funds.json");
  const fundCount = (funds.funds || []).length;

  // --- optional inputs -----------------------------------------------------
  const manifest = await readJsonOptional(MANIFEST_PATH, { transcripts: [] });
  const index = await readJsonOptional(INDEX_PATH, { concalls: [], count: 0 });
  const priorStore = await readJsonOptional(SIGHTINGS_PATH, { sightings: [] });
  const priorProcessed = await readJsonOptional(PROCESSED_PATH, { concalls: {} });

  // --- 1/2. merge sightings ------------------------------------------------
  // Start from prior memory (keyed), then overlay this run's sightings.
  const store = new Map();
  for (const s of priorStore.sightings || []) store.set(keyOf(s), s);

  let added = 0;
  let refreshed = 0;
  for (const m of enriched.matches || []) {
    // Incoming sightings are always in-window (the concall list is 90-day
    // windowed); guard anyway so a stray stale one is never counted/stored.
    if (!inWindow(m.concall_date)) continue;
    const key = keyOf(m);
    const existing = store.get(key);
    const merged = {
      fund_id: m.fund_id,
      fund_name: m.fund_name,
      matched_alias: m.matched_alias,
      company: m.company,
      // Enrichment only improves: keep a previously-resolved value rather than
      // downgrading it to null if this run's enrich couldn't resolve the company.
      ticker: m.ticker ?? existing?.ticker ?? null,
      sector: m.sector ?? existing?.sector ?? null,
      industry: m.industry ?? existing?.industry ?? null,
      concall_date: m.concall_date,
      transcript_url: m.transcript_url,
      transcript_id: m.transcript_id,
      occurrences: m.occurrences,
      quote: m.quote,
      // first_seen = when WE discovered it; preserved across reruns.
      first_seen: existing ? existing.first_seen : nowIso,
    };
    store.set(key, merged);
    if (existing) refreshed++;
    else added++;
  }

  // --- 3. prune outside the rolling window ---------------------------------
  let pruned = 0;
  for (const [key, s] of store) {
    if (!inWindow(s.concall_date)) {
      store.delete(key);
      pruned++;
    }
  }

  // --- 3b. heal from the persistent company-meta cache ---------------------
  // enrich resolves companies into company-meta.json across runs; apply it to
  // every stored sighting so older sightings gain sector/industry/ticker over
  // time (monotonic — only fills nulls, never downgrades).
  if (existsSync(COMPANY_META_PATH)) {
    try {
      const cache = JSON.parse(await readFile(COMPANY_META_PATH, "utf8")).companies || {};
      for (const s of store.values()) {
        const c = cache[s.company];
        if (!c) continue;
        if (!s.sector && c.sector) s.sector = c.sector;
        if (!s.industry && c.industry) s.industry = c.industry;
        if (!s.ticker && c.ticker) s.ticker = c.ticker;
      }
    } catch {
      /* ignore */
    }
  }

  // --- 4. write fund-sightings.json ----------------------------------------
  const sightings = [...store.values()].sort((a, b) =>
    (b.first_seen || "").localeCompare(a.first_seen || "")
  );
  const companyCount = new Set(sightings.map((s) => s.company)).size;

  await mkdir(PUBLIC_DATA, { recursive: true });
  await writeFile(
    SIGHTINGS_PATH,
    JSON.stringify(
      {
        generated_at: nowIso,
        window_days: WINDOW_DAYS,
        fund_count: fundCount,
        company_count: companyCount,
        sighting_count: sightings.length,
        sightings,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  // --- 5. update processed-concalls.json (dedup memory) --------------------
  const processed = { ...(priorProcessed.concalls || {}) };
  for (const t of manifest.transcripts || []) {
    if (!t.id) continue;
    processed[t.id] = {
      concall_date: t.concall_date ?? null,
      transcript_url: t.transcript_url ?? null,
      processed_at: nowIso,
      ok: t.ok === true,
    };
  }
  // Prune processed entries outside the window.
  for (const [id, p] of Object.entries(processed)) {
    if (!inWindow(p.concall_date)) delete processed[id];
  }
  await writeFile(
    PROCESSED_PATH,
    JSON.stringify(
      { generated_at: nowIso, count: Object.keys(processed).length, concalls: processed },
      null,
      2
    ) + "\n",
    "utf8"
  );

  // --- 6. update metadata.json (dashboard "last updated" badge) ------------
  const concalls = index.concalls || [];
  const concallsScanned = index.count ?? concalls.length;
  const withTranscript = concalls.filter((c) => c.has_transcript).length;
  await writeFile(
    META_PATH,
    JSON.stringify(
      {
        generated_at: nowIso,
        source: "Screener.in — Market Pulse > Concalls (last 90 days)",
        fund_count: fundCount,
        sighting_count: sightings.length,
        company_count: companyCount,
        concalls_scanned: concallsScanned,
        concalls_with_transcript: withTranscript,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  // --- summary -------------------------------------------------------------
  console.log(
    `Merged: +${added} new sightings, ${refreshed} refreshed, ${pruned} pruned. ` +
      `Store now: ${sightings.length} sightings across ${companyCount} companies. ` +
      `Processed memory: ${Object.keys(processed).length} concalls.`
  );
}

run().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
