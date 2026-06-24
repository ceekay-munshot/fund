// newspaper.js — Fund Tracker — MGA · "Get Insight" → the MUNSHOT NEWSPAPER
// ---------------------------------------------------------------------------
// One click builds a long, colorful, plain-English newspaper PDF that mines the whole
// dashboard: who the funds are watching, where consensus is forming, which sectors are
// hot, what's gaining/losing attention, and what management is promising. Written so a
// total newcomer understands every number.
//
// Mechanism: build fixed A4 pages (794×1123px) as DOM, render charts to PNG via ECharts,
// then html2canvas + jsPDF (unpkg) → real .pdf download. No print dialog.
// ---------------------------------------------------------------------------

import { loadData, fundColor, sectorColor, escapeHtml, fmtDate } from "./ui.js";

const PAGE_W = 794, PAGE_H = 1123;
const INK = "#16161D", CREAM = "#FAF6EE";
const C = { indigo: "#6366F1", emerald: "#10b981", rose: "#f43f5e", amber: "#f59e0b", violet: "#7C3AED", pink: "#DB2777", slate: "#64748b" };

// ---- small utilities ------------------------------------------------------
const esc = (s) => escapeHtml(s == null ? "" : String(s));
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const median = (arr) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const QMON = { 1: "Jan–Mar", 2: "Apr–Jun", 3: "Jul–Sep", 4: "Oct–Dec" };
const qKey = (d) => { const y = d.slice(0, 4), m = +d.slice(5, 7); return `${y}-Q${Math.floor((m - 1) / 3) + 1}`; };
const qLabel = (k) => { const [y, q] = k.split("-Q"); return `${QMON[+q]} ${y}`; };

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load failed: " + src)); document.head.appendChild(s); });
}
async function ensureLibs() {
  if (!window.html2canvas) await loadScript("https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js");
  if (!(window.jspdf && window.jspdf.jsPDF)) await loadScript("https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js");
}
async function ensureFonts() {
  if (!document.getElementById("np-fonts")) {
    const l = document.createElement("link"); l.id = "np-fonts"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Newsreader:ital,opt@0,7..72;1,7..72&family=Fraunces:opt,wght@9..144,600;9..144,900&family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@500;700&display=swap";
    document.head.appendChild(l);
  }
  try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3500))]); } catch { /* fallback to system serifs */ }
}

// ---- ECharts → PNG --------------------------------------------------------
async function chartPNG(option, w, h) {
  if (!window.echarts) return null;
  const d = document.createElement("div");
  d.style.cssText = `width:${w}px;height:${h}px;position:absolute;left:-99999px;top:0;`;
  document.body.appendChild(d);
  const ch = window.echarts.init(d, null, { renderer: "canvas" });
  ch.setOption(option);
  await new Promise((r) => setTimeout(r, 80));
  const url = ch.getDataURL({ pixelRatio: 2, backgroundColor: CREAM });
  ch.dispose(); d.remove();
  return url;
}
const barOpt = (cats, vals, colors, horizontal = true) => ({
  animation: false, grid: { left: horizontal ? 150 : 40, right: 24, top: 12, bottom: horizontal ? 12 : 60 },
  xAxis: horizontal ? { type: "value", axisLabel: { color: C.slate, fontSize: 12 }, splitLine: { lineStyle: { color: "#e7e0d2" } } }
    : { type: "category", data: cats, axisLabel: { color: INK, fontSize: 12, rotate: 30, interval: 0 } },
  yAxis: horizontal ? { type: "category", data: cats, inverse: true, axisLabel: { color: INK, fontSize: 13, fontWeight: 600 }, axisLine: { show: false }, axisTick: { show: false } }
    : { type: "value", axisLabel: { color: C.slate, fontSize: 12 }, splitLine: { lineStyle: { color: "#e7e0d2" } } },
  series: [{ type: "bar", data: vals.map((v, i) => ({ value: v, itemStyle: { color: colors[i] || C.indigo, borderRadius: horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0] } })),
    label: { show: true, position: horizontal ? "right" : "top", color: INK, fontFamily: "JetBrains Mono", fontWeight: 700, fontSize: 12 }, barWidth: "62%" }],
});

// ---- data crunch ----------------------------------------------------------
function crunch(DATA) {
  const S = DATA.sightings || [];
  const funds = new Map();
  for (const f of DATA.funds || []) funds.set(f.id, { id: f.id, name: f.name, companies: new Set(), sightings: 0, occ: 0, sectors: new Map() });
  for (const s of S) {
    let f = funds.get(s.fund_id); if (!f) { f = { id: s.fund_id, name: s.fund_name, companies: new Set(), sightings: 0, occ: 0, sectors: new Map() }; funds.set(s.fund_id, f); }
    f.companies.add(s.company); f.sightings++; f.occ += s.occurrences || 1;
    const sec = s.sector || "Unknown"; if (sec !== "Unknown") f.sectors.set(sec, (f.sectors.get(sec) || 0) + 1);
  }
  const cos = new Map();
  for (const s of S) {
    let c = cos.get(s.company); if (!c) { c = { company: s.company, ticker: s.ticker, sector: s.sector, funds: new Set(), sightings: 0, last: "" }; cos.set(s.company, c); }
    c.funds.add(s.fund_id); c.sightings++; if ((s.concall_date || "") > c.last) c.last = s.concall_date;
  }
  const secs = new Map();
  for (const s of S) { const k = s.sector || "Unknown"; if (k === "Unknown") continue; let x = secs.get(k); if (!x) { x = { sector: k, sightings: 0, funds: new Set(), companies: new Set() }; secs.set(k, x); } x.sightings++; x.funds.add(s.fund_id); x.companies.add(s.company); }
  const q = new Map(); const qsec = new Map();
  for (const s of S) { if (!s.concall_date) continue; const k = qKey(s.concall_date); q.set(k, (q.get(k) || 0) + 1); }
  const dates = S.map((s) => s.concall_date).filter(Boolean).sort();
  const fundArr = [...funds.values()];
  const coArr = [...cos.values()];
  const secArr = [...secs.values()];
  return {
    S, funds, cos, secs, q, fundArr, coArr, secArr,
    span: dates.length ? [dates[0], dates[dates.length - 1]] : ["", ""],
    meta: DATA.meta || {}, trends: DATA.trends || { dropped: [], gained: [] }, guidance: (DATA.guidance && DATA.guidance.companies) || {},
  };
}

