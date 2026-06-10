// app.js — Fund Tracker — MGA · visual-first dashboard
// ---------------------------------------------------------------------------
// Builds the KPI strip, tab nav, the "Radar" tab (interactive network graph +
// sector treemap + new-sightings timeline) and the "Funds" tab (visual tile
// board + slide-over drill panel). Sectors / Overlap / Recent Flags are styled
// "coming soon" panels filled in Prompt 11, reusing the design system in ui.js.
// ---------------------------------------------------------------------------

import {
  loadData, fundColor, sectorColor, sectorPill, escapeHtml, initials, fmtDate,
  isToday, analystOf, sourceIconBtn, transcriptBtn, quoteBlock, wireShowMore,
  emptyState, countUp, makeChart, resizeCharts, refreshIcons,
} from "./ui.js";

let DATA = null;
const rendered = new Set();
let selectedFund = null; // graph emphasis
let graphData = null; // { nodes, links } for the Radar graph (NOT on the chart instance)

// --- aggregation -----------------------------------------------------------
function groupByFund() {
  const m = new Map();
  for (const f of DATA.funds) m.set(f.id, { id: f.id, name: f.name, sightings: [] });
  for (const s of DATA.sightings) {
    if (!m.has(s.fund_id)) m.set(s.fund_id, { id: s.fund_id, name: s.fund_name, sightings: [] });
    m.get(s.fund_id).sightings.push(s);
  }
  return m;
}
function companiesOf(sightings) {
  const m = new Map();
  for (const s of sightings) {
    const c = m.get(s.company);
    if (!c) m.set(s.company, { ...s, occurrences: s.occurrences || 1 });
    else {
      c.occurrences += s.occurrences || 1;
      if ((s.concall_date || "") > (c.concall_date || "")) Object.assign(c, { concall_date: s.concall_date, quote: s.quote, transcript_url: s.transcript_url, sector: s.sector, industry: s.industry, ticker: s.ticker });
    }
  }
  return [...m.values()].sort((a, b) => (b.concall_date || "").localeCompare(a.concall_date || ""));
}
function sectorMix(sightings) {
  const m = new Map();
  for (const s of sightings) {
    const k = s.sector || "Unknown";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([sector, count]) => ({ sector, count })).sort((a, b) => b.count - a.count);
}
// company -> Set(fund_id) for consensus sizing
function fundsByCompany() {
  const m = new Map();
  for (const s of DATA.sightings) {
    if (!m.has(s.company)) m.set(s.company, new Set());
    m.get(s.company).add(s.fund_id);
  }
  return m;
}

// --- KPI strip -------------------------------------------------------------
function renderKpis() {
  const s = DATA.sightings;
  const activeFunds = new Set(s.map((x) => x.fund_id)).size;
  const fundTotal = DATA.meta.fund_count ?? DATA.funds.length ?? 13;
  const companies = DATA.meta.company_count ?? new Set(s.map((x) => x.company)).size;
  const cards = [
    { label: "Engagements", value: s.length, icon: "radar", grad: "from-indigo-500 to-violet-500" },
    { label: "Active Funds", value: activeFunds, suffix: ` / ${fundTotal}`, icon: "briefcase", grad: "from-emerald-500 to-teal-500", action: "funds" },
    { label: "Companies Tracked", value: companies, icon: "building-2", grad: "from-sky-500 to-blue-500" },
    { label: "Concalls Scanned (90d)", value: DATA.meta.concalls_scanned ?? 0, icon: "file-text", grad: "from-amber-500 to-orange-500" },
  ];
  document.getElementById("kpi-strip").innerHTML = cards
    .map(
      (c) => `
    <div class="card card-hover relative overflow-hidden p-4 sm:p-5 ${c.action ? "cursor-pointer" : ""}" ${c.action ? `data-kpi="${c.action}" role="button" tabindex="0"` : ""}>
      <div class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${c.grad}"></div>
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium uppercase tracking-wide text-slate-400">${c.label}</span>
        <span class="rounded-xl bg-gradient-to-br ${c.grad} p-1.5 text-white shadow-sm"><i data-lucide="${c.icon}" class="h-4 w-4"></i></span>
      </div>
      <div class="mt-3 flex items-end justify-between">
        <div class="font-mono text-3xl font-semibold text-slate-800"><span data-count="${c.value}">0</span><span class="text-lg text-slate-400">${c.suffix || ""}</span></div>
        ${c.action ? `<span class="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">view <i data-lucide="arrow-up-right" class="h-3 w-3"></i></span>` : ""}
      </div>
    </div>`
    )
    .join("");
  document.querySelectorAll("#kpi-strip [data-count]").forEach((el) => countUp(el, Number(el.dataset.count)));
  document.querySelectorAll('#kpi-strip [data-kpi="funds"]').forEach((el) => el.addEventListener("click", openFundsList));
}

// ===========================================================================
// RADAR
// ===========================================================================
function renderRadar() {
  const root = document.getElementById("tab-radar");
  root.innerHTML = `
    <div class="card mb-4 p-4 sm:p-5">
      <div class="mb-1 flex items-center gap-2"><span class="rounded-xl bg-indigo-50 p-1.5 text-indigo-500"><i data-lucide="grid-3x3" class="h-4 w-4"></i></span>
        <h2 class="font-display text-lg font-semibold text-slate-800">Fund × Sector concentration</h2></div>
      <p class="mb-3 text-xs text-slate-400">Showing fund·sector pairs with <b>≥3 engagements</b> — where each fund is really concentrating. Click a row to open the fund.</p>
      <div id="chart-heatmap" class="chart-heat"></div>
    </div>
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="card p-4 sm:p-5">
        <div class="mb-2 flex items-center gap-2"><span class="rounded-xl bg-fuchsia-50 p-1.5 text-fuchsia-500"><i data-lucide="layers" class="h-4 w-4"></i></span>
          <h2 class="font-display text-lg font-semibold text-slate-800">Sector clustering</h2></div>
        <div id="chart-treemap" class="chart-box"></div>
      </div>
      <div class="card p-4 sm:p-5">
        <div class="mb-1 flex items-center gap-2"><span class="rounded-xl bg-amber-50 p-1.5 text-amber-500"><i data-lucide="users" class="h-4 w-4"></i></span>
          <h2 class="font-display text-lg font-semibold text-slate-800">Highest conviction</h2></div>
        <p class="mb-2 text-xs text-slate-400">Companies on <b>2+ funds'</b> radar — where smart money overlaps.</p>
        <div id="chart-consensus" class="chart-box"></div>
      </div>
    </div>`;

  if (!window.echarts) {
    for (const id of ["chart-heatmap", "chart-treemap", "chart-consensus"]) {
      const c = document.getElementById(id);
      if (c) c.innerHTML = emptyState("wifi-off", "Charts couldn't load", "The charting library was blocked by the network. Check your connection / CSP and reload.");
    }
    refreshIcons();
    return;
  }
  const guard = (label, boxId, fn) => {
    try { fn(); }
    catch (e) {
      console.error(`render ${label}:`, e);
      const box = boxId && document.getElementById(boxId);
      if (box) box.innerHTML = `<div class="flex h-full items-center justify-center p-4 text-center text-xs text-rose-500">${label} error: ${escapeHtml(e.message)}</div>`;
    }
  };
  guard("heatmap", "chart-heatmap", renderHeatmap);
  guard("treemap", "chart-treemap", renderTreemap);
  guard("consensus", "chart-consensus", renderConsensus);
  refreshIcons();
  setTimeout(resizeCharts, 300);
}

