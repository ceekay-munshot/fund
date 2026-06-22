// ui.js — Fund Tracker — MGA · shared design system (light, visual-first)
// ---------------------------------------------------------------------------
// Tokens, fund palette, sector colors, formatting, component builders, the
// cached data loader, and an ECharts instance registry (init/resize/dispose).
// Imported by app.js (Radar + Funds) and Prompt 11 (Sectors / Overlap / Flags +
// export) so the whole dashboard shares one consistent look.
// ---------------------------------------------------------------------------

// --- fund color system -----------------------------------------------------
export const FUND_PALETTE = [
  "#6366F1", "#8B5CF6", "#EC4899", "#F43F5E", "#F59E0B", "#10B981", "#14B8A6",
  "#06B6D4", "#3B82F6", "#F97316", "#84CC16", "#A855F7", "#0EA5E9",
];

let _fundColorMap = null;
export function buildFundColorMap(funds) {
  _fundColorMap = {};
  (funds || []).forEach((f, i) => (_fundColorMap[f.id] = FUND_PALETTE[i % FUND_PALETTE.length]));
  return _fundColorMap;
}
export function fundColor(fundId) {
  if (_fundColorMap && _fundColorMap[fundId]) return _fundColorMap[fundId];
  let h = 0;
  for (const ch of String(fundId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FUND_PALETTE[h % FUND_PALETTE.length];
}

// --- sector colors (stable hue per sector) ---------------------------------
function hueOf(str) {
  let h = 0;
  for (const ch of String(str || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
export function sectorColor(sector) {
  if (!sector) return "#94A3B8";
  return `hsl(${hueOf(sector)}, 68%, 56%)`;
}
export function sectorPill(sector, industry) {
  const label = sector || "Unknown";
  const hue = sector ? hueOf(sector) : 220;
  const sat = sector ? 68 : 10;
  return `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
    style="background:hsla(${hue},${sat}%,55%,0.12);color:hsl(${hue},${Math.min(sat + 5, 75)}%,38%);box-shadow:0 0 0 1px hsla(${hue},${sat}%,55%,0.25) inset">
    <i data-lucide="trending-up" class="h-3 w-3"></i>${escapeHtml(label)}${
      industry ? `<span class="opacity-70"> · ${escapeHtml(industry)}</span>` : ""
    }</span>`;
}

// --- text / date helpers ---------------------------------------------------
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
export function initials(name) {
  return String(name || "?")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}
const IST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
export const istDateStr = (d) => IST.format(new Date(d));
export function fmtDate(ymd) {
  if (!ymd) return "—";
  const [y, m, d] = String(ymd).split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${d} ${mon} ${y}`;
}
export function recencyBucket(iso) {
  const today = istDateStr(new Date());
  if (istDateStr(iso) === today) return "Today";
  if (Date.now() - new Date(iso).getTime() <= 7 * 86400000) return "This week";
  return "Earlier";
}
export const isToday = (iso) => iso && istDateStr(iso) === istDateStr(new Date());

// --- component builders ----------------------------------------------------
export function transcriptBtn(url) {
  if (!url) return "";
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
    class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50 hover:text-slate-900">
    <i data-lucide="file-text" class="h-3.5 w-3.5"></i>Transcript<i data-lucide="external-link" class="h-3 w-3 opacity-60"></i></a>`;
}
export function quoteBlock(quote, accent = "#6366F1") {
  if (!quote) return "";
  const q = escapeHtml(quote);
  const long = quote.length > 220;
  const shown = long ? q.slice(0, 220) + "…" : q;
  return `<div class="mt-2 rounded-r-lg px-3 py-2 text-sm text-slate-600" style="border-left:3px solid ${accent};background:${accent}0d">
    <span class="mr-1 select-none font-display text-base text-slate-300">“</span><span data-quote>${shown}</span>${
      long ? ` <button type="button" class="ml-1 text-xs font-medium text-indigo-600 hover:text-indigo-700" data-more data-full="${q}" data-short="${shown}">show more</button>` : ""
    }</div>`;
}
export const titleCase = (s) =>
  String(s || "").split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

// Icon-only "open transcript" button (the "source" icon).
export function sourceIconBtn(url) {
  if (!url) return `<span class="grid h-8 w-8 place-items-center rounded-lg text-slate-300"><i data-lucide="file-x" class="h-4 w-4"></i></span>`;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open transcript (source)"
    class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 ring-1 ring-slate-200 transition hover:bg-indigo-50 hover:text-indigo-600"><i data-lucide="file-text" class="h-4 w-4"></i></a>`;
}

// Best-effort analyst-name extraction from a concall quote, anchored on the fund
// alias (e.g. "…from the line of madhur rathi with counter cyclical…" → "Madhur Rathi").
export function analystOf(quote, alias) {
  if (!quote) return null;
  const q = " " + quote.toLowerCase().replace(/\s+/g, " ").trim() + " ";
  const esc = (s) => String(s || "").toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const clean = (n) => n.replace(/\b(the|line|of|from|with|representing|mr|ms|mrs|dr|shri|smt)\b\.?/g, " ").replace(/[^a-z .]/g, "").replace(/\s+/g, " ").trim();
  const ok = (n) => { const w = n.split(" ").filter(Boolean); return w.length >= 1 && w.length <= 4 && n.length >= 3; };
  const tries = [];
  if (alias) {
    const a = esc(alias);
    tries.push(new RegExp("(?:line of|from|with|of)\\s+([a-z][a-z. ]{2,38}?)\\s+(?:with|from|of|representing)\\s+" + a));
    tries.push(new RegExp("([a-z][a-z. ]{2,38}?)\\s*[-\\u2013]\\s*" + a));
  }
  tries.push(/line of\s+([a-z][a-z. ]{2,38}?)(?:\s+(?:with|from|of)\b|[.,])/);
  for (const re of tries) {
    const m = q.match(re);
    if (m && m[1]) { const n = clean(m[1]); if (ok(n)) return titleCase(n); }
  }
  const sp = q.match(/\b([a-z]+ [a-z]+)\s*:/);
  if (sp) { const n = clean(sp[1]); if (ok(n)) return titleCase(n); }
  return null;
}

export function emptyState(icon, title, sub = "") {
  return `<div class="flex flex-col items-center justify-center gap-3 rounded-3xl bg-white/70 px-6 py-16 text-center shadow-sm ring-1 ring-slate-100">
    <div class="rounded-2xl bg-indigo-50 p-3 text-indigo-500"><i data-lucide="${icon}" class="h-7 w-7"></i></div>
    <p class="font-display text-lg font-semibold text-slate-800">${escapeHtml(title)}</p>
    ${sub ? `<p class="max-w-sm text-sm text-slate-500">${escapeHtml(sub)}</p>` : ""}</div>`;
}
export function countUp(el, target, ms = 900) {
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(target * eased).toLocaleString("en-IN");
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
export function wireShowMore(container) {
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-more]");
    if (!btn) return;
    const span = btn.parentElement.querySelector("[data-quote]");
    const open = btn.dataset.state === "open";
    span.innerHTML = open ? btn.dataset.short : btn.dataset.full;
    btn.textContent = open ? "show more" : "show less";
    btn.dataset.state = open ? "" : "open";
  });
}

// Generic "show first N, reveal the rest" for long lists. `items` = array of HTML
// strings, each a single top-level element. Pair with wireMore(container) once.
let _moreSeq = 0;
export function moreList(items, n = 10, noun = "more") {
  if (!items || items.length <= n) return (items || []).join("");
  const g = "m" + ++_moreSeq;
  const head = items.slice(0, n).join("");
  const rest = items.slice(n).map((h) => h.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 data-more-item="${g}" hidden`)).join("");
  return `${head}${rest}<button type="button" data-more-btn="${g}" class="mx-auto mt-3 flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-xs font-medium text-slate-500 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"><i data-lucide="chevron-down" class="h-3.5 w-3.5"></i>+ ${items.length - n} ${noun}</button>`;
}
export function wireMore(container) {
  if (!container || container._wiredMore) return;
  container._wiredMore = true;
  container.addEventListener("click", (e) => {
    const b = e.target.closest("[data-more-btn]");
    if (!b) return;
    container.querySelectorAll(`[data-more-item="${b.dataset.moreBtn}"]`).forEach((el) => el.removeAttribute("hidden"));
    b.remove();
  });
}

// Analyst LinkedIn — Option A: a people-search deep-link (name + firm). No API/scrape.
export function linkedinUrl(name, firm) {
  if (!name) return null;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([name, firm].filter(Boolean).join(" "))}`;
}
export function linkedinBtn(name, firm) {
  const url = linkedinUrl(name, firm);
  if (!url) return "";
  return `<a href="${url}" target="_blank" rel="noopener noreferrer" title="Find ${escapeHtml(name)} on LinkedIn" class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#0a66c2] hover:bg-sky-50"><i data-lucide="external-link" class="h-3 w-3"></i></a>`;
}

// --- ECharts registry ------------------------------------------------------
const _charts = new Map(); // id -> instance
export function makeChart(el, id) {
  if (!window.echarts || !el) return null;
  const prev = _charts.get(id);
  if (prev) prev.dispose();
  const c = window.echarts.init(el, null, { renderer: "canvas" });
  _charts.set(id, c);
  return c;
}
export function getChart(id) {
  return _charts.get(id);
}
export function resizeCharts() {
  for (const c of _charts.values()) {
    try {
      c.resize();
    } catch {
      /* noop */
    }
  }
}

// --- cached data loader ----------------------------------------------------
let _cache = null;
export async function loadData() {
  if (_cache) return _cache;
  const get = async (p, fallback) => {
    try {
      const r = await fetch(p, { cache: "no-store" });
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      console.warn("loadData:", err.message);
      return fallback;
    }
  };
  // Track whether the core file loaded so the UI can show an honest error state.
  let dataError = false;
  let store = { sightings: [] };
  try {
    const r = await fetch("data/fund-sightings.json", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    store = await r.json();
  } catch (err) {
    console.warn("loadData (fund-sightings):", err.message);
    dataError = true;
  }
  const [funds, meta, snapIndex, trends, guidance] = await Promise.all([
    get("data/funds.json", { funds: [] }),
    get("data/metadata.json", {}),
    get("data/snapshots/index.json", { snapshots: [] }),
    get("data/fund-company-trends.json", { dropped: [], gained: [], summary: {} }),
    get("data/guidance.json", { companies: {} }),
  ]);
  buildFundColorMap(funds.funds || []);
  _cache = {
    sightings: store.sightings || [],
    funds: funds.funds || [],
    meta: meta || {},
    snapshots: snapIndex.snapshots || [],
    trends: trends || { dropped: [], gained: [], summary: {} },
    guidance: guidance || { companies: {} },
    dataError,
  };
  return _cache;
}

export function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}
