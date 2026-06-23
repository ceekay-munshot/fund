// app.js — Fund Tracker — MGA · visual-first dashboard
// ---------------------------------------------------------------------------
// Renders the KPI strip + five tabs from the cached data in ./data, all on the
// shared design system in ui.js:
//   Radar    — Fund×Sector heatmap + sector treemap + highest-conviction bar
//   Funds    — searchable fund board + drill modal
//   Sectors  — House View + ranked funds-per-sector bar + sortable table + drill
//   Consensus(overlap) — tiered consensus book + "conviction building" + drill
//   Recent Flags — chronological feed (First-interest/Repeat, filters)
// Plus a header Export button (sightings → styled .xlsx / CSV).
// ---------------------------------------------------------------------------

import {
  loadData, fundColor, sectorColor, sectorPill, escapeHtml, initials, fmtDate,
  isToday, recencyBucket, analystOf, sourceIconBtn, transcriptBtn, quoteBlock, wireShowMore,
  moreList, wireMore, linkedinBtn, linkedinUrl,
  emptyState, countUp, makeChart, resizeCharts, refreshIcons,
} from "./ui.js";

let DATA = null;
const rendered = new Set();
let selectedFund = null; // graph emphasis
let graphData = null; // { nodes, links } for the Radar graph (NOT on the chart instance)
let heatmapExpanded = false; // Fund×Sector heatmap: top 10 funds vs all

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
    { label: "Concalls Scanned (4 qtrs)", value: DATA.meta.concalls_scanned ?? 0, icon: "file-text", grad: "from-amber-500 to-orange-500" },
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
  const allRowCount = rows.length;
  const shownRows = heatmapExpanded ? rows : rows.slice(0, 10);
  const fundNames = shownRows.map((r) => r.f.name);
  const fundIds = shownRows.map((r) => r.f.id);

  if (!rows.length || !sectors.length) {
    el.innerHTML = emptyState("grid-3x3", "No strong concentration yet", `No fund has ${MIN}+ engagements in a single sector in this window.`);
    refreshIcons();
    return;
  }

  const data = [];
  let maxV = 0;
  shownRows.forEach((r, yi) => sectors.forEach((sec, xi) => {
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

  // Top-10 cap with an expand toggle (the matrix gets unwieldy past ~10 funds).
  const wrap = el.parentElement;
  let more = wrap.querySelector("#heatmap-more");
  if (allRowCount > 10) {
    if (!more) {
      more = document.createElement("button");
      more.id = "heatmap-more";
      more.className = "mx-auto mt-3 flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-xs font-medium text-slate-500 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50";
      more.addEventListener("click", () => { heatmapExpanded = !heatmapExpanded; renderHeatmap(); });
      wrap.appendChild(more);
    }
    more.innerHTML = `<i data-lucide="${heatmapExpanded ? "chevron-up" : "chevron-down"}" class="h-3.5 w-3.5"></i>${heatmapExpanded ? "Show top 10 funds" : `+ ${allRowCount - 10} more funds`}`;
    refreshIcons();
  } else if (more) {
    more.remove();
  }
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
          <div class="font-mono text-xs text-slate-500">${zero ? "no companies (4 qtrs)" : `${f.companyCount} ${f.companyCount === 1 ? "company" : "companies"}`}</div>
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
      ${companies.length ? `<div class="grid gap-2 sm:grid-cols-2">${companies.map((c) => drillRow(c, color)).join("")}</div>` : emptyState("inbox", "No companies", "Not seen in a concall in the last 4 quarters.")}
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

// --- analyst line + guidance button (replaces raw quote blurbs) -------------
function guidanceBtn(company) {
  const has = !!(DATA.guidance && DATA.guidance.companies && DATA.guidance.companies[company]);
  return has
    ? `<button type="button" data-guid-co="${escapeHtml(company)}" class="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-100"><i data-lucide="target" class="h-3.5 w-3.5"></i>View guidance</button>`
    : `<span class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-400"><i data-lucide="clock" class="h-3.5 w-3.5"></i>Guidance coming soon</span>`;
}

function analystName(analyst, firm) {
  return analyst
    ? `<span class="inline-flex items-center gap-1.5 text-xs text-slate-500"><i data-lucide="user-round" class="h-3.5 w-3.5 shrink-0 text-slate-400"></i><a href="${linkedinUrl(analyst, firm)}" target="_blank" rel="noopener noreferrer" title="Find ${escapeHtml(analyst)} on LinkedIn" class="inline-flex items-center gap-1 font-medium text-[#0a66c2] hover:underline">${escapeHtml(analyst)}<i data-lucide="external-link" class="h-2.5 w-2.5 shrink-0"></i></a></span>`
    : `<span class="inline-flex items-center gap-1.5 text-xs text-slate-400"><i data-lucide="user-round" class="h-3.5 w-3.5 shrink-0"></i>Analyst N/A</span>`;
}

// Analyst (LinkedIn) on the left, guidance button on the right.
function analystRow(analyst, firm, company, withButton = true) {
  return `<div class="mt-2 flex flex-wrap items-center justify-between gap-2">${analystName(analyst, firm)}${withButton ? guidanceBtn(company) : ""}</div>`;
}

// Guidance popup (reuses the drill modal). Shows the company's guidance or "coming soon".
function openGuidance(company) {
  const g = DATA.guidance && DATA.guidance.companies && DATA.guidance.companies[company];
  document.getElementById("drill-content").innerHTML = `
    <div class="flex items-start justify-between gap-3 border-b border-slate-100 p-5">
      <div class="flex items-center gap-2">
        <span class="rounded-xl bg-indigo-50 p-1.5 text-indigo-500"><i data-lucide="target" class="h-4 w-4"></i></span>
        <div><div class="font-display text-xl font-semibold text-slate-800">${escapeHtml(company)}</div>
          <div class="text-xs text-slate-400">Forward guidance${g ? ` · latest call ${fmtDate(g.concall_date)}` : ""}</div></div>
      </div>
      <button id="drill-close" class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>
    <div class="scroll-area flex-1 overflow-y-auto p-5">
      ${g ? guidanceBody(g) : emptyState("clock", "Guidance coming soon", "Our AI hasn't processed this company's latest concall yet — it's queued and will appear here automatically.")}
    </div>`;
  revealModal();
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
        <i data-lucide="user-round" class="h-3 w-3 shrink-0 text-slate-400"></i>
        ${analyst
          ? `<a href="${linkedinUrl(analyst, c.fund_name)}" target="_blank" rel="noopener noreferrer" title="Find ${escapeHtml(analyst)} on LinkedIn" class="inline-flex items-center gap-1 truncate font-medium text-[#0a66c2] hover:underline">${escapeHtml(analyst)}<i data-lucide="external-link" class="h-2.5 w-2.5 shrink-0"></i></a>`
          : `<span class="truncate">—</span>`}
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
    xAxis: { type: "value", minInterval: 1, max: (DATA.funds.length || 52), splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { color: "#94a3b8", fontFamily: "JetBrains Mono" } },
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
          <td class="px-4 py-3"><div class="flex items-center gap-2"><span class="font-mono text-slate-700">${s.fundCount}<span class="text-slate-300">/${DATA.funds.length}</span></span><span class="flex gap-0.5">${fundDots(s.fundIds)}</span></div></td>
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
        <div><div class="font-mono text-2xl font-semibold text-slate-800">${s.fundCount}<span class="text-base text-slate-400">/${DATA.funds.length}</span></div><div class="text-[11px] uppercase tracking-wide text-slate-400">funds</div></div>
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
    <div class="mt-2 flex justify-end">${guidanceBtn(c.company)}</div>
  </div>`;
}

// ===========================================================================
// OVERLAP — the consensus book: which names have the most smart-money funds,
// where conviction is BUILDING (a fund just joined), and who's in each name.
// ===========================================================================
let _book = [];
let overlapSector = "all";
let overlapMin = 2;
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

function consensusBook() {
  const cutoff14 = ymdAgo(14);
  const map = new Map();
  for (const s of DATA.sightings) {
    if (!map.has(s.company)) map.set(s.company, { company: s.company, ticker: s.ticker, sector: s.sector, industry: s.industry, _latest: "", funds: new Map() });
    const a = map.get(s.company);
    const cd = s.concall_date || "";
    if (cd >= a._latest) { a._latest = cd; a.ticker = s.ticker; a.sector = s.sector; a.industry = s.industry; }
    let pf = a.funds.get(s.fund_id);
    if (!pf) { pf = { fund_id: s.fund_id, firstSeen: s.first_seen || "", date: cd, quote: s.quote, transcript_url: s.transcript_url }; a.funds.set(s.fund_id, pf); }
    if (s.first_seen && (!pf.firstSeen || s.first_seen < pf.firstSeen)) pf.firstSeen = s.first_seen;
    if (cd >= pf.date) { pf.date = cd; pf.quote = s.quote; pf.transcript_url = s.transcript_url; }
  }
  const out = [];
  for (const a of map.values()) {
    const funds = [...a.funds.values()];
    if (funds.length < 2) continue;
    const earliest = funds.reduce((m, f) => (!m || (f.firstSeen && f.firstSeen < m) ? f.firstSeen || m : m), "");
    // A fund "just joined" = its first_seen is later than the name's earliest fund AND within ~14 days.
    const newFunds = new Set(funds.filter((f) => f.firstSeen && earliest && f.firstSeen.slice(0, 10) > earliest.slice(0, 10) && f.firstSeen >= cutoff14).map((f) => f.fund_id));
    funds.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
    out.push({ company: a.company, ticker: a.ticker, sector: a.sector, industry: a.industry, fundIds: funds.map((f) => f.fund_id), fundCount: funds.length, lastDate: a._latest, perFund: funds, newFunds, building: newFunds.size > 0 });
  }
  out.sort((x, y) => y.fundCount - x.fundCount || (y.lastDate || "").localeCompare(x.lastDate || "") || x.company.localeCompare(y.company));
  return out;
}

function overlapHouseView(items, min) {
  if (!items.length) return `No companies with ${min}+ smart-money funds in this selection.`;
  const top = items.reduce((a, b) => (b.fundCount > a.fundCount ? b : a));
  const parts = [`${items.length} ${items.length === 1 ? "company has" : "companies have"} ${min}+ smart-money funds.`, `Highest conviction: ${top.company} (${top.fundCount} funds).`];
  const building = items.filter((b) => b.building).sort((a, b) => b.fundCount - a.fundCount)[0];
  if (building) parts.push(`Conviction is building in ${building.company} — a ${ordinal(building.fundCount)} fund just appeared this week.`);
  return parts.join(" ");
}

function fundAvatars(ids, newSet) {
  const shown = ids.slice(0, 8).map((id) => {
    const nw = newSet && newSet.has(id);
    return `<span title="${escapeHtml(fundName(id))}${nw ? " (just joined)" : ""}" class="grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold text-white ring-2 ${nw ? "ring-amber-400" : "ring-white"}" style="background:${fundColor(id)}">${escapeHtml(initials(fundName(id)))}</span>`;
  }).join("");
  const more = ids.length > 8 ? `<span class="grid h-7 w-7 place-items-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-500 ring-2 ring-white">+${ids.length - 8}</span>` : "";
  return `<div class="flex -space-x-1.5">${shown}${more}</div>`;
}

function renderOverlap() {
  const root = document.getElementById("tab-overlap");
  _book = consensusBook();
  const sectors = [...new Set(_book.map((b) => b.sector || "Unclassified"))].sort();
  const buildingNames = _book.filter((b) => b.building).slice(0, 4);

  const strip = buildingNames.length
    ? `<div class="mb-4">
        <div class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-600"><i data-lucide="sparkles" class="h-3.5 w-3.5"></i>Conviction building this week</div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          ${buildingNames.map((c) => `
          <button type="button" data-co="${escapeHtml(c.company)}" class="card card-hover p-4 text-left ring-1 ring-amber-200" style="box-shadow:0 0 0 1px rgba(245,158,11,.25),0 14px 32px -18px rgba(245,158,11,.5)">
            <div class="flex items-center gap-2"><span class="truncate font-semibold text-slate-800">${escapeHtml(c.company)}</span>${c.ticker ? `<span class="font-mono text-[11px] uppercase" style="color:${sectorColor(c.sector || null)}">${escapeHtml(c.ticker)}</span>` : ""}</div>
            <div class="mt-1.5">${sectorPill(c.sector, c.industry)}</div>
            <div class="mt-3 flex items-center justify-between">${fundAvatars(c.fundIds, c.newFunds)}<span class="font-mono text-xs font-semibold text-slate-600">${c.fundCount} funds</span></div>
          </button>`).join("")}
        </div>
      </div>`
    : "";

  const minBtn = (n, label) => `<button type="button" data-min="${n}" class="rounded-lg px-3 py-1.5 text-xs font-medium transition ${overlapMin === n ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-white"}">${label}</button>`;

  root.innerHTML = `
    <div class="mb-4 rounded-3xl bg-gradient-to-br from-amber-50 via-white to-indigo-50 p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1.5 flex items-center gap-2"><span class="rounded-xl bg-white p-1.5 text-amber-500 shadow-sm"><i data-lucide="git-merge" class="h-4 w-4"></i></span>
        <h2 class="font-display text-xs font-semibold uppercase tracking-wider text-slate-500">House view</h2></div>
      <p id="overlap-headline" class="font-display text-lg font-semibold leading-snug text-slate-800 sm:text-xl"></p>
      <p class="mt-2 text-[11px] text-slate-400">Signal = smart-money attention from concall participation (a leading indicator), not confirmed positions.</p>
    </div>
    ${strip}
    <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-2 rounded-xl bg-white p-1 shadow-sm ring-1 ring-slate-200">
        <span class="pl-2 text-xs text-slate-400">Min funds</span>${minBtn(2, "2+")}${minBtn(3, "3+")}${minBtn(4, "4+")}
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span class="text-slate-400">Sector</span>
        <select id="overlap-sector" class="rounded-xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400">
          <option value="all">All sectors</option>${sectors.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div id="overlap-book" class="space-y-6"></div>`;

  root.querySelectorAll("[data-min]").forEach((b) => b.addEventListener("click", () => { overlapMin = Number(b.dataset.min); renderOverlap(); }));
  const sel = root.querySelector("#overlap-sector");
  sel.value = overlapSector;
  sel.addEventListener("change", () => { overlapSector = sel.value; updateOverlapBook(); });
  root.addEventListener("click", (e) => { const t = e.target.closest("[data-co]"); if (t) openCompanyDrill(t.dataset.co); });

  updateOverlapBook();
  refreshIcons();
}

function updateOverlapBook() {
  const cont = document.getElementById("overlap-book");
  if (!cont) return;
  let items = _book.filter((b) => b.fundCount >= overlapMin && (overlapSector === "all" || (b.sector || "Unclassified") === overlapSector));
  const ohl = document.getElementById("overlap-headline");
  if (ohl) ohl.textContent = overlapHouseView(items, overlapMin);
  if (!items.length) {
    cont.innerHTML = emptyState("git-merge", "No consensus names here", "Try lowering the min-funds filter or picking another sector.");
    refreshIcons();
    return;
  }
  const tiers = [
    { label: "High conviction", sub: "4+ funds", test: (b) => b.fundCount >= 4, hi: true },
    { label: "Building", sub: "3 funds", test: (b) => b.fundCount === 3 },
    { label: "On the radar", sub: "2 funds", test: (b) => b.fundCount === 2 },
  ];
  cont.innerHTML = tiers
    .map((t) => {
      const list = items.filter(t.test);
      if (!list.length) return "";
      return `<div>
        <div class="mb-2 flex items-baseline gap-2 px-1">
          <h3 class="font-display text-sm font-bold ${t.hi ? "text-amber-600" : "text-slate-700"}">${t.label}</h3>
          <span class="text-xs text-slate-400">${t.sub} · ${list.length}</span>
        </div>
        <div class="space-y-2">${moreList(list.map((c) => overlapRow(c, t.hi)), 10, "companies")}</div>
      </div>`;
    })
    .join("");
  wireMore(cont);
  refreshIcons();
}

function overlapRow(c, hi) {
  const col = sectorColor(c.sector || null);
  const glow = hi ? `style="box-shadow:0 0 0 1px rgba(99,102,241,.18),0 14px 30px -18px rgba(99,102,241,.45)"` : "";
  return `<button type="button" data-co="${escapeHtml(c.company)}" class="card card-hover flex w-full items-center gap-3 p-3.5 text-left ${hi ? "ring-1 ring-indigo-100" : ""}" ${glow}>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <span class="truncate font-semibold text-slate-800">${escapeHtml(c.company)}</span>
        ${c.ticker ? `<span class="font-mono text-xs uppercase tracking-wide" style="color:${col}">${escapeHtml(c.ticker)}</span>` : ""}
        ${c.building ? `<span class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700"><i data-lucide="sparkles" class="h-2.5 w-2.5"></i>building</span>` : ""}
      </div>
      <div class="mt-1.5 flex flex-wrap items-center gap-2">${sectorPill(c.sector, c.industry)}<span class="inline-flex items-center gap-1 font-mono text-[11px] text-slate-400"><i data-lucide="calendar" class="h-3 w-3"></i>${fmtDate(c.lastDate)}</span></div>
    </div>
    <div class="flex shrink-0 items-center gap-3">
      ${fundAvatars(c.fundIds, c.newFunds)}
      <span class="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs font-semibold text-slate-600">${c.fundCount} funds</span>
    </div>
  </button>`;
}

function openCompanyDrill(company) {
  const c = _book.find((x) => x.company === company);
  if (!c) return;
  const col = sectorColor(c.sector || null);
  const blocks = c.perFund.map((pf) => {
    const fc = fundColor(pf.fund_id);
    const isNew = c.newFunds.has(pf.fund_id);
    return `<div class="rounded-2xl bg-slate-50/60 p-3 ring-1 ring-slate-100">
      <div class="flex flex-wrap items-center gap-2">
        <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold" style="background:${fc}1a;color:${fc}"><span class="h-2 w-2 rounded-full" style="background:${fc}"></span>${escapeHtml(fundName(pf.fund_id))}</span>
        ${isNew ? `<span class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700">New</span>` : ""}
        <span class="ml-auto inline-flex items-center gap-2"><span class="font-mono text-xs text-slate-400">${fmtDate(pf.date)}</span>${transcriptBtn(pf.transcript_url)}</span>
      </div>
      ${analystRow(analystOf(pf.quote, null), fundName(pf.fund_id), c.company, false)}
    </div>`;
  }).join("");
  document.getElementById("drill-content").innerHTML = `
    <div class="flex items-start justify-between gap-3 border-b border-slate-100 p-5">
      <div>
        <div class="flex items-center gap-2"><span class="font-display text-xl font-semibold text-slate-800">${escapeHtml(c.company)}</span>${c.ticker ? `<span class="font-mono text-sm uppercase tracking-wide" style="color:${col}">${escapeHtml(c.ticker)}</span>` : ""}</div>
        <div class="mt-1.5 flex items-center gap-2">${sectorPill(c.sector, c.industry)}<span class="text-xs font-medium text-slate-500">${c.fundCount} smart-money funds</span></div>
      </div>
      <button id="drill-close" class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>
    <div class="scroll-area flex-1 space-y-2 overflow-y-auto p-4">
      <div class="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Who's interested — and the evidence</div>
      ${blocks}
      ${guidanceDrillBlock(c.company)}
    </div>`;
  revealModal();
  wireShowMore(document.getElementById("drill-content"));
  refreshIcons();
}

// ===========================================================================
// RECENT FLAGS — the chronological monitoring feed: "what's new on the radar
// since I last looked", newest first, with First-interest vs Repeat novelty.
// ===========================================================================
let _flags = [];
let flagFunds = new Set(); // selected fund_ids (empty = all)
let flagSector = "all";
let flagFirstOnly = false;
let flagWindow = "month"; // today | week | month | quarter | all
const FLAG_WINDOWS = [["today", "Today"], ["week", "This week"], ["month", "This month"], ["quarter", "This quarter"], ["all", "All time"]];
const flagWindowCutoff = () => ({ today: ymdAgo(0), week: ymdAgo(7), month: ymdAgo(30), quarter: ymdAgo(92), all: "0000-01-01" }[flagWindow] || "0000-01-01");

function buildFlags() {
  // first_seen = when it appeared on our radar (gets more granular as daily runs
  // add flags over time). Fall back to concall_date.
  const pairFirst = new Map(); // fund|company -> earliest flag date
  const pairCount = new Map();
  for (const s of DATA.sightings) {
    const k = s.fund_id + "|" + s.company;
    const fd = s.first_seen || s.concall_date || "";
    if (!pairFirst.has(k) || fd < pairFirst.get(k)) pairFirst.set(k, fd);
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }
  return DATA.sightings
    .map((s) => {
      const k = s.fund_id + "|" + s.company;
      const fd = s.first_seen || s.concall_date || "";
      const firstInterest = !(pairCount.get(k) > 1 && fd > pairFirst.get(k));
      return { ...s, flagDate: fd, firstInterest };
    })
    .sort((a, b) => (b.flagDate || "").localeCompare(a.flagDate || "") || (b.concall_date || "").localeCompare(a.concall_date || ""));
}

function flagsHouseView(items, label) {
  if (!items.length) return `No appearances ${label} for this selection.`;
  const firstCnt = items.filter((f) => f.firstInterest).length;
  const parts = [`${items.length} appearance${items.length === 1 ? "" : "s"} ${label}.`, `${firstCnt} ${firstCnt === 1 ? "is" : "are"} first-time interest.`];
  const nf = items.find((f) => f.firstInterest), nr = items.find((f) => !f.firstInterest);
  const bits = [];
  if (nf) bits.push(`${nf.fund_name} in ${nf.company} for the first time`);
  if (nr) bits.push(`${nr.fund_name} re-engaged ${nr.company}`);
  if (bits.length) parts.push("Notable: " + bits.join("; ") + ".");
  return parts.join(" ");
}

function renderFlags() {
  const root = document.getElementById("tab-flags");
  _flags = buildFlags();
  const todayN = _flags.filter((f) => isToday(f.concall_date)).length;
  const weekN = _flags.filter((f) => (f.concall_date || "") >= ymdAgo(7)).length;
  const activeFunds = DATA.funds.filter((f) => DATA.sightings.some((s) => s.fund_id === f.id));
  const sectors = [...new Set(_flags.map((f) => f.sector || "Unclassified"))].sort();

  // selected funds → removable chips; the rest live in the "add fund" dropdown
  const selChips = activeFunds.filter((f) => flagFunds.has(f.id)).map((f) => {
    const c = fundColor(f.id);
    return `<button type="button" data-flagfund="${f.id}" title="Remove" class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90" style="background:${c}"><span class="h-1.5 w-1.5 rounded-full bg-white"></span>${escapeHtml(f.name)}<i data-lucide="x" class="h-3 w-3"></i></button>`;
  }).join("");
  const fundOpts = activeFunds.filter((f) => !flagFunds.has(f.id))
    .map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("");

  root.innerHTML = `
    <div class="mb-4 rounded-3xl bg-gradient-to-br from-emerald-50 via-white to-indigo-50 p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1.5 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2"><span class="rounded-xl bg-white p-1.5 text-emerald-500 shadow-sm"><i data-lucide="bell" class="h-4 w-4"></i></span>
          <h2 class="font-display text-xs font-semibold uppercase tracking-wider text-slate-500">House view</h2></div>
        <div class="flex gap-2">
          <span class="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm ring-1 ring-slate-100">Today <span class="font-mono font-semibold text-emerald-600">${todayN}</span></span>
          <span class="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm ring-1 ring-slate-100">7 days <span class="font-mono font-semibold text-indigo-600">${weekN}</span></span>
        </div>
      </div>
      <p id="flag-headline" class="font-display text-lg font-semibold leading-snug text-slate-800 sm:text-xl"></p>
      <p class="mt-2 text-[11px] text-slate-400">A live feed of where smart money showed up, newest first. Attention from concall participation (a leading indicator), not confirmed positions. <span class="text-slate-300">For who's <em>entering/exiting</em> a name, see the Shifts tab.</span></p>
    </div>
    <div class="mb-4 flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2 text-sm">
          <span class="text-slate-400">When</span>
          <select id="flag-window" class="rounded-xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400">
            ${FLAG_WINDOWS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
          </select>
        </div>
        <div class="flex items-center gap-2 text-sm">
          <span class="text-slate-400">Fund</span>
          <select id="flag-fund-add" class="rounded-xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400">
            <option value="">${flagFunds.size ? "Add another fund…" : "All funds — pick to filter…"}</option>${fundOpts}
          </select>
        </div>
        <div class="flex items-center gap-2 text-sm">
          <span class="text-slate-400">Sector</span>
          <select id="flag-sector" class="rounded-xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400">
            <option value="all">All sectors</option>${sectors.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
          </select>
        </div>
        <button type="button" id="flag-first" class="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition ${flagFirstOnly ? "bg-emerald-600 text-white shadow-sm" : "bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"}"><i data-lucide="sparkles" class="h-4 w-4"></i>First interest only</button>
      </div>
      ${flagFunds.size ? `<div id="flag-fund-sel" class="flex flex-wrap items-center gap-1.5">${selChips}<button type="button" id="flag-clear" class="ml-1 text-xs font-medium text-slate-400 hover:text-slate-600">clear all</button></div>` : ""}
    </div>
    <div id="flags-feed" class="space-y-2.5"></div>`;

  const addSel = root.querySelector("#flag-fund-add");
  addSel.addEventListener("change", () => { if (addSel.value) { flagFunds.add(addSel.value); renderFlags(); } });
  const selWrap = root.querySelector("#flag-fund-sel");
  if (selWrap) selWrap.addEventListener("click", (e) => { const b = e.target.closest("[data-flagfund]"); if (!b) return; flagFunds.delete(b.dataset.flagfund); renderFlags(); });
  root.querySelector("#flag-first").addEventListener("click", () => { flagFirstOnly = !flagFirstOnly; renderFlags(); });
  const sel = root.querySelector("#flag-sector"); sel.value = flagSector;
  sel.addEventListener("change", () => { flagSector = sel.value; updateFlagsFeed(); });
  const win = root.querySelector("#flag-window"); win.value = flagWindow;
  win.addEventListener("change", () => { flagWindow = win.value; updateFlagsFeed(); });
  const clr = root.querySelector("#flag-clear"); if (clr) clr.addEventListener("click", () => { flagFunds.clear(); renderFlags(); });

  wireMore(root);
  updateFlagsFeed();
  refreshIcons();
}

function updateFlagsFeed() {
  const feed = document.getElementById("flags-feed");
  if (!feed) return;
  const fbc = fundsByCompany();
  const cutoff = flagWindowCutoff();
  let items = _flags.filter((f) =>
    (f.concall_date || "") >= cutoff &&
    (!flagFunds.size || flagFunds.has(f.fund_id)) &&
    (flagSector === "all" || (f.sector || "Unclassified") === flagSector) &&
    (!flagFirstOnly || f.firstInterest)
  );
  const label = (FLAG_WINDOWS.find(([v]) => v === flagWindow) || [, "this period"])[1].toLowerCase();
  items = items.slice().sort((a, b) => (b.concall_date || "").localeCompare(a.concall_date || ""));
  const hl = document.getElementById("flag-headline");
  if (hl) hl.textContent = flagsHouseView(items, label);
  if (!items.length) {
    feed.innerHTML = emptyState("bell-off", `No activity ${label}`, "Widen the time window, or loosen the fund/sector filters.");
    refreshIcons();
    return;
  }
  feed.innerHTML = `<div class="mb-1 px-1 text-xs font-semibold uppercase tracking-wider text-slate-400">${items.length} appearance${items.length === 1 ? "" : "s"} ${label}</div>`
    + moreList(items.map((f) => flagCard(f, fbc)), 10, "appearances");
  refreshIcons();
}

function flagCard(f, fbc) {
  const c = fundColor(f.fund_id);
  const others = (fbc.get(f.company)?.size || 1) - 1;
  const tag = f.firstInterest
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600"><i data-lucide="badge-check" class="h-3 w-3"></i>First interest</span>`
    : `<span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500"><i data-lucide="repeat" class="h-3 w-3"></i>Repeat</span>`;
  const isNew = isToday(f.concall_date);
  return `<div class="card card-hover overflow-hidden p-4" style="border-left:4px solid ${c}">
    <div class="flex items-start gap-3">
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl font-display text-[11px] font-bold text-white shadow-sm" style="background:${c}">${escapeHtml(initials(f.fund_name))}</span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="font-medium text-slate-800"><span style="color:${c}" class="font-semibold">${escapeHtml(f.fund_name)}</span> spotted in <span class="font-semibold">${escapeHtml(f.company)}</span></span>
          ${isNew ? `<span class="new-pulse inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700"><i data-lucide="sparkles" class="h-2.5 w-2.5"></i>New</span>` : ""}
        </div>
        <div class="mt-1.5 flex flex-wrap items-center gap-2">
          ${f.ticker ? `<span class="font-mono text-xs uppercase tracking-wide" style="color:${c}">${escapeHtml(f.ticker)}</span>` : ""}
          ${sectorPill(f.sector, f.industry)}
          <span class="inline-flex items-center gap-1 font-mono text-[11px] text-slate-400"><i data-lucide="calendar" class="h-3 w-3"></i>${fmtDate(f.concall_date)}</span>
          ${tag}
        </div>
        ${analystRow(analystOf(f.quote, f.matched_alias), f.fund_name, f.company)}
        <div class="mt-2 flex items-center justify-between">
          <span class="text-[11px] text-slate-400">${others > 0 ? `${others} other fund${others === 1 ? "" : "s"} also here` : ""}</span>
          ${transcriptBtn(f.transcript_url)}
        </div>
      </div>
    </div>
  </div>`;
}

// ===========================================================================
// Attention Shifts — funds that went quiet (lost interest) / newly engaged
// ===========================================================================
let shiftsView = "dropped"; // "dropped" | "gained"
let shiftsSector = "all";

function renderShifts() {
  const root = document.getElementById("tab-shifts");
  const t = DATA.trends || { dropped: [], gained: [], summary: {} };
  const sum = t.summary || {};
  const sectors = [...new Set([...(t.dropped || []), ...(t.gained || [])].map((x) => x.sector || "Unclassified"))].sort();
  const tab = (id, label, n, on, color) =>
    `<button type="button" data-shift="${id}" class="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition ${on ? "text-white shadow-sm" : "bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"}" ${on ? `style="background:${color}"` : ""}>${label}<span class="font-mono ${on ? "text-white/80" : "text-slate-400"}">${n}</span></button>`;

  root.innerHTML = `
    <div class="mb-4 rounded-3xl bg-gradient-to-br from-rose-50 via-white to-indigo-50 p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1.5 flex items-center gap-2">
        <span class="rounded-xl bg-white p-1.5 text-rose-500 shadow-sm"><i data-lucide="trending-down" class="h-4 w-4"></i></span>
        <h2 class="font-display text-xs font-semibold uppercase tracking-wider text-slate-500">Attention shifts</h2>
      </div>
      <p id="shifts-headline" class="font-display text-lg font-semibold leading-snug text-slate-800 sm:text-xl"></p>
      <p class="mt-2 text-[11px] text-slate-400">A fund here attended a company's earlier concalls but stopped participating on the most recent one — a leading <span class="font-medium text-slate-500">loss-of-attention</span> signal, <span class="font-medium text-slate-500">not</span> proof it sold. "New" = first appearance on the latest call.</p>
    </div>
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <div class="flex gap-2">
        ${tab("dropped", "Lost interest", sum.dropped || 0, shiftsView === "dropped", "#f43f5e")}
        ${tab("gained", "New interest", sum.gained || 0, shiftsView === "gained", "#10b981")}
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span class="text-slate-400">Sector</span>
        <select id="shift-sector" class="rounded-xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400">
          <option value="all">All sectors</option>${sectors.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div id="shifts-feed" class="space-y-6"></div>`;

  root.querySelectorAll("[data-shift]").forEach((b) => b.addEventListener("click", () => { shiftsView = b.dataset.shift; renderShifts(); }));
  const sel = root.querySelector("#shift-sector"); sel.value = shiftsSector;
  sel.addEventListener("change", () => { shiftsSector = sel.value; updateShiftsFeed(); });
  root.addEventListener("click", (e) => { const c = e.target.closest("[data-co]"); if (c) openCompanyDrill(c.dataset.co); });
  updateShiftsFeed();
  refreshIcons();
}

function updateShiftsFeed() {
  const feed = document.getElementById("shifts-feed");
  if (!feed) return;
  const t = DATA.trends || { dropped: [], gained: [] };
  let items = (t[shiftsView] || []).filter((x) => shiftsSector === "all" || (x.sector || "Unclassified") === shiftsSector);
  const where = shiftsSector === "all" ? "" : ` in ${shiftsSector}`;
  const shl = document.getElementById("shifts-headline");
  if (shl) {
    if (shiftsView === "dropped") {
      const strong = items.filter((x) => x.tier === "strong").length;
      shl.textContent = `${items.length} fund–company relationship${items.length === 1 ? "" : "s"} went quiet on the latest call${where} · ${strong} strong signal${strong === 1 ? "" : "s"}.`;
    } else {
      shl.textContent = `${items.length} new fund engagement${items.length === 1 ? "" : "s"} on the latest call${where}.`;
    }
  }
  if (!items.length) {
    feed.innerHTML = emptyState(shiftsView === "dropped" ? "smile" : "search", "Nothing here", shiftsView === "dropped" ? "No funds dropped a name in this slice — that's a good sign." : "No new fund engagements in this slice yet.");
    refreshIcons();
    return;
  }
  if (shiftsView === "gained") {
    feed.innerHTML = `<div class="space-y-2.5">${moreList(items.map(shiftCard), 10, "companies")}</div>`;
    wireMore(feed);
    refreshIcons();
    return;
  }
  const groups = { strong: items.filter((x) => x.tier === "strong"), medium: items.filter((x) => x.tier === "medium") };
  const labels = { strong: ["Strong signal", "flame", "attended 3+ prior calls, then absent"], medium: ["Worth watching", "eye", "attended 2 prior calls, then absent"] };
  feed.innerHTML = Object.entries(groups).filter(([, arr]) => arr.length).map(([k, arr]) => `
    <div>
      <h3 class="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
        <i data-lucide="${labels[k][1]}" class="h-3.5 w-3.5"></i>${labels[k][0]}<span class="font-mono text-slate-300">${arr.length}</span>
        <span class="font-sans normal-case tracking-normal text-slate-300">· ${labels[k][2]}</span>
      </h3>
      <div class="space-y-2.5">${moreList(arr.map(shiftCard), 10, "companies")}</div>
    </div>`).join("");
  wireMore(feed);
  refreshIcons();
}

function shiftCard(x) {
  const c = fundColor(x.fund_id);
  const dropped = shiftsView === "dropped";
  const accent = dropped ? "#f43f5e" : "#10b981";
  const verb = dropped
    ? `went quiet on <span class="font-semibold">${escapeHtml(x.company)}</span>`
    : `newly engaged <span class="font-semibold">${escapeHtml(x.company)}</span>`;
  const detail = dropped
    ? `<span class="inline-flex items-center gap-1"><i data-lucide="history" class="h-3 w-3"></i>attended ${x.prior_calls_attended} prior call${x.prior_calls_attended === 1 ? "" : "s"} · last seen ${fmtDate(x.last_seen_date)}</span><span class="inline-flex items-center gap-1"><i data-lucide="x-circle" class="h-3 w-3"></i>absent from latest call ${fmtDate(x.latest_call_date)}</span>`
    : `<span class="inline-flex items-center gap-1"><i data-lucide="sparkles" class="h-3 w-3"></i>first appeared on latest call ${fmtDate(x.latest_call_date)}</span>`;
  const badge = dropped
    ? `<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${x.tier === "strong" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}">${x.tier}</span>`
    : `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">new</span>`;
  return `<div class="card card-hover cursor-pointer overflow-hidden p-4" style="border-left:4px solid ${accent}" data-co="${escapeHtml(x.company)}">
    <div class="flex items-start gap-3">
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl font-display text-[11px] font-bold text-white shadow-sm" style="background:${c}">${escapeHtml(initials(x.fund_name))}</span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="font-medium text-slate-800"><span style="color:${c}" class="font-semibold">${escapeHtml(x.fund_name)}</span> ${verb}</span>
          ${badge}
        </div>
        <div class="mt-1.5 flex flex-wrap items-center gap-2">
          ${x.ticker ? `<span class="font-mono text-xs uppercase tracking-wide" style="color:${c}">${escapeHtml(x.ticker)}</span>` : ""}
          ${sectorPill(x.sector, null)}
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-slate-400">${detail}</div>
      </div>
    </div>
  </div>`;
}

// ===========================================================================
// Forward Guidance — LLM-extracted, specificity-flagged (from latest concall)
// ===========================================================================
let guidanceSearch = "";
let guidanceSector = "all";

function renderGuidance() {
  const root = document.getElementById("tab-guidance");
  const all = Object.values((DATA.guidance && DATA.guidance.companies) || {});
  if (!all.length) {
    root.innerHTML = emptyState("target", "Guidance is being extracted", "An LLM is reading the most recent concalls and pulling forward guidance. Cards appear here as companies are processed — check back shortly.");
    refreshIcons();
    return;
  }
  const sectors = [...new Set(all.map((g) => g.sector || "Unclassified"))].sort();
  root.innerHTML = `
    <div class="mb-4 rounded-3xl bg-gradient-to-br from-indigo-50 via-white to-emerald-50 p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1.5 flex items-center gap-2">
        <span class="rounded-xl bg-white p-1.5 text-indigo-500 shadow-sm"><i data-lucide="target" class="h-4 w-4"></i></span>
        <h2 class="font-display text-xs font-semibold uppercase tracking-wider text-slate-500">Forward guidance</h2>
      </div>
      <p class="font-display text-lg font-semibold leading-snug text-slate-800 sm:text-xl">What management committed to on the latest call — flagged <span class="text-emerald-600">specific</span>, <span class="text-amber-600">vague</span>, or <span class="text-rose-500">refused</span>.</p>
      <p class="mt-2 text-[11px] text-slate-400"><span id="guid-count">${all.length} companies</span> · AI-extracted from the concall transcript — always verify against the source before acting.</p>
    </div>
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <div class="relative flex-1 min-w-[200px]">
        <i data-lucide="search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"></i>
        <input id="guid-search" type="text" placeholder="Search company or ticker…" class="w-full rounded-xl bg-white py-2 pl-9 pr-3 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400" />
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span class="text-slate-400">Sector</span>
        <select id="guid-sector" class="rounded-xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400">
          <option value="all">All sectors</option>${sectors.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div id="guid-feed" class="space-y-4"></div>`;

  const si = root.querySelector("#guid-search");
  si.value = guidanceSearch;
  si.addEventListener("input", () => { guidanceSearch = si.value; updateGuidanceFeed(); });
  const se = root.querySelector("#guid-sector"); se.value = guidanceSector;
  se.addEventListener("change", () => { guidanceSector = se.value; updateGuidanceFeed(); });
  wireMore(root);
  updateGuidanceFeed();
  refreshIcons();
}

function updateGuidanceFeed() {
  const feed = document.getElementById("guid-feed");
  if (!feed) return;
  const q = guidanceSearch.trim().toLowerCase();
  let items = Object.values(DATA.guidance.companies || {}).filter((g) =>
    (guidanceSector === "all" || (g.sector || "Unclassified") === guidanceSector) &&
    (!q || (g.company || "").toLowerCase().includes(q) || (g.ticker || "").toLowerCase().includes(q))
  );
  items.sort((a, b) => (b.concall_date || "").localeCompare(a.concall_date || ""));
  const total = Object.keys(DATA.guidance.companies || {}).length;
  const gc = document.getElementById("guid-count");
  const filtered = guidanceSector !== "all" || q;
  if (gc) gc.textContent = filtered ? `${items.length} of ${total} companies` : `${total} ${total === 1 ? "company" : "companies"}`;
  if (!items.length) {
    feed.innerHTML = emptyState("search-x", "No matches", "Try another company, ticker, or sector.");
    refreshIcons();
    return;
  }
  feed.innerHTML = moreList(items.map(guidanceCard), 10, "companies");
  refreshIcons();
}

const SPEC_STYLE = {
  specific: { dot: "#10b981", chip: "bg-emerald-50 text-emerald-700" },
  vague: { dot: "#f59e0b", chip: "bg-amber-50 text-amber-700" },
  refused: { dot: "#f43f5e", chip: "bg-rose-50 text-rose-700" },
};
const DIR_ICON = { up: "trending-up", down: "trending-down", flat: "move-right", unclear: "help-circle" };

function guidanceItemRows(g) {
  const rows = (g.guidance || []).map((it) => {
    const sp = SPEC_STYLE[it.specificity] || SPEC_STYLE.vague;
    return `<div class="flex items-start gap-2.5 rounded-xl bg-slate-50/70 p-2.5 ring-1 ring-slate-100">
      <span class="mt-1 h-2 w-2 shrink-0 rounded-full" style="background:${sp.dot}"></span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-sm font-semibold text-slate-800">${escapeHtml(it.metric || "—")}</span>
          ${it.horizon ? `<span class="font-mono text-[11px] text-slate-400">${escapeHtml(it.horizon)}</span>` : ""}
          <span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${sp.chip}">${escapeHtml(it.specificity || "—")}</span>
          ${it.direction && it.direction !== "unclear" ? `<i data-lucide="${DIR_ICON[it.direction] || "minus"}" class="h-3.5 w-3.5 text-slate-400"></i>` : ""}
        </div>
        <p class="mt-0.5 text-[13px] leading-snug text-slate-600">${escapeHtml(it.statement || "")}</p>
      </div>
    </div>`;
  }).join("");
  return rows || `<p class="text-sm text-slate-400">No forward guidance extracted.</p>`;
}

function guidanceTags(g) {
  const tagRow = (label, arr, icon, cls) => (arr && arr.length)
    ? `<div class="mt-3"><div class="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400"><i data-lucide="${icon}" class="h-3 w-3"></i>${label}</div>
       <div class="flex flex-wrap gap-1.5">${arr.map((x) => `<span class="rounded-full ${cls} px-2 py-0.5 text-[11px]">${escapeHtml(x)}</span>`).join("")}</div></div>`
    : "";
  return tagRow("Refused to guide", g.refused_to_guide, "shield-off", "bg-rose-50 text-rose-600")
    + tagRow("Margin drivers", g.margin_drivers, "settings-2", "bg-slate-100 text-slate-600");
}

function guidanceBody(g) {
  return `${g.summary ? `<p class="mb-3 rounded-xl bg-indigo-50/50 p-3 text-sm italic leading-snug text-slate-600">“${escapeHtml(g.summary)}”</p>` : ""}
    <div class="space-y-2">${guidanceItemRows(g)}</div>
    ${guidanceTags(g)}
    <p class="mt-3 text-[10px] text-slate-300">AI-extracted (${escapeHtml(g.provider || "llm")}) · verify against transcript</p>`;
}

// Guidance block for the company drill (shown alongside the fund evidence).
function guidanceDrillBlock(company) {
  const g = (DATA.guidance && DATA.guidance.companies && DATA.guidance.companies[company]) || null;
  if (!g) return "";
  const n = (g.guidance || []).length;
  return `<div class="mt-4 rounded-2xl bg-white p-4 ring-1 ring-slate-100">
      <div class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-500"><i data-lucide="target" class="h-3.5 w-3.5"></i>Forward guidance · latest call ${fmtDate(g.concall_date)}<span class="font-mono text-slate-300">${n} item${n === 1 ? "" : "s"}</span></div>
      ${guidanceBody(g)}
    </div>`;
}

// Click-to-expand accordion card for the Guidance tab.
function guidanceCard(g) {
  const col = sectorColor(g.sector || null);
  const n = (g.guidance || []).length;
  const specN = (g.guidance || []).filter((x) => x.specificity === "specific").length;
  return `<details class="card overflow-hidden" style="border-top:3px solid ${col}">
    <summary class="guid-sum flex cursor-pointer items-center gap-3 p-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-display text-base font-bold text-slate-800">${escapeHtml(g.company)}</span>
          ${g.ticker ? `<span class="font-mono text-xs uppercase tracking-wide" style="color:${col}">${escapeHtml(g.ticker)}</span>` : ""}
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-2">${sectorPill(g.sector, null)}<span class="inline-flex items-center gap-1 font-mono text-[11px] text-slate-400"><i data-lucide="calendar" class="h-3 w-3"></i>${fmtDate(g.concall_date)}</span></div>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <span class="hidden sm:inline rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">${specN} specific</span>
        <span class="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs font-semibold text-slate-600">${n} items</span>
        <i data-lucide="chevron-down" class="guid-chev h-4 w-4 text-slate-400 transition-transform"></i>
      </div>
    </summary>
    <div class="border-t border-slate-100 p-5 pt-4">${guidanceBody(g)}</div>
  </details>`;
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
  overlap: renderOverlap,
  shifts: renderShifts,
  guidance: renderGuidance,
  flags: renderFlags,
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
  const todayNew = DATA.sightings.filter((x) => isToday(x.concall_date)).length;
  const el = document.querySelector('[data-badge="flags"]');
  if (el) { el.textContent = todayNew; el.classList.toggle("hidden", todayNew === 0); }
}

// --- boot ------------------------------------------------------------------
// --- data export -----------------------------------------------------------
const EXPORT_COLS = [
  { header: "Fund", key: "fund", width: 24 },
  { header: "Company", key: "company", width: 26 },
  { header: "Ticker", key: "ticker", width: 12 },
  { header: "Sector", key: "sector", width: 22 },
  { header: "Industry", key: "industry", width: 28 },
  { header: "Concall Date", key: "concall_date", width: 14 },
  { header: "Occurrences", key: "occurrences", width: 12 },
  { header: "First Interest?", key: "first_interest", width: 14 },
  { header: "Funds On Name", key: "funds_on_name", width: 14 },
  { header: "Analyst", key: "analyst", width: 22 },
  { header: "Transcript URL", key: "transcript_url", width: 50 },
  { header: "First Seen", key: "first_seen", width: 22 },
];

function exportRows() {
  const pairFirst = new Map(), pairCount = new Map();
  for (const s of DATA.sightings) {
    const k = s.fund_id + "|" + s.company;
    const fd = s.first_seen || s.concall_date || "";
    if (!pairFirst.has(k) || fd < pairFirst.get(k)) pairFirst.set(k, fd);
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }
  const fbc = fundsByCompany();
  return DATA.sightings.map((s) => {
    const k = s.fund_id + "|" + s.company;
    const fd = s.first_seen || s.concall_date || "";
    const first = !(pairCount.get(k) > 1 && fd > pairFirst.get(k));
    return {
      fund_id: s.fund_id, // for styling only (not a column)
      fund: s.fund_name || "", company: s.company || "", ticker: s.ticker || "",
      sector: s.sector || "", industry: s.industry || "", concall_date: s.concall_date || "",
      occurrences: s.occurrences || 1, first_interest: first ? "Yes" : "No",
      funds_on_name: fbc.get(s.company)?.size || 1,
      analyst: analystOf(s.quote, s.matched_alias) || "—",
      transcript_url: s.transcript_url || "", first_seen: s.first_seen || "",
    };
  });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// css color → Excel ARGB (handles #rrggbb and hsl(h,s%,l%))
function toArgb(css) {
  if (!css) return "FF94A3B8";
  if (css[0] === "#") return "FF" + css.slice(1).toUpperCase();
  const m = css.match(/hsl\(([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)/);
  if (m) {
    const h = +m[1], s = +m[2] / 100, l = +m[3] / 100, a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(255 * c).toString(16).padStart(2, "0"); };
    return "FF" + (f(0) + f(8) + f(4)).toUpperCase();
  }
  return "FF94A3B8";
}
const BRAND = "FF6366F1", BRAND_LT = "FFEEF2FF", INK = "FF1E293B", MUTE = "FF64748B";

function buildSightingsSheet(wb, rows) {
  const ws = wb.addWorksheet("Sightings", { views: [{ state: "frozen", ySplit: 3 }] });
  const N = EXPORT_COLS.length, last = "L";
  ws.columns = EXPORT_COLS.map((c) => ({ key: c.key, width: c.width }));
  // Title + subtitle
  ws.mergeCells(`A1:${last}1`);
  Object.assign(ws.getCell("A1"), { value: "📡 Fund Tracker — MGA · Smart-Money Sightings" });
  ws.getCell("A1").font = { name: "Calibri", bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
  ws.getCell("A1").alignment = { vertical: "middle" };
  ws.getRow(1).height = 30;
  ws.mergeCells(`A2:${last}2`);
  ws.getCell("A2").value = `Rolling 4-quarter concall participation · ${rows.length} sightings · ${DATA.funds.length} funds · a leading-indicator attention signal, not confirmed positions`;
  ws.getCell("A2").font = { italic: true, size: 10, color: { argb: MUTE } };
  ws.getRow(2).height = 18;
  // Header row (3)
  const hr = ws.addRow(EXPORT_COLS.map((c) => c.header));
  hr.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } };
    c.alignment = { vertical: "middle" };
    c.border = { bottom: { style: "thin", color: { argb: "FFC7D2FE" } } };
  });
  hr.height = 22;
  // Data rows
  rows.forEach((r, i) => {
    const row = ws.addRow(r);
    const banded = i % 2 === 1;
    row.eachCell((c) => {
      if (banded) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFF" } };
      c.alignment = { vertical: "middle" };
      c.font = { size: 10, color: { argb: INK } };
    });
    // fund-color left accent on the Fund cell
    row.getCell("fund").border = { left: { style: "thick", color: { argb: toArgb(fundColor(r.fund_id)) } } };
    row.getCell("fund").font = { size: 10, bold: true, color: { argb: INK } };
    // First Interest? colored
    const fi = row.getCell("first_interest");
    const yes = r.first_interest === "Yes";
    fi.fill = { type: "pattern", pattern: "solid", fgColor: { argb: yes ? "FFD1FAE5" : "FFF1F5F9" } };
    fi.font = { size: 10, bold: true, color: { argb: yes ? "FF047857" : "FF94A3B8" } };
    fi.alignment = { vertical: "middle", horizontal: "center" };
    row.getCell("funds_on_name").alignment = { vertical: "middle", horizontal: "center" };
    row.getCell("occurrences").alignment = { vertical: "middle", horizontal: "center" };
  });
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: N } };
  // in-cell data bar on "Funds On Name" (chart-like)
  try {
    ws.addConditionalFormatting({ ref: `I4:I${3 + rows.length}`, rules: [{ type: "dataBar", cfvo: [{ type: "min" }, { type: "max" }], color: { argb: "FF8B5CF6" } }] });
  } catch (e) { console.warn("databar skipped:", e.message); }
}

