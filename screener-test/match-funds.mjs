// match-funds.mjs — Fund Tracker — MGA · Matcher
// ---------------------------------------------------------------------------
// Searches each extracted transcript for the 13 watchlist funds (by their
// aliases) and records a "sighting" wherever a fund is found. Reads local files
// only — no network, no login. Pure JS (string matching, no new deps).
//
// THIS STEP does NOT enrich sector/ticker (Prompt 5), does NOT dedup/store into
// public/data (Prompt 6), and does NOT touch the dashboard.
//
// Inputs:
//   screener-test/static/funds.json                 (funds + aliases)
//   screener-test/output/transcripts-manifest.json  (ok transcripts)
//   screener-test/output/transcripts/<id>.txt        (full transcript text)
// Output:
//   screener-test/output/fund-matches.json
//
// Run:
//   node screener-test/match-funds.mjs
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FUNDS_PATH = join(__dirname, "static", "funds.json");
const OUTPUT_DIR = join(__dirname, "output");
const MANIFEST_PATH = join(OUTPUT_DIR, "transcripts-manifest.json");
const TRANSCRIPTS_DIR = join(OUTPUT_DIR, "transcripts");
const MATCHES_PATH = join(OUTPUT_DIR, "fund-matches.json");

const QUOTE_PAD = 70; // chars of context on each side of a match (~160 total)

// --- regex construction ----------------------------------------------------
function escapeRe(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a WHITESPACE-TOLERANT, WORD-BOUNDED regex for one alias (lowercased):
//  - chars within a word are joined by \s* (defeats PDF's injected mid-word space),
//  - the alias's own spaces become \s+ (multi-word names still need a real gap),
//  - (?<![a-z]) / (?![a-z]) guard the ends so we never match inside a larger word.
function buildAliasRegex(alias) {
  const tokens = alias.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const body = tokens
    .map((tok) => [...tok].map(escapeRe).join("\\s*"))
    .join("\\s+");
  return new RegExp(`(?<![a-z])${body}(?![a-z])`, "g");
}

// Precompile every alias regex once.
function compileFunds(funds) {
  return funds.map((f) => ({
    ...f,
    regexes: (f.aliases || [])
      .map((a) => ({ alias: a, re: buildAliasRegex(a) }))
      .filter((x) => x.re),
  }));
}

// --- matching --------------------------------------------------------------
// Find a fund in normalized text. Returns null or
// { matched_alias, occurrences, start, end }.
// Distinct mentions are counted by merging overlapping alias hits (so the
// nested aliases "Niveshaay" + "Niveshaay Investment Advisors" count as one).
function findFund(fund, text) {
  const hits = [];
  for (const { alias, re } of fund.regexes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ start: m.index, end: m.index + m[0].length, alias });
      if (m.index === re.lastIndex) re.lastIndex++; // never loop on a zero-length match
    }
  }
  if (!hits.length) return null;

  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const groups = [];
  for (const h of hits) {
    const last = groups[groups.length - 1];
    if (last && h.start < last.end) {
      last.end = Math.max(last.end, h.end);
      if (h.alias.length > last.bestAlias.length) last.bestAlias = h.alias; // most specific
    } else {
      groups.push({ start: h.start, end: h.end, bestAlias: h.alias });
    }
  }
  const first = groups[0];
  return { matched_alias: first.bestAlias, occurrences: groups.length, start: first.start, end: first.end };
}

// ~160-char quote around a match, trimmed to word edges (text already collapsed).
function makeQuote(text, start, end) {
  let s = Math.max(0, start - QUOTE_PAD);
  let e = Math.min(text.length, end + QUOTE_PAD);
  if (s > 0) {
    const sp = text.indexOf(" ", s);
    if (sp !== -1 && sp < start) s = sp + 1;
  }
  if (e < text.length) {
    const sp = text.lastIndexOf(" ", e);
    if (sp !== -1 && sp > end) e = sp;
  }
  return text.slice(s, e).trim();
}

const normalize = (raw) => raw.toLowerCase().replace(/\s+/g, " ").trim();