function renderHeatmap() {
  const el = document.getElementById("chart-heatmap");
  const MIN = 3; // only show fund·sector pairs with >= this many sightings
  const active = [...groupByFund().values()].filter((f) => f.sightings.length);
  // per-fund sector counts
  const rows = active.map((f) => {
    const m = new Map();
    for (const s of f.sightings) { const k = s.sector || "Unknown"; if (k === "Unknown") continue; m.set(k, (m.get(k) || 0) + 1); }
    return { f, m, peak: Math.max(0, ...m.values()) };
  }).filter((r) => r.peak >= MIN);

  const secTotal = new Map();
  for (const r of rows) for (const [sec, v] of r.m) if (v >= MIN) secTotal.set(sec, (secTotal.get(sec) || 0) + v);
  const sectors = [...secTotal.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  rows.sort((a, b) => b.peak - a.peak || b.f.sightings.length - a.f.sightings.length);
  const fundNames = rows.map((r) => r.f.name);
  const fundIds = rows.map((r) => r.f.id);

  if (!rows.length || !sectors.length) {
    el.innerHTML = emptyState("grid-3x3", "No strong concentration yet", `No fund has ${MIN}+ engagements in a single sector in this window.`);
    refreshIcons();
    return;
  }

  const data = [];
  let maxV = 0;
  rows.forEach((r, yi) => sectors.forEach((sec, xi) => {
    const v = r.m.get(sec) || 0;
    if (v >= MIN) { data.push([xi, yi, v]); maxV = Math.max(maxV, v); }
  }));

  // Dynamic height so rows aren't cramped or over-stretched.
  el.style.height = Math.max(280, fundNames.length * 46 + 150) + "px";
  const chart = makeChart(el, "heatmap");
  if (!chart) return;
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  chart.setOption({
    grid: { left: 172, right: 24, top: 12, bottom: 116 },
    tooltip: { position: "top", confine: true, backgroundColor: "#fff", borderColor: "#e2e8f0", textStyle: { color: "#334155" }, extraCssText: "border-radius:12px;box-shadow:0 12px 32px -12px rgba(16,24,40,.3);",
      formatter: (p) => `<b>${escapeHtml(fundNames[p.value[1]])}</b><br/>${escapeHtml(sectors[p.value[0]])}: <b>${p.value[2]}</b> engagements` },
    xAxis: { type: "category", data: sectors, splitArea: { show: true }, axisTick: { show: false }, axisLine: { lineStyle: { color: "#e2e8f0" } },
      axisLabel: { color: "#64748b", fontSize: 11, rotate: 30, interval: 0, formatter: (v) => trunc(v, 18) } },
    yAxis: { type: "category", data: fundNames, inverse: true, splitArea: { show: true }, axisTick: { show: false }, axisLine: { lineStyle: { color: "#e2e8f0" } },
      axisLabel: { color: "#334155", fontSize: 11.5, width: 160, overflow: "truncate", margin: 12 } },
    visualMap: { min: MIN, max: maxV || MIN, calculable: true, orient: "horizontal", left: "center", bottom: 12, itemWidth: 16, itemHeight: 140, inRange: { color: ["#C7D2FE", "#818CF8", "#6366F1", "#7C3AED", "#DB2777"] }, textStyle: { color: "#94a3b8", fontSize: 11 } },
    series: [{ type: "heatmap", data, label: { show: true, color: "#0f172a", fontFamily: "JetBrains Mono", fontSize: 11.5, formatter: (p) => p.value[2] },
      itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 6 },
      emphasis: { focus: "self", itemStyle: { shadowBlur: 12, shadowColor: "rgba(99,102,241,.5)" } },
      blur: { itemStyle: { opacity: 0.25 } } }],
  });
  chart.off("click");
  chart.on("click", (p) => { if (p.componentType === "series") { const id = fundIds[p.value[1]]; if (id) openDrill(id); } });
}

function graphModel() {
  const byFund = groupByFund();
  const fbc = fundsByCompany();
  const nodes = [];
  const links = [];
  const nameByFund = new Map(); // fund_id -> display name (link source key)
  for (const f of byFund.values()) nameByFund.set(f.id, f.name);
  const maxSight = Math.max(1, ...[...byFund.values()].map((f) => f.sightings.length));

  // Graph nodes are matched to links by `name`, so name = id here (fund names and
  // company names don't collide in this data). Custom props (_type, fundId, …)
  // ride along for tooltips/emphasis.
  for (const f of byFund.values()) {
    if (!f.sightings.length) continue;
    nodes.push({
      id: f.name, name: f.name, _type: "fund", fundId: f.id,
      symbolSize: 26 + 34 * (f.sightings.length / maxSight),
      itemStyle: { color: fundColor(f.id), borderColor: "#fff", borderWidth: 2, shadowBlur: 10, shadowColor: fundColor(f.id) + "66" },
      label: { show: true, fontFamily: "Space Grotesk", fontWeight: 600, fontSize: 11, color: "#334155" },
      _companies: f.sightings.length,
    });
  }
  for (const [company, fundSet] of fbc) {
    const n = fundSet.size;
    const consensus = n >= 2;
    const any = DATA.sightings.find((s) => s.company === company) || {};
    nodes.push({
      id: company, name: company, _type: "company", _funds: [...fundSet], _sector: any.sector, _industry: any.industry, _quote: any.quote,
      symbolSize: 7 + n * 5,
      itemStyle: { color: consensus ? "#F59E0B" : "#cbd5e1", borderColor: consensus ? "#fff" : "#e2e8f0", borderWidth: consensus ? 2 : 1 },
      label: { show: false },
    });
  }
  // aggregate occurrences per fund→company (null-byte sep avoids name collisions)
  const linkAgg = new Map();
  for (const s of DATA.sightings) {
    const k = s.fund_id + " " + s.company;
    linkAgg.set(k, (linkAgg.get(k) || 0) + (s.occurrences || 1));
  }
  for (const [k, occ] of linkAgg) {
    const i = k.indexOf(" ");
    const fid = k.slice(0, i), company = k.slice(i + 1);
    links.push({ source: nameByFund.get(fid) || fid, target: company, _fundId: fid, lineStyle: { color: fundColor(fid), width: 1 + Math.min(occ, 6), opacity: 0.45, curveness: 0.08 } });
  }
  return { nodes, links };
}