function buildSummarySheet(wb) {
  const ws = wb.addWorksheet("Summary");
  ws.columns = [{ width: 3 }, { width: 26 }, { width: 12 }, { width: 16 }, { width: 2 }, { width: 3 }, { width: 26 }, { width: 12 }, { width: 16 }];
  ws.mergeCells("A1:I1");
  ws.getCell("A1").value = "📡 Fund Tracker — MGA · Summary";
  ws.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
  ws.getCell("A1").alignment = { vertical: "middle" };
  ws.getRow(1).height = 30;

  // KPI cards (row 3–4, four cards)
  const sights = DATA.sightings;
  const activeFunds = new Set(sights.map((s) => s.fund_id)).size;
  const companies = DATA.meta.company_count ?? new Set(sights.map((s) => s.company)).size;
  const book = consensusBook();
  const kpis = [
    { span: "A3:B4", v: sights.length, l: "Engagements", c: "FF6366F1" },
    { span: "C3:D4", v: `${activeFunds} / ${DATA.funds.length}`, l: "Active Funds", c: "FF10B981" },
    { span: "F3:G4", v: companies, l: "Companies", c: "FF0EA5E9" },
    { span: "H3:I4", v: book.length, l: "Consensus (2+)", c: "FFF59E0B" },
  ];
  kpis.forEach((k) => {
    ws.mergeCells(k.span);
    const cell = ws.getCell(k.span.split(":")[0]);
    cell.value = `${k.v}\n${k.l}`;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: k.c } };
    cell.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  ws.getRow(3).height = 22; ws.getRow(4).height = 22;

  const sectionHdr = (ref, text) => {
    ws.mergeCells(ref);
    const cell = ws.getCell(ref.split(":")[0]);
    cell.value = text;
    cell.font = { bold: true, size: 11, color: { argb: BRAND } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_LT } };
    cell.alignment = { vertical: "middle" };
  };
  const colHdr = (cellRef, text, align) => { const c = ws.getCell(cellRef); c.value = text; c.font = { bold: true, size: 9, color: { argb: MUTE } }; c.alignment = { vertical: "middle", horizontal: align || "left" }; };

  // Funds (A–D) and Sectors (F–I) side by side, starting row 6
  const HDR = 6, START = 7;
  sectionHdr("A6:D6", "Top funds by reach");
  sectionHdr("F6:I6", "Sectors by conviction");
  colHdr("B7", "Fund"); colHdr("C7", "Companies", "center"); colHdr("D7", "Engagements", "center");
  colHdr("G7", "Sector"); colHdr("H7", "Funds", "center"); colHdr("I7", "Engagements", "center");

  const funds = [...groupByFund().values()].map((f) => ({ name: f.name, id: f.id, companies: companiesOf(f.sightings).length, eng: f.sightings.length })).sort((a, b) => b.companies - a.companies);
  const sectors = sectorStats().filter((s) => s.sector !== "Unclassified");
  funds.forEach((f, i) => {
    const r = START + 1 + i;
    ws.getCell(`A${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: toArgb(fundColor(f.id)) } };
    ws.getCell(`B${r}`).value = f.name; ws.getCell(`B${r}`).font = { size: 10, color: { argb: INK } };
    ws.getCell(`C${r}`).value = f.companies; ws.getCell(`C${r}`).alignment = { horizontal: "center" };
    ws.getCell(`D${r}`).value = f.eng;
  });
  sectors.forEach((s, i) => {
    const r = START + 1 + i;
    ws.getCell(`F${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: toArgb(sectorColor(s.sector)) } };
    ws.getCell(`G${r}`).value = s.sector; ws.getCell(`G${r}`).font = { size: 10, color: { argb: INK } };
    ws.getCell(`H${r}`).value = s.fundCount; ws.getCell(`H${r}`).alignment = { horizontal: "center" };
    ws.getCell(`I${r}`).value = s.sightings;
  });
  try {
    ws.addConditionalFormatting({ ref: `D${START + 1}:D${START + funds.length}`, rules: [{ type: "dataBar", cfvo: [{ type: "min" }, { type: "max" }], color: { argb: "FF6366F1" } }] });
    ws.addConditionalFormatting({ ref: `I${START + 1}:I${START + sectors.length}`, rules: [{ type: "dataBar", cfvo: [{ type: "min" }, { type: "max" }], color: { argb: "FFA855F7" } }] });
  } catch (e) { console.warn("summary databar skipped:", e.message); }

  // Consensus tiers below
  const tierTop = START + Math.max(funds.length, sectors.length) + 2;
  sectionHdr(`A${tierTop}:C${tierTop}`, "Consensus tiers");
  colHdr(`B${tierTop + 1}`, "Tier"); colHdr(`C${tierTop + 1}`, "Companies", "center");
  const tiers = [["High conviction (4+ funds)", book.filter((b) => b.fundCount >= 4).length, "FFF59E0B"], ["Building (3 funds)", book.filter((b) => b.fundCount === 3).length, "FF6366F1"], ["On the radar (2 funds)", book.filter((b) => b.fundCount === 2).length, "FF94A3B8"]];
  tiers.forEach((t, i) => {
    const r = tierTop + 2 + i;
    ws.getCell(`A${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: t[2] } };
    ws.getCell(`B${r}`).value = t[0]; ws.getCell(`B${r}`).font = { size: 10, color: { argb: INK } };
    ws.getCell(`C${r}`).value = t[1]; ws.getCell(`C${r}`).alignment = { horizontal: "center" };
  });
}

async function exportData() {
  if (!DATA || !DATA.sightings.length) return;
  const rows = exportRows();
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const base = `fund-tracker-mga_sightings_${dateStr}`;

  if (window.ExcelJS) {
    try {
      const wb = new window.ExcelJS.Workbook();
      wb.creator = "Fund Tracker — MGA";
      wb.created = new Date();
      buildSightingsSheet(wb, rows);
      try { buildSummarySheet(wb); } catch (e) { console.warn("summary sheet skipped:", e.message); }
      const buf = await wb.xlsx.writeBuffer();
      downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), base + ".xlsx");
      return;
    } catch (e) {
      console.warn("xlsx export failed, falling back to CSV:", e.message);
    }
  }
  // CSV fallback (same columns, no styling)
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [EXPORT_COLS.map((c) => esc(c.header)).join(",")]
    .concat(rows.map((r) => EXPORT_COLS.map((c) => esc(r[c.key])).join(",")))
    .join("\r\n");
  downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), base + ".csv");
}

function showBootError(msg) {
  const l = document.getElementById("boot-loader");
  if (!l) return;
  l.innerHTML = `<div class="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
    <div class="rounded-2xl bg-rose-50 p-3 text-rose-500"><i data-lucide="alert-triangle" class="h-7 w-7"></i></div>
    <p class="font-display text-lg font-semibold text-slate-700">Couldn't load data</p>
    <p class="text-sm text-slate-500">${escapeHtml(msg)}</p>
    <button onclick="location.reload()" class="mt-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white">Retry</button></div>`;
  refreshIcons();
}

// --- add fund (UI → Worker API) --------------------------------------------
function openAddFund() {
  const input = "w-full rounded-xl bg-white px-3 py-2.5 text-sm text-slate-800 shadow-sm ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-400";
  document.getElementById("drill-content").innerHTML = `
    <div class="flex items-start justify-between gap-3 border-b border-slate-100 p-5">
      <div class="flex items-center gap-3">
        <span class="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-sm"><i data-lucide="plus" class="h-5 w-5"></i></span>
        <div><div class="font-display text-xl font-semibold text-slate-800">Add a fund</div>
          <div class="mt-0.5 text-xs text-slate-500">We'll backfill its concall appearances over the last 4 quarters.</div></div>
      </div>
      <button id="drill-close" class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>
    <form id="addfund-form" class="scroll-area flex-1 space-y-4 overflow-y-auto p-5">
      <div>
        <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Fund name <span class="text-rose-500">*</span></label>
        <input id="af-name" class="${input}" placeholder="e.g. Acme Capital" autocomplete="off" />
      </div>
      <div>
        <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Aliases <span class="font-normal normal-case text-slate-400">(optional)</span></label>
        <input id="af-aliases" class="${input}" placeholder="Acme Capital, Acme Investment Advisors" autocomplete="off" />
        <p class="mt-1 text-[11px] text-slate-400">Comma-separated name variations as they appear in concalls. We auto-add a few sensible variants too.</p>
      </div>
      <div>
        <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Passcode</label>
        <input id="af-pass" type="password" class="${input}" placeholder="passcode" autocomplete="off" />
      </div>
      <button type="submit" id="af-submit" class="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-fuchsia-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-95 disabled:opacity-60">
        <i data-lucide="plus" class="h-4 w-4"></i>Add fund
      </button>
      <div id="af-status"></div>
      <div>
        <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Already tracking</div>
        <div id="af-chips" class="flex flex-wrap gap-1.5"><span class="text-xs text-slate-400">Loading…</span></div>
      </div>
      <p class="text-[11px] text-slate-400">New funds are matched against the last 4 quarters of concalls on the next backfill run.</p>
    </form>`;
  revealModal();
  loadWatchlistChips();
  document.getElementById("addfund-form").addEventListener("submit", submitAddFund);
}

async function loadWatchlistChips() {
  const el = document.getElementById("af-chips");
  if (!el) return;
  try {
    const r = await fetch("/api/funds");
    const d = await r.json();
    const funds = d.funds || [];
    el.innerHTML = funds.length
      ? funds.map((f) => { const c = fundColor(f.id); return `<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium" style="background:${c}1a;color:${c}"><span class="h-1.5 w-1.5 rounded-full" style="background:${c}"></span>${escapeHtml(f.name)}</span>`; }).join("")
      : `<span class="text-xs text-slate-400">No funds yet.</span>`;
  } catch {
    el.innerHTML = `<span class="text-xs text-slate-400">Couldn't load the current watchlist.</span>`;
  }
}

async function submitAddFund(e) {
  e.preventDefault();
  const btn = document.getElementById("af-submit");
  const status = document.getElementById("af-status");
  const note = (icon, color, msg) => `<div class="flex items-start gap-2 rounded-xl px-3 py-2 text-sm" style="background:${color}14;color:${color}"><i data-lucide="${icon}" class="mt-0.5 h-4 w-4 shrink-0"></i><span>${escapeHtml(msg)}</span></div>`;
  const name = document.getElementById("af-name").value.trim();
  const aliases = document.getElementById("af-aliases").value.trim();
  const passcode = document.getElementById("af-pass").value;
  if (!name) { status.innerHTML = note("alert-circle", "#F43F5E", "Please enter a fund name."); refreshIcons(); return; }

  btn.disabled = true;
  btn.innerHTML = `<span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"></span> Adding…`;
  status.innerHTML = "";
  try {
    const r = await fetch("/api/add-fund", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, aliases, passcode }) });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) {
      status.innerHTML = note("check-circle", "#10B981", data.message || "Added!");
      document.getElementById("af-name").value = "";
      document.getElementById("af-aliases").value = "";
      loadWatchlistChips();
    } else {
      status.innerHTML = note("alert-circle", "#F43F5E", data.error || `Something went wrong (HTTP ${r.status}).`);
    }
  } catch {
    status.innerHTML = note("wifi-off", "#F43F5E", "Network error — please try again.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="plus" class="h-4 w-4"></i>Add fund`;
    refreshIcons();
  }
}

