// analyze-trends.mjs — Fund Tracker — MGA · attention-churn insight
// ---------------------------------------------------------------------------
// Turns the sightings + processed-concalls memory into an "attention shift" view:
// for each company a fund has engaged, did that fund KEEP showing up, or did it go
// quiet on the most recent call? A fund that attended several prior calls and is then
// absent from the latest one is a leading "lost interest / possible exit" signal.
//
// Pure data step — reads only committed JSON, no Screener/login, so it never blocks
// and always runs at the tail of the pipeline.
//
//   in:  public/data/fund-sightings.json, public/data/processed-concalls.json
//   out: public/data/fund-company-trends.json
//
// HONEST CAVEAT (also surfaced on the dashboard): "stopped appearing" = the fund's
// analyst stopped participating on the call — an attention signal, NOT proof they
// sold the position.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DATA = join(__dirname, "..", "public", "data");
const SIGHTINGS_PATH = join(PUBLIC_DATA, "fund-sightings.json");
const PROCESSED_PATH = join(PUBLIC_DATA, "processed-concalls.json");
const TRENDS_PATH = join(PUBLIC_DATA, "fund-company-trends.json");

const MIN_PRIOR = Number(process.env.TRENDS_MIN_PRIOR || 3); // only flag "lost interest" after >= this many prior calls attended, then absent
const stripDate = (id) => id.replace(/_\d{4}-\d{2}-\d{2}$/, "");

async function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}

async function main() {
  const store = await readJson(SIGHTINGS_PATH, { sightings: [] });
  const processedDoc = await readJson(PROCESSED_PATH, { concalls: {} });
  const sightings = store.sightings || [];
  const processed = processedDoc.concalls || {};

  // Company (by slug) → sorted list of all concall dates we actually scanned.
  const callDates = new Map(); // slug -> Set(date)
  for (const [id, meta] of Object.entries(processed)) {
    const d = meta.concall_date;
    if (!d) continue;
    const slug = stripDate(id);
    if (!callDates.has(slug)) callDates.set(slug, new Set());
    callDates.get(slug).add(d);
  }

  // (slug,date) → funds present;  slug → company display meta.
  const fundsOn = new Map();   // `${slug}|${date}` -> Map(fund_id -> fund_name)
  const coMeta = new Map();    // slug -> { company, ticker, sector }
  for (const s of sightings) {
    const slug = stripDate(s.transcript_id || "");
    if (!slug) continue;
    if (!coMeta.has(slug)) coMeta.set(slug, { company: s.company, ticker: s.ticker || null, sector: s.sector || null });
    const k = `${slug}|${s.concall_date}`;
    if (!fundsOn.has(k)) fundsOn.set(k, new Map());
    fundsOn.get(k).set(s.fund_id, s.fund_name);
  }

  const dropped = [];
  const gained = [];
  let consistent = 0, evaluated = 0;

  for (const [slug, meta] of coMeta) {
    const dates = [...(callDates.get(slug) || [])].sort();
    if (dates.length < 2) continue; // need history to judge a shift
    evaluated++;
    const latest = dates[dates.length - 1];
    const prior = dates.slice(0, -1);
    const fundsLatest = fundsOn.get(`${slug}|${latest}`) || new Map();

    // tally each fund's attendance across this company's prior calls
    const priorCount = new Map(); // fund_id -> {name, count, lastSeen}
    for (const d of prior) {
      const fm = fundsOn.get(`${slug}|${d}`);
      if (!fm) continue;
      for (const [fid, fname] of fm) {
        const e = priorCount.get(fid) || { name: fname, count: 0, lastSeen: d };
        e.count++; if (d > e.lastSeen) e.lastSeen = d;
        priorCount.set(fid, e);
      }
    }

    for (const [fid, e] of priorCount) {
      if (fundsLatest.has(fid)) { consistent++; continue; }
      if (e.count < MIN_PRIOR) continue; // weak — ignore (showed up once long ago)
      dropped.push({
        fund_id: fid, fund_name: e.name,
        company: meta.company, ticker: meta.ticker, sector: meta.sector,
        latest_call_date: latest, last_seen_date: e.lastSeen,
        prior_calls_attended: e.count,
        tier: e.count >= 3 ? "strong" : "medium",
      });
    }
    for (const [fid, fname] of fundsLatest) {
      if (!priorCount.has(fid)) gained.push({ fund_id: fid, fund_name: fname, company: meta.company, ticker: meta.ticker, sector: meta.sector, latest_call_date: latest });
    }
  }

  // strongest signals first: most prior calls, then most recent
  dropped.sort((a, b) => b.prior_calls_attended - a.prior_calls_attended || b.latest_call_date.localeCompare(a.latest_call_date));
  gained.sort((a, b) => b.latest_call_date.localeCompare(a.latest_call_date));

  await mkdir(PUBLIC_DATA, { recursive: true });
  const out = {
    generated_at: new Date().toISOString(),
    min_prior_calls: MIN_PRIOR,
    summary: { dropped: dropped.length, gained: gained.length, consistent, companies_evaluated: evaluated },
    dropped, gained,
  };
  await writeFile(TRENDS_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(
    `Attention trends: ${dropped.length} dropped (>=${MIN_PRIOR} prior calls), ${gained.length} new, ` +
      `${consistent} consistent, across ${evaluated} companies. → fund-company-trends.json`
  );
}

main().catch((err) => { console.error("FATAL:", err.message); process.exit(1); });
