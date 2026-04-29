---
name: openrouter-cli
description: Use the `openrouter` CLI to call any OpenRouter API endpoint from the shell — chat / messages / responses, embeddings, rerank, audio, video, model + provider discovery, generation lookup, credits, activity, and full key / guardrail / workspace management. Pass `--json` on every command for machine-parseable output.
---

# openrouter-cli skill

`openrouter` is a zero-dependency Node CLI that wraps the OpenRouter API. It's
designed for both humans and LLM agents — every command supports `--json` for
clean piping, has stable exit codes, and reads stdin where useful.

## When to use this skill

TRIGGER when the user asks to:
- call OpenRouter from the shell, a script, or an agent loop
- pick a cheaper / faster / more reliable model or provider variant
- look up pricing, throughput, latency, or supported parameters for a model
- check credits, per-key spend, daily/weekly/monthly usage, or rate limits
- inspect or audit a specific generation (`gen-...` id) — input, output, cost,
  latency, finish reason
- create / list / disable / delete OpenRouter API keys programmatically
- manage guardrails, workspaces, or organization members
- log in to OpenRouter from a fresh machine (OAuth PKCE in the browser)

SKIP when the user is already using the OpenAI / Anthropic / Cohere SDKs
directly without OpenRouter, or when the work is purely about model selection
strategy without any actual API calls.

## Install

```bash
# Recommended
npm install -g @aaronjmars/openrouter

# No install
npx -p @aaronjmars/openrouter openrouter --help

# From source
git clone https://github.com/aaronjmars/openroutercli && cd openroutercli && npm link
```

Requires Node.js 20+. Once installed, two binaries are available: `openrouter`
and the shorter alias `or`.

## Authenticate

Three ways, in priority order. The first match wins:

1. `--key sk-or-...` flag on the command (overrides everything)
2. Env var: `OPENROUTER_API_KEY` (user) / `OPENROUTER_MANAGEMENT_KEY` (mgmt)
3. Stored key from `openrouter login` at `~/.config/openrouter/config.json`
   (`0600`)

```bash
# Browser OAuth (PKCE) — recommended for humans
openrouter login

# Save an existing key non-interactively
openrouter login --key sk-or-v1-...
echo "sk-or-v1-..." | openrouter login --stdin
openrouter login --no-browser    # SSH / headless — prints URL, you open it

# Inspect / forget
openrouter whoami
openrouter logout
```

### Two key slots: user vs management

OpenRouter has two key types. The CLI keeps a slot for each and routes per
command automatically.

| Slot | Used by | How to obtain |
| --- | --- | --- |
| **User key** | `chat`, `messages`, `responses`, `embed`, `rerank`, `speech`, `video`, `generation`, `credits`, `whoami` | OAuth (`openrouter login`) or paste from dashboard |
| **Management key** | `keys`, `guardrails`, `workspaces`, `activity`, `org members`, `auth-code` | Dashboard only — <https://openrouter.ai/settings/provisioning-keys>. Cannot be obtained via OAuth. Save with `openrouter login --management`. |

You can store both — they live side by side in the config file. `--key sk-or-...`
always wins over both. Inference commands prefer the user key; management
commands prefer the management key; either falls back to the other if the
preferred slot is empty.

## Output: streaming vs JSON

- TTY + interactive command → streams tokens to stdout, status to stderr.
- `--json` → parsed JSON to stdout, no streaming, no color, no spinners.
- Piped stdout (no `--json`) → still streams unless the command formats a
  table, in which case it switches to a stable text format.

For agents, **always pass `--json` and parse the response.** Stderr stays
clean for diagnostic messages.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | success |
| 1 | usage error / unknown command / missing argument |
| 2 | API error (4xx / 5xx). Message format: `error: <status> <message>` on stderr. |
| 3 | no API key configured |
| 4 | async job ended in failed/cancelled state (e.g. `video wait`) |

Set `OPENROUTER_DEBUG=1` to print stack traces.

## Common commands

### Inference

