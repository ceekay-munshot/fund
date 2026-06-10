// app.js — Fund Tracker — MGA · visual-first dashboard
// ---------------------------------------------------------------------------
// Builds the KPI strip, tab nav, the "Radar" tab (interactive network graph +
// sector treemap + new-sightings timeline) and the "Funds" tab (visual tile
// board + slide-over drill panel). Sectors / Overlap / Recent Flags are styled
// "coming soon" panels filled in Prompt 11, reusing the design system in ui.js.
// ---------------------------------------------------------------------------

import {
  loadData, fundColor, sectorColor, sectorPill, escapeHtml, initials, fmtDate,
  isToday, transcriptBtn, quoteBlock, emptyState, countUp, wireShowMore,
  makeChart, resizeCharts, refreshIcons,
} from "./ui.js";

let DATA = null;
const rendered = new Set();
let selectedFund = null; // graph emphasis

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
    { label: "Sightings", value: s.length, icon: "radar", grad: "from-indigo-500 to-violet-500" },
    { label: "Active Funds", value: activeFunds, suffix: ` / ${fundTotal}`, icon: "briefcase", grad: "from-emerald-500 to-teal-500" },
    { label: "Companies Tracked", value: companies, icon: "building-2", grad: "from-sky-500 to-blue-500" },
    { label: "Concalls Scanned (90d)", value: DATA.meta.concalls_scanned ?? 0, icon: "file-text", grad: "from-amber-500 to-orange-500" },
  ];
  document.getElementById("kpi-strip").innerHTML = cards
    .map(
      (c) => `
    <div class="card card-hover relative overflow-hidden p-4 sm:p-5">
      <div class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${c.grad}"></div>
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium uppercase tracking-wide text-slate-400">${c.label}</span>
        <span class="rounded-xl bg-gradient-to-br ${c.grad} p-1.5 text-white shadow-sm"><i data-lucide="${c.icon}" class="h-4 w-4"></i></span>
      </div>
      <div class="mt-3 font-mono text-3xl font-semibold text-slate-800"><span data-count="${c.value}">0</span><span class="text-lg text-slate-400">${c.suffix || ""}</span></div>
    </div>`
    )
    .join("");
  document.querySelectorAll("#kpi-strip [data-count]").forEach((el) => countUp(el, Number(el.dataset.count)));
}

// ===========================================================================
// RADAR
// ===========================================================================
function renderRadar() {
  const root = document.getElementById("tab-radar");
  root.innerHTML = `
    <div class="card mb-4 p-4 sm:p-5">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2"><span class="rounded-xl bg-indigo-50 p-1.5 text-indigo-500"><i data-lucide="radar" class="h-4 w-4"></i></span>
          <h2 class="font-display text-lg font-semibold text-slate-800">Fund · Company network</h2></div>
        <button id="graph-reset" class="hidden rounded-lg px-2.5 py-1 text-xs font-medium text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50">Reset</button>
      </div>
      <p class="mb-3 text-xs text-slate-400">Drag nodes · scroll to zoom · hover for detail · click a fund to isolate its companies. Bigger neutral dots = companies multiple funds are tracking (consensus).</p>
      <div id="chart-graph" class="chart-graph-box"></div>
      <div id="graph-legend" class="mt-3 flex flex-wrap gap-1.5"></div>
    </div>
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="card p-4 sm:p-5">
        <div class="mb-2 flex items-center gap-2"><span class="rounded-xl bg-fuchsia-50 p-1.5 text-fuchsia-500"><i data-lucide="layers" class="h-4 w-4"></i></span>
          <h2 class="font-display text-lg font-semibold text-slate-800">Sector clustering</h2></div>
        <div id="chart-treemap" class="chart-box"></div>
      </div>
      <div class="card p-4 sm:p-5">
        <div class="mb-2 flex items-center gap-2"><span class="rounded-xl bg-emerald-50 p-1.5 text-emerald-500"><i data-lucide="trending-up" class="h-4 w-4"></i></span>
          <h2 class="font-display text-lg font-semibold text-slate-800">New sightings over time</h2></div>
        <div id="chart-timeline" class="chart-box"></div>
      </div>
    </div>`;

  if (!window.echarts) {
    for (const id of ["chart-graph", "chart-treemap", "chart-timeline"]) {
      const c = document.getElementById(id);
      if (c) c.innerHTML = emptyState("wifi-off", "Charts couldn't load", "The charting library was blocked by the network. Check your connection / CSP and reload.");
    }
    refreshIcons();
    return;
  }
  const guard = (label, fn) => { try { fn(); } catch (e) { console.error(`render ${label}:`, e); } };
  guard("graph", renderGraph);
  guard("legend", renderLegend);
  guard("treemap", renderTreemap);
  guard("timeline", renderTimeline);
  document.getElementById("graph-reset").addEventListener("click", () => emphasizeFund(null));
  refreshIcons();
  // Belt-and-suspenders: re-measure once layout/fonts have fully settled.
  setTimeout(resizeCharts, 300);
}

