// ui.js — Fund Tracker — MGA · shared design system
// ---------------------------------------------------------------------------
// Tokens, fund color palette, pill/card helpers, and the cached data loader.
// Imported by app.js (By Fund / Recent Flags) and Prompt 11 (By Sector / Overlap)
// so the whole dashboard shares one consistent, designed look.
// ---------------------------------------------------------------------------

// --- fund color system -----------------------------------------------------
// 13 distinct, vivid accents — assigned stably by a fund's position in funds.json
// so each fund keeps the same color everywhere it appears.
export const FUND_PALETTE = [
  "#6366f1", "#8b5cf6", "#d946ef", "#10b981", "#f59e0b", "#0ea5e9", "#f43f5e",
  "#14b8a6", "#f97316", "#22d3ee", "#84cc16", "#ec4899", "#3b82f6",
];

let _fundColorMap = null;
export function buildFundColorMap(funds) {
  _fundColorMap = {};
  (funds || []).forEach((f, i) => {
    _fundColorMap[f.id] = FUND_PALETTE[i % FUND_PALETTE.length];
  });
  return _fundColorMap;
}
export function fundColor(fundId) {
  if (_fundColorMap && _fundColorMap[fundId]) return _fundColorMap[fundId];
  // Fallback: stable hash → palette index.
  let h = 0;
  for (const ch of String(fundId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FUND_PALETTE[h % FUND_PALETTE.length];
}

// --- sector hue-coding -----------------------------------------------------
function hueOf(str) {
  let h = 0;
  for (const ch of String(str || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
// A rounded pill showing "Sector · Industry", hue-coded by sector.
export function sectorPill(sector, industry) {
  const label = sector || "Unknown";
  const hue = sector ? hueOf(sector) : 220;
  const sat = sector ? 70 : 8;
  const bg = `hsla(${hue}, ${sat}%, 55%, 0.14)`;
  const ring = `hsla(${hue}, ${sat}%, 65%, 0.40)`;
  const fg = `hsl(${hue}, ${Math.min(sat + 20, 90)}%, 82%)`;
  const ind = industry ? `<span class="text-slate-400"> · ${escapeHtml(industry)}</span>` : "";
  return `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
    style="background:${bg};box-shadow:0 0 0 1px ${ring} inset;color:${fg}">
    <i data-lucide="trending-up" class="h-3 w-3"></i>${escapeHtml(label)}${ind}</span>`;
}

// --- text / date helpers ---------------------------------------------------
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const IST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
export const istDateStr = (d) => IST.format(new Date(d)); // YYYY-MM-DD

// "2026-06-10" → "10 Jun 2026"
export function fmtDate(ymd) {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${d} ${mon} ${y}`;
}

// Recency bucket (IST) for the flags feed.
export function recencyBucket(iso) {
  const today = istDateStr(new Date());
  const day = istDateStr(iso);
  if (day === today) return "Today";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms <= 7 * 86400000) return "This week";
  return "Earlier";
}
export const isToday = (iso) => iso && istDateStr(iso) === istDateStr(new Date());

// --- component helpers -----------------------------------------------------
export function transcriptBtn(url) {
  if (!url) return "";
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
    class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-slate-300
           ring-1 ring-white/15 transition hover:bg-white/10 hover:text-white">
    <i data-lucide="file-text" class="h-3.5 w-3.5"></i>Transcript
    <i data-lucide="external-link" class="h-3 w-3 opacity-70"></i></a>`;
}

export function newPill() {
  return `<span class="new-pulse inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5
    text-[10px] font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-amber-400/40">
    <i data-lucide="sparkles" class="h-3 w-3"></i>New</span>`;
}

// Quote block with left accent bar + glyph; long quotes get a show-more toggle.
export function quoteBlock(quote) {
  if (!quote) return "";
  const q = escapeHtml(quote);
  const long = quote.length > 220;
  const shown = long ? q.slice(0, 220) + "…" : q;
  return `<div class="quote mt-2 rounded-r-lg px-3 py-2 text-sm text-slate-300/90">
    <span class="mr-1 select-none font-display text-base text-slate-500">“</span><span data-quote>${shown}</span>${
      long
        ? ` <button type="button" class="ml-1 text-xs font-medium text-indigo-300 hover:text-indigo-200"
             data-more data-full="${q}" data-short="${shown}">show more</button>`
        : ""
    }</div>`;
}

export function emptyState(icon, title, sub = "") {
  return `<div class="flex flex-col items-center justify-center gap-3 rounded-2xl glass px-6 py-16 text-center">
    <div class="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10"><i data-lucide="${icon}" class="h-7 w-7 text-slate-400"></i></div>
    <p class="font-display text-lg font-semibold text-slate-200">${escapeHtml(title)}</p>
    ${sub ? `<p class="max-w-sm text-sm text-slate-400">${escapeHtml(sub)}</p>` : ""}
  </div>`;
}

// Count-up animation for KPI numbers.
export function countUp(el, target, ms = 900) {
  const start = performance.now();
  const from = 0;
  function step(now) {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (target - from) * eased).toLocaleString("en-IN");
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// Wire show-more toggles within a container (event delegation).
export function wireShowMore(container) {
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-more]");
    if (!btn) return;
    const span = btn.parentElement.querySelector("[data-quote]");
    const expanded = btn.dataset.state === "open";
    // dataset values are already HTML-escaped; restore via innerHTML.
    span.innerHTML = expanded ? btn.dataset.short : btn.dataset.full;
    btn.textContent = expanded ? "show more" : "show less";
    btn.dataset.state = expanded ? "" : "open";
  });
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
  const [store, funds, meta] = await Promise.all([
    get("data/fund-sightings.json", { sightings: [] }),
    get("data/funds.json", { funds: [] }),
    get("data/metadata.json", {}),
  ]);
  buildFundColorMap(funds.funds || []);
  _cache = {
    sightings: store.sightings || [],
    store,
    funds: funds.funds || [],
    meta: meta || {},
  };
  return _cache;
}

export function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}
