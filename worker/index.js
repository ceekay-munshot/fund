// worker/index.js — Fund Tracker — MGA · Cloudflare Worker API
// ---------------------------------------------------------------------------
// Serves /api/* dynamically and falls through to the static dashboard (./public)
// via the ASSETS binding. Holds the GitHub token as a secret so privileged calls
// (edit the watchlist, trigger the backfill) never touch the client.
//
// Routes:
//   GET  /api/funds     → current watchlist (id, name, aliases)
//   POST /api/add-fund  → append a fund to screener-test/static/funds.json + trigger
//                         the quarterly (FULL=1) backfill workflow.
//
// Secrets / vars (set in Cloudflare, never hardcoded):
//   GITHUB_TOKEN       fine-grained PAT for this repo: Contents r/w + Actions r/w
//   GITHUB_REPO        "owner/fund"
//   GITHUB_BRANCH      "main"
//   ADD_FUND_PASSCODE  shared passcode for authorized users
// ---------------------------------------------------------------------------

const FUNDS_PATH = "screener-test/static/funds.json";
const WORKFLOW = "quarterly-sweep.yml";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/funds" && request.method === "GET") return listFunds(env);
      if (url.pathname === "/api/add-fund" && request.method === "POST") return addFund(request, env);
    } catch (e) {
      return json({ ok: false, error: e.message || "Server error." }, 500);
    }
    // Everything else → the static dashboard.
    return env.ASSETS.fetch(request);
  },
};

// --- helpers ---------------------------------------------------------------
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fund-tracker-mga",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

function slug(name) {
  return String(name).toLowerCase().trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const b64ToStr = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const strToB64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

// Generate sensible alias variants (e.g. drop a trailing entity word).
function buildAliases(name, userAliases) {
  const out = new Set();
  const add = (s) => { const t = String(s || "").trim(); if (t) out.add(t); };
  add(name);
  (Array.isArray(userAliases) ? userAliases : String(userAliases || "").split(","))
    .forEach(add);
  const stripped = name.replace(/\s+(capital|investments?|advisors?|pms|partners|llp|asset\s+management|management|securities|fund)\.?$/i, "").trim();
  if (stripped && stripped.toLowerCase() !== name.toLowerCase()) add(stripped);
  return [...out];
}

async function readFundsFile(env) {
  const repo = env.GITHUB_REPO, branch = env.GITHUB_BRANCH || "main";
  const r = await gh(env, `/repos/${repo}/contents/${FUNDS_PATH}?ref=${encodeURIComponent(branch)}`);
  if (!r.ok) throw new Error(`Could not read watchlist (GitHub ${r.status}).`);
  const meta = await r.json();
  const data = JSON.parse(b64ToStr(meta.content));
  return { sha: meta.sha, data };
}

// --- GET /api/funds --------------------------------------------------------
async function listFunds(env) {
  try {
    const { data } = await readFundsFile(env);
    const funds = (data.funds || []).map((f) => ({ id: f.id, name: f.name, aliases: f.aliases || [] }));
    return new Response(JSON.stringify({ funds }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=30" },
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

// --- POST /api/add-fund ----------------------------------------------------
async function addFund(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }

  const { name, aliases, passcode } = body || {};
  if (!env.ADD_FUND_PASSCODE || passcode !== env.ADD_FUND_PASSCODE) {
    return json({ ok: false, error: "Wrong passcode." }, 401);
  }
  const cleanName = String(name || "").trim().replace(/\s+/g, " ");
  if (cleanName.length < 2 || cleanName.length > 80) {
    return json({ ok: false, error: "Enter a valid fund name (2–80 characters)." }, 400);
  }
  const id = slug(cleanName);
  if (!id) return json({ ok: false, error: "Could not derive an id from that name." }, 400);

  const repo = env.GITHUB_REPO, branch = env.GITHUB_BRANCH || "main";

  let fileSha, data;
  try {
    ({ sha: fileSha, data } = await readFundsFile(env));
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
  data.funds = data.funds || [];
  if (data.funds.some((f) => f.id === id || (f.name || "").toLowerCase() === cleanName.toLowerCase())) {
    return json({ ok: false, error: `"${cleanName}" is already tracked.` }, 409);
  }

  const newFund = { id, name: cleanName, aliases: buildAliases(cleanName, aliases) };
  data.funds.push(newFund);

  // Commit the updated watchlist.
  const put = await gh(env, `/repos/${repo}/contents/${FUNDS_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Add fund: ${cleanName}`,
      content: strToB64(JSON.stringify(data, null, 2) + "\n"),
      sha: fileSha,
      branch,
    }),
  });
  if (!put.ok) {
    const detail = await put.text().catch(() => "");
    return json({ ok: false, error: `Couldn't update the watchlist (GitHub ${put.status}). ${detail.slice(0, 120)}` }, 502);
  }

  // Trigger the FULL backfill so the new fund's 90-day history populates.
  const dispatch = await gh(env, `/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: branch }),
  });
  const triggered = dispatch.ok;

  return json({
    ok: true,
    id,
    triggered,
    message: triggered
      ? `Added — ${cleanName}'s history will populate after the backfill run (usually a few minutes).`
      : `Added ${cleanName} to the watchlist, but the backfill couldn't be triggered automatically — run "Quarterly full sweep" from the Actions tab.`,
  });
}
