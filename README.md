<p align="center">
  <img src="./openrouter-logo.jpeg" alt="openrouter-cli" width="120" />
</p>

<h1 align="center">openrouter-cli</h1>

<p align="center">
  <em>Unofficial — not affiliated with or endorsed by OpenRouter.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openrouter"><img src="https://img.shields.io/npm/v/openrouter?style=flat-square&logo=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/openrouter"><img src="https://img.shields.io/npm/dm/openrouter?style=flat-square&logo=npm&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/aaronjmars/openroutercli/stargazers"><img src="https://img.shields.io/github/stars/aaronjmars/openroutercli?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/aaronjmars/openroutercli/network/members"><img src="https://img.shields.io/github/forks/aaronjmars/openroutercli?style=flat-square&logo=github" alt="GitHub forks"></a>
  <a href="https://openrouter.ai/"><img src="https://img.shields.io/badge/Powered%20by-OpenRouter-6E4AFF?style=flat-square&labelColor=1a1a2e" alt="Powered by OpenRouter"></a>
</p>

<p align="center">
  <strong>Every OpenRouter endpoint, on the command line — for humans and LLM agents</strong><br>
  Browser-based OAuth login, full access to chat / messages / responses / embeddings / rerank / audio / video / models / providers / generations / credits / activity / keys / guardrails / workspaces, and a raw <code>request</code> escape hatch. <code>--json</code> on every command. Zero npm dependencies.
</p>

---

## What it does