// --- boot ------------------------------------------------------------------
async function boot() {
  try {
    DATA = await loadData();
  } catch (e) {
    showBootError(e.message || "Network error.");
    return;
  }
  if (DATA.dataError && !DATA.sightings.length) {
    showBootError("Couldn't reach data/fund-sightings.json. Check the deployment / network and retry.");
    return;
  }

  const updated = document.getElementById("meta-updated");
  if (updated) updated.textContent = DATA.meta.generated_at ? fmtDate(String(DATA.meta.generated_at).slice(0, 10)) : "—";

  renderKpis();
  renderBadges();

  document.querySelectorAll("#tab-nav [data-tab]").forEach((btn) => btn.addEventListener("click", () => activate(btn.dataset.tab)));
  activate("radar");

  // Any "View guidance" button anywhere opens the guidance popup.
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-guid-co]");
    if (b) { e.preventDefault(); openGuidance(b.dataset.guidCo); }
  });

  const panel = document.getElementById("drill-panel");
  panel.addEventListener("click", (e) => { if (e.target === panel) closeDrill(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrill(); });
  document.getElementById("export-btn")?.addEventListener("click", exportData);
  document.getElementById("addfund-btn")?.addEventListener("click", openAddFund);

  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(resizeCharts, 150); });
  refreshIcons();
  document.getElementById("boot-loader")?.remove();
}
document.addEventListener("DOMContentLoaded", boot);
