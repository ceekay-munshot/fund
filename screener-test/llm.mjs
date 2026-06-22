// llm.mjs — Fund Tracker — MGA · free-tier multi-provider LLM client
// ---------------------------------------------------------------------------
// Wraps Gemini, Groq and Mistral behind one callLLM(). Rotates the starting
// provider per call (to spread free-tier rate limits) and falls through to the
// others on error / 429. Returns { text, provider }. JSON-mode requested where the
// provider supports it; extractJson() defensively parses the result.
//
// Keys (any subset): GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY.
// Optional model overrides: GEMINI_MODEL, GROQ_MODEL, MISTRAL_MODEL.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";

// Each provider: { name, ok, call(system,user) -> text }
function buildProviders() {
  const out = [];

  if (process.env.GEMINI_API_KEY) {
    out.push({
      name: "gemini",
      async call(system, user) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 2048 },
          }),
        });
        if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 160)}`);
        const j = await r.json();
        return j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      },
    });
  }

  // Groq + Mistral are OpenAI-compatible chat completions.
  const openaiStyle = (name, endpoint, keyEnv, model) => ({
    name,
    async call(system, user) {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env[keyEnv]}` },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 2048,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
      if (!r.ok) throw new Error(`${name} ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = await r.json();
      return j?.choices?.[0]?.message?.content || "";
    },
  });
  if (process.env.GROQ_API_KEY) out.push(openaiStyle("groq", "https://api.groq.com/openai/v1/chat/completions", "GROQ_API_KEY", GROQ_MODEL));
  if (process.env.MISTRAL_API_KEY) out.push(openaiStyle("mistral", "https://api.mistral.ai/v1/chat/completions", "MISTRAL_API_KEY", MISTRAL_MODEL));

  return out;
}

const PROVIDERS = buildProviders();
export const llmAvailable = PROVIDERS.length > 0;
export const llmProviderNames = PROVIDERS.map((p) => p.name);

let _rr = 0;
// Try providers starting at a rotating offset; fall through on any error/429.
export async function callLLM(system, user) {
  if (!PROVIDERS.length) throw new Error("No LLM keys configured (GEMINI_API_KEY / GROQ_API_KEY / MISTRAL_API_KEY).");
  const start = _rr++ % PROVIDERS.length;
  const errors = [];
  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[(start + i) % PROVIDERS.length];
    try {
      const text = await p.call(system, user);
      if (text && text.trim()) return { text, provider: p.name };
      errors.push(`${p.name}: empty`);
    } catch (e) {
      errors.push(e.message);
      await sleep(400); // small breather before the next provider
    }
  }
  throw new Error(`all providers failed — ${errors.join(" | ")}`);
}

// Defensive JSON parse: strip code fences / leading prose, grab the outermost object.
export function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(t); } catch { /* try to slice */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* nope */ } }
  return null;
}