```bash
# Streaming chat (default in TTY)
openrouter chat "Write a haiku about caching" -m anthropic/claude-sonnet-4.5

# One-shot, JSON for scripts
openrouter --json chat "Reply: ok" -m openai/gpt-4o-mini --no-stream

# From stdin
echo "summarize this" | openrouter chat -m openai/gpt-4o-mini

# Multimodal
openrouter chat "What's in this picture?" -m google/gemini-2.5-flash --image ./photo.jpg
openrouter chat "Caption this" -m openai/gpt-4o --image https://example.com/cat.png

# Strict structured output (JSON schema, strict mode)
openrouter chat "Pick 3 fruits" -m openai/gpt-4o-mini \
  --schema '{"type":"object","properties":{"fruits":{"type":"array","items":{"type":"string"}}},"required":["fruits"],"additionalProperties":false}'

# Tool calling
openrouter chat "What is 2+2?" -m openai/gpt-4o-mini \
  --tool '{"name":"add","parameters":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}}' \
  --tool-choice required --raw

# Reasoning effort
openrouter chat "tricky question" -m anthropic/claude-sonnet-4.5 --reasoning high

# Provider routing / fallback models
openrouter chat "..." -m primary/model --models fallback1/m,fallback2/m
openrouter chat "..." -m anthropic/claude-sonnet-4.5 --provider '{"order":["Google","Anthropic"]}'

# Interactive REPL
openrouter chat -i -m openrouter/auto
# Inside the REPL: /model <id>, /reset, /exit

# Anthropic-format and OpenAI Responses API are also available
openrouter messages "..." -m anthropic/claude-sonnet-4.5
openrouter responses "..." -m openai/gpt-4o-mini

# Embeddings, rerank, TTS, video
openrouter embed -m openai/text-embedding-3-small "hello" "world"
openrouter rerank -m cohere/rerank-v3.5 --query "italian food" -d pizza -d sushi -d pasta
openrouter speech "Hello there" -m elevenlabs/eleven-turbo-v2 --voice alloy -o out.mp3
openrouter video create "a sunset over mountains" -m google/veo-3
openrouter video wait <jobId> && openrouter video download <jobId> -o out.mp4
```

### Discovery & pricing

```bash
# Browse / filter / sort the catalog
openrouter models                                       # all (~370)
openrouter models --filter sonnet --sort prompt         # cheapest first
openrouter models --free                                # only :free models
openrouter models --output-modalities image             # image-output models
openrouter models --supported tools                     # filter by capability

# Full detail for one model: pricing breakdown, architecture, supported params
openrouter models show anthropic/claude-sonnet-4.5

# Compare provider variants for one model — find the best one
openrouter models endpoints anthropic/claude-sonnet-4.5 --sort throughput --best
openrouter models endpoints openai/gpt-4o-mini --sort latency
openrouter models endpoints openai/gpt-4o-mini --sort prompt

# Supporting metadata
openrouter providers                                    # all providers
openrouter embed models                                 # embedding models
openrouter video models                                 # video gen models
openrouter zdr                                          # ZDR-eligible endpoints
```

### Account / spend / runs

```bash
openrouter credits                       # total balance + total usage
openrouter whoami                        # label, daily/weekly/monthly usage, rate limit
openrouter generation gen-1234567890     # full per-request metadata + cost
openrouter generation gen-1234567890 --content   # + the input/output content

# Activity (management key required) — daily aggregates per endpoint
openrouter activity --date 2026-04-28
openrouter activity --api-key-hash <hash>
```

NOTE: `activity` only covers **completed UTC days** in the last 30 days.
Today's data isn't queryable until tomorrow. There's no per-request log
endpoint — the only way to inspect a specific in-flight request is by
`generation <id>` if you saved the id at call time.

`generation` lookups have a ~30-second propagation delay after the request
completes.

### Key management (management key required)

```bash
openrouter keys list
openrouter keys create "agent key" --limit 25 --limit-reset monthly
openrouter keys get <hash>
openrouter keys update <hash> --name "renamed" --limit 50
openrouter keys update <hash> --disabled
openrouter keys delete <hash>
```

The full `sk-or-v1-...` secret is returned **only once** in the `create`
response — capture it then.

### Guardrails / workspaces / org

```bash
openrouter guardrails list
openrouter guardrails create "no-paid-models" --allowed-providers "" --enforce-zdr
openrouter guardrails update <id> --limit-usd 10 --reset-interval daily
openrouter guardrails assign-key <id> <key-hash>
openrouter guardrails delete <id>

openrouter workspaces list
openrouter workspaces create "staging" --slug staging --default-text-model openai/gpt-4o-mini
openrouter workspaces add-members <id|slug> <user_id> [<user_id>...]
openrouter workspaces delete <id|slug>

openrouter org members
```

