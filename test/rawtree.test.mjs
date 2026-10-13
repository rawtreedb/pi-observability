import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";

import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createRawtreeExtension } from "../index.mjs";
import { openSession, closeSession } from "./helpers/session.mjs";

const SECRET = "synthetic-secret-value-1234567890";
const initialEnv = { ...process.env };
const requests = [];
let server;
let apiUrl;
let status = 200;
let responseBody = {};
let delayMs = 0;

before(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    requests.push({ url: req.url, headers: req.headers, payload: JSON.parse(body) });
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(responseBody));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  for (const name of Object.keys(process.env)) if (!(name in initialEnv)) delete process.env[name];
  Object.assign(process.env, initialEnv);
});
beforeEach(() => {
  requests.length = 0;
  status = 200;
  responseBody = {};
  delayMs = 0;
});

const spans = () => requests.flatMap((request) => {
  assert.ok(Array.isArray(request.payload.resourceSpans), "export must be OTLP, not table rows");
  return request.payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
});
const attributes = (span) => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? value.arrayValue?.values.map((item) => item.stringValue)]));

/** @param {any[]} responses @param {any[]} [tools] @returns {Promise<any>} */
async function openAgent(responses, tools = []) {
  Object.assign(process.env, {
    RAWTREE_API_KEY: "rt_test_key", RAWTREE_API_URL: apiUrl, RAWTREE_DATABASE: "agents",
    RAWTREE_SERVICE_NAME: "pi-test", TEST_API_TOKEN: SECRET,
  });
  return openSession(responses, tools);
}

/** @param {any[]} responses @param {any[]} [tools] @returns {Promise<any>} */
async function runAgent(responses, tools = []) {
  const session = await openAgent(responses, tools);
  await session.prompt("check the synthetic service");
  // SDK hosts can dispose the session as soon as prompt() returns.
  const received = spans().map((span) => span.spanId);
  await closeSession(session);
  session.receivedBeforeDispose = received;
  return session;
}

const queryTool = defineTool({
  name: "query_logs",
  label: "Query logs",
  description: "Query logs",
  parameters: Type.Object({ sql: Type.String() }),
  execute: async (_id, params) => ({
    content: [{ type: "text", text: `rows for ${params.sql}; token=${SECRET}; Authorization: Bearer abcdefghijklmnop` }],
    details: undefined,
  }),
});

test("an SDK run exports a GenAI span tree with reasoning, transcript, tools, and redaction", async () => {
  delayMs = 300;
  const session = await runAgent([
    fauxAssistantMessage([fauxThinking("Check synthetic service errors first"), fauxToolCall("query_logs", { sql: "SELECT 1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Synthetic service result verified.")]),
  ], [queryTool]);

  assert.ok(requests.length >= 1);
  for (const request of requests) {
    assert.equal(request.url, "/otlp/v1/traces");
    assert.equal(request.headers.authorization, "Bearer rt_test_key");
    assert.equal(request.headers["x-rawtree-database"], "agents");
    assert.equal(request.headers["x-rawtree-traces-table"], undefined);
    assert.equal(attributes(request.payload.resourceSpans[0].resource)["service.name"], "pi-test");
  }
  const events = spans();
  assert.deepEqual(session.receivedBeforeDispose, events.map((span) => span.spanId));
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map((span) => span.traceId)).size, 1);
  assert.equal(new Set(events.map((span) => span.spanId)).size, 4);
  const root = events.find((span) => !span.parentSpanId);
  assert.ok(root);
  for (const span of events) {
    assert.match(span.traceId, /^[a-f0-9]{32}$/);
    assert.match(span.spanId, /^[a-f0-9]{16}$/);
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
    if (span !== root) assert.equal(span.parentSpanId, root.spanId);
  }
  const [decision, tool, answer] = events.filter((span) => span !== root).map(attributes);
  const start = attributes(root);
  assert.equal(start["gen_ai.operation.name"], "invoke_agent");
  assert.ok(start["gen_ai.conversation.id"]);
  assert.equal(JSON.parse(start["gen_ai.input.messages"])[0].parts[0].content, "check the synthetic service");
  assert.match(start["gen_ai.system_instructions"], /You are a synthetic test assistant/);
  assert.match(decision["gen_ai.system_instructions"], /You are a synthetic test assistant/);
  assert.equal(decision["gen_ai.provider.name"], "faux");
  assert.equal(decision["gen_ai.request.model"], "faux-1");
  assert.equal(decision["pi.reasoning"], "Check synthetic service errors first");
  assert.deepEqual(decision["gen_ai.response.finish_reasons"], ["tool_calls"]);
  const call = JSON.parse(decision["gen_ai.output.messages"])[0].parts.find((part) => part.type === "tool_call");
  assert.equal(call.id, tool["gen_ai.tool.call.id"]);
  assert.equal(tool["gen_ai.operation.name"], "execute_tool");
  assert.equal(tool["gen_ai.tool.name"], "query_logs");
  assert.deepEqual(JSON.parse(tool["gen_ai.tool.call.arguments"]), { sql: "SELECT 1" });
  assert.match(tool["gen_ai.tool.call.result"], /rows for SELECT 1/);
  const history = JSON.parse(answer["gen_ai.input.messages"]);
  assert.ok(history.some((message) => message.role === "tool" && message.parts.some((part) => part.id === call.id && /rows for SELECT 1/.test(part.response))));
  assert.equal(JSON.parse(start["gen_ai.output.messages"])[0].parts[0].content, session.getLastAssistantText());
  assert.ok(Number(answer["gen_ai.usage.output_tokens"]) > 0);

  const exported = JSON.stringify(requests.map((request) => request.payload));
  assert.doesNotMatch(exported, new RegExp(SECRET));
  assert.doesNotMatch(exported, /abcdefghijklmnop|rt_test_key/);
  assert.match(exported, /\[REDACTED\]/);
  const artifacts = new URL("../artifacts/", import.meta.url);
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(new URL("sdk-trace.json", artifacts), JSON.stringify(requests.map((request) => request.payload), null, 2));
});

