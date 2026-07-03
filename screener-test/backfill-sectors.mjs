// backfill-sectors.mjs — creds-free sector/industry backfill via Screener's PUBLIC
// endpoints. The login-based enricher (enrich-sectors.mjs) failed to resolve ~half
// our companies — they ended up with no ticker AND no sector — because it couldn't
// map Screener's abbreviated concall names to a company page. Screener's public
// search API resolves those names, and the public company page carries the
// classification breadcrumb, so we can fill the gaps with no login and no throttle.
//
//   in/out: public/data/fund-sightings.json  (sets sector/industry/ticker per sighting)
//           public/data/company-meta.json     (self-healing name -> meta cache)
//   env: LIMIT     cap companies processed this run (0 = all unresolved). default 0
//        DELAY_MS  polite delay between companies. default 350
//        FRESH=1   re-resolve even companies that already have a sector
// ---------------------------------------------------------------------------

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DATA = join(__dirname, "..", "public", "data");
const SIGHTINGS = join(PUBLIC_DATA, "fund-sightings.json");
const META = join(PUBLIC_DATA, "company-meta.json");

const LIMIT = Number(process.env.LIMIT || 0);
const DELAY_MS = Number(process.env.DELAY_MS || 350);
const FRESH = process.env.FRESH === "1";
const UA = "Mozilla/5.0 (compatible; fund-tracker-mga/1.0)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (p, fb) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fb; } };

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&#38;/g, "&").replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/json" }, signal: ctrl.signal });
      clearTimeout(t);
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.text();
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

// Match Screener's abbreviated concall name to a search result (token-prefix aware,
// so "Aditya Bir. Fas." matches "Aditya Birla Fashion & Retail Ltd").
function normTokens(s) {
  return String(s || "").toLowerCase().replace(/\b(ltd|limited|the|and)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
}
function scoreMatch(query, cand) {
  const q = normTokens(query), c = normTokens(cand);
  if (!q.length) return 0;
  let hits = 0;
  for (const qt of q) if (c.some((ct) => ct.startsWith(qt) || qt.startsWith(ct))) hits++;
  return hits / q.length;
}

async function resolve(name) {
  const js = await fetchText(`https://www.screener.in/api/company/search/?q=${encodeURIComponent(name)}`);
  if (!js) return null;
  let list; try { list = JSON.parse(js); } catch { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  // Best token-match; ties keep Screener's own relevance order (first).
  let best = list[0], bestScore = -1;
  list.forEach((c, i) => { const s = scoreMatch(name, c.name) - i * 1e-3; if (s > bestScore) { bestScore = s; best = c; } });
  if (bestScore < 0.34) return null; // too weak — don't guess wildly
  const url = best.url || "";
  const ticker = (url.match(/\/company\/([^/]+)/) || [])[1] || null;
  return { url, ticker, matchName: best.name };
}

function extractClass(html) {
  const crumbs = [];
  const re = /href="(\/market\/IN[0-9A-Za-z/]*)"[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(html))) {
    const depth = m[1].replace("/market/", "").split("/").filter(Boolean).length;
    crumbs.push({ depth, label: decodeEntities(m[2]) });
  }
  if (!crumbs.length) return { sector: null, industry: null };
  crumbs.sort((a, b) => a.depth - b.depth);
  return { sector: crumbs[0].label || null, industry: crumbs[crumbs.length - 1].label || null };
}

async function main() {
  const store = await readJson(SIGHTINGS, { sightings: [] });
  const metaDoc = await readJson(META, { companies: {} });
  const meta = metaDoc.companies || (metaDoc.companies = {});
  const sightings = store.sightings || [];

  // distinct companies that still need a sector
  const need = [];
  const seen = new Set();
  for (const s of sightings) {
    const c = s.company;
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const cached = meta[c];
    const hasSec = (cached && cached.sector) || s.sector;
    if (FRESH || !hasSec) need.push(c);
  }
  const todo = LIMIT > 0 ? need.slice(0, LIMIT) : need;
  console.log(`Backfill: ${need.length} companies need a sector; processing ${todo.length}${LIMIT ? ` (LIMIT=${LIMIT})` : ""}.`);

  let ok = 0, fail = 0;
  const save = async () => {
    metaDoc.generated_at = metaDoc.generated_at || null;
    metaDoc.companies = meta;
    await writeFile(META, JSON.stringify(metaDoc, null, 2) + "\n", "utf8");
    await writeFile(SIGHTINGS, JSON.stringify(store, null, 2) + "\n", "utf8");
  };

  for (let i = 0; i < todo.length; i++) {
    const name = todo[i];
    const r = await resolve(name);
    if (r && r.url) {
      const html = await fetchText(`https://www.screener.in${r.url}`);
      const cls = html ? extractClass(html) : { sector: null, industry: null };
      if (cls.sector) {
        meta[name] = { ticker: r.ticker || (meta[name] && meta[name].ticker) || null, sector: cls.sector, industry: cls.industry, company_url: `https://www.screener.in${r.url}` };
        // propagate onto every sighting of this company
        for (const s of sightings) if (s.company === name) {
          if (!s.sector) s.sector = cls.sector;
          if (!s.industry) s.industry = cls.industry;
          if (!s.ticker && r.ticker) s.ticker = r.ticker;
        }
        ok++;
        console.log(`  [${i + 1}/${todo.length}] ✓ ${name} → ${cls.sector} · ${cls.industry} (${r.ticker || "?"})`);
      } else { fail++; console.log(`  [${i + 1}/${todo.length}] ∅ ${name} → page had no classification`); }
    } else { fail++; console.log(`  [${i + 1}/${todo.length}] ✗ ${name} → no confident match`); }
    if ((i + 1) % 25 === 0) { await save(); console.log(`  …saved (${ok} ok / ${fail} miss so far)`); }
    await sleep(DELAY_MS);
  }
  await save();
  console.log(`Done. Resolved ${ok}, missed ${fail}. → company-meta.json + fund-sightings.json`);
}

// Best-effort gap-filler: never abort the pipeline over a Screener hiccup.
main().catch((e) => { console.error("backfill-sectors non-fatal error:", e.message); process.exit(0); });
