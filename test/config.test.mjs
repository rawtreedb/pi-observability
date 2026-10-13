import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import rawtree, { createRawtreeExtension } from "../index.mjs";
import { startCollector } from "./helpers/collector.mjs";

/** @returns {{handlers: Map<string, Function>, on: (name: string, handler: Function) => void}} */
function fakePi() {
  const handlers = new Map();
  return { handlers, on: (name, handler) => { handlers.set(name, handler); } };
}

/** @param {Record<string, string>} values @returns {{pi: ReturnType<typeof fakePi>, diagnostics: string[]}} */
function load(values) {
  const names = ["RAWTREE_ENABLED", "RAWTREE_API_KEY", "RAWTREE_API_URL", "RAWTREE_DATABASE", "RAWTREE_TABLE", "RAWTREE_SERVICE_NAME", "RAWTREE_MAX_FIELD_CHARS", "RAWTREE_CAPTURE_CONTENT"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const warn = console.warn;
  const diagnostics = [];
  const pi = fakePi();
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    console.warn = (...args) => { diagnostics.push(args.join(" ")); };
    assert.doesNotThrow(() => rawtree(pi));
    return { pi, diagnostics };
  } finally {
    console.warn = warn;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("explicit disablement needs no API key and installs no handlers", () => {
  const { pi, diagnostics } = load({ RAWTREE_ENABLED: "false" });
  assert.equal(pi.handlers.size, 0);
  assert.deepEqual(diagnostics, []);
});

test("an unconfigured local install stays inactive with a safe diagnostic", () => {
  const { pi, diagnostics } = load({});
  assert.equal(pi.handlers.size, 0);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /RAWTREE_API_KEY/);
});

test("existing API-key configuration enables tracing without a new flag", () => {
  const { pi, diagnostics } = load({ RAWTREE_API_KEY: "rt_test_key" });
  assert.ok(pi.handlers.has("before_agent_start"));
  assert.deepEqual(diagnostics, []);
});

for (const [name, value] of [
  ["RAWTREE_ENABLED", "yes"], ["RAWTREE_CAPTURE_CONTENT", "no"],
  ["RAWTREE_MAX_FIELD_CHARS", "0"], ["RAWTREE_MAX_FIELD_CHARS", "-1"],
  ["RAWTREE_MAX_FIELD_CHARS", "NaN"], ["RAWTREE_MAX_FIELD_CHARS", "Infinity"],
  ["RAWTREE_MAX_FIELD_CHARS", "1.5"],
]) {
  test(`invalid ${name}=${value} disables tracing with a diagnostic`, () => {
    const { pi, diagnostics } = load({ RAWTREE_API_KEY: "rt_test_key", [name]: value });
    assert.equal(pi.handlers.size, 0);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], new RegExp(name));
    assert.doesNotMatch(diagnostics[0], /rt_test_key/);
  });
}

for (const apiUrl of ["http://remote.example", "ftp://localhost", "https://user:private-endpoint-value@remote.example"]) {
  test(`unsafe endpoint ${apiUrl} stays inactive without disclosing credentials`, () => {
    const { pi, diagnostics } = load({ RAWTREE_API_KEY: "rt_test_key", RAWTREE_API_URL: apiUrl });
    assert.equal(pi.handlers.size, 0);
    assert.equal(diagnostics.length, 1);
    assert.doesNotMatch(diagnostics[0], /private-endpoint-value|rt_test_key/);
  });
}

/** @param {ReturnType<typeof fakePi>} pi @returns {Promise<void>} */
async function exercise(pi) {
  const ctx = { model: { provider: "test", id: "synthetic" }, cwd: "/private-content-marker", sessionManager: { getSessionId: () => "test-session" } };
  await pi.handlers.get("before_agent_start")({ prompt: "private-content-marker", systemPrompt: "private-content-marker" }, ctx);
  await pi.handlers.get("turn_start")({ turnIndex: 0 }, ctx);
  await pi.handlers.get("message_end")({ message: {
    role: "assistant", model: "synthetic", provider: "test", stopReason: "toolUse",
    content: [{ type: "thinking", thinking: "private-content-marker" }, { type: "toolCall", id: "call-1", name: "lookup", arguments: { data: "private-content-marker" } }],
    usage: { input: 1, output: 2 },
  } });
  await pi.handlers.get("tool_execution_start")({ toolCallId: "call-1", toolName: "lookup", args: { data: "private-content-marker" } });
  await pi.handlers.get("tool_execution_end")({ toolCallId: "call-1", toolName: "lookup", result: { content: [{ type: "text", text: "private-content-marker" }] }, isError: false });
  await pi.handlers.get("message_end")({ message: {
    role: "assistant", model: "synthetic", provider: "test", stopReason: "error", errorMessage: "private-content-marker",
    content: [{ type: "text", text: "private-content-marker" }], usage: { input: 3, output: 4 },
  } });
  await pi.handlers.get("agent_settled")({});
}

test("programmatic configuration routes spans to a custom trace table", async () => {
  const collector = await startCollector();
  try {
    const pi = fakePi();
    createRawtreeExtension(pi, { apiKey: "rt_test_key", apiUrl: collector.url, table: "pi_sdk_traces" });
    await exercise(pi);
    assert.ok(collector.requests.length > 0);
    assert.ok(collector.requests.every((request) => request.table === "pi_sdk_traces"));
  } finally {
    await collector.close();
  }
});

test("content opt-out preserves trace metadata without leaking content or error bodies", async () => {
  const requests = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(500).end("private-content-marker");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    const pi = fakePi();
    createRawtreeExtension(pi, { apiKey: "rt_test_key", apiUrl, captureContent: false, onError: (error) => errors.push(String(error)) });
    await exercise(pi);
    const payload = requests[0];
    assert.doesNotMatch(JSON.stringify(payload), /private-content-marker/);
    assert.doesNotMatch(errors.join("\n"), /private-content-marker/);
    assert.match(errors.join("\n"), /HTTP 500/);
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 4);
    const root = spans.find((span) => !span.parentSpanId);
    assert.equal(root.status.code, 2);
    assert.ok(spans.every((span) => span.startTimeUnixNano && span.endTimeUnixNano));
    const attrs = Object.fromEntries(root.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue]));
    assert.equal(Number(attrs["gen_ai.usage.input_tokens"]), 4);
    assert.equal(Number(attrs["gen_ai.usage.output_tokens"]), 6);
    const keys = spans.flatMap((span) => span.attributes.map((attr) => attr.key));
    assert.ok(keys.includes("gen_ai.tool.name"));
    for (const key of ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions", "pi.reasoning", "pi.cwd", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) {
      assert.ok(!keys.includes(key), `content attribute ${key} must be absent`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
