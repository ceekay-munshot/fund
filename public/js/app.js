// app.js — Fund Tracker — MGA · dashboard entry point
// ---------------------------------------------------------------------------
// Renders the KPI strip, tab navigation, and the "By Fund" + "Recent Flags"
// tabs from the committed data in ./data. By Sector / Overlap are added in
// Prompt 11 (reusing the shared design system in ui.js).
//
// Data shapes (./data):
//   fund-sightings.json → { generated_at, window_days, fund_count, company_count,
//     sighting_count, sightings:[ { fund_id, fund_name, matched_alias, company,
//     ticker, sector, industry, concall_date, transcript_url, transcript_id,
//     occurrences, quote, first_seen } ] }
//   funds.json    → { funds:[ { id, name } ] }
//   metadata.json → { generated_at, source, fund_count, sighting_count,
//                     company_count, concalls_scanned, concalls_with_transcript }
// ---------------------------------------------------------------------------

import {
  loadData, fundColor, sectorPill, escapeHtml, fmtDate, recencyBucket, isToday,
  transcriptBtn, newPill, quoteBlock, emptyState, countUp, wireShowMore, refreshIcons,
} from "./ui.js";

let DATA = null;
const expandedFunds = new Set();
let flagFundFilter = "all";

// --- KPI strip -------------------------------------------------------------
function renderKpis() {
  const s = DATA.sightings;
  const activeFunds = new Set(s.map((x) => x.fund_id)).size;
  const companies = DATA.meta.company_count ?? new Set(s.map((x) => x.company)).size;
  const fundTotal = DATA.meta.fund_count ?? DATA.funds.length ?? 13;
  const cards = [
    { label: "Sightings", value: s.length, icon: "radar", accent: "#8b5cf6" },
    { label: `Active Funds`, value: activeFunds, suffix: ` / ${fundTotal}`, icon: "briefcase", accent: "#10b981" },
    { label: "Companies Tracked", value: companies, icon: "building-2", accent: "#0ea5e9" },
    { label: "Concalls Scanned (90d)", value: DATA.meta.concalls_scanned ?? 0, icon: "file-text", accent: "#f59e0b" },
  ];
  document.getElementById("kpi-strip").innerHTML = cards
    .map(
      (c) => `
    <div class="glass glass-hover rounded-2xl p-4 sm:p-5" style="--accent:${c.accent}">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium uppercase tracking-wide text-slate-400">${c.label}</span>
        <span class="rounded-lg p-1.5" style="background:${c.accent}1f;color:${c.accent}"><i data-lucide="${c.icon}" class="h-4 w-4"></i></span>
      </div>
      <div class="mt-3 font-mono text-3xl font-semibold text-slate-50">
        <span data-count="${c.value}">0</span><span class="text-lg text-slate-400">${c.suffix || ""}</span>
      </div>
    </div>`
    )
    .join("");
  document.querySelectorAll("#kpi-strip [data-count]").forEach((el) => countUp(el, Number(el.dataset.count)));
}

// --- tab badges ------------------------------------------------------------
function renderBadges() {
  const activeFunds = new Set(DATA.sightings.map((x) => x.fund_id)).size;
  const todayNew = DATA.sightings.filter((x) => isToday(x.first_seen)).length;
  const setBadge = (tab, n, show) => {
    const el = document.querySelector(`[data-badge="${tab}"]`);
    if (!el) return;
    el.textContent = n;
    el.classList.toggle("hidden", !show);
  };
  setBadge("byFund", activeFunds, activeFunds > 0);
  setBadge("flags", todayNew, todayNew > 0);
}

// --- grouping --------------------------------------------------------------
function groupByFund() {
  const map = new Map(); // fund_id -> { id, name, sightings:[] }
  for (const f of DATA.funds) map.set(f.id, { id: f.id, name: f.name, sightings: [] });
  for (const s of DATA.sightings) {
    if (!map.has(s.fund_id)) map.set(s.fund_id, { id: s.fund_id, name: s.fund_name, sightings: [] });
    map.get(s.fund_id).sightings.push(s);
  }
  return map;
}