// ---- layout helpers (return HTML strings) ---------------------------------
const band = (kicker, title, color = C.indigo) =>
  `<div class="np-band"><span class="np-kicker" style="background:${color}">${esc(kicker)}</span><h2 class="np-h2">${esc(title)}</h2><div class="np-rule" style="background:${color}"></div></div>`;
const takeaway = (txt, color = C.emerald) =>
  `<div class="np-take" style="border-color:${color}"><span style="color:${color}">What this means →</span> ${esc(txt)}</div>`;
function table(headers, rows, opts = {}) {
  const al = opts.align || headers.map(() => "left");
  const th = headers.map((h, i) => `<th style="text-align:${al[i]}">${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${al[i]}" class="${i === 0 ? "np-td-name" : ""}">${c}</td>`).join("")}</tr>`).join("");
  return `<table class="np-tbl ${opts.cls || ""}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}
const chip = (txt, col) => `<span class="np-chip" style="background:${col}22;color:${col}">${esc(txt)}</span>`;
const rank = (i) => `<span class="np-rank">${i}</span>`;

// ===========================================================================
// THE EDITION — array of page HTML strings
// ===========================================================================
async function buildPages(X) {
  const pages = [];
  const issue = (X.meta.generated_at || new Date().toISOString()).slice(0, 10);
  const spanTxt = X.span[0] ? `${fmtDate(X.span[0])} – ${fmtDate(X.span[1])}` : "the last four quarters";
  const totalFunds = X.meta.fund_count || X.funds.size;
  const activeFunds = X.fundArr.filter((f) => f.sightings > 0).length;

  // ---- common sorts
  const byFundCompanies = [...X.fundArr].sort((a, b) => b.companies.size - a.companies.size || b.sightings - a.sightings);
  const byFundEng = [...X.fundArr].sort((a, b) => b.sightings - a.sightings);
  const byCoFunds = [...X.coArr].sort((a, b) => b.funds.size - a.funds.size || b.sightings - a.sightings);
  const bySector = [...X.secArr].sort((a, b) => b.sightings - a.sightings);
  const quarters = [...X.q.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const consensus = byCoFunds.filter((c) => c.funds.size >= 2);
  const topCo = byCoFunds[0];
  const topSector = bySector[0];
  const medCompanies = median(X.fundArr.filter((f) => f.sightings > 0).map((f) => f.companies.size));

  // ---------- PAGE 1 — FRONT ----------
  const heroPNG = await chartPNG(barOpt(
    bySector.slice(0, 9).map((s) => s.sector),
    bySector.slice(0, 9).map((s) => s.sightings),
    bySector.slice(0, 9).map((s) => sectorColor(s.sector))
  ), 700, 300);

  const leadHeadline = topCo
    ? `${topCo.funds.size} smart-money funds are circling ${topCo.company}`
    : "Smart money fans out across the market";
  const leadBody = `
    <p><span class="np-drop">A</span> single number tells the story of this edition: <b>${X.meta.sighting_count || X.S.length}</b> times over the past year, one of India's sharp, independent investment funds turned up on a company's earnings call — the quarterly meeting where a company explains its results and answers analysts' questions. We track <b>${totalFunds}</b> such funds. When several of them show up on the <i>same</i> company's call, that company is getting unusual attention from people who do this for a living.</p>
    <p>The most-watched name right now is <b>${esc(topCo ? topCo.company : "—")}</b>${topCo && topCo.ticker ? ` (${esc(topCo.ticker)})` : ""}, where <b>${topCo ? topCo.funds.size : 0}</b> different funds appeared — far above the typical company, which draws just one or two. ${topCo && topCo.sector ? `It sits in <b>${esc(topCo.sector)}</b>, ` : ""}and that crowd of independent buyers asking questions is a classic early sign of conviction building.</p>
    <p>Zoom out and the busiest hunting ground is <b>${esc(topSector ? topSector.sector : "—")}</b>, which drew <b>${topSector ? topSector.sightings : 0}</b> of all fund appearances across <b>${topSector ? topSector.companies.size : 0}</b> companies — more than any other part of the market. The busiest fund of all, <b>${esc(byFundCompanies[0] ? byFundCompanies[0].name : "—")}</b>, has been seen on <b>${byFundCompanies[0] ? byFundCompanies[0].companies.size : 0}</b> different companies' calls.</p>
    <p class="np-note">A word of caution, in plain terms: showing up on a call means a fund is <i>interested</i> and doing homework — it is <b>not</b> proof they bought the stock. Read this as a map of attention, not a list of holdings.</p>`;

  const byNumbers = `
    <div class="np-side" style="border-color:${C.indigo}">
      <div class="np-side-h" style="color:${C.indigo}">BY THE NUMBERS</div>
      ${[
        ["Funds we track", totalFunds, "the independent investors we follow"],
        ["Funds actually seen", activeFunds, "turned up on ≥1 call this year"],
        ["Companies covered", X.meta.company_count || X.cos.size, "where ≥1 fund appeared"],
        ["Total appearances", X.meta.sighting_count || X.S.length, "fund-on-a-call events"],
        ["Calls read", X.meta.concalls_scanned || "—", "earnings-call transcripts scanned"],
        ["Most funds on one name", topCo ? topCo.funds.size : 0, esc(topCo ? topCo.company : "")],
        ["Typical fund's reach", medCompanies, "companies (the middle fund)"],
      ].map(([k, v, sub]) => `<div class="np-stat"><span class="np-stat-v">${typeof v === "number" ? v.toLocaleString("en-IN") : esc(v)}</span><span class="np-stat-k">${esc(k)}</span><span class="np-stat-sub">${sub}</span></div>`).join("")}
    </div>`;

  const jargon = `
    <div class="np-side" style="border-color:${C.amber}">
      <div class="np-side-h" style="color:${C.amber}">JARGON BUSTER</div>
      ${[
        ["Fund (buy-side)", "A firm that invests money for clients and picks stocks for a living."],
        ["Earnings call / concall", "A quarterly phone meeting where a company explains results and takes analysts' questions."],
        ["Appearance / sighting", "One time a fund's analyst spoke up on a company's call — our core signal."],
        ["Consensus name", "A company several funds are watching at once — crowd interest."],
        ["Forward guidance", "What management says about the FUTURE — sales, profit margins, spending plans."],
      ].map(([t, d]) => `<div class="np-jb"><b>${esc(t)}:</b> ${esc(d)}</div>`).join("")}
    </div>`;

  pages.push(`
  <div class="np-page">
    <div class="np-nameplate">
      <div class="np-plate-rule"></div>
      <div class="np-masthead">MUNSHOT NEWSPAPER</div>
      <div class="np-tagline">Where India's smart money is paying attention — explained for everyone</div>
      <div class="np-dateline"><span>MUMBAI</span><span>${esc(spanTxt)}</span><span>VOL. 1, NO. 1</span><span>SMART-MONEY CHRONICLE</span></div>
    </div>
    <div class="np-front">
      <div class="np-front-main">
        <div class="np-kicker" style="background:${C.rose}">LEAD STORY · THE BIG PICTURE</div>
        <h1 class="np-lead">${esc(leadHeadline)}</h1>
        <div class="np-deck">A year of earnings calls, decoded: who the professionals keep showing up for, the sectors pulling them in, and what it signals — in plain English.</div>
        <div class="np-byline">By the Munshot Desk · An automated insight digest</div>
        <div class="np-cols-2">${leadBody}</div>
        <div class="np-hero">${heroPNG ? `<img src="${heroPNG}" style="width:100%;display:block"/>` : ""}</div>
        ${takeaway(`${esc(topSector ? topSector.sector : "The top sector")} is where funds are spending most of their attention right now. Taller bar = more fund appearances in that part of the market.`, sectorColor(topSector ? topSector.sector : null))}
      </div>
      <div class="np-front-side">
        ${byNumbers}
        ${jargon}
        <div class="np-teasers">
          <div class="np-teaser-h">INSIDE THIS EDITION</div>
          <div class="np-teaser">Most-followed companies · p3</div>
          <div class="np-teaser">Busiest & quietest funds · p4</div>
          <div class="np-teaser">Sector-by-sector tour · p5</div>
          <div class="np-teaser">Gaining & losing attention · p6–7</div>
          <div class="np-teaser">Management's promises · p8</div>
          <div class="np-teaser">Spotlights & watch list · p9–10</div>
        </div>
      </div>
    </div>
  </div>`);

  // ---------- PAGE 2 — THE BIG PICTURE (KPIs + quarterly trend) ----------
  const qPNG = await chartPNG(barOpt(quarters.map(([k]) => qLabel(k)), quarters.map(([, v]) => v), quarters.map(() => C.violet), false), 700, 300);
  const firstInterest = X.S.filter((s) => s.first_seen && s.concall_date && s.first_seen.slice(0, 10) === s.concall_date).length; // proxy not exact; show counts differently
  const singleFundCos = X.coArr.filter((c) => c.funds.size === 1).length;
  pages.push(`
  <div class="np-page">
    ${band("ORIENTATION", "The big picture — what this paper measures, and how to read it", C.violet)}
    <div class="np-cols-2 np-body">
      <p><span class="np-drop">T</span>hink of this paper as a giant attendance register for India's stock market. Every quarter, listed companies hold an "earnings call" — a public phone meeting to discuss results. Professional investors dial in and ask questions. We listen to those calls, recognise <b>${totalFunds}</b> respected independent funds by name, and note every time one of them speaks up. Each such note is an <b>appearance</b>.</p>
      <p>Why care? Because these funds are selective. When their analysts spend time on a company's call, it usually means the company is on their research list. One fund is a flicker of interest. Several funds on the same name is a <b>crowd</b> — and crowds of smart, independent buyers are worth knowing about early.</p>
      <p>Across the period <b>${esc(spanTxt)}</b>, we logged <b>${(X.meta.sighting_count || X.S.length).toLocaleString("en-IN")}</b> appearances across <b>${(X.meta.company_count || X.cos.size).toLocaleString("en-IN")}</b> companies. Of those companies, <b>${consensus.length}</b> drew two or more funds (the interesting "crowd" cases), while <b>${singleFundCos}</b> drew just one — a long tail of single-fund curiosity.</p>
      <p>The chart on the right shows appearances by quarter. It is shaped partly by the calendar — most companies report results in the weeks after each quarter ends — so the busy bars are India's results seasons. The steadiness across quarters tells you funds keep showing up all year, not just once.</p>
      <p class="np-note">Remember the golden rule of this paper: we measure <b>attention</b> (who turned up), not <b>ownership</b> (who bought). It is a leading clue, gathered straight from public transcripts.</p>
    </div>
    <div class="np-hero" style="margin-top:10px">${qPNG ? `<img src="${qPNG}" style="width:100%;display:block"/>` : ""}</div>
    ${takeaway("Each bar is one three-month window. The tall bars are results season, when most earnings calls happen — that's when fund attention spikes.", C.violet)}
    <div class="np-2col-tables">
      <div>${band("AT A GLANCE", "The market in five facts", C.emerald)}
        ${table(["Fact", "Value"], [
          ["Sectors with fund attention", `<b>${X.secs.size}</b>`],
          ["Busiest sector", `${esc(topSector ? topSector.sector : "—")}`],
          ["Most-crowded company", `${esc(topCo ? topCo.company : "—")} (${topCo ? topCo.funds.size : 0})`],
          ["Companies with a 2+ fund crowd", `<b>${consensus.length}</b>`],
          ["Quarters of history", `<b>${quarters.length}</b>`],
        ], { align: ["left", "right"] })}
      </div>
      <div>${band("HOW TO READ", "Three habits", C.amber)}
        <div class="np-howto"><b>1. Count the crowd.</b> More funds on a name = stronger shared interest.</div>
        <div class="np-howto"><b>2. Watch the change.</b> A fund newly appearing, or going quiet, is the real signal (pages 6–7).</div>
        <div class="np-howto"><b>3. Check the words.</b> What management promised about the future is on page 8.</div>
      </div>
    </div>
  </div>`);

  // ---------- PAGE 3 — MOST-FOLLOWED COMPANIES ----------
  {
    const rows = byCoFunds.slice(0, 28).map((c, i) => [rank(i + 1), `${esc(c.company)}${c.ticker ? ` <span class="np-tick">${esc(c.ticker)}</span>` : ""}`, c.sector ? chip(c.sector, sectorColor(c.sector)) : "—", `<b>${c.funds.size}</b>`, c.sightings, fmtDate(c.last)]);
    pages.push(`
    <div class="np-page">
      ${band("LEAGUE TABLE · DEMAND", "The most-followed companies — where the crowd is thickest", C.indigo)}
      <div class="np-lead-in">These are the companies the most <b>different</b> funds showed up for. A high "Funds" count means many independent investors are researching the same name at once — the strongest form of the signal in this paper.</div>
      ${table(["#", "Company", "Sector", "Funds", "Appearances", "Latest call"], rows, { align: ["left", "left", "left", "right", "right", "right"], cls: "np-tbl-zebra" })}
      ${takeaway(`${esc(topCo ? topCo.company : "The leader")} tops the table with ${topCo ? topCo.funds.size : 0} funds — that's ${topCo ? topCo.funds.size : 0} separate professional teams interested in one company. The further down the list, the smaller the crowd.`, C.indigo)}
    </div>`);
  }

  // ---------- PAGE 4 — BUSIEST & QUIETEST FUNDS ----------
  {
    const fundPNG = await chartPNG(barOpt(byFundCompanies.slice(0, 10).map((f) => f.name), byFundCompanies.slice(0, 10).map((f) => f.companies.size), byFundCompanies.slice(0, 10).map((f) => fundColor(f.id))), 700, 300);
    const topRows = byFundCompanies.slice(0, 14).map((f, i) => [rank(i + 1), esc(f.name), `<b>${f.companies.size}</b>`, f.sightings, [...f.sectors.entries()].sort((a, b) => b[1] - a[1])[0] ? esc([...f.sectors.entries()].sort((a, b) => b[1] - a[1])[0][0]) : "—"]);
    const quiet = byFundCompanies.filter((f) => f.sightings === 0).map((f) => f.name);
    const lowRows = byFundEng.filter((f) => f.sightings > 0).slice(-8).reverse().map((f) => [esc(f.name), f.companies.size, f.sightings]);
    pages.push(`
    <div class="np-page">
      ${band("LEAGUE TABLE · ACTIVITY", "The busiest funds — and the quiet ones", C.pink)}
      <div class="np-lead-in">"Reach" = how many different companies a fund has been seen on. A wide reach means the fund casts a broad net; a narrow reach can mean a focused, high-conviction style.</div>
      <div class="np-hero">${fundPNG ? `<img src="${fundPNG}" style="width:100%;display:block"/>` : ""}</div>
      ${takeaway(`${esc(byFundCompanies[0] ? byFundCompanies[0].name : "The leader")} has the widest reach — seen on ${byFundCompanies[0] ? byFundCompanies[0].companies.size : 0} different companies' calls. Longer bar = broader net.`, C.pink)}
      <div class="np-2col-tables">
        <div>${band("WIDEST REACH", "Top 14 by companies followed", C.indigo)}
          ${table(["#", "Fund", "Cos", "Appears", "Top sector"], topRows, { align: ["left", "left", "right", "right", "left"] })}
        </div>
        <div>${band("FEWEST", "Least-active funds (still on the board)", C.slate)}
          ${table(["Fund", "Cos", "Appears"], lowRows, { align: ["left", "right", "right"] })}
          ${quiet.length ? `<div class="np-box" style="border-color:${C.amber}"><b>Not yet seen (${quiet.length}):</b> ${esc(quiet.slice(0, 12).join(", "))}${quiet.length > 12 ? "…" : ""}. These funds we track but haven't caught on a call in this window — either they ask few questions publicly, or our coverage hasn't reached their names yet.</div>` : ""}
        </div>
      </div>
    </div>`);
  }

  // ---------- PAGE 5 — SECTORS ----------
  {
    const rows = bySector.map((s, i) => [rank(i + 1), chip(s.sector, sectorColor(s.sector)), `<b>${s.sightings}</b>`, s.companies.size, s.funds.size, pct(s.sightings, X.S.length) + "%"]);
    // leader per top sectors
    const leadByCo = (sec) => { const list = X.coArr.filter((c) => (c.sector || "") === sec).sort((a, b) => b.funds.size - a.funds.size)[0]; return list ? `${esc(list.company)} (${list.funds.size} funds)` : "—"; };
    const spotlights = bySector.slice(0, 6).map((s) => `<div class="np-howto"><b style="color:${sectorColor(s.sector)}">${esc(s.sector)}.</b> ${s.sightings} appearances across ${s.companies.size} companies; ${s.funds.size} funds active. Crowd favourite: ${leadByCo(s.sector)}.</div>`).join("");
    pages.push(`
    <div class="np-page">
      ${band("SECTOR TOUR", "Where the attention is concentrated, sector by sector", C.emerald)}
      <div class="np-lead-in">A "sector" is a slice of the market grouped by business type (banks, chemicals, autos, and so on). This table ranks them by total fund appearances, so you can see which corners of the market the professionals are combing through hardest.</div>
      ${table(["#", "Sector", "Appearances", "Companies", "Funds", "Share"], rows, { align: ["left", "left", "right", "right", "right", "right"], cls: "np-tbl-zebra" })}
      ${takeaway(`The top sector, ${esc(topSector ? topSector.sector : "—")}, alone accounts for ${pct(topSector ? topSector.sightings : 0, X.S.length)}% of all fund attention. "Share" shows each sector's slice of the total.`, C.emerald)}
      ${band("SECTOR SPOTLIGHTS", "The crowd favourite in each leading sector", C.violet)}
      <div class="np-spotlist">${spotlights}</div>
    </div>`);
  }

  // ---------- PAGE 6 — NEW INTEREST (gained) ----------
  {
    const g = (X.trends.gained || []).slice(0, 30).map((x, i) => [rank(i + 1), esc(x.fund_name), `${esc(x.company)}${x.ticker ? ` <span class="np-tick">${esc(x.ticker)}</span>` : ""}`, x.sector ? chip(x.sector, sectorColor(x.sector)) : "—", fmtDate(x.latest_call_date)]);
    pages.push(`
    <div class="np-page">
      ${band("MOVERS · ATTENTION GAINED", "New interest — funds showing up for the first time", C.emerald)}
      <div class="np-lead-in">This is fresh attention: a fund that had <b>not</b> been on a company's earlier calls, but turned up on the most recent one. New eyes on a name can be the very start of a position — worth watching.</div>
      ${g.length ? table(["#", "Fund", "Company", "Sector", "First seen on call"], g, { align: ["left", "left", "left", "left", "right"], cls: "np-tbl-zebra" })
        : `<div class="np-box">No brand-new fund engagements detected in the latest calls yet.</div>`}
      ${takeaway(`${(X.trends.gained || []).length} fresh fund-company engagements appeared on the latest round of calls. Each row is a fund paying attention to a company it had ignored before.`, C.emerald)}
    </div>`);
  }

  // ---------- PAGE 7 — LOST INTEREST (dropped) ----------
  {
    const d = (X.trends.dropped || []).slice(0, 30).map((x, i) => [rank(i + 1), esc(x.fund_name), `${esc(x.company)}${x.ticker ? ` <span class="np-tick">${esc(x.ticker)}</span>` : ""}`, x.tier === "strong" ? chip("strong", C.rose) : chip("watch", C.amber), x.prior_calls_attended, fmtDate(x.latest_call_date)]);
    const strong = (X.trends.dropped || []).filter((x) => x.tier === "strong").length;
    pages.push(`
    <div class="np-page">
      ${band("MOVERS · ATTENTION LOST", "Funds that went quiet — a possible cooling of interest", C.rose)}
      <div class="np-lead-in">The flip side: a fund that attended a company's earlier calls but was <b>absent</b> from the most recent one. "Strong" means it had shown up on three or more prior calls before vanishing — a louder signal. Important: going quiet is <b>not</b> proof a fund sold; it only means its analyst stopped asking questions.</div>
      ${d.length ? table(["#", "Fund", "Company", "Signal", "Prior calls", "Latest (absent)"], d, { align: ["left", "left", "left", "left", "right", "right"], cls: "np-tbl-zebra" })
        : `<div class="np-box">No funds have gone quiet on names they used to follow — a healthy sign.</div>`}
      ${takeaway(`${(X.trends.dropped || []).length} fund-company relationships cooled off, ${strong} of them "strong" (the fund had been a regular for 3+ calls). These are the names to double-check.`, C.rose)}
    </div>`);
  }

  // ---------- PAGE 8 — GUIDANCE DIGEST ----------
  {
    const gv = Object.values(X.guidance);
    const withSpec = gv.map((g) => ({ g, spec: (g.guidance || []).filter((i) => i.specificity === "specific").length, total: (g.guidance || []).length }))
      .sort((a, b) => b.spec - a.spec || b.total - a.total);
    const rows = withSpec.slice(0, 16).map((o, i) => [rank(i + 1), `${esc(o.g.company)}${o.g.ticker ? ` <span class="np-tick">${esc(o.g.ticker)}</span>` : ""}`, `<b>${o.spec}</b>`, o.total, fmtDate(o.g.concall_date)]);
    // sample specific statements
    const samples = [];
    for (const o of withSpec) { for (const it of (o.g.guidance || [])) { if (it.specificity === "specific" && samples.length < 7) samples.push({ co: o.g.company, it }); } if (samples.length >= 7) break; }
    const sampleHTML = samples.map((s) => `<div class="np-quote"><b>${esc(s.co)}</b> — <span style="color:${C.emerald}">${esc(s.it.metric)}</span> <span class="np-mono">(${esc(s.it.horizon || "")})</span>: ${esc(s.it.statement)}</div>`).join("");
    const refused = gv.flatMap((g) => (g.refused_to_guide || []).map((r) => ({ co: g.company, r }))).slice(0, 6);
    pages.push(`
    <div class="np-page">
      ${band("IN THEIR OWN WORDS", "What management is promising — forward guidance", C.indigo)}
      <div class="np-lead-in">"Forward guidance" is what a company says about its <b>future</b> — expected sales, profit margins, spending. Our AI reads each company's latest call and flags whether a promise is <span style="color:${C.emerald}"><b>specific</b></span> (a real number/target), <span style="color:${C.amber}"><b>vague</b></span> (just direction), or <span style="color:${C.rose}"><b>refused</b></span> (declined to say). Specific guidance is the most useful — and the most accountable.</div>
      <div class="np-2col-tables">
        <div>${band("MOST SPECIFIC", "Companies giving the clearest targets", C.emerald)}
          ${rows.length ? table(["#", "Company", "Specific", "Total", "Call"], rows, { align: ["left", "left", "right", "right", "right"] }) : `<div class="np-box">Guidance is still being extracted.</div>`}
        </div>
        <div>${band("DECLINED TO GUIDE", "Where management held back", C.rose)}
          ${refused.length ? refused.map((x) => `<div class="np-howto"><b>${esc(x.co)}:</b> ${esc(x.r)}</div>`).join("") : `<div class="np-box">Nothing notable withheld.</div>`}
        </div>
      </div>
      ${band("SPECIFIC PROMISES, VERBATIM-ISH", "A few concrete targets management put on record", C.violet)}
      <div class="np-spotlist">${sampleHTML || `<div class="np-box">Specific targets will appear here as more calls are processed.</div>`}</div>
      ${takeaway(`${gv.length} companies have had their latest call read for guidance so far. A higher "Specific" count means management gave hard numbers you can hold them to next quarter.`, C.indigo)}
    </div>`);
  }

  // ---------- PAGE 9 — FUND SPOTLIGHTS ----------
  {
    const spots = byFundCompanies.filter((f) => f.sightings > 0).slice(0, 6).map((f) => {
      const topSecs = [...f.sectors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const totalSec = [...f.sectors.values()].reduce((a, b) => a + b, 0) || 1;
      const bar = topSecs.map(([s, v]) => `<span style="width:${pct(v, totalSec)}%;background:${sectorColor(s)}"></span>`).join("");
      const names = X.coArr.filter((c) => c.funds.has(f.id)).sort((a, b) => b.funds.size - a.funds.size).slice(0, 5).map((c) => esc(c.company)).join(", ");
      return `<div class="np-spot">
        <div class="np-spot-h"><span class="np-spot-dot" style="background:${fundColor(f.id)}"></span>${esc(f.name)}</div>
        <div class="np-spot-stats"><span><b>${f.companies.size}</b> companies</span><span><b>${f.sightings}</b> appearances</span><span><b>${f.sectors.size}</b> sectors</span></div>
        <div class="np-spot-bar">${bar}</div>
        <div class="np-spot-secs">${topSecs.map(([s, v]) => `${chip(`${s} ${pct(v, totalSec)}%`, sectorColor(s))}`).join(" ")}</div>
        <div class="np-spot-names"><b>Watching:</b> ${names || "—"}</div>
      </div>`;
    }).join("");
    pages.push(`
    <div class="np-page">
      ${band("SPOTLIGHT", "Six funds, up close — their footprint and favourite names", C.violet)}
      <div class="np-lead-in">A closer look at the most active funds: how broad their interest is, which sectors they lean into (the coloured bar shows the mix), and the crowded names they're currently watching.</div>
      <div class="np-spotgrid">${spots}</div>
      ${takeaway("The coloured bar is each fund's sector mix — a quick read on whether a fund spreads across the market or concentrates in a few themes.", C.violet)}
    </div>`);
  }

  // ---------- PAGE 10 — WATCH LIST ----------
  {
    const singles = X.coArr.filter((c) => c.funds.size === 1).sort((a, b) => b.sightings - a.sightings).slice(0, 14)
      .map((c) => [`${esc(c.company)}${c.ticker ? ` <span class="np-tick">${esc(c.ticker)}</span>` : ""}`, c.sector ? chip(c.sector, sectorColor(c.sector)) : "—", fmtDate(c.last)]);
    const strongDrops = (X.trends.dropped || []).filter((x) => x.tier === "strong").slice(0, 12)
      .map((x) => [esc(x.fund_name), esc(x.company), x.prior_calls_attended, fmtDate(x.latest_call_date)]);
    pages.push(`
    <div class="np-page">
      ${band("THE WATCH LIST", "Names and signals worth a second look", C.amber)}
      <div class="np-lead-in">Two lists to keep an eye on. Left: companies where exactly one fund has shown up — early, lonely interest that could become a crowd (or fade). Right: the strongest "cooling" signals, where a long-time follower went quiet.</div>
      <div class="np-2col-tables">
        <div>${band("EARLY & LONELY", "Single-fund interest (could be early)", C.indigo)}
          ${table(["Company", "Sector", "Latest"], singles, { align: ["left", "left", "right"] })}
        </div>
        <div>${band("COOLING OFF", "Strong drop-offs to double-check", C.rose)}
          ${strongDrops.length ? table(["Fund", "Company", "Prior", "Gone since"], strongDrops, { align: ["left", "left", "right", "right"] }) : `<div class="np-box">No strong drop-offs right now.</div>`}
        </div>
      </div>
      ${takeaway("Single-fund names are lottery tickets — most stay quiet, a few turn into crowds. Strong drop-offs are the opposite: someone who cared a lot has stopped showing up.", C.amber)}
    </div>`);
  }

  // ---------- FINAL PAGE — METHODOLOGY + CLOSING ----------
  {
    const topThree = byCoFunds.slice(0, 3).map((c) => `${esc(c.company)} (${c.funds.size})`).join(", ");
    pages.push(`
    <div class="np-page">
      ${band("THE FINE PRINT", "How this paper is made — in plain words", C.slate)}
      <div class="np-cols-2 np-body">
        <p><span class="np-drop">E</span>verything here is built from <b>public earnings-call transcripts</b>. Each quarter, listed Indian companies publish these on the stock exchanges (BSE and NSE). We collect them, read the text, and look for the names (and known aliases) of <b>${totalFunds}</b> independent investment funds. Every match is recorded as one "appearance," with the company, date, sector and the fund involved.</p>
        <p>The <b>forward-guidance</b> pages are produced by an AI model that reads each company's most recent transcript and pulls out statements about the future, tagging each as specific, vague, or refused. AI can misread; treat those pages as a helpful first draft, and check the original transcript before acting.</p>
        <p>This edition covers <b>${esc(spanTxt)}</b> and was generated on <b>${esc(issue)}</b>. It reflects <b>${(X.meta.sighting_count || X.S.length).toLocaleString("en-IN")}</b> appearances across <b>${(X.meta.company_count || X.cos.size).toLocaleString("en-IN")}</b> companies. The headline names this issue: <b>${topThree}</b>.</p>
        <p class="np-note"><b>Honest disclaimer.</b> This paper measures <b>attention</b>, not <b>ownership</b>. A fund appearing on a call means it is researching the company — it is <b>not</b> evidence that the fund bought, holds, or sold any shares. Nothing here is investment advice. Numbers depend on transcripts being published and on name-matching, so coverage is good but not perfect.</p>
      </div>
      ${band("PARTING SHOT", "The one-paragraph summary", C.indigo)}
      <div class="np-body"><p>If you read nothing else: India's independent funds are most crowded around <b>${esc(topCo ? topCo.company : "—")}</b> and most active in <b>${esc(topSector ? topSector.sector : "—")}</b>. ${(X.trends.gained || []).length} fresh interests just appeared and ${(X.trends.dropped || []).length} relationships cooled — the changes, more than the totals, are where tomorrow's stories start.</p></div>
      <div class="np-colophon">
        <div class="np-masthead" style="font-size:30px">MUNSHOT NEWSPAPER</div>
        <div class="np-tagline">Generated automatically by the Fund Tracker dashboard · Source: BSE/NSE earnings-call transcripts via Screener.in · As of ${esc(issue)}</div>
      </div>
    </div>`);
  }

  return pages;
}

// ---- styles (scoped) ------------------------------------------------------
const STYLE = `
#np-stage{position:absolute;left:-99999px;top:0;}
.np-page{width:${PAGE_W}px;height:${PAGE_H}px;background:${CREAM};color:${INK};box-sizing:border-box;padding:38px 40px 48px;font-family:'Newsreader',Georgia,serif;position:relative;overflow:hidden;display:flex;flex-direction:column;}
.np-page *{box-sizing:border-box;}
.np-inner{flex:1;min-height:0;overflow:hidden;transform-origin:top left;}
.np-nameplate{text-align:center;}
.np-plate-rule{height:5px;background:${INK};margin-bottom:6px;}
.np-masthead{font-family:'Playfair Display',serif;font-weight:900;letter-spacing:.5px;font-size:52px;line-height:1;color:${INK};white-space:nowrap;}
.np-tagline{font-family:'Newsreader',serif;font-style:italic;color:#4a4a55;font-size:13px;margin-top:4px;}
.np-dateline{display:flex;justify-content:space-between;border-top:2px solid ${INK};border-bottom:2px solid ${INK};margin-top:8px;padding:4px 2px;font-family:'Space Grotesk',sans-serif;font-size:10.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#33333d;}
.np-front{display:grid;grid-template-columns:1fr 250px;gap:22px;margin-top:14px;}
.np-front-main{display:block;}
.np-front-side{display:flex;flex-direction:column;gap:12px;border-left:2px solid #ddd4c2;padding-left:18px;}
.np-kicker{display:inline-block;color:#fff;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;padding:3px 9px;border-radius:3px;}
.np-lead{font-family:'Fraunces','Playfair Display',serif;font-weight:900;font-size:40px;line-height:1.02;margin:8px 0 6px;letter-spacing:-.5px;}
.np-deck{font-family:'Newsreader',serif;font-style:italic;font-size:15px;color:#3a3a44;line-height:1.35;border-bottom:1px solid #ddd4c2;padding-bottom:8px;}
.np-byline{font-family:'Space Grotesk',sans-serif;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${C.rose};margin:7px 0;}
.np-cols-2{column-count:2;column-gap:18px;column-rule:1px solid #e2dccc;}
.np-body p,.np-cols-2 p{font-size:12.4px;line-height:1.5;text-align:justify;margin:0 0 7px;break-inside:avoid;}
.np-note{background:#fff;border-left:3px solid ${C.rose};padding:7px 9px;font-size:11.6px !important;font-style:italic;color:#444;}
.np-drop{float:left;font-family:'Playfair Display',serif;font-weight:900;font-size:46px;line-height:36px;padding:2px 7px 0 0;color:${C.indigo};}
.np-hero{margin-top:12px;background:#fff;border:1px solid #e2dccc;border-radius:8px;padding:8px;}
.np-take{background:#fff;border-left:4px solid ${C.emerald};border-radius:0 8px 8px 0;padding:8px 11px;font-size:12px;line-height:1.4;margin:9px 0;box-shadow:0 1px 0 #e7e0d2;}
.np-take span{font-family:'Space Grotesk',sans-serif;font-weight:700;}
.np-side{background:#fff;border-top:4px solid ${C.indigo};border-radius:0 0 8px 8px;padding:10px 12px;box-shadow:0 2px 8px -4px rgba(0,0,0,.15);}
.np-side-h{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:11px;letter-spacing:1.5px;margin-bottom:7px;}
.np-stat{display:flex;flex-direction:column;border-bottom:1px dotted #d8d0bf;padding:4px 0;}
.np-stat-v{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:19px;line-height:1;}
.np-stat-k{font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:600;color:#222;}
.np-stat-sub{font-size:10px;color:#777;font-style:italic;}
.np-jb{font-size:11px;line-height:1.35;margin-bottom:5px;border-bottom:1px dotted #e0d8c6;padding-bottom:4px;}
.np-teasers{background:${INK};color:${CREAM};border-radius:8px;padding:11px 13px;}
.np-teaser-h{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:11px;letter-spacing:1.5px;margin-bottom:6px;color:${C.amber};}
.np-teaser{font-size:12px;line-height:1.7;border-bottom:1px solid #2c2c38;}
.np-band{margin:4px 0 10px;}
.np-h2{font-family:'Fraunces','Playfair Display',serif;font-weight:900;font-size:24px;line-height:1.15;margin:6px 0 10px;letter-spacing:-.3px;}
.np-rule{height:3px;width:100%;border-radius:2px;margin-top:2px;}
.np-lead-in{font-family:'Newsreader',serif;font-size:13px;font-style:italic;line-height:1.4;color:#3a3a44;margin-bottom:10px;background:#fff;border:1px solid #e7e0d2;border-left:4px solid ${C.indigo};padding:8px 11px;border-radius:0 6px 6px 0;}
.np-tbl{width:100%;border-collapse:collapse;font-size:11.6px;}
.np-tbl th{font-family:'Space Grotesk',sans-serif;font-size:9.5px;letter-spacing:.8px;text-transform:uppercase;color:#fff;background:${INK};padding:5px 7px;}
.np-tbl td{padding:4.5px 7px;border-bottom:1px solid #e4ddcc;font-family:'JetBrains Mono',monospace;}
.np-td-name{font-family:'Newsreader',serif !important;font-weight:600;font-size:12.5px;}
.np-tbl-zebra tbody tr:nth-child(odd){background:rgba(255,255,255,.55);}
.np-tick{font-family:'JetBrains Mono',monospace;font-size:10px;color:${C.indigo};}
.np-rank{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:${INK};color:#fff;font-family:'JetBrains Mono';font-size:10px;font-weight:700;}
.np-chip{display:inline-block;font-family:'Space Grotesk',sans-serif;font-size:9.5px;font-weight:700;padding:1.5px 7px;border-radius:20px;}
.np-2col-tables{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:8px;}
.np-howto{font-size:12px;line-height:1.4;background:#fff;border:1px solid #e7e0d2;border-radius:6px;padding:7px 9px;margin-bottom:6px;break-inside:avoid;}
.np-box{font-size:11.5px;line-height:1.4;background:#fff;border-left:3px solid ${C.amber};padding:7px 9px;margin-top:7px;border-radius:0 6px 6px 0;}
.np-spotlist .np-howto,.np-spotlist{margin-top:4px;}
.np-quote{font-size:12px;line-height:1.45;background:#fff;border-left:3px solid ${C.emerald};padding:7px 10px;margin-bottom:6px;border-radius:0 6px 6px 0;break-inside:avoid;}
.np-mono{font-family:'JetBrains Mono',monospace;font-size:10.5px;color:#777;}
.np-spotgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.np-spot{background:#fff;border:1px solid #e2dccc;border-radius:8px;padding:11px 12px;break-inside:avoid;}
.np-spot-h{font-family:'Fraunces',serif;font-weight:900;font-size:16px;display:flex;align-items:center;gap:7px;}
.np-spot-dot{width:11px;height:11px;border-radius:50%;}
.np-spot-stats{display:flex;gap:12px;font-size:11px;color:#444;margin:6px 0;font-family:'Space Grotesk',sans-serif;}
.np-spot-bar{display:flex;height:9px;border-radius:5px;overflow:hidden;background:#eee;margin-bottom:6px;}
.np-spot-secs{margin-bottom:6px;line-height:1.9;}
.np-spot-names{font-size:11px;line-height:1.4;color:#333;}
.np-spotlist{display:block;}
.np-colophon{margin-top:18px;text-align:center;border-top:3px double ${INK};padding-top:12px;}
.np-folio{position:absolute;bottom:10px;left:40px;right:40px;display:flex;justify-content:center;font-family:'Space Grotesk',sans-serif;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#9a9282;border-top:1px solid #ddd4c2;padding-top:5px;}
`;

// ---- export ---------------------------------------------------------------
async function exportPDF(stage, count, filename) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "px", format: [PAGE_W, PAGE_H], orientation: "portrait", compress: true });
  const nodes = stage.querySelectorAll(".np-page");
  for (let i = 0; i < nodes.length; i++) {
    const canvas = await window.html2canvas(nodes[i], { scale: 2, backgroundColor: CREAM, useCORS: true, logging: false, width: PAGE_W, height: PAGE_H, windowWidth: PAGE_W, windowHeight: PAGE_H });
    const img = canvas.toDataURL("image/jpeg", 0.93);
    if (i > 0) pdf.addPage([PAGE_W, PAGE_H], "portrait");
    pdf.addImage(img, "JPEG", 0, 0, PAGE_W, PAGE_H);
  }
  pdf.save(filename);
}

// ---- public entry ---------------------------------------------------------
export async function buildNewspaper(onStatus = () => {}) {
  onStatus("Composing your edition…");
  const DATA = await loadData();
  if (!DATA || !DATA.sightings || !DATA.sightings.length) { onStatus(""); alert("No data loaded yet — try again in a moment."); return; }
  await ensureFonts();
  await ensureLibs();

  if (!document.getElementById("np-style")) { const st = document.createElement("style"); st.id = "np-style"; st.textContent = STYLE; document.head.appendChild(st); }

  onStatus("Crunching the numbers & drawing charts…");
  const X = crunch(DATA);
  const pages = await buildPages(X);

  const stage = document.createElement("div"); stage.id = "np-stage"; stage.innerHTML = pages.join("");
  document.body.appendChild(stage);
  await new Promise((r) => setTimeout(r, 160)); // let chart images + layout settle

  // Wrap each page's content in .np-inner, add a folio, then AUTO-FIT: if the content
  // is taller than the page, scale it down (centered) so it never clips or overlaps.
  const pgs = stage.querySelectorAll(".np-page");
  pgs.forEach((pg, i) => {
    const inner = document.createElement("div"); inner.className = "np-inner";
    while (pg.firstChild) inner.appendChild(pg.firstChild);
    pg.appendChild(inner);
    const folio = document.createElement("div"); folio.className = "np-folio";
    folio.textContent = `Munshot Newspaper · Page ${i + 1} of ${pgs.length}`;
    pg.appendChild(folio);
  });
  await new Promise((r) => setTimeout(r, 30));
  pgs.forEach((pg) => {
    const inner = pg.querySelector(".np-inner");
    const avail = inner.clientHeight, need = inner.scrollHeight;
    if (need > avail + 4) {
      const sc = Math.max(0.5, avail / need);
      inner.style.transformOrigin = "top center";
      inner.style.transform = `scale(${sc})`;
    }
  });
  await new Promise((r) => setTimeout(r, 30));

  onStatus("Printing the paper (this takes a few seconds)…");
  const issue = (X.meta.generated_at || new Date().toISOString()).slice(0, 10);
  try {
    await exportPDF(stage, pages.length, `Munshot-Newspaper-${issue}.pdf`);
  } finally {
    stage.remove();
    onStatus("");
  }
}