function renderGraph() {
  const el = document.getElementById("chart-graph");
  const chart = makeChart(el, "graph");
  if (!chart) return;
  const { nodes, links } = graphModel();
  graphData = { nodes, links };
  chart.setOption({
    tooltip: {
      borderColor: "#e2e8f0", backgroundColor: "#fff", textStyle: { color: "#334155" }, extraCssText: "box-shadow:0 12px 32px -12px rgba(16,24,40,.3);border-radius:12px;",
      formatter: (p) => {
        if (p.dataType !== "node") return "";
        const d = p.data;
        if (d._type === "fund") return `<b style="color:${fundColor(d.fundId)}">${escapeHtml(d.name)}</b><br/>${d._companies} engagements`;
        const funds = (d._funds || []).map((id) => `<span style="color:${fundColor(id)}">●</span>`).join(" ");
        const q = d._quote ? `<div style="max-width:260px;white-space:normal;color:#64748b;margin-top:4px">“${escapeHtml(d._quote.slice(0, 120))}…”</div>` : "";
        return `<b>${escapeHtml(d.name)}</b><br/>${escapeHtml(d._sector || "Unknown")}<br/>${d._funds.length} fund(s): ${funds}${q}`;
      },
    },
    animationDuration: 900,
    series: [{
      type: "graph", layout: "force", roam: true, draggable: true, data: nodes, links,
      force: { repulsion: 130, edgeLength: [50, 130], gravity: 0.09, friction: 0.18 },
      emphasis: { focus: "adjacency", scale: true, lineStyle: { width: 4, opacity: 0.9 }, label: { show: true } },
      label: { position: "right" },
      lineStyle: { color: "source" },
    }],
  });
  chart.off("click");
  chart.on("click", (p) => {
    if (p.dataType === "node" && p.data._type === "fund") {
      emphasizeFund(selectedFund === p.data.fundId ? null : p.data.fundId);
    } else if (p.dataType === undefined) {
      emphasizeFund(null);
    }
  });
}

function emphasizeFund(fundId) {
  selectedFund = fundId;
  const chart = makeChartExisting("graph");
  if (!chart || !graphData) return;
  const { nodes, links } = graphData;
  const adjacentCompanies = new Set();
  if (fundId) links.forEach((l) => { if (l._fundId === fundId) adjacentCompanies.add(l.target); });

  const nd = nodes.map((n) => {
    let on = true;
    if (fundId) on = (n._type === "fund" && n.fundId === fundId) || (n._type === "company" && adjacentCompanies.has(n.id));
    return { ...n, itemStyle: { ...n.itemStyle, opacity: on ? 1 : 0.12 }, label: { ...n.label, show: n._type === "fund" ? on || !fundId : false } };
  });
  const lk = links.map((l) => ({ ...l, lineStyle: { ...l.lineStyle, opacity: !fundId ? 0.45 : l._fundId === fundId ? 0.85 : 0.04 } }));
  chart.setOption({ series: [{ data: nd, links: lk }] });
  const btn = document.getElementById("graph-reset");
  if (btn) btn.classList.toggle("hidden", !fundId);
  renderLegend();
}
function makeChartExisting(id) {
  return window.echarts ? window.echarts.getInstanceByDom(document.getElementById("chart-" + id)) : null;
}

function renderLegend() {
  const el = document.getElementById("graph-legend");
  if (!el) return;
  const active = DATA.funds.filter((f) => DATA.sightings.some((s) => s.fund_id === f.id));
  el.innerHTML = active
    .map((f) => {
      const sel = selectedFund === f.id;
      const c = fundColor(f.id);
      return `<button type="button" data-leg="${f.id}" class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition ${sel ? "text-white" : "text-slate-600 hover:bg-slate-50"}" style="${sel ? `background:${c}` : `box-shadow:0 0 0 1px ${c}40 inset`}"><span class="h-2 w-2 rounded-full" style="background:${sel ? "#fff" : c}"></span>${escapeHtml(f.name)}</button>`;
    })
    .join("");
  el.querySelectorAll("[data-leg]").forEach((b) =>
    b.addEventListener("click", () => emphasizeFund(selectedFund === b.dataset.leg ? null : b.dataset.leg))
  );
}

function renderTreemap() {
  const chart = makeChart(document.getElementById("chart-treemap"), "treemap");
  if (!chart) return;
  const agg = new Map();
  for (const s of DATA.sightings) {
    const k = s.sector || "Unknown";
    if (k === "Unknown") continue;
    if (!agg.has(k)) agg.set(k, { count: 0, companies: new Set(), funds: new Map() });
    const a = agg.get(k);
    a.count++; a.companies.add(s.company);
    a.funds.set(s.fund_name, (a.funds.get(s.fund_name) || 0) + 1);
  }
  const data = [...agg.entries()].map(([sector, a]) => ({
    name: sector, value: a.count, _companies: a.companies.size,
    _topFunds: [...a.funds.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n, c]) => `${n} (${c})`).join(", "),
    itemStyle: { color: sectorColor(sector), borderColor: "#fff", borderWidth: 2, gapWidth: 2 },
  }));
  chart.setOption({
    tooltip: {
      confine: true, backgroundColor: "#fff", borderColor: "#e2e8f0", textStyle: { color: "#334155" }, extraCssText: "box-shadow:0 12px 32px -12px rgba(16,24,40,.3);border-radius:12px;",
      formatter: (p) => `<b>${escapeHtml(p.name)}</b><br/>${p.value} engagements · ${p.data._companies} companies<br/><span style="color:#64748b">Top: ${escapeHtml(p.data._topFunds || "—")}</span>`,
    },
    series: [{ type: "treemap", roam: false, breadcrumb: { show: false }, nodeClick: false, animationDuration: 800,
      label: { show: true, formatter: "{b}", color: "#fff", fontFamily: "Inter", fontWeight: 600, overflow: "truncate" },
      itemStyle: { borderRadius: 6 }, emphasis: { focus: "self" }, blur: { itemStyle: { opacity: 0.3 } }, data }],
  });
}

