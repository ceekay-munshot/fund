// run-pipeline.mjs — Fund Tracker — MGA · Orchestrator
// ---------------------------------------------------------------------------
// Runs the whole pipeline in order, each step as a child process with stdio
// inherited and the current env forwarded (so SCREENER_EMAIL/PASSWORD and
// LIMIT/FULL/HEADFUL pass straight through):
//
//   1. scrape-concalls.mjs     (MUST succeed)
//   2. scrape-transcripts.mjs  (incremental across runs via processed-concalls.json)
//   3. match-funds.mjs
//   4. enrich-sectors.mjs
//   5. build-store.mjs         (MUST succeed)
//   6. write-snapshot.mjs      (ALWAYS runs, non-fatal — daily snapshot trail)
//
// Steps 1–5 exiting non-zero abort the pipeline and report which step failed.
// Per-transcript failures are swallowed inside step 2. Step 6 is non-fatal: the
// core data is already committed by build-store, so a snapshot hiccup won't fail
// the run.
//
// Env knobs:
//   LIMIT   — cap concalls for testing
//   FULL=1  — ignore the processed-concalls skip list → reprocess the whole 4-quarter
//             window (first run / quarterly sweep)
//   HEADFUL=1
//
// Run:
//   SCREENER_EMAIL=... SCREENER_PASSWORD=... node screener-test/run-pipeline.mjs
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");
const PUBLIC_DATA = join(__dirname, "..", "public", "data");

const STEPS = [
  "scrape-concalls.mjs",
  "scrape-transcripts.mjs",
  "match-funds.mjs",
  "enrich-sectors.mjs",
  "build-store.mjs",
];

async function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const startedAt = Date.now();
  const mode = process.env.FULL === "1" || process.env.FORCE === "1" ? "FULL (full 4-quarter sweep)" : "incremental";
  console.log(`Running pipeline in ${mode} mode…`);

  for (const file of STEPS) {
    const name = file.replace(/\.mjs$/, "");
    console.log(`\n${"=".repeat(64)}\n▶ ${name}\n${"=".repeat(64)}`);
    const r = spawnSync(process.execPath, [join(__dirname, file)], {
      stdio: "inherit",
      env: process.env,
    });
    if (r.status !== 0) {
      const why = r.signal ? `signal ${r.signal}` : `exit code ${r.status}`;
      console.error(`\n✗ Pipeline ABORTED — step "${name}" failed (${why}).`);
      process.exit(1);
    }
  }

  // Step 6: daily snapshot trail — ALWAYS run, even on a quiet day. Non-fatal:
  // the core data is already committed by build-store, so a snapshot hiccup must
  // not fail the pipeline.
  console.log(`\n${"=".repeat(64)}\n▶ write-snapshot\n${"=".repeat(64)}`);
  const snap = spawnSync(process.execPath, [join(__dirname, "write-snapshot.mjs")], {
    stdio: "inherit",
    env: process.env,
  });
  if (snap.status !== 0) {
    const why = snap.signal ? `signal ${snap.signal}` : `exit code ${snap.status}`;
    console.error(`⚠ write-snapshot failed (${why}) — non-fatal, core data already committed.`);
  }

  // Consolidated summary read from the resulting files.
  const index = await readJson(join(OUTPUT_DIR, "concalls-index.json"));
  const manifest = await readJson(join(OUTPUT_DIR, "transcripts-manifest.json"));
  const store = await readJson(join(PUBLIC_DATA, "fund-sightings.json"));

  const scanned = index?.count ?? index?.concalls?.length ?? 0;
  const fetched = manifest?.count ?? 0;
  const sightingCount = store?.sighting_count ?? store?.sightings?.length ?? 0;
  const companyCount = store?.company_count ?? 0;
  const ts = store?.generated_at ?? new Date().toISOString();
  // New-this-run sightings carry first_seen == the store's generated_at.
  const newThisRun = (store?.sightings || []).filter((s) => s.first_seen === ts).length;

  console.log(`\n${"=".repeat(64)}`);
  console.log(
    `Pipeline complete — scanned ${scanned} concalls (${fetched} new fetched this run), ` +
      `+${newThisRun} new sightings, store now ${sightingCount} sightings across ${companyCount} companies. ` +
      `Updated at ${ts}.`
  );
  console.log(`(${((Date.now() - startedAt) / 1000).toFixed(0)}s, ${mode} mode)`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