- One CLI for the entire [OpenRouter API](https://openrouter.ai/docs) — every endpoint in the OpenAPI spec is reachable.
- Login once with browser-based **OAuth (PKCE)**, paste an existing key, or use env vars. Separate slot for **management/provisioning keys**.
- Streams chat completions in a TTY; emits clean JSON when piped or with `--json`. Built so an agent can `--json | jq` reliably.
- Knows the difference between user keys and management keys — picks the right one per command.

## Quick start

The recommended path: **install with npm + `openrouter login`.** First request in under 60 seconds.

**Prereqs** — Node.js 20+ and an [OpenRouter account](https://openrouter.ai/).

Install:

- **npm** — `npm install -g openrouter`
- **npx** *(no install)* — `npx openrouter --help`
- **From source** — `git clone https://github.com/aaronjmars/openroutercli && cd openroutercli && npm link`

Then:

```bash
openrouter login                                            # OAuth in the browser
openrouter chat "say hi" -m openai/gpt-4o-mini              # streaming chat
openrouter --json models --filter sonnet | jq '.data[].id'  # pipeable JSON
openrouter credits                                          # what's left in the tank
```

**Other paths** — drop in an existing key with `openrouter login --key sk-or-...`, pipe one in with `--stdin`, or set `OPENROUTER_API_KEY` for ephemeral use. Management keys (for `keys` / `guardrails` / `workspaces` / `activity`) come from the [dashboard](https://openrouter.ai/settings/provisioning-keys) and are saved with `openrouter login --management`.

## Features

| Feature | What it does |
|---|---|
| **OAuth PKCE login** | `openrouter login` opens the browser, catches the callback locally, exchanges the code, and stores the key — `0600` perms in `~/.config/openrouter/`. No paste-an-API-key dance. |
| **Two-slot key management** | User key + management/provisioning key live in separate slots. `keys`, `guardrails`, `workspaces`, `activity` auto-pick the management key; everything else uses the user key. `--key` always wins. |
| **Streaming + JSON modes** | Streams in a TTY, switches to JSON when piped or `--json` is set. No global flag plumbing — works on every command. |
| **Chat with everything** | Tool calls (`--tool @file.json --tool-choice required`), structured output (`--schema schema.json`), JSON mode, multimodal images (`--image url\|path`), reasoning effort, provider routing, fallback models, seed, stop sequences, full sampling controls. |
| **Interactive REPL** | `openrouter chat -i` — slash commands `/model <id>`, `/reset`, `/exit`. History preserved per session. |
| **Multi-format inference** | `chat` (OpenAI), `messages` (Anthropic), `responses` (OpenAI Responses) — same auth, same flags, same JSON contract. |
| **Embeddings + rerank + TTS + video** | `embed`, `rerank`, `speech`, `video {create,wait,download}` — async video jobs poll-until-done with `video wait <jobId>`. |
| **Model discovery with detail** | `models list` (filter, sort by price/context), `models show <id>` (full pricing breakdown — prompt, completion, cache r/w, reasoning, image, web search), `models endpoints <id> --sort throughput\|latency\|prompt\|completion\|uptime --best` for choosing the right provider variant. |
| **Spend + activity + generations** | `credits` for balance, `whoami` for daily/weekly/monthly usage + rate limit, `keys get <hash>` for per-key spend, `activity --api-key-hash <hash>` for daily aggregates, `generation <id> [--content]` for full per-request metadata + input/output. |
| **Account + governance** | `keys`, `guardrails` (allow/deny lists, USD limits, ZDR), `workspaces` (defaults + members), `org members`, `auth-code` to mint claim links. All require a management key. |
| **Raw escape hatch** | `openrouter request <METHOD> <path> --body @file.json --query k=v --header k:v` — talk to any current or future endpoint without waiting for a CLI release. |
| **Agent-friendly errors** | Stable exit codes (1 usage, 2 API, 3 no key, 4 job failed). API error messages surfaced verbatim. `OPENROUTER_DEBUG=1` for stack traces. |
| **Zero npm dependencies** | Pure Node 20+ — built-in `fetch`, `parseArgs`, `crypto`. Cold install in seconds. Easy to audit. |

Each command supports `openrouter <command> --help` for full per-command flags.

## Use cases

- **Throwaway prompts from the shell** — `echo "summarize this" \| openrouter chat -m openai/gpt-4o-mini` instead of opening a browser tab.
- **Agent / script integration** — `openrouter --json chat ... \| jq` keeps stdout clean and machine-parseable; meaningful exit codes let scripts branch on errors.
- **Comparing models head-to-head** — `for m in claude-sonnet-4.5 gpt-4o gemini-2.5-pro; do openrouter chat "$prompt" -m anthropic/$m; done`
- **Picking the cheapest / fastest provider variant** — `openrouter models endpoints <id> --sort throughput --best` before locking in a model in production.
- **Cost monitoring** — `openrouter credits` + `openrouter whoami` in cron / a status bar; `openrouter keys get <hash>` per-app.
- **Provisioning per-customer keys** — wrap `openrouter keys create` in your onboarding flow; rotate / disable / delete via `keys update --disabled` and `keys delete`.
- **Auditing a specific request** — paste a `gen-...` id into `openrouter generation <id> --content` to see exactly what was sent and returned, with cost.
- **CI smoke-tests for prompt changes** — fixed seed, JSON-schema response, exit non-zero on regression.

## Examples

```bash
# Browser OAuth login (recommended)
openrouter login

# Manual key entry (and management/provisioning key)
openrouter login --key sk-or-v1-...
openrouter login --management --key sk-or-v1-...

# Streaming chat
openrouter chat "Write a haiku about caching" -m anthropic/claude-sonnet-4.5

# Multimodal
openrouter chat "What's in this picture?" -m google/gemini-2.5-flash --image ./photo.jpg

# Strict JSON output
openrouter chat "List 3 fruits" -m openai/gpt-4o-mini \
  --schema '{"type":"object","properties":{"fruits":{"type":"array","items":{"type":"string"}}},"required":["fruits"]}'

# Tool calling
openrouter chat "What is 2+2?" -m openai/gpt-4o-mini \
  --tool @calc.json --tool-choice required --raw

# Discovery
openrouter models --filter claude --sort prompt
openrouter models show anthropic/claude-sonnet-4.5
openrouter models endpoints anthropic/claude-sonnet-4.5 --sort throughput --best
openrouter providers

# Spend / runs
openrouter credits
openrouter whoami
openrouter generation gen-1234567890 --content
openrouter activity --date 2026-04-28 --api-key-hash <hash>

# Management (provisioning key required)
openrouter keys create "agent-key" --limit 25 --limit-reset monthly
openrouter guardrails create "no-paid-models" --allowed-providers "" --enforce-zdr
openrouter workspaces create "staging" --slug staging --default-text-model openai/gpt-4o-mini

# Raw escape hatch — call any endpoint
openrouter request POST /chat/completions --body @body.json
openrouter request GET /endpoints/zdr
```

## Documentation

| | |
|---|---|
| `openrouter --help` | Top-level command index |
| `openrouter <command> --help` | Per-command flags + examples |
| [SKILL.md](./SKILL.md) | Drop-in skill description for LLM agents (Claude Code / Cursor / etc.) — what to use, when, how, with patterns and pitfalls |
| [OpenRouter API docs](https://openrouter.ai/docs) | Upstream API reference |
| [OpenRouter dashboard](https://openrouter.ai/keys) | Manage keys, billing, workspaces in the browser |
| [Provisioning keys](https://openrouter.ai/settings/provisioning-keys) | Where management keys are minted |

Endpoint coverage map:

| OpenRouter endpoint | Command |
|---|---|
| `POST /auth/keys` (PKCE exchange) | `openrouter login` |
| `POST /auth/keys/code` | `openrouter auth-code` |
| `GET /key` | `openrouter whoami` |
| `GET /credits` | `openrouter credits` |
| `GET /activity` | `openrouter activity` |
| `GET /models` | `openrouter models list` |
| `GET /models/count` | `openrouter models count` |
| `GET /models/user` | `openrouter models user` |
| `GET /models/{author}/{slug}/endpoints` | `openrouter models endpoints` |
| `GET /providers` | `openrouter providers` |
| `GET /endpoints/zdr` | `openrouter zdr` |
| `POST /chat/completions` | `openrouter chat`, `openrouter complete` |
| `POST /messages` | `openrouter messages` |
| `POST /responses` | `openrouter responses` |
| `POST /embeddings` / `GET /embeddings/models` | `openrouter embed [models]` |
| `POST /rerank` | `openrouter rerank` |
| `POST /audio/speech` | `openrouter speech`, `openrouter tts` |
| `POST /videos`, `GET /videos/{id}`, `GET /videos/{id}/content`, `GET /videos/models` | `openrouter video {create,get,wait,download,models}` |
| `GET /generation`, `GET /generation/content` | `openrouter generation [--content]` |
| `GET/POST/PATCH/DELETE /keys[/{hash}]` | `openrouter keys {list,get,create,update,delete}` |
| `GET/POST/PATCH/DELETE /guardrails[/{id}]` + assignments | `openrouter guardrails ...` |
| `GET/POST/PATCH/DELETE /workspaces[/{id}]` + members | `openrouter workspaces ...` |
| `GET /organization/members` | `openrouter org members` |
| anything else | `openrouter request <METHOD> <path>` |

## Configuration

| flag | env | description |
|---|---|---|
| `-k, --key <key>` | `OPENROUTER_API_KEY` (user) / `OPENROUTER_MANAGEMENT_KEY` (mgmt) | API key to use; flag overrides env / config |
| `--base-url <url>` | `OPENROUTER_BASE_URL` | API base (default `https://openrouter.ai/api/v1`) |
| `--referer <url>` | `OPENROUTER_REFERER` | `HTTP-Referer` header (your app URL) |
| `--title <name>` | `OPENROUTER_TITLE` | `X-Title` header (your app name; appears on openrouter.ai) |
| `--json` | — | JSON output, no streaming, no color |
| `-q, --quiet` | — | Suppress informational stderr |
| — | `NO_COLOR` | Disable ANSI colors |
| — | `OPENROUTER_DEBUG=1` | Stack traces on error |

Config file: `~/.config/openrouter/config.json` (or `$XDG_CONFIG_HOME/openrouter/`), `0600` perms.

## License & disclaimer

MIT. See [LICENSE](./LICENSE).

This is an **unofficial** community project. It is not affiliated with,
endorsed by, or sponsored by OpenRouter. "OpenRouter" and the OpenRouter
logo are trademarks of their respective owners; usage here is for
identification only.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=aaronjmars/openroutercli&type=Date)](https://www.star-history.com/#aaronjmars/openroutercli&Date)
