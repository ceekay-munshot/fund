# Fund Tracker — MGA

Fund Tracker — MGA is a dashboard that watches Indian buy-side funds and surfaces which company earnings concalls (conference calls) they show up in. It tracks a curated watchlist of funds and flags their appearances in concall transcripts sourced from [Screener.in](https://www.screener.in) (Market Pulse → Concalls), covering a rolling window of the last 3 months plus new concalls as they appear.

**Stack:** Playwright (chromium) + cheerio scrapers (Node ESM `.mjs`) → committed JSON files in `public/data/` → a static Tailwind + vanilla-JS dashboard → deployed to Cloudflare static assets.

Detailed setup and run instructions will be added in a later prompt.
