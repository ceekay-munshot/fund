// Fund Tracker — MGA · dashboard entry point
// ---------------------------------------------------------------------------
// Data shapes (read from the committed JSON in ./data, produced by the
// Playwright scrapers in ../screener-test/):
//
//   metadata.json
//     { generated_at, source, fund_count, sighting_count, concalls_scanned }
//
//   fund-sightings.json
//     { generated_at, sightings: [ Sighting, ... ] }
//
//   A "sighting" is one appearance of a watched fund in a concall transcript:
//     {
//       fund_id,        // slug from screener-test/static/funds.json
//       fund_name,      // display name of the fund
//       company,        // company hosting the concall
//       ticker,         // company ticker symbol
//       sector,         // company sector
//       concall_date,   // date of the concall
//       transcript_url, // link to the source transcript on Screener.in
//       quote           // the matched snippet of transcript text
//     }
//
// NOTE: The By Fund / By Sector / Overlap / Recent Flags renderers will be
// added in later prompts. For now this module only wires up the "last updated"
// badge and the tab switching. No transcript parsing happens here.
// ---------------------------------------------------------------------------

async function loadMetadata() {
  try {
    const res = await fetch("data/metadata.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json();
    const el = document.getElementById("meta-updated");
    if (el) el.textContent = meta.generated_at ?? "—";
  } catch (err) {
    console.warn("Could not load metadata.json:", err);
  }
}

function initTabs() {
  const buttons = document.querySelectorAll("#tab-nav [data-tab]");

  const activeClasses = ["bg-indigo-600", "text-white"];
  const inactiveClasses = ["bg-white", "text-slate-600", "ring-1", "ring-slate-200", "hover:bg-slate-100"];

  function activate(tab) {
    buttons.forEach((btn) => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle("bg-indigo-600", isActive);
      btn.classList.toggle("text-white", isActive);
      inactiveClasses.forEach((cls) => btn.classList.toggle(cls, !isActive));

      const section = document.getElementById(`tab-${btn.dataset.tab}`);
      if (section) section.hidden = !isActive;
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadMetadata();
  initTabs();
});
