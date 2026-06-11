# 📡 Fund Tracker — MGA

**Fund Tracker — MGA** tracks which buy-side funds we follow are showing up in Indian company earnings **concalls** (conference calls), sourced from [Screener.in](https://www.screener.in) → Market Pulse → Concalls. When a fund on our watchlist participates in a company's concall (asks a question, appears in the participant list), that's a **smart‑money attention signal** — a *leading indicator of interest, not a confirmed holding* — over a rolling **90‑day window**. The result is a colorful, static analytics dashboard answering: *where is smart money concentrating, who's converging on the same names, and what's new since I last looked?*

> **Honest caveat:** the signal is attention from concall participation, a leading indicator — **not** confirmed positions.

---

## What the dashboard shows

Five tabs, each answering a distinct question:

| Tab | The question it answers |
|---|---|
| **Radar** | The big picture — a Fund × Sector concentration heatmap, sector clustering treemap, and a "highest conviction" glance bar. |
| **Funds** | Per‑fund view — a searchable board of all 13 funds; click a fund to drill into its companies, sector mix, dates, and transcripts. |
| **Sectors** | Where smart money is concentrating by sector — a House View read, a ranked "funds per sector" bar, a sortable table (with trend ▲/▼ and Concentrated/Broad focus), and a sector drill of the top names. |
| **Consensus** | The consensus book — companies ranked into conviction tiers (4+ / 3 / 2 funds), a "conviction building" strip when a new fund just joined a name, fund/sector filters, and a per‑fund evidence drill. |
| **Recent Flags** | The chronological monitoring feed — newest first by discovery date, grouped Today / This week / Earlier, with a **First interest** vs **Repeat** novelty tag and a "first interest only" filter. |

Plus a **KPI strip** (engagements, active funds, companies tracked, concalls scanned) and an **Export** button (full sightings → Excel/CSV).

---

## How it works

One entry point runs the whole pipeline:

```bash
node screener-test/run-pipeline.mjs
```

It chains six steps (each a standalone `.mjs` in `screener-test/`):

1. **`scrape-concalls.mjs`** — logs into Screener, walks the paginated `/concalls/` list, and writes the last‑90‑day concall index (`output/concalls-index.json`).
2. **`scrape-transcripts.mjs`** — fetches each transcript PDF, **defeating BSE/NSE hotlink 403s** via the authenticated browser context with a **per‑host `Referer`** (bseindia.com / nseindia.com) and an **NSE cookie warm‑up** (`page.goto` the NSE home first). PDF → text via **`pdfjs-dist`**. Incremental across runs (skips concalls already in `processed-concalls.json`).
3. **`match-funds.mjs`** — searches each transcript for the 13 funds using **whitespace‑tolerant, word‑bounded alias matching** (so `Niveshaay` still matches `Nivesh aay` from PDF kerning, but `Lucky Investments` doesn't match "unlucky in investments").
4. **`enrich-sectors.mjs`** — visits each sighting company's Screener page for **sector / industry / ticker**, using a committed, self‑healing `company-meta.json` cache (only fetches new/unresolved companies; gentle + capped to avoid throttling).
5. **`build-store.mjs`** — merges results into the committed store. **Dedup key = `fund_id` + `transcript_id`**, rolling **90‑day prune**, monotonic enrichment (never downgrades a resolved sector to null). Idempotent.
6. **`write-snapshot.mjs`** — appends a dated daily snapshot for the time series.

### Env knobs

| Var | Effect |
|---|---|
| `SCREENER_EMAIL` / `SCREENER_PASSWORD` | Screener login (required). |
| `FIRECRAWL_API_KEY` | Optional last‑resort PDF fetch fallback. |
| `LIMIT` | Cap concalls processed (quick tests). `0` = all in window. |
| `FULL=1` | **Full sweep** — ignore the processed‑concalls skip list and reprocess the entire 90‑day window (first run / quarterly refresh). |
| `FORCE=1` | Re‑fetch transcripts even if already on disk. |
| `HEADFUL=1` | Launch a visible browser (debugging). |

---

## Data files (`public/data/`)

The dashboard reads only `./public` (the served site). These committed JSON files are the system's long‑term memory:

| File | What it is |
|---|---|
| `fund-sightings.json` | The canonical store — every sighting `{ fund_id, fund_name, company, ticker, sector, industry, concall_date, occurrences, quote, transcript_url, first_seen }`, rolling 90 days. |
| `funds.json` | The 13 funds (`id`, `name`) for coloring/listing. |
| `metadata.json` | "Last updated" badge fields + counts. |
| `processed-concalls.json` | Cross‑run dedup memory (which concalls we've handled). |
| `company-meta.json` | Cached company → ticker/sector/industry. |
| `snapshots/<YYYY-MM-DD>.json` + `snapshots/index.json` | Daily history for the time series. |

---

## The watchlist

The 13 funds live in **`screener-test/static/funds.json`**, each with a stable `id`, a display `name`, and `aliases[]` (every spelling likely to appear in a transcript). To **add or edit a fund**, add an entry with good aliases and run a `FULL=1` sweep to backfill it.

**Roadmap:**
- Let the client **add a fund from the UI** and auto‑pull its data (planned).
- A periodic **alias‑precision pass** — tighten broad names (e.g. so a fund isn't confused with a similarly‑named broker/company).

---

## Running it locally

```bash
# deps are installed no-save (no package.json / node_modules committed)
npm install playwright@1 cheerio@1 pdfjs-dist --no-save
npx playwright install --with-deps chromium

export SCREENER_EMAIL="you@example.com"
export SCREENER_PASSWORD="••••••••"
# optional: export FIRECRAWL_API_KEY="..."

node screener-test/run-pipeline.mjs          # incremental
FULL=1 node screener-test/run-pipeline.mjs    # full 90-day reprocess
```

---

## Automation (GitHub Actions)

Two scheduled workflows commit fresh data to `main` (with a **rebase‑retry push** so concurrent runs don't clobber each other):

- **`daily-refresh.yml`** — incremental run at **14:23 UTC (19:53 IST)** every evening.
- **`quarterly-sweep.yml`** — **`FULL=1`** 90‑day reprocess at 01:23 UTC on the 1st of Jan/Apr/Jul/Oct.

**Setup:**
1. Add repo secrets **`SCREENER_EMAIL`** and **`SCREENER_PASSWORD`** (optional `FIRECRAWL_API_KEY`) under *Settings → Secrets and variables → Actions*.
2. Trigger **Quarterly full sweep → Run workflow** once for the initial full 90‑day backfill. Daily runs keep it fresh thereafter.

> ⚠️ GitHub disables scheduled workflows after ~60 days of repo inactivity — the daily data commits keep the repo active, so the schedule is self‑sustaining once it starts.

---

## Deployment

Static site served from **`./public`** via **Cloudflare** static assets (`wrangler.jsonc` → `"assets": { "directory": "./public" }`). No build step — Tailwind, Google Fonts, Lucide icons, ECharts, and ExcelJS all load via CDN. If your Cloudflare project auto‑deploys on push to `main`, the daily data commits refresh the live dashboard automatically.

---

*Built as a 12‑step project: scaffold → scrapers → matcher → enrichment → store → orchestrator → snapshots → Actions → dashboard (Radar / Funds / Sectors / Consensus / Recent Flags) → export + docs.*