test("a recovered tool failure stays on the tool span without failing the agent", async () => {
  const failingTool = defineTool({
    name: "query_logs", label: "Query logs", description: "Query logs",
    parameters: Type.Object({ sql: Type.String() }),
    execute: async () => { throw new Error("query timed out"); },
  });
  const session = await runAgent([
    fauxAssistantMessage([fauxToolCall("query_logs", { sql: "SELECT 1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("The query timed out; the available evidence is inconclusive."),
  ], [failingTool]);
  assert.equal(session.getLastAssistantText(), "The query timed out; the available evidence is inconclusive.");
  const tool = spans().find((span) => attributes(span)["gen_ai.operation.name"] === "execute_tool");
  const root = spans().find((span) => !span.parentSpanId);
  assert.equal(tool.status.code, 2);
  assert.equal(attributes(tool)["error.type"], "tool_error");
  assert.equal(root.status.code, 1);
});

test("a recovered model failure stays on its span without failing the agent", async () => {
  const pi = fakePi();
  createRawtreeExtension(pi, { apiKey: "k", apiUrl });
  await pi.handlers.get("before_agent_start")({ prompt: "check" }, {});
  await pi.handlers.get("message_end")({ message: {
    role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited",
  } });
  await pi.handlers.get("message_end")({ message: {
    role: "assistant", content: [{ type: "text", text: "all clear" }], stopReason: "stop",
  } });
  await pi.handlers.get("agent_settled")({});
  assert.deepEqual(spans().map((span) => span.status.code), [2, 1, 1]);
});

test("a failing RawTree API does not fail the run", async () => {
  status = 500;
  const session = await runAgent([fauxAssistantMessage("all clear")]);
  assert.equal(session.getLastAssistantText(), "all clear");
  assert.ok(requests.length >= 1);
});

test("SDK shutdown sends what an unfinished run recorded", async () => {
  delayMs = 300;
  let toolStarted;
  const started = new Promise((resolve) => { toolStarted = resolve; });
  const hangingTool = defineTool({
    name: "slow_query",
    label: "Slow query",
    description: "Never returns before the signal aborts",
    parameters: Type.Object({}),
    execute: (_id, _params, signal) => {
      toolStarted();
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  });
  const session = await openAgent([
    fauxAssistantMessage([fauxThinking("look at the slow table"), fauxToolCall("slow_query", {})], { stopReason: "toolUse" }),
  ], [hangingTool]);
  const running = session.prompt("check the synthetic service").catch(() => {});
  await started;

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  const events = spans();
  assert.equal(events.length, 3);
  assert.equal(attributes(events.at(-2))["pi.interrupted"], true);
  assert.equal(attributes(events.at(-1))["pi.interrupted"], true);
  assert.equal(events.at(-2).status.code, 2);
  assert.equal(attributes(events[0])["pi.reasoning"], "look at the slow table");

  await session.abort();
  await running;
  await closeSession(session);
});

/** @returns {{handlers: Map<string, Function>, on: (name: string, handler: Function) => void}} */
function fakePi() {
  const handlers = new Map();
  return { handlers, on(name, handler) { handlers.set(name, handler); } };
}

test("long fields are truncated and the batch is flushed on shutdown when a run never settles", async () => {
  const pi = fakePi();
  createRawtreeExtension(pi, { apiKey: "k", apiUrl, maxFieldChars: 100 });
  const ctx = { model: undefined, getSystemPrompt: () => "", sessionManager: { getSessionId: () => "s1" } };
  await pi.handlers.get("before_agent_start")({ prompt: "x".repeat(500) }, ctx);
  await pi.handlers.get("session_shutdown")({}, ctx);
  const [root] = spans();
  const prompt = JSON.parse(attributes(root)["gen_ai.input.messages"])[0].parts[0].content;
  assert.equal(prompt.length < 150, true);
  assert.match(prompt, /truncated/);
  assert.equal(attributes(root)["pi.interrupted"], true);
});

test("OTLP partial rejection is reported without failing the agent", async () => {
  responseBody = { partialSuccess: { rejectedSpans: "1", errorMessage: "invalid span" } };
  const errors = [];
  const pi = fakePi();
  createRawtreeExtension(pi, { apiKey: "k", apiUrl, onError: (error) => errors.push(String(error)) });
  await pi.handlers.get("before_agent_start")({ prompt: "check" }, {});
  await pi.handlers.get("agent_settled")({});
  assert.equal(spans().length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /rejected.*1.*invalid span/);
});

test("cache tokens count toward input usage and failed model calls have error status", async () => {
  const pi = fakePi();
  createRawtreeExtension(pi, { apiKey: "k", apiUrl });
  await pi.handlers.get("before_agent_start")({ prompt: "check" }, { model: { provider: "anthropic", id: "claude" } });
  await pi.handlers.get("turn_start")({ turnIndex: 0 });
  await pi.handlers.get("message_start")({ message: { role: "assistant" } });
  await pi.handlers.get("message_end")({ message: {
    role: "assistant", provider: "anthropic", model: "claude", content: [],
    stopReason: "error", errorMessage: "provider unavailable",
    usage: { input: 10, cacheRead: 20, cacheWrite: 30, output: 2, cost: { total: 0.1 } },
  } });
  await pi.handlers.get("agent_settled")({});
  const [model, root] = spans();
  assert.equal(Number(attributes(model)["gen_ai.usage.input_tokens"]), 60);
  assert.equal(Number(attributes(root)["gen_ai.usage.input_tokens"]), 60);
  assert.equal(Number(attributes(model)["gen_ai.usage.cache_read.input_tokens"]), 20);
  assert.equal(attributes(model)["pi.cost.usd"], 0.1);
  assert.equal(model.status.code, 2);
  assert.equal(root.status.code, 2);
});

test("shutdown closes an in-flight generation once and new prompts get independent traces", async () => {
  const pi = fakePi();
  createRawtreeExtension(pi, { apiKey: "k", apiUrl });
  await pi.handlers.get("before_agent_start")({ prompt: "first" }, {});
  await pi.handlers.get("message_start")({ message: { role: "assistant" } });
  await pi.handlers.get("session_shutdown")({});
  await pi.handlers.get("session_shutdown")({});
  const first = spans();
  assert.equal(first.length, 2);
  assert.equal(first[0].status.code, 2);
  assert.equal(attributes(first[0])["pi.interrupted"], true);
  await pi.handlers.get("before_agent_start")({ prompt: "second" }, {});
  await pi.handlers.get("agent_settled")({});
  assert.equal(spans().length, 3);
  assert.notEqual(first[0].traceId, spans().at(-1).traceId);
});

test("the package is a standard Pi package configured from the environment", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.deepEqual(manifest.pi.extensions, ["./index.mjs"]);
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.throws(() => createRawtreeExtension(fakePi(), { apiKey: undefined }), /RAWTREE_API_KEY/);
});
