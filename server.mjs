import { createServer } from "node:http";

const UPSTREAM = "https://integrate.api.nvidia.com/v1";
const PORT = Number(process.env.PORT || 8787);

// Keys: rotate on quota/auth failure. Comma-separated in NVIDIA_API_KEY.
const KEYS = (process.env.NVIDIA_API_KEY || "").split(",").map((s) => s.trim()).filter(Boolean);

// Fallback model chain. First that has quota wins. Override with MODELS env (comma-separated).
const MODELS = (process.env.MODELS ||
  "mistralai/mistral-large-3-675b-instruct-2512,nvidia/nemotron-3-ultra-550b-a55b,qwen/qwen3.5-122b-a10b,deepseek-ai/deepseek-v4-pro,openai/gpt-oss-120b,nvidia/nemotron-3-super-120b-a12b,minimaxai/minimax-m3,mistralai/mistral-small-4-119b-2603,nvidia/nemotron-3-nano-30b-a3b,meta/llama-3.1-8b-instruct"
).split(",").map((s) => s.trim()).filter(Boolean);

if (!KEYS.length) {
  console.error("Set NVIDIA_API_KEY (one or more, comma-separated).");
  process.exit(1);
}

// name -> timestamp until which it is on cooldown (rate limited / unavailable)
const cooldown = new Map();
const now = () => Date.now();
const isCool = (x) => (cooldown.get(x) || 0) > now();
const cool = (x, ms) => cooldown.set(x, now() + ms);
const retryAfterMs = (res, def) => {
  const ra = Number(res.headers.get("retry-after"));
  return Number.isFinite(ra) && ra > 0 ? ra * 1000 : def;
};

function ready(list) {
  const r = list.filter((x) => !isCool(x));
  return r.length ? r : list; // all cooling: try anyway
}

// Round-robin key start so load spreads across keys (higher aggregate RPM).
let rr = 0;
function readyKeys() {
  const r = ready(KEYS);
  if (r.length < 2) return r;
  const i = rr++ % r.length;
  return r.slice(i).concat(r.slice(0, i));
}
function orderedModels(preferred) {
  const chain = preferred ? [preferred, ...MODELS.filter((m) => m !== preferred)] : [...MODELS];
  return ready(chain);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function callUpstream(path, body, model, key) {
  const payload = model ? JSON.stringify({ ...body, model }) : JSON.stringify(body);
  return fetch(UPSTREAM + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: payload,
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        keys: KEYS.map((k, i) => ({ idx: i, tail: k.slice(-6), cooling: isCool(k) })),
        models: MODELS.map((m) => ({ model: m, cooling: isCool(m) })),
      }));
    }

    if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model", owned_by: "nvidia" })) }));
    }

    if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }

    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw.toString("utf8") || "{}"); }
    catch { res.writeHead(400); return res.end(JSON.stringify({ error: "invalid json" })); }

    const models = orderedModels(body.model);
    let last = null;

    // Key is the primary rotation axis (rate limit may be per-key global).
    // Model is secondary: switch on 404/5xx (model unavailable).
    for (const key of readyKeys()) {
      for (const model of models) {
        let up;
        try { up = await callUpstream("/chat/completions", body, model, key); }
        catch (e) { last = { status: 502, text: String(e) }; continue; } // network: next model

        if (up.ok) {
          res.writeHead(up.status, {
            "content-type": up.headers.get("content-type") || "application/json",
            "x-proxy-model": model,
            "x-proxy-key": String(KEYS.indexOf(key)),
          });
          const reader = up.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          return res.end();
        }

        const text = await up.text().catch(() => "");
        last = { status: up.status, text };

        if (up.status === 429 || up.status === 402) {
          cool(key, retryAfterMs(up, 60_000));   // rate limited: rotate to next key
          cool(model, retryAfterMs(up, 15_000)); // also brief model cooldown
          break; // stop using this key, jump to next key
        }
        if (up.status === 401 || up.status === 403) {
          cool(key, 300_000); // bad/blocked key: park it 5m, next key
          break;
        }
        if (up.status === 404) { cool(model, 300_000); continue; } // model gone: next model
        if (up.status >= 500) { cool(model, 30_000); continue; }   // upstream hiccup: next model
        // real client error (e.g. 400): return as-is
        res.writeHead(up.status, { "content-type": "application/json", "x-proxy-model": model });
        return res.end(text || JSON.stringify({ error: "upstream error" }));
      }
    }

    res.writeHead(last?.status || 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "all keys/models exhausted", detail: last }));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  }
});

server.listen(PORT, () => console.log(`nvidia-proxy on :${PORT} | models=${MODELS.length} keys=${KEYS.length}`));