// Buy-side signal: companies that 2+ tracked funds are watching (consensus).
function renderConsensus() {
  const el = document.getElementById("chart-consensus");
  const fbc = fundsByCompany();
  const secByCo = new Map();
  for (const s of DATA.sightings) if (!secByCo.has(s.company)) secByCo.set(s.company, s.sector);
  const rows = [...fbc.entries()]
    .map(([company, set]) => ({ company, funds: [...set], n: set.size }))
    .filter((r) => r.n >= 2)
    .sort((a, b) => b.n - a.n || a.company.localeCompare(b.company))
    .slice(0, 12)
    .reverse(); // horizontal bar plots bottom→top

  if (!rows.length) {
    el.innerHTML = emptyState("users", "No overlaps yet", "No company is tracked by 2+ funds in this window.");
    refreshIcons();
    return;
  }
  el.style.height = Math.max(260, rows.length * 30 + 40) + "px";
  const chart = makeChart(el, "consensus");
  if (!chart) return;
  chart.setOption({
    grid: { left: 6, right: 64, top: 6, bottom: 6, containLabel: true },
    tooltip: { trigger: "item", confine: true, backgroundColor: "#fff", borderColor: "#e2e8f0", textStyle: { color: "#334155" }, extraCssText: "border-radius:12px;box-shadow:0 12px 32px -12px rgba(16,24,40,.3);",
      formatter: (p) => { const r = rows[p.dataIndex]; return `<b>${escapeHtml(r.company)}</b> · ${escapeHtml(secByCo.get(r.company) || "Unknown")}<br/><b>${r.n} funds:</b> ${r.funds.map((id) => `<span style="color:${fundColor(id)}">●</span> ${escapeHtml((DATA.funds.find((f) => f.id === id) || {}).name || id)}`).join("<br/>")}`; } },
    xAxis: { type: "value", minInterval: 1, splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { color: "#94a3b8", fontFamily: "JetBrains Mono" } },
    yAxis: { type: "category", data: rows.map((r) => r.company), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: "#334155", fontSize: 11, width: 130, overflow: "truncate" } },
    series: [{
      type: "bar", barWidth: "60%", data: rows.map((r) => ({ value: r.n, itemStyle: { color: sectorColor(secByCo.get(r.company) || null), borderRadius: [0, 6, 6, 0] } })),
      label: { show: true, position: "right", formatter: (p) => `${rows[p.dataIndex].n} funds`, color: "#64748b", fontFamily: "JetBrains Mono", fontSize: 11 },
      emphasis: { focus: "self" }, blur: { itemStyle: { opacity: 0.3 } }, animationDuration: 800,
    }],
  });
}

// ===========================================================================
// FUNDS
// ===========================================================================
function renderFunds() {
  const root = document.getElementById("tab-funds");
  root.innerHTML = `
    <div class="mb-5 relative w-full sm:max-w-sm">
      <i data-lucide="search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"></i>
      <input id="funds-search" type="search" placeholder="Search fund, company, or ticker…" class="w-full rounded-xl bg-white py-2.5 pl-9 pr-3 text-sm shadow-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400" />
    </div>
    <div id="funds-grid" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"></div>`;
  root.querySelector("#funds-search").addEventListener("input", updateFundsGrid);
  root.querySelector("#funds-grid").addEventListener("click", (e) => {
    const tile = e.target.closest("[data-fund-tile]");
    if (tile) openDrill(tile.dataset.fundTile);
  });
  updateFundsGrid();
}

function updateFundsGrid() {
  const q = (document.getElementById("funds-search")?.value || "").trim().toLowerCase();
  const grid = document.getElementById("funds-grid");
  let funds = [...groupByFund().values()].map((f) => {
    const companies = companiesOf(f.sightings);
    return { ...f, companies, companyCount: companies.length, sightingCount: f.sightings.length, mix: sectorMix(f.sightings) };
  });
  if (q) {
    funds = funds.filter(
      (f) => f.name.toLowerCase().includes(q) || f.companies.some((c) => (c.company || "").toLowerCase().includes(q) || (c.ticker || "").toLowerCase().includes(q))
    );
  }
  funds.sort((a, b) => b.companyCount - a.companyCount || a.name.localeCompare(b.name));
  grid.innerHTML = funds.length ? funds.map(fundTile).join("") : emptyState("search-x", "No matches", `Nothing matched “${q}”.`);
  refreshIcons();
}

function fundTile(f) {
  const color = fundColor(f.id);
  const zero = f.sightingCount === 0;
  const total = f.sightingCount || 1;
  const bar = zero
    ? `<div class="h-2 w-full rounded-full bg-slate-100"></div>`
    : `<div class="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">${f.mix
        .map((m) => `<span title="${escapeHtml(m.sector)}: ${m.count}" style="width:${(m.count / total) * 100}%;background:${sectorColor(m.sector === "Unknown" ? null : m.sector)}"></span>`)
        .join("")}</div>`;
  const pills = f.mix.slice(0, 3).map((m) => sectorPill(m.sector === "Unknown" ? null : m.sector)).join(" ");
  return `
    <button type="button" data-fund-tile="${f.id}" class="card card-hover relative overflow-hidden p-5 text-left ${zero ? "opacity-60" : ""}">
      <div class="absolute inset-x-0 top-0 h-1" style="background:${color}"></div>
      <div class="flex items-center gap-3">
        <span class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl font-display text-sm font-bold text-white shadow-sm" style="background:${color}">${escapeHtml(initials(f.name))}</span>
        <div class="min-w-0">
          <div class="truncate font-display text-base font-semibold text-slate-800">${escapeHtml(f.name)}</div>
          <div class="font-mono text-xs text-slate-500">${zero ? "no companies (90d)" : `${f.companyCount} ${f.companyCount === 1 ? "company" : "companies"}`}</div>
        </div>
      </div>
      <div class="mt-4">${bar}</div>
      <div class="mt-3 flex flex-wrap gap-1.5">${zero ? "" : pills}</div>
    </button>`;
}