// Within a fund, collapse to one row per company (latest concall + total occurrences).
function companiesOf(sightings) {
  const m = new Map();
  for (const s of sightings) {
    const cur = m.get(s.company);
    if (!cur) {
      m.set(s.company, { ...s, occurrences: s.occurrences || 1, count: 1 });
    } else {
      cur.occurrences += s.occurrences || 1;
      cur.count += 1;
      if ((s.concall_date || "") > (cur.concall_date || "")) {
        cur.concall_date = s.concall_date;
        cur.quote = s.quote;
        cur.transcript_url = s.transcript_url;
        cur.sector = s.sector;
        cur.industry = s.industry;
        cur.ticker = s.ticker;
      }
    }
  }
  return [...m.values()].sort((a, b) => (b.concall_date || "").localeCompare(a.concall_date || ""));
}

// --- By Fund tab -----------------------------------------------------------
function renderByFund() {
  const root = document.getElementById("tab-byFund");
  root.innerHTML = `
    <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="relative w-full sm:max-w-sm">
        <i data-lucide="search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"></i>
        <input id="fund-search" type="search" placeholder="Search fund, company, or ticker…"
          class="w-full rounded-xl glass py-2.5 pl-9 pr-3 text-sm text-slate-100 placeholder-slate-500 outline-none focus:ring-2 focus:ring-indigo-500/50" />
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span class="text-slate-400">Sort</span>
        <select id="fund-sort" class="rounded-xl glass px-3 py-2 text-sm text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/50">
          <option value="company_count">Most companies</option>
          <option value="sighting_count">Most sightings</option>
          <option value="az">A–Z</option>
        </select>
      </div>
    </div>
    <div id="fund-list" class="space-y-3"></div>`;

  const search = root.querySelector("#fund-search");
  const sort = root.querySelector("#fund-sort");
  search.addEventListener("input", updateFundList);
  sort.addEventListener("change", updateFundList);
  root.addEventListener("click", (e) => {
    const head = e.target.closest("[data-fund-toggle]");
    if (head) {
      const id = head.dataset.fundToggle;
      if (expandedFunds.has(id)) expandedFunds.delete(id);
      else expandedFunds.add(id);
      updateFundList();
    }
  });
  wireShowMore(root);
  updateFundList();
}

function updateFundList() {
  const root = document.getElementById("tab-byFund");
  const q = (root.querySelector("#fund-search")?.value || "").trim().toLowerCase();
  const sortBy = root.querySelector("#fund-sort")?.value || "company_count";
  const list = root.querySelector("#fund-list");

  let funds = [...groupByFund().values()].map((f) => {
    const companies = companiesOf(f.sightings);
    return { ...f, companies, companyCount: companies.length, sightingCount: f.sightings.length };
  });

  // Filter (fund name OR any company/ticker)
  if (q) {
    funds = funds
      .map((f) => {
        const fundMatch = f.name.toLowerCase().includes(q);
        const companies = fundMatch
          ? f.companies
          : f.companies.filter(
              (c) =>
                (c.company || "").toLowerCase().includes(q) ||
                (c.ticker || "").toLowerCase().includes(q)
            );
        return { ...f, companies, _match: fundMatch || companies.length > 0 };
      })
      .filter((f) => f._match);
  }

  // Sort
  funds.sort((a, b) => {
    if (sortBy === "az") return a.name.localeCompare(b.name);
    if (sortBy === "sighting_count") return b.sightingCount - a.sightingCount || a.name.localeCompare(b.name);
    return b.companyCount - a.companyCount || a.name.localeCompare(b.name);
  });

  if (!funds.length) {
    list.innerHTML = emptyState("search-x", "No matches", `Nothing matched “${q}”.`);
    refreshIcons();
    return;
  }

  list.innerHTML = funds.map((f) => fundCard(f, q)).join("");
  refreshIcons();
}

