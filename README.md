# nvidia-proxy

OpenAI-compatible proxy for [build.nvidia.com](https://build.nvidia.com) NIM APIs
that **auto-rotates API keys and models** when one hits its rate limit (`429`).

Single file, zero dependencies, Node 18+ (uses built-in `fetch`).

## Why

The NVIDIA free tier is rate-limited (~40 RPM, no token/day cap). When a key/model
returns `429`, this proxy transparently fails over to the next key, then the next
model, so a coding agent keeps running.

## Run

```sh
# one or more keys, comma-separated
NVIDIA_API_KEY="nvapi-aaa,nvapi-bbb" node server.mjs
```

Windows PowerShell:

```powershell
$env:NVIDIA_API_KEY="nvapi-aaa,nvapi-bbb"; node server.mjs
```

Point any OpenAI client at `http://localhost:8787/v1`.

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `NVIDIA_API_KEY` | — (required) | One or more keys, comma-separated |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | Bind address. `0.0.0.0` = reachable from other machines |
| `PROXY_TOKEN` | — | If set, callers must send `Authorization: Bearer <token>`. **Set this when exposing the proxy.** |
| `MODELS` | see `server.mjs` | Fallback chain, comma-separated, in priority order |

## Access from other machines / a domain

The server binds `0.0.0.0` by default, so it's reachable at `http://<machine-ip>:8787/v1`
from any device on the network. **Always set `PROXY_TOKEN`** first — otherwise anyone
who reaches the port can spend your NVIDIA keys.

```sh
PROXY_TOKEN="s3cret" NVIDIA_API_KEY="nvapi-aaa,nvapi-bbb" node server.mjs
```

Clients then use `PROXY_TOKEN` as their OpenAI API key:

```sh
curl http://SERVER_IP:8787/v1/chat/completions \
  -H "Authorization: Bearer s3cret" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

For a domain + HTTPS, put it behind any reverse proxy (Caddy, nginx, or a Cloudflare
Tunnel) pointing at `127.0.0.1:8787`. CORS is enabled (`*`) so browser clients work too.

## Rotation logic

- Outer loop = **key** (primary; rate limit may be global per-key).
- Inner loop = **model** (secondary).
- `429/402` → cool the key (honors `Retry-After`) + brief model cooldown → next key.
- `401/403` → park key 5m → next key.
- `404` → cool model 5m → next model.
- `5xx`/network → cool model 30s → next model.
- `400` → returned as-is (real client error).

Response headers `x-proxy-model` and `x-proxy-key` show what served the request.
Streaming (`stream: true`) is passed through.

## Endpoints

- `POST /v1/chat/completions` — proxied with rotation.
- `GET /v1/models` — the configured chain.
- `GET /health` — per-key and per-model cooldown status.

## Recommended models for coding

`qwen/qwen3.5-122b-a10b`, `deepseek-ai/deepseek-v4-pro`, `openai/gpt-oss-120b`,
`minimaxai/minimax-m3`, `mistralai/mistral-small-4-119b-2603`.