function graphModel() {
  const byFund = groupByFund();
  const fbc = fundsByCompany();
  const nodes = [];
  const links = [];
  const maxSight = Math.max(1, ...[...byFund.values()].map((f) => f.sightings.length));

  for (const f of byFund.values()) {
    if (!f.sightings.length) continue;
    nodes.push({
      id: "f:" + f.id, name: f.name, _type: "fund", fundId: f.id,
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
      id: "c:" + company, name: company, _type: "company", _funds: [...fundSet], _sector: any.sector, _industry: any.industry, _quote: any.quote,
      symbolSize: 7 + n * 5,
      itemStyle: { color: consensus ? "#F59E0B" : "#cbd5e1", borderColor: consensus ? "#fff" : "#e2e8f0", borderWidth: consensus ? 2 : 1 },
      label: { show: false },
    });
  }
  // aggregate occurrences per fund→company
  const linkAgg = new Map();
  for (const s of DATA.sightings) {
    const k = s.fund_id + "→" + s.company;
    linkAgg.set(k, (linkAgg.get(k) || 0) + (s.occurrences || 1));
  }
  for (const [k, occ] of linkAgg) {
    const [fid, company] = k.split("→");
    links.push({ source: "f:" + fid, target: "c:" + company, _fundId: fid, lineStyle: { color: fundColor(fid), width: 1 + Math.min(occ, 6), opacity: 0.45, curveness: 0.08 } });
  }
  return { nodes, links };
}