// --- drill modal (centered) ------------------------------------------------
function openDrill(fundId) {
  const f = groupByFund().get(fundId);
  if (!f) return;
  const color = fundColor(fundId);
  const companies = companiesOf(f.sightings);
  const content = document.getElementById("drill-content");
  content.innerHTML = `
    <div class="flex items-center justify-between gap-3 border-b border-slate-100 p-5">
      <div class="flex items-center gap-3">
        <span class="grid h-12 w-12 place-items-center rounded-2xl font-display text-base font-bold text-white shadow-sm" style="background:${color}">${escapeHtml(initials(f.name))}</span>
        <div><div class="font-display text-xl font-semibold text-slate-800">${escapeHtml(f.name)}</div>
          <div class="font-mono text-xs text-slate-500">${companies.length} ${companies.length === 1 ? "company" : "companies"}</div></div>
      </div>
      <button id="drill-close" class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>
    ${f.sightings.length ? `<div class="flex flex-col items-center gap-4 border-b border-slate-100 p-5 sm:flex-row">
      <div id="drill-donut" class="chart-donut-lg sm:flex-[0_0_220px]"></div>
      <div id="drill-legend" class="grid w-full flex-1 grid-cols-2 gap-x-5 gap-y-1.5 text-xs"></div>
    </div>` : ""}
    <div class="scroll-area flex-1 overflow-y-auto p-4">
      ${companies.length ? `<div class="grid gap-2 sm:grid-cols-2">${companies.map((c) => drillRow(c, color)).join("")}</div>` : emptyState("inbox", "No companies", "Not seen in a concall in the last 90 days.")}
    </div>`;
  revealModal();
  if (f.sightings.length) drawDrillDonut(f, color);
}

function revealModal() {
  const panel = document.getElementById("drill-panel");
  const card = document.getElementById("drill-card");
  const ov = document.getElementById("drill-overlay");
  panel.classList.remove("pointer-events-none");
  panel.style.opacity = "1";
  card.style.transform = "scale(1)";
  card.style.opacity = "1";
  ov.classList.remove("pointer-events-none");
  ov.style.opacity = "1";
  const close = document.getElementById("drill-close");
  if (close) close.addEventListener("click", closeDrill);
  refreshIcons();
}

// "Funds we track" board — opened from the Active Funds KPI card.
function openFundsList() {
  const list = [...groupByFund().values()]
    .map((f) => ({ ...f, companyCount: companiesOf(f.sightings).length, sightingCount: f.sightings.length, mix: sectorMix(f.sightings) }))
    .sort((a, b) => b.companyCount - a.companyCount || a.name.localeCompare(b.name));
  const tiles = list.map((f) => {
    const color = fundColor(f.id);
    const zero = f.companyCount === 0;
    const total = f.sightingCount || 1;
    const bar = zero
      ? `<div class="mt-3 h-1.5 w-full rounded-full bg-slate-100"></div>`
      : `<div class="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100">${f.mix.filter((m) => m.sector !== "Unknown").map((m) => `<span style="width:${(m.count / total) * 100}%;background:${sectorColor(m.sector)}"></span>`).join("")}</div>`;
    return `<button type="button" data-fund-open="${f.id}" class="group rounded-2xl bg-white p-4 text-left ring-1 ring-slate-100 transition hover:-translate-y-0.5 hover:shadow-lg ${zero ? "opacity-60" : ""}">
      <div class="flex items-center gap-3">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl font-display text-xs font-bold text-white shadow-sm" style="background:${color}">${escapeHtml(initials(f.name))}</span>
        <div class="min-w-0"><div class="truncate text-sm font-semibold text-slate-800">${escapeHtml(f.name)}</div>
          <div class="font-mono text-[11px] text-slate-500">${zero ? "no companies" : `${f.companyCount} ${f.companyCount === 1 ? "company" : "companies"}`}</div></div>
      </div>${bar}</button>`;
  }).join("");
  document.getElementById("drill-content").innerHTML = `
    <div class="flex items-center justify-between gap-3 border-b border-slate-100 p-5">
      <div class="flex items-center gap-3">
        <span class="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-sm"><i data-lucide="briefcase" class="h-5 w-5"></i></span>
        <div><div class="font-display text-xl font-semibold text-slate-800">Funds on the radar</div>
          <div class="font-mono text-xs text-slate-500">${list.length} funds tracked</div></div>
      </div>
      <button id="drill-close" class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>
    <div class="scroll-area flex-1 overflow-y-auto bg-slate-50/40 p-4">
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${tiles}</div>
    </div>`;
  revealModal();
  document.getElementById("drill-content").addEventListener("click", (e) => {
    const t = e.target.closest("[data-fund-open]");
    if (t) openDrill(t.dataset.fundOpen);
  });
}

// Compact cell: company + ticker, analyst · date, source icon (no quote).
function drillRow(c, color) {
  const analyst = analystOf(c.quote, c.matched_alias);
  return `<div class="flex items-center justify-between gap-2 rounded-xl bg-slate-50/60 px-3 py-2.5 ring-1 ring-slate-100 transition hover:bg-white hover:ring-slate-200">
    <div class="min-w-0">
      <div class="flex items-center gap-1.5">
        <span class="truncate text-sm font-semibold text-slate-800">${escapeHtml(c.company)}</span>
        ${c.ticker ? `<span class="shrink-0 font-mono text-[11px] font-medium uppercase tracking-wide" style="color:${color}">${escapeHtml(c.ticker)}</span>` : ""}
      </div>
      <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
        <i data-lucide="user-round" class="h-3 w-3 shrink-0 text-slate-400"></i><span class="truncate">${analyst ? escapeHtml(analyst) : "—"}</span>
        <span class="text-slate-300">·</span>
        <span class="whitespace-nowrap font-mono">${fmtDate(c.concall_date)}</span>
      </div>
    </div>
    ${sourceIconBtn(c.transcript_url)}
  </div>`;
}

function drawDrillDonut(f, color) {
  const mix = sectorMix(f.sightings);
  const chart = makeChart(document.getElementById("drill-donut"), "drill-donut");
  if (chart) {
    chart.setOption({
      tooltip: { trigger: "item", confine: true, backgroundColor: "#fff", borderColor: "#e2e8f0", textStyle: { color: "#334155" }, extraCssText: "border-radius:12px;box-shadow:0 12px 32px -12px rgba(16,24,40,.3);", formatter: (p) => `${escapeHtml(p.name)}: <b>${p.value}</b> (${p.percent}%)` },
      series: [{
        type: "pie", radius: ["56%", "84%"], center: ["50%", "50%"], avoidLabelOverlap: true, padAngle: 3,
        itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 3 },
        label: { show: false }, labelLine: { show: false },
        emphasis: { focus: "self", scaleSize: 6 }, blur: { itemStyle: { opacity: 0.3 } },
        data: mix.map((m) => ({ name: m.sector, value: m.count, itemStyle: { color: sectorColor(m.sector === "Unknown" ? null : m.sector) } })),
      }],
      graphic: [{ type: "text", left: "center", top: "center", style: { text: `${mix.length}\nsectors`, textAlign: "center", fill: "#475569", font: "600 15px Space Grotesk" } }],
    });
  }
  // Clean, aligned HTML legend (no clipping like ECharts' built-in legend).
  const leg = document.getElementById("drill-legend");
  if (leg) {
    leg.innerHTML = mix
      .map((m) => {
        const c = sectorColor(m.sector === "Unknown" ? null : m.sector);
        return `<div class="flex min-w-0 items-center gap-2">
          <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:${c}"></span>
          <span class="truncate text-slate-600">${escapeHtml(m.sector)}</span>
          <span class="ml-auto shrink-0 font-mono text-slate-400">${m.count}</span></div>`;
      })
      .join("");
  }
}

