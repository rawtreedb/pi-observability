# pi-observability-rawtree

Pi extension that exports agent, model-request and tool-call spans to RawTree's
[OTLP endpoint](https://rawtree.com/docs/guides/opentelemetry), using
[OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai).
Requires Node 22.19+ and Pi 1.0.3+; standalone CLI tests use Pi 1.2.0.
Licensed under [Apache-2.0](LICENSE); contributions follow [CONTRIBUTING.md](CONTRIBUTING.md).

Install the OpenTelemetry app on an available RawTree cluster before exporting.
The package has no runtime dependencies and needs no npm publication for local use.

## Install

Install from Git; npm publication is not required:

```bash
pi install git:github.com/tinybirdco/pi-observability-rawtree
export RAWTREE_API_KEY=...  # writable cluster API key
export RAWTREE_DATABASE=default
pi
```

Append `@<commit-sha>` to the Git source for a pinned installation. For local development,
run `pi -e /absolute/path/to/pi-observability-rawtree` or install that directory.

Local installs reference the directory; keep it available or remove it with
`pi remove /absolute/path/to/pi-observability-rawtree`. Use `pi install --local` for project scope.

**Content capture is enabled by default.** Prompts, reasoning and tool results can
contain private data; restrict database access. Set `RAWTREE_CAPTURE_CONTENT=false`
for metadata-only traces before starting Pi.

## Configuration

Configuration comes from environment variables. `.env.example` is a template;
Pi does not automatically load dotenv files. Keep credentials out of Pi settings.

| Variable | Default | Meaning |
|---|---|---|
| `RAWTREE_API_KEY` | required to activate | RawTree cluster API key with write access |
| `RAWTREE_ENABLED` | `true` | `false` disables tracing even with a key |
| `RAWTREE_DATABASE` | key's default | destination database via `x-rawtree-database` |
| `RAWTREE_TABLE` | `traces` | destination trace table via `x-rawtree-traces-table` |
| `RAWTREE_API_URL` | `https://api.rawtree.com` | API base URL; exporter posts to `/otlp/v1/traces` |
| `RAWTREE_SERVICE_NAME` | `pi-agent` | OpenTelemetry `service.name` |
| `RAWTREE_CAPTURE_CONTENT` | `true` | export prompt, message, reasoning and tool content |
| `RAWTREE_MAX_FIELD_CHARS` | `32000` | positive integer limit for each content string |

Booleans accept `true` or `false`. A missing key or invalid configuration leaves
tracing inactive with a diagnostic; it does not prevent Pi from running. Disabled
tracing requires no key. Remote endpoints require HTTPS without URL credentials;
HTTP is permitted only for localhost test collectors.

Metadata-only mode omits message bodies, system instructions, reasoning, tool
arguments/results, final answer and working directory. Model/tool names, IDs,
timings, usage, cost and status remain; detailed error messages are omitted.

## Data sent

Each run has an `invoke_agent` root, `chat` model-request children and
`execute_tool` children. Nested tool calls use their executing tool as parent.
`service.name` identifies the workload, `gen_ai.conversation.id` groups runs from
one session and `pi.turn.index` identifies each child's turn.

| Span | Attributes |
|---|---|
| Agent | `gen_ai.agent.name`, messages, system instructions, token totals, `pi.turns`, `pi.tool_calls`, `pi.interrupted`, `pi.cost.usd` |
| Model | Provider, requested/response model, messages, finish reasons, input/output/cache tokens, `pi.reasoning`, `pi.cost.usd` |
| Tool | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` |

Messages use the GenAI role/parts structure serialized as JSON string attributes.
Reasoning uses `pi.reasoning`; images are placeholders and thinking signatures are
omitted. Input-token totals include uncached input, cache reads and cache writes.

Completed spans are batched after each turn; the root is sent when the run ends.
Child errors remain visible; recovered tool/model errors do not fail the root.
HTTP failures and OTLP partial rejections are logged without failing the agent.

Secret-like environment values, bearer tokens, known token formats and private
keys are redacted. Each content string is truncated without breaking message JSON.
Redaction is best-effort, not a guarantee that arbitrary content is safe to export.

Spans go to `traces` or the table selected by `RAWTREE_TABLE`; log and metric tables
receive no data. RawTree flattens resource/span attributes into columns;
trace IDs and parent span IDs preserve the hierarchy. GenAI conventions are in
Development, and backend rendering support can differ.

```sql
SELECT traceId, spanId, parentSpanId, name, gen_ai.operation.name, pi.reasoning
FROM traces
WHERE service.name = 'pi-agent'
ORDER BY startTimeUnixNano DESC
LIMIT 100
```

## Verify independently

From this package directory:

```bash
npm ci
TB_TEST_SHARED_ENV=true npm test
TB_TEST_SHARED_ENV=true npm run test:cli
npm pack --dry-run
```

Tests use scripted models and a local OTLP collector, without live model or
RawTree calls. CLI tests copy the runtime outside the repository and exercise
installation/removal and one-shot loading with isolated `PI_CODING_AGENT_DIR`
settings. Redacted examples are written to `artifacts/*-trace.json`.

## Test with Pi CLI and RawTree

With a RawTree key exported, use a temporary directory containing only synthetic
input and your configured Pi model:

```bash
PLUGIN_DIR="$(pwd)"
TEST_DIR="$(mktemp -d)"
printf 'Synthetic sample: ready\n' > "$TEST_DIR/sample.txt"
cd "$TEST_DIR"
RAWTREE_ENABLED=true RAWTREE_SERVICE_NAME=pi-rawtree-cli-smoke \
  pi -e "$PLUGIN_DIR" --no-approve --no-context-files --no-skills \
  --no-prompt-templates --tools read --print \
  "Read sample.txt and report its contents."
```

Query `traces` (or your `RAWTREE_TABLE`) with `service.name = 'pi-rawtree-cli-smoke'` and inspect the agent,
model and read-tool spans. Model requests incur your provider's normal charges.

## SDK hosts

Load the directory through `DefaultResourceLoader.additionalExtensionPaths`.
`createRawtreeExtension(pi, options)` also supports programmatic configuration;
`captureContent: false` selects metadata-only mode.

Pi CLI owns shutdown emission. SDK hosts must emit it before disposing unfinished
sessions; `AgentSession.dispose()` does not emit `session_shutdown`:

```js
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
session.dispose();
```

Pi awaits final export before `prompt()` returns. Export requests time out after
five seconds; SDK hosts should bound shutdown waits. SIGKILL can lose spans.
The plugin sends OTLP/HTTP JSON directly; it does not install a global OTel provider
or automatically instrument other libraries.