### Raw escape hatch

For any endpoint that doesn't have a first-class subcommand yet (or new
endpoints OpenRouter ships):

```bash
openrouter request GET /credits
openrouter request POST /chat/completions --body @body.json
openrouter request POST /chat/completions --body - < body.json     # stdin
openrouter request GET /models --query category=programming --query supported_parameters=tools
openrouter request POST /audio/speech --body @speech.json --binary out.mp3
openrouter request GET /key --header "X-Custom: value"
```

## Patterns for agents

### Pipe to jq

```bash
openrouter --json models --filter sonnet | jq -r '.data[].id'
openrouter --json chat "Say hi" -m openrouter/auto | jq -r '.choices[0].message.content'
openrouter --json credits | jq '.data.total_credits - .data.total_usage'
```

### Fail fast

```bash
if ! openrouter --json chat "..." -m model > /tmp/r.json; then
  echo "API call failed (exit $?)" >&2
  exit 1
fi
```

### Save the gen id for later audit

```bash
out=$(openrouter --json chat "..." -m openai/gpt-4o-mini)
gen_id=$(echo "$out" | jq -r '.id')
echo "$out" | jq -r '.choices[0].message.content'
# ...later, after ~30s...
openrouter generation "$gen_id" --content
```

### Pick the best provider variant before locking it in

```bash
# Cheapest provider for a given model
openrouter --json models endpoints openai/gpt-4o-mini --sort prompt --best \
  | jq -r '.data.endpoints[0] | "\(.provider_name): $\(.pricing.prompt)/tok"'

# Highest throughput provider
openrouter --json models endpoints anthropic/claude-sonnet-4.5 --sort throughput --best \
  | jq -r '.data.endpoints[0] | "\(.provider_name) @ \(.throughput_last_30m.p50) tok/s"'
```

### Check spend on a specific key

```bash
openrouter --json keys get <hash> | jq '.data | {usage, usage_daily, limit_remaining}'
```

## Pitfalls and gotchas

- **`--json` must come BEFORE the subcommand** for the global pre-parser to
  pick it up reliably. `openrouter --json chat ...` (correct), `openrouter
  chat ... --json` also works but is slightly less robust with positionals.
- **Generation lookups have ~30s lag.** Don't poll faster than that — you'll
  just get 404.
- **Activity is daily-aggregated and only covers completed UTC days.** A
  query for today returns `400 Date must be within the last 30 (completed)
  UTC days`.
- **Speech (`/audio/speech`) currently has limited model availability** on
  OpenRouter. The CLI sends valid requests; the API may return `Model X
  does not exist` for many model ids.
- **`auth-code` requires a Clerk session JWT** despite the OpenAPI spec
  suggesting any management key works. Treat that subcommand as best-effort
  until OpenRouter aligns server behavior with the spec.
- **`rate_limit` field is deprecated** by OpenRouter and may show as
  `-1 req / 10s`. Surfaced verbatim.
- **Management keys cannot do inference.** If you only have a management key
  saved and run `openrouter chat`, OpenRouter rejects with `401 User not
  found`. Save a user key too.

## Configuration reference

| flag | env | default |
| --- | --- | --- |
| `-k, --key` | `OPENROUTER_API_KEY` / `OPENROUTER_MANAGEMENT_KEY` | from config |
| `--base-url` | `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` |
| `--referer` | `OPENROUTER_REFERER` | `https://github.com/openrouter-cli` |
| `--title` | `OPENROUTER_TITLE` | `openrouter-cli` |
| `--json` | — | off |
| `-q, --quiet` | — | off |
| — | `NO_COLOR` | colors on in TTY |
| — | `OPENROUTER_DEBUG=1` | off |

Config file location: `$XDG_CONFIG_HOME/openrouter/config.json` (defaults to
`~/.config/openrouter/config.json`). Created with `0700` dir / `0600` file.

## Help

Every command has its own `--help`:

```bash
openrouter --help
openrouter chat --help
openrouter models --help
openrouter keys --help
openrouter guardrails --help
# ...etc
```

Repository: <https://github.com/aaronjmars/openroutercli>
OpenRouter docs: <https://openrouter.ai/docs>