function renderGraph() {
  const el = document.getElementById("chart-graph");
  const chart = makeChart(el, "graph");
  if (!chart) return;
  const { nodes, links } = graphModel();
  chart._model = { nodes, links };
  chart.setOption({
    tooltip: {
      borderColor: "#e2e8f0", backgroundColor: "#fff", textStyle: { color: "#334155" }, extraCssText: "box-shadow:0 12px 32px -12px rgba(16,24,40,.3);border-radius:12px;",
      formatter: (p) => {
        if (p.dataType !== "node") return "";
        const d = p.data;
        if (d._type === "fund") return `<b style="color:${fundColor(d.fundId)}">${escapeHtml(d.name)}</b><br/>${d._companies} sightings`;
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
  if (!chart || !chart._model) return;
  const { nodes, links } = chart._model;
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
    if (!agg.has(k)) agg.set(k, { count: 0, companies: new Set(), funds: new Map() });
    const a = agg.get(k);
    a.count++; a.companies.add(s.company);
    a.funds.set(s.fund_name, (a.funds.get(s.fund_name) || 0) + 1);
  }
  const data = [...agg.entries()].map(([sector, a]) => ({
    name: sector, value: a.count, _companies: a.companies.size,
    _topFunds: [...a.funds.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n, c]) => `${n} (${c})`).join(", "),
    itemStyle: { color: sectorColor(sector === "Unknown" ? null : sector), borderColor: "#fff", borderWidth: 2, gapWidth: 2 },
  }));
  chart.setOption({
    tooltip: {
      backgroundColor: "#fff", borderColor: "#e2e8f0", textStyle: { color: "#334155" }, extraCssText: "box-shadow:0 12px 32px -12px rgba(16,24,40,.3);border-radius:12px;",
      formatter: (p) => `<b>${escapeHtml(p.name)}</b><br/>${p.value} sightings · ${p.data._companies} companies<br/><span style="color:#64748b">Top: ${escapeHtml(p.data._topFunds || "—")}</span>`,
    },
    series: [{ type: "treemap", roam: false, breadcrumb: { show: false }, nodeClick: false, animationDuration: 800,
      label: { show: true, formatter: "{b}", color: "#fff", fontFamily: "Inter", fontWeight: 600, overflow: "truncate" },
      itemStyle: { borderRadius: 6 }, data }],
  });
}

function renderTimeline() {
  const chart = makeChart(document.getElementById("chart-timeline"), "timeline");
  if (!chart) return;
  const snaps = [...DATA.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const x = snaps.map((s) => fmtDate(s.date));
  const y = snaps.map((s) => s.new_today_count ?? s.sightings ?? 0);
  const single = snaps.length <= 1;
  chart.setOption({
    grid: { left: 44, right: 16, top: 20, bottom: 28 },
    tooltip: { trigger: "axis", backgroundColor: "#fff", borderColor: "#e2e8f0", textStyle: { color: "#334155" }, extraCssText: "border-radius:12px;" },
    xAxis: { type: "category", data: x, axisLine: { lineStyle: { color: "#e2e8f0" } }, axisLabel: { color: "#94a3b8", fontFamily: "JetBrains Mono", fontSize: 10 } },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { color: "#94a3b8", fontFamily: "JetBrains Mono" } },
    series: [{
      type: "line", data: y, smooth: true, symbol: "circle", symbolSize: single ? 12 : 7,
      lineStyle: { width: 3, color: "#8B5CF6" }, itemStyle: { color: "#8B5CF6" },
      areaStyle: { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: "rgba(139,92,246,0.35)" }, { offset: 1, color: "rgba(139,92,246,0.02)" }]) },
      animationDuration: 900,
    }],
    graphic: single ? [{ type: "text", right: 16, top: 8, style: { text: "History builds daily", fill: "#cbd5e1", font: "11px Inter" } }] : [],
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
          <div class="font-mono text-xs text-slate-500">${zero ? "no sightings (90d)" : `${f.companyCount} ${f.companyCount === 1 ? "company" : "companies"} · ${f.sightingCount} ${f.sightingCount === 1 ? "sighting" : "sightings"}`}</div>
        </div>
      </div>
      <div class="mt-4">${bar}</div>
      <div class="mt-3 flex flex-wrap gap-1.5">${zero ? "" : pills}</div>
    </button>`;
}

// --- drill panel -----------------------------------------------------------
function openDrill(fundId) {
  const f = groupByFund().get(fundId);
  if (!f) return;
  const color = fundColor(fundId);
  const companies = companiesOf(f.sightings);
  const content = document.getElementById("drill-content");
  content.innerHTML = `
    <div class="flex items-center justify-between gap-3 border-b border-slate-100 p-5" style="box-shadow:inset 0 3px 0 ${color}">
      <div class="flex items-center gap-3">
        <span class="grid h-11 w-11 place-items-center rounded-2xl font-display text-sm font-bold text-white" style="background:${color}">${escapeHtml(initials(f.name))}</span>
        <div><div class="font-display text-lg font-semibold text-slate-800">${escapeHtml(f.name)}</div>
          <div class="font-mono text-xs text-slate-500">${companies.length} companies · ${f.sightings.length} sightings</div></div>
      </div>
      <button id="drill-close" class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>
    ${f.sightings.length ? `<div class="border-b border-slate-100 p-5"><div id="drill-donut" class="chart-donut"></div></div>` : ""}
    <div class="scroll-area flex-1 space-y-2.5 overflow-y-auto p-5">
      ${companies.length ? companies.map((c) => drillRow(c, color)).join("") : emptyState("inbox", "No sightings", "This fund hasn't appeared in a concall in the last 90 days.")}
    </div>`;
  wireShowMore(content);
  content.querySelector("#drill-close").addEventListener("click", closeDrill);

  document.getElementById("drill-panel").style.transform = "translateX(0)";
  const ov = document.getElementById("drill-overlay");
  ov.classList.remove("pointer-events-none");
  ov.style.opacity = "1";
  refreshIcons();

  if (f.sightings.length) drawDrillDonut(f, color);
}

function drillRow(c, color) {
  return `<div class="rounded-2xl bg-slate-50/70 p-3 ring-1 ring-slate-100">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span class="inline-flex items-center gap-1.5 font-medium text-slate-800"><i data-lucide="building-2" class="h-3.5 w-3.5 text-slate-400"></i>${escapeHtml(c.company)}</span>
      ${c.ticker ? `<span class="font-mono text-xs uppercase" style="color:${color}">${escapeHtml(c.ticker)}</span>` : ""}
      ${sectorPill(c.sector, c.industry)}
      <span class="ml-auto inline-flex items-center gap-2"><span class="inline-flex items-center gap-1 font-mono text-xs text-slate-400"><i data-lucide="calendar" class="h-3 w-3"></i>${fmtDate(c.concall_date)}</span>${transcriptBtn(c.transcript_url)}</span>
    </div>
    ${quoteBlock(c.quote, color)}</div>`;
}

function drawDrillDonut(f, color) {
  const chart = makeChart(document.getElementById("drill-donut"), "drill-donut");
  if (!chart) return;
  const mix = sectorMix(f.sightings);
  chart.setOption({
    tooltip: { trigger: "item", backgroundColor: "#fff", borderColor: "#e2e8f0", textStyle: { color: "#334155" }, extraCssText: "border-radius:12px;", formatter: (p) => `${escapeHtml(p.name)}: <b>${p.value}</b> (${p.percent}%)` },
    series: [{
      type: "pie", radius: ["52%", "82%"], center: ["50%", "50%"], avoidLabelOverlap: true, padAngle: 2,
      itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
      label: { show: false }, labelLine: { show: false },
      data: mix.map((m) => ({ name: m.sector, value: m.count, itemStyle: { color: sectorColor(m.sector === "Unknown" ? null : m.sector) } })),
    }],
    graphic: [{ type: "text", left: "center", top: "center", style: { text: `${mix.length}\nsectors`, textAlign: "center", fill: "#475569", font: "600 13px Space Grotesk" } }],
  });
}

function closeDrill() {
  document.getElementById("drill-panel").style.transform = "translateX(100%)";
  const ov = document.getElementById("drill-overlay");
  ov.style.opacity = "0";
  ov.classList.add("pointer-events-none");
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
  sectors: () => renderPlaceholder("tab-sectors", "layers", "By Sector"),
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

  document.getElementById("drill-overlay").addEventListener("click", closeDrill);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrill(); });

  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(resizeCharts, 150); });
  refreshIcons();
}
document.addEventListener("DOMContentLoaded", boot);