function fundCard(f, q) {
  const color = fundColor(f.id);
  const open = expandedFunds.has(f.id) || (q && f.companies.length > 0);
  const zero = f.sightingCount === 0;
  const badge = zero
    ? `<span class="text-xs text-slate-500">No sightings in the last 90 days</span>`
    : `<span class="font-mono text-xs text-slate-300">${f.companyCount} ${f.companyCount === 1 ? "company" : "companies"} · ${f.sightingCount} ${f.sightingCount === 1 ? "sighting" : "sightings"}</span>`;

  const body = zero
    ? ""
    : `<div class="scroll-area max-h-[28rem] space-y-2 overflow-y-auto px-3 pb-3 ${open ? "" : "hidden"}" data-fund-body="${f.id}">
        ${f.companies.map((c) => companyRow(c, color)).join("")}
      </div>`;

  return `
    <div class="glass glass-hover overflow-hidden rounded-2xl" style="--accent:${color}">
      <button type="button" data-fund-toggle="${f.id}"
        class="flex w-full items-center gap-3 px-4 py-3.5 text-left ${zero ? "opacity-60" : ""}">
        <span class="h-8 w-1.5 shrink-0 rounded-full accent-bar"></span>
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style="background:${color}1f;color:${color}">
          <i data-lucide="briefcase" class="h-4 w-4"></i>
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-display text-base font-semibold text-slate-100">${escapeHtml(f.name)}</span>
          <span class="block">${badge}</span>
        </span>
        ${zero ? "" : `<i data-lucide="chevron-down" class="h-5 w-5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}"></i>`}
      </button>
      ${body}
    </div>`;
}

function companyRow(c, color) {
  const dateChip = `<span class="inline-flex items-center gap-1 font-mono text-xs text-slate-400"><i data-lucide="calendar" class="h-3 w-3"></i>${fmtDate(c.concall_date)}</span>`;
  const occ = c.occurrences > 1 ? `<span class="font-mono text-[11px] text-slate-500">×${c.occurrences}</span>` : "";
  const ticker = c.ticker ? `<span class="font-mono text-xs uppercase tracking-wide" style="color:${color}">${escapeHtml(c.ticker)}</span>` : "";
  return `
    <div class="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="inline-flex items-center gap-1.5 font-medium text-slate-100"><i data-lucide="building-2" class="h-3.5 w-3.5 text-slate-400"></i>${escapeHtml(c.company)}</span>
        ${ticker}
        ${sectorPill(c.sector, c.industry)}
        <span class="ml-auto flex items-center gap-2">${dateChip}${occ}${transcriptBtn(c.transcript_url)}</span>
      </div>
      ${quoteBlock(c.quote)}
    </div>`;
}

// --- Recent Flags tab ------------------------------------------------------
function renderFlags() {
  const root = document.getElementById("tab-flags");
  const active = DATA.funds.filter((f) => DATA.sightings.some((s) => s.fund_id === f.id));
  const chips = [{ id: "all", name: "All funds" }, ...active]
    .map((f) => {
      const color = f.id === "all" ? "#94a3b8" : fundColor(f.id);
      const sel = flagFundFilter === f.id;
      return `<button type="button" data-flag-chip="${f.id}"
        class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${sel ? "text-white" : "text-slate-300 hover:bg-white/5"}"
        style="${sel ? `background:${color};box-shadow:0 0 16px -4px ${color}` : `box-shadow:0 0 0 1px ${color}55 inset`}">
        ${f.id === "all" ? "" : `<span class="h-1.5 w-1.5 rounded-full" style="background:${sel ? "#fff" : color}"></span>`}${escapeHtml(f.name)}</button>`;
    })
    .join("");

  root.innerHTML = `
    <div class="mb-5 flex flex-wrap gap-2" id="flag-chips">${chips}</div>
    <div id="flags-list" class="space-y-6"></div>`;

  root.querySelector("#flag-chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-flag-chip]");
    if (!chip) return;
    flagFundFilter = chip.dataset.flagChip;
    renderFlags();
  });
  wireShowMore(root);
  updateFlagsList();
}