function closeDrill() {
  const panel = document.getElementById("drill-panel");
  const card = document.getElementById("drill-card");
  const ov = document.getElementById("drill-overlay");
  card.style.transform = "scale(0.95)";
  card.style.opacity = "0";
  panel.style.opacity = "0";
  panel.classList.add("pointer-events-none");
  ov.style.opacity = "0";
  ov.classList.add("pointer-events-none");
}

// ===========================================================================
// SECTORS — "where is smart money concentrating, is it rising/cooling, names?"
// ===========================================================================
let _sectorStats = [];
let sectorSort = { key: "funds", dir: -1 };
const fundName = (id) => (DATA.funds.find((f) => f.id === id) || {}).name || id;
const ymdAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// Per-sector signal metrics (null sector → "Unclassified", bucketed last).
function sectorStats() {
  const d45 = ymdAgo(45), d90 = ymdAgo(90); // trend: last 45d vs prior 45d (by concall_date)
  const map = new Map();
  for (const s of DATA.sightings) {
    const key = s.sector || "Unclassified";
    if (!map.has(key)) map.set(key, { sector: key, funds: new Set(), sightings: 0, recent: 0, prior: 0, companies: new Map() });
    const a = map.get(key);
    a.funds.add(s.fund_id); a.sightings++;
    const cd = s.concall_date || "";
    if (cd >= d45) a.recent++; else if (cd >= d90) a.prior++;
    let c = a.companies.get(s.company);
    if (!c) { c = { company: s.company, ticker: s.ticker, funds: new Set(), sightings: 0, latestDate: cd, quote: s.quote, matched_alias: s.matched_alias, transcript_url: s.transcript_url }; a.companies.set(s.company, c); }
    c.funds.add(s.fund_id); c.sightings++;
    if (cd >= c.latestDate) { c.latestDate = cd; c.quote = s.quote; c.matched_alias = s.matched_alias; c.transcript_url = s.transcript_url; c.ticker = s.ticker; }
  }
  const out = [...map.values()].map((a) => {
    const companies = [...a.companies.values()].map((c) => ({ ...c, fundCount: c.funds.size, fundIds: [...c.funds] }))
      .sort((x, y) => y.fundCount - x.fundCount || y.sightings - x.sightings || y.latestDate.localeCompare(x.latestDate));
    const bySight = [...companies].sort((x, y) => y.sightings - x.sightings);
    const top2 = (bySight[0]?.sightings || 0) + (bySight[1]?.sightings || 0);
    const focus = a.sightings && top2 / a.sightings >= 0.6 ? "Concentrated" : "Broad"; // most sightings in 1–2 names?
    const delta = a.recent - a.prior;
    return { sector: a.sector, fundIds: [...a.funds], fundCount: a.funds.size, sightings: a.sightings, recent: a.recent, prior: a.prior, delta, trend: delta > 0 ? "up" : delta < 0 ? "down" : "flat", focus, companies };
  });
  out.sort((x, y) => (x.sector === "Unclassified" ? 1 : 0) - (y.sector === "Unclassified" ? 1 : 0) || y.fundCount - x.fundCount || y.sightings - x.sightings);
  return out;
}

// Auto-generated plain-English takeaway.
function houseView(stats) {
  const real = stats.filter((s) => s.sector !== "Unclassified" && s.fundCount);
  if (!real.length) return "No sector signal yet — the radar runs daily.";
  const heat = (s) => (s.trend === "up" ? "heating up" : s.trend === "down" ? "cooling" : "steady");
  const s1 = real[0], s2 = real[1];
  const parts = [];
  let lead = `Smart money is most concentrated in ${s1.sector} (${s1.fundCount} funds)`;
  if (s2) lead += ` and ${s2.sector} (${s2.fundCount} funds)`;
  lead += s2 && s1.trend === "up" && s2.trend === "up" ? ", both heating up." : `, ${heat(s1)}.`;
  parts.push(lead);
  const broadCool = real.find((s) => s !== s1 && s !== s2 && s.focus === "Broad" && s.trend === "down");
  if (broadCool) parts.push(`${broadCool.sector} is broad but cooling.`);
  const early = real.filter((s) => s !== s1 && s !== s2 && s.trend === "up" && s.fundCount <= 2).sort((a, b) => b.delta - a.delta)[0];
  if (early) parts.push(`Early interest building in ${early.sector}.`);
  return parts.join(" ");
}

function sectorRead(s) {
  const top = s.companies.slice(0, 2).map((c) => c.company);
  const rising = s.trend === "up" ? " and rising" : s.trend === "down" ? " but cooling" : "";
  const focus = s.focus === "Concentrated" ? "concentrated" : "broad";
  return `${s.fundCount} fund${s.fundCount === 1 ? "" : "s"}${rising} — ${focus}${top.length ? `, top: ${top.join(" & ")}` : ""}`;
}

function trendBadge(s) {
  if (s.trend === "up") return `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600"><i data-lucide="trending-up" class="h-3 w-3"></i>Heating up${s.delta ? ` +${s.delta}` : ""}</span>`;
  if (s.trend === "down") return `<span class="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600"><i data-lucide="trending-down" class="h-3 w-3"></i>Cooling ${s.delta}</span>`;
  return `<span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500"><i data-lucide="minus" class="h-3 w-3"></i>Steady</span>`;
}
const focusBadge = (s) => s.focus === "Concentrated"
  ? `<span class="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600">Concentrated</span>`
  : `<span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">Broad</span>`;
const fundDots = (ids) => ids.slice(0, 13).map((id) => `<span class="inline-block h-2 w-2 rounded-full ring-1 ring-white" style="background:${fundColor(id)}"></span>`).join("");