// --- self-check (proves the matching logic on synthetic strings) -----------
function runSelfCheck() {
  const cases = [
    {
      name: 'injected-space tolerance: "Niveshaay" ~ "Nivesh aay"',
      alias: "Niveshaay",
      text: "the call was hosted by Nivesh aay Investment Advisors today",
      expect: true,
    },
    {
      name: 'word-boundary guard: "Lucky Investments" !~ "unlucky in investments"',
      alias: "Lucky Investments",
      text: "he got unlucky in investments last year",
      expect: false,
    },
    {
      name: 'clean positive: "2Point2 Capital" ~ "from 2Point2 Capital"',
      alias: "2Point2 Capital",
      text: "a question from 2Point2 Capital on margins",
      expect: true,
    },
    {
      name: 'no substring match: "Astute" !~ "astuteness"',
      alias: "Astute",
      text: "we admire the astuteness of management",
      expect: false,
    },
    {
      name: 'multi-word needs a gap: "Crown Capital" !~ "crowncapital"',
      alias: "Crown Capital",
      text: "visit crowncapitalinc dot com",
      expect: false,
    },
  ];

  let pass = 0;
  console.log("Self-check:");
  for (const c of cases) {
    const re = buildAliasRegex(c.alias);
    const got = re.test(normalize(c.text));
    const ok = got === c.expect;
    if (ok) pass++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name}  (got ${got}, expected ${c.expect})`);
  }
  console.log(`  ${pass}/${cases.length} self-check cases passed.\n`);
  return pass === cases.length;
}

// --- main ------------------------------------------------------------------
async function run() {
  const fundsData = JSON.parse(await readFile(FUNDS_PATH, "utf8"));
  const funds = compileFunds(fundsData.funds || []);

  const selfOk = runSelfCheck();

  const matches = [];
  const perFund = new Map(); // fund_id -> Set(company)
  for (const f of funds) perFund.set(f.id, new Set());

  let scanned = 0;
  if (existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
    const oks = (manifest.transcripts || []).filter((t) => t.ok === true);

    for (const t of oks) {
      const txtPath = join(TRANSCRIPTS_DIR, `${t.id}.txt`);
      if (!existsSync(txtPath)) continue;
      let raw;
      try {
        raw = await readFile(txtPath, "utf8");
      } catch {
        continue;
      }
      if (!raw || !raw.trim()) continue;
      scanned++;

      const text = normalize(raw);
      for (const f of funds) {
        const hit = findFund(f, text);
        if (!hit) continue;
        perFund.get(f.id).add(t.company);
        matches.push({
          fund_id: f.id,
          fund_name: f.name,
          matched_alias: hit.matched_alias,
          company: t.company,
          concall_date: t.concall_date,
          transcript_url: t.transcript_url,
          transcript_id: t.id,
          occurrences: hit.occurrences,
          quote: makeQuote(text, hit.start, hit.end),
        });
      }
    }
  } else {
    console.log(`(no manifest at ${MANIFEST_PATH} — scanned 0 transcripts)`);
  }

  const out = {
    generated_at: new Date().toISOString(),
    transcripts_scanned: scanned,
    match_count: matches.length,
    matches,
  };
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(MATCHES_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");

  // Per-fund summary.
  console.log("Per-fund summary:");
  for (const f of funds) {
    const companies = [...perFund.get(f.id)];
    const label = companies.length ? `${companies.length} companies (${companies.join(", ")})` : "0";
    console.log(`  ${f.name} → ${label}`);
  }
  console.log(`\nTotal sightings: ${matches.length} across ${scanned} transcripts. → ${MATCHES_PATH}`);

  // Show each real sighting with its quote.
  if (matches.length) {
    console.log("\nSightings:");
    for (const m of matches) {
      console.log(`  • ${m.fund_name} in ${m.company} (${m.concall_date}) ×${m.occurrences} [${m.matched_alias}]`);
      console.log(`      "…${m.quote}…"`);
    }
  }

  if (!selfOk) {
    console.error("\nSelf-check FAILED — matching logic regression.");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