function updateFlagsList() {
  const list = document.getElementById("flags-list");
  let items = [...DATA.sightings];
  if (flagFundFilter !== "all") items = items.filter((s) => s.fund_id === flagFundFilter);
  items.sort((a, b) => (b.first_seen || b.concall_date || "").localeCompare(a.first_seen || a.concall_date || ""));

  if (!items.length) {
    list.innerHTML = emptyState("bell-off", "No fund sightings recorded yet", "The radar runs daily — check back soon.");
    refreshIcons();
    return;
  }

  const groups = { Today: [], "This week": [], Earlier: [] };
  for (const s of items) groups[recencyBucket(s.first_seen || s.concall_date)].push(s);

  list.innerHTML = Object.entries(groups)
    .filter(([, arr]) => arr.length)
    .map(
      ([label, arr]) => `
      <div>
        <h3 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <i data-lucide="${label === "Today" ? "sparkles" : label === "This week" ? "calendar-clock" : "history"}" class="h-3.5 w-3.5"></i>
          ${label} <span class="font-mono text-slate-600">${arr.length}</span>
        </h3>
        <div class="space-y-2.5">${arr.map(flagCard).join("")}</div>
      </div>`
    )
    .join("");
  refreshIcons();
}

function flagCard(s) {
  const color = fundColor(s.fund_id);
  return `
    <div class="glass glass-hover rounded-2xl p-4" style="--accent:${color}">
      <div class="flex items-start gap-3">
        <span class="mt-0.5 h-9 w-1.5 shrink-0 rounded-full accent-bar"></span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="font-display font-semibold" style="color:${color}">${escapeHtml(s.fund_name)}</span>
            <span class="text-slate-400">spotted in</span>
            <span class="inline-flex items-center gap-1.5 font-medium text-slate-100"><i data-lucide="building-2" class="h-3.5 w-3.5 text-slate-400"></i>${escapeHtml(s.company)}</span>
            ${s.ticker ? `<span class="font-mono text-xs uppercase" style="color:${color}">${escapeHtml(s.ticker)}</span>` : ""}
            ${isToday(s.first_seen) ? newPill() : ""}
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            ${sectorPill(s.sector, s.industry)}
            <span class="inline-flex items-center gap-1 font-mono text-xs text-slate-400"><i data-lucide="calendar" class="h-3 w-3"></i>${fmtDate(s.concall_date)}</span>
            <span class="ml-auto">${transcriptBtn(s.transcript_url)}</span>
          </div>
          ${quoteBlock(s.quote)}
        </div>
      </div>
    </div>`;
}

// --- placeholder for Prompt 11 tabs ---------------------------------------
function renderPlaceholder(id, icon, title) {
  document.getElementById(id).innerHTML = emptyState(icon, title, "Coming in the next release.");
  refreshIcons();
}

// --- tab switching ---------------------------------------------------------
function initTabs() {
  const buttons = document.querySelectorAll("#tab-nav [data-tab]");
  function activate(tab) {
    buttons.forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.setAttribute("aria-selected", on ? "true" : "false");
      const sec = document.getElementById(`tab-${btn.dataset.tab}`);
      if (sec) {
        sec.hidden = !on;
        if (on) sec.classList.add("fade-in");
      }
    });
  }
  buttons.forEach((btn) => btn.addEventListener("click", () => activate(btn.dataset.tab)));
  activate("byFund");
}

// --- boot ------------------------------------------------------------------
async function boot() {
  DATA = await loadData();

  const updated = document.getElementById("meta-updated");
  if (updated) updated.textContent = DATA.meta.generated_at ? fmtDate((DATA.meta.generated_at || "").slice(0, 10)) : "—";

  renderKpis();
  renderBadges();
  renderByFund();
  renderFlags();
  renderPlaceholder("tab-bySector", "layers", "By Sector");
  renderPlaceholder("tab-overlap", "git-merge", "Overlap");
  initTabs();
  refreshIcons();
}

document.addEventListener("DOMContentLoaded", boot);