function renderSectors() {
  const root = document.getElementById("tab-sectors");
  _sectorStats = sectorStats();
  root.innerHTML = `
    <div class="mb-4 rounded-3xl bg-gradient-to-br from-indigo-50 via-white to-fuchsia-50 p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1.5 flex items-center gap-2"><span class="rounded-xl bg-white p-1.5 text-indigo-500 shadow-sm"><i data-lucide="lightbulb" class="h-4 w-4"></i></span>
        <h2 class="font-display text-xs font-semibold uppercase tracking-wider text-slate-500">House view</h2></div>
      <p class="font-display text-lg font-semibold leading-snug text-slate-800 sm:text-xl">${escapeHtml(houseView(_sectorStats))}</p>
      <p class="mt-2 text-[11px] text-slate-400">Signal = smart-money attention from concall participation (a leading indicator), not confirmed positions.</p>
    </div>
    <div class="card mb-4 p-4 sm:p-5">
      <div class="mb-1 flex items-center gap-2"><span class="rounded-xl bg-indigo-50 p-1.5 text-indigo-500"><i data-lucide="bar-chart-3" class="h-4 w-4"></i></span>
        <h2 class="font-display text-lg font-semibold text-slate-800">Where smart money is concentrating</h2></div>
      <p class="mb-3 text-xs text-slate-400">Distinct funds active per sector — longer = more conviction · <span class="text-emerald-600">▲ heating up</span> · <span class="text-rose-500">▼ cooling</span>. Click a bar to drill.</p>
      <div id="chart-sectors" class="chart-box"></div>
    </div>
    <div class="card overflow-hidden p-0"><div id="sector-table"></div></div>`;

  if (window.echarts) {
    try { renderSectorBar(_sectorStats); }
    catch (e) { console.error("render sectorbar:", e); document.getElementById("chart-sectors").innerHTML = `<div class="flex h-full items-center justify-center text-xs text-rose-500">chart error: ${escapeHtml(e.message)}</div>`; }
  } else {
    document.getElementById("chart-sectors").innerHTML = emptyState("wifi-off", "Chart couldn't load", "The charting library was blocked. Reload.");
  }
  renderSectorTable();
  refreshIcons();
}

function renderSectorBar(stats) {
  const el = document.getElementById("chart-sectors");
  el.style.height = Math.max(280, stats.length * 34 + 50) + "px";
  const chart = makeChart(el, "sectors");
  if (!chart) return;
  const rows = [...stats].reverse(); // horizontal bar plots bottom→top
  chart.setOption({
    grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: "item", confine: true, backgroundColor: "#fff", borderColor: "#e2e8f0", textStyle: { color: "#334155" }, extraCssText: "border-radius:12px;box-shadow:0 12px 32px -12px rgba(16,24,40,.3);",
      formatter: (p) => { const r = rows[p.dataIndex]; const t = r.trend === "up" ? "Heating up ▲" : r.trend === "down" ? "Cooling ▼" : "Steady"; return `<b>${escapeHtml(r.sector)}</b><br/>${r.fundCount} funds · ${r.sightings} engagements<br/><span style="color:#64748b">${t}${r.delta ? ` (${r.delta > 0 ? "+" : ""}${r.delta})` : ""} · ${r.focus}</span>`; } },
    xAxis: { type: "value", minInterval: 1, max: 13, splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { color: "#94a3b8", fontFamily: "JetBrains Mono" } },
    yAxis: { type: "category", data: rows.map((r) => r.sector), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: "#334155", fontSize: 11.5, width: 150, overflow: "truncate" } },
    series: [{
      type: "bar", barWidth: "58%",
      data: rows.map((r) => ({ value: r.fundCount, itemStyle: { color: sectorColor(r.sector === "Unclassified" ? null : r.sector), borderRadius: [0, 6, 6, 0] } })),
      label: { show: true, position: "right", formatter: (p) => { const r = rows[p.dataIndex]; const m = r.trend === "up" ? "{up|▲}" : r.trend === "down" ? "{down|▼}" : "{flat|–}"; return `{v|${r.fundCount}}  ${m}`; },
        rich: { v: { color: "#334155", fontFamily: "JetBrains Mono", fontWeight: 600, fontSize: 12 }, up: { color: "#10B981", fontSize: 12 }, down: { color: "#F43F5E", fontSize: 12 }, flat: { color: "#94A3B8", fontSize: 12 } } },
      emphasis: { focus: "self" }, blur: { itemStyle: { opacity: 0.3 } }, animationDuration: 800,
    }],
  });
  chart.off("click");
  chart.on("click", (p) => { const r = rows[p.dataIndex]; if (r) openSectorDrill(r.sector); });
}

function renderSectorTable() {
  const cont = document.getElementById("sector-table");
  if (!cont) return;
  const k = sectorSort.key, dir = sectorSort.dir;
  const sorted = [..._sectorStats].sort((a, b) => {
    let v = k === "sector" ? a.sector.localeCompare(b.sector) : k === "sightings" ? a.sightings - b.sightings : k === "trend" ? a.delta - b.delta : a.fundCount - b.fundCount;
    return v * dir;
  }).sort((a, b) => (a.sector === "Unclassified" ? 1 : 0) - (b.sector === "Unclassified" ? 1 : 0));
  const arrow = (key) => (sectorSort.key === key ? (sectorSort.dir < 0 ? " ↓" : " ↑") : "");
  const th = (key, label, extra = "") => `<th class="px-4 py-3 ${extra}"><button data-sort="${key}" class="font-semibold uppercase tracking-wide hover:text-slate-700">${label}${arrow(key)}</button></th>`;

  cont.innerHTML = `
    <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead><tr class="text-left text-[11px] text-slate-400">
        ${th("sector", "Sector")}${th("funds", "Funds")}${th("sightings", "Engagements", "hidden sm:table-cell")}
        ${th("trend", "Trend")}<th class="px-4 py-3 hidden md:table-cell text-[11px] font-semibold uppercase tracking-wide text-slate-400">Focus</th>
        <th class="px-4 py-3 hidden lg:table-cell text-[11px] font-semibold uppercase tracking-wide text-slate-400">Read</th>
      </tr></thead>
      <tbody>
        ${sorted.map((s) => `
        <tr data-sector="${escapeHtml(s.sector)}" class="cursor-pointer border-t border-slate-100 transition hover:bg-slate-50">
          <td class="px-4 py-3"><span class="inline-flex items-center gap-2 font-medium text-slate-800"><span class="h-2.5 w-2.5 rounded-full" style="background:${sectorColor(s.sector === "Unclassified" ? null : s.sector)}"></span>${escapeHtml(s.sector)}</span></td>
          <td class="px-4 py-3"><div class="flex items-center gap-2"><span class="font-mono text-slate-700">${s.fundCount}<span class="text-slate-300">/13</span></span><span class="flex gap-0.5">${fundDots(s.fundIds)}</span></div></td>
          <td class="px-4 py-3 hidden sm:table-cell font-mono text-slate-600">${s.sightings}</td>
          <td class="px-4 py-3">${trendBadge(s)}</td>
          <td class="px-4 py-3 hidden md:table-cell">${focusBadge(s)}</td>
          <td class="px-4 py-3 hidden lg:table-cell text-slate-500">${escapeHtml(sectorRead(s))}</td>
        </tr>`).join("")}
      </tbody>
    </table></div>`;

  cont.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const key = b.dataset.sort;
    if (sectorSort.key === key) sectorSort.dir *= -1;
    else { sectorSort.key = key; sectorSort.dir = key === "sector" ? 1 : -1; }
    renderSectorTable();
    refreshIcons();
  }));
  cont.querySelectorAll("[data-sector]").forEach((r) => r.addEventListener("click", () => openSectorDrill(r.dataset.sector)));
}

function openSectorDrill(sectorName) {
  const s = _sectorStats.find((x) => x.sector === sectorName);
  if (!s) return;
  const col = sectorColor(sectorName === "Unclassified" ? null : sectorName);
  const fundChips = s.fundIds.map((id) => `<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium" style="background:${fundColor(id)}1a;color:${fundColor(id)}"><span class="h-1.5 w-1.5 rounded-full" style="background:${fundColor(id)}"></span>${escapeHtml(fundName(id))}</span>`).join("");
  document.getElementById("drill-content").innerHTML = `
    <div class="flex items-start justify-between gap-3 border-b border-slate-100 p-5">
      <div class="flex items-center gap-3">
        <span class="grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-white shadow-sm" style="background:${col}"><i data-lucide="layers" class="h-5 w-5"></i></span>
        <div><div class="font-display text-xl font-semibold text-slate-800">${escapeHtml(sectorName)}</div>
          <div class="mt-0.5 text-xs text-slate-500">${escapeHtml(sectorRead(s))}</div></div>
      </div>
      <button id="drill-close" class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>
    <div class="border-b border-slate-100 p-5">
      <div class="mb-3 flex flex-wrap items-center gap-5">
        <div><div class="font-mono text-2xl font-semibold text-slate-800">${s.fundCount}<span class="text-base text-slate-400">/13</span></div><div class="text-[11px] uppercase tracking-wide text-slate-400">funds</div></div>
        <div><div class="font-mono text-2xl font-semibold text-slate-800">${s.sightings}</div><div class="text-[11px] uppercase tracking-wide text-slate-400">engagements</div></div>
        <div class="flex gap-2 self-center">${trendBadge(s)}${focusBadge(s)}</div>
      </div>
      <div class="flex flex-wrap gap-1.5">${fundChips}</div>
    </div>
    <div class="scroll-area flex-1 overflow-y-auto p-4">
      <div class="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Top names — what the most funds are tracking here</div>
      <div class="space-y-2">${s.companies.map((c) => sectorCompanyRow(c, col)).join("")}</div>
    </div>`;
  revealModal();
  wireShowMore(document.getElementById("drill-content"));
}

function sectorCompanyRow(c, col) {
  const chips = c.fundIds.map((id) => `<span title="${escapeHtml(fundName(id))}" class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style="background:${fundColor(id)}1a;color:${fundColor(id)}"><span class="h-1.5 w-1.5 rounded-full" style="background:${fundColor(id)}"></span>${escapeHtml(fundName(id))}</span>`).join("");
  return `<div class="rounded-2xl bg-slate-50/60 p-3 ring-1 ring-slate-100">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span class="font-semibold text-slate-800">${escapeHtml(c.company)}</span>
      ${c.ticker ? `<span class="font-mono text-xs uppercase tracking-wide" style="color:${col}">${escapeHtml(c.ticker)}</span>` : ""}
      <span class="ml-auto inline-flex items-center gap-2">
        <span class="inline-flex items-center gap-1 font-mono text-xs text-slate-400"><i data-lucide="users" class="h-3 w-3"></i>${c.fundCount}</span>
        <span class="font-mono text-xs text-slate-400">${fmtDate(c.latestDate)}</span>
        ${transcriptBtn(c.transcript_url)}
      </span>
    </div>
    <div class="mt-1.5 flex flex-wrap gap-1">${chips}</div>
    ${quoteBlock(c.quote, col)}
  </div>`;
}

// ===========================================================================
// placeholders (Prompt 11)
// ===========================================================================
function renderPlaceholder(id, icon, title) {
  document.getElementById(id).innerHTML = emptyState(icon, title, "Coming in the next release — built on this same design system.");
  refreshIcons();
}

// --- tabs ------------------------------------------------------------------
const RENDERERS = {
  radar: renderRadar,
  funds: renderFunds,
  sectors: renderSectors,
  overlap: () => renderPlaceholder("tab-overlap", "git-merge", "Overlap"),
  flags: () => renderPlaceholder("tab-flags", "bell", "Recent Flags"),
};
function activate(tab) {
  document.querySelectorAll("#tab-nav [data-tab]").forEach((btn) => {
    const on = btn.dataset.tab === tab;
    btn.setAttribute("aria-selected", on ? "true" : "false");
    const sec = document.getElementById(`tab-${btn.dataset.tab}`);
    if (sec) { sec.hidden = !on; if (on) sec.classList.add("fade-in"); }
  });
  if (!rendered.has(tab)) { RENDERERS[tab](); rendered.add(tab); }
  // charts need a visible container to size correctly
  requestAnimationFrame(() => resizeCharts());
}

function renderBadges() {
  const todayNew = DATA.sightings.filter((x) => isToday(x.first_seen)).length;
  const el = document.querySelector('[data-badge="flags"]');
  if (el) { el.textContent = todayNew; el.classList.toggle("hidden", todayNew === 0); }
}

// --- boot ------------------------------------------------------------------
async function boot() {
  DATA = await loadData();
  const updated = document.getElementById("meta-updated");
  if (updated) updated.textContent = DATA.meta.generated_at ? fmtDate(String(DATA.meta.generated_at).slice(0, 10)) : "—";

  renderKpis();
  renderBadges();

  document.querySelectorAll("#tab-nav [data-tab]").forEach((btn) => btn.addEventListener("click", () => activate(btn.dataset.tab)));
  activate("radar");

  const panel = document.getElementById("drill-panel");
  panel.addEventListener("click", (e) => { if (e.target === panel) closeDrill(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrill(); });

  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(resizeCharts, 150); });
  refreshIcons();
}
document.addEventListener("DOMContentLoaded", boot);
