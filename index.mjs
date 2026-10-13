import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveRawtreeOptions } from "./config.mjs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const DEFAULT_API_URL = "https://api.rawtree.com";
const DEFAULT_MAX_FIELD_CHARS = 32000;
const REDACTED = "[REDACTED]";
const CONTENT_ATTRIBUTES = new Set([
  "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "pi.reasoning", "pi.cwd",
]);

const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTH|COOKIE|CREDENTIAL/i;
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|rt_[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g,
];
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY|PRIVATE_?KEY)[A-Z0-9_]*)\s*[=:]\s*([^\s"'`,;]+)/gi;

/**
 * @typedef {{
 *   apiKey: string | undefined, apiUrl?: string, database?: string, table?: string,
 *   serviceName?: string, maxFieldChars?: number, captureContent?: boolean, onError?: (error: unknown) => void,
 * }} RawtreeOptions
 * @typedef {Record<string, unknown>} Attributes
 * @typedef {{role: string, parts: object[]}} ChatMessage
 * @typedef {{
 *   traceId: string, spanId: string, parentSpanId?: string, name: string, kind: number,
 *   startTimeUnixNano: string, endTimeUnixNano?: string, attributes: object[],
 *   status?: {code: number, message?: string},
 * }} Span
 * @typedef {{
 *   root: Span, sessionId: string, turn: number, turns: number, toolCalls: number,
 *   inputTokens: number, outputTokens: number, costUsd: number, output: string,
 *   lastModelFailed: boolean, model?: {provider: string, id: string},
 *   generation?: Span, tools: Map<string, Span>, input: object[], system: object[],
 * }} Run
 */

/** @param {unknown} error @returns {void} */
function report(error) {
  console.warn(`RawTree trace export failed: ${error instanceof Error ? error.message : String(error)}`);
}

/** @returns {string[]} */
function environmentSecrets() {
  return Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

/** @param {unknown} value @returns {string} */
function toText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** @param {any} result @returns {string} */
function toolResultText(result) {
  if (Array.isArray(result?.content)) {
    return result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
  }
  return toText(result);
}

/** @param {any} message @param {string} type @param {string} field @returns {string} */
function blocks(message, type, field) {
  return (message.content ?? []).filter((block) => block.type === type).map((block) => block[field]).join("\n");
}

/** Binary image data and provider thinking signatures must not leave the process. @param {any} message @returns {ChatMessage} */
function chatMessage(message) {
  if (message.role === "toolResult") {
    return { role: "tool", parts: [{ type: "tool_call_response", id: message.toolCallId, response: toolResultText(message) }] };
  }
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...(message.content ?? [])];
  if (message.role === "system") {
    for (const text of Object.values(message.sections ?? {})) {
      if (text !== null) content.push({ type: "text", text });
    }
  }
  return {
    role: message.role,
    parts: content.filter((block) => block.type !== "thinking").map((block) => {
      if (block.type === "text") return { type: "text", content: block.text };
      if (block.type === "toolCall") return { type: "tool_call", id: block.id, name: block.name, arguments: block.arguments };
      return { type: "text", content: `[${block.type}]` };
    }),
  };
}

/** @returns {string} */
function timestamp() {
  return (BigInt(Date.now()) * 1000000n).toString();
}

/**
 * Exports completed Pi operations as OTLP/HTTP JSON spans with GenAI attributes.
 * Content is redacted before export; failures do not affect the agent.
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 * @param {RawtreeOptions} options
 * @returns {void}
 */
export function createRawtreeExtension(pi, {
  apiKey, apiUrl = DEFAULT_API_URL, database, table, serviceName = "pi-agent",
  maxFieldChars = DEFAULT_MAX_FIELD_CHARS, captureContent = true, onError = report,
}) {
  if (!apiKey) throw new Error("RAWTREE_API_KEY is required when RawTree export is enabled");
  if (!Number.isSafeInteger(maxFieldChars) || maxFieldChars <= 0) throw new Error("RAWTREE_MAX_FIELD_CHARS must be a positive safe integer");
  if (typeof captureContent !== "boolean") throw new Error("captureContent must be a boolean");
  const baseUrl = new URL(apiUrl);
  if (baseUrl.username || baseUrl.password) throw new Error("RawTree API URL must not contain credentials");
  const url = new URL("/otlp/v1/traces", baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("RawTree export requires an HTTPS API URL");
  }
  const secrets = [apiKey, ...environmentSecrets()];
  /** @param {unknown} value @returns {string} */
  function clean(value) {
    let text = toText(value);
    for (const secret of secrets) text = text.split(secret).join(REDACTED);
    for (const pattern of PATTERNS) text = text.replace(pattern, REDACTED);
    text = text.replace(SECRET_ASSIGNMENT, (_match, name) => `${name}=${REDACTED}`);
    return text.length > maxFieldChars ? `${text.slice(0, maxFieldChars)}… [truncated ${text.length - maxFieldChars} chars]` : text;
  }

  /** Preserve structured message JSON when a content field is truncated. @param {unknown} value @returns {unknown} */
  function cleanStructure(value) {
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value)) return value.map(cleanStructure);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), cleanStructure(item)]));
    return value;
  }

  /** @param {Attributes} fields @returns {object[]} */
  function attributes(fields) {
    return Object.entries(fields).filter(([key, value]) => value !== undefined && (captureContent || !CONTENT_ATTRIBUTES.has(key))).map(([key, value]) => {
      let encoded;
      if (typeof value === "boolean") encoded = { boolValue: value };
      else if (typeof value === "number") encoded = Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
      else if (Array.isArray(value) && value.every((item) => typeof item === "string")) encoded = { arrayValue: { values: value.map((item) => ({ stringValue: clean(item) })) } };
      else encoded = { stringValue: typeof value === "string" ? clean(value) : JSON.stringify(cleanStructure(value)) };
      return { key, value: encoded };
    });
  }

  /** @type {Run | undefined} */
  let run;
  /** @type {Span[]} */
  let pending = [];
  let sending = Promise.resolve();

  /** @param {string} name @param {number} kind @param {Attributes} fields @param {string} [parentSpanId] @returns {Span} */
  function startSpan(name, kind, fields, parentSpanId) {
    return {
      traceId: run?.root.traceId ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"),
      ...(parentSpanId ? { parentSpanId } : {}), name: clean(name), kind,
      startTimeUnixNano: timestamp(), attributes: attributes(fields),
    };
  }

  /** @param {Span} span @param {Attributes} [fields] @param {string} [error] @returns {void} */
  function finishSpan(span, fields = {}, error) {
    if (span.endTimeUnixNano) return;
    span.endTimeUnixNano = timestamp();
    span.attributes.push(...attributes(fields));
    span.status = error ? { code: 2, message: captureContent ? clean(error) : "operation failed" } : { code: 1 };
    pending.push(span);
  }

  /** A failed batch is reported and dropped. @returns {Promise<void>} */
  function flush() {
    if (pending.length === 0) return sending;
    const spans = pending;
    pending = [];
    sending = sending.then(async () => {
      try {
        const response = await fetch(url, {
          method: "POST", signal: AbortSignal.timeout(5000),
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...(database ? { "x-rawtree-database": database } : {}), ...(table ? { "x-rawtree-traces-table": table } : {}) },
          body: JSON.stringify({ resourceSpans: [{
            resource: { attributes: attributes({ "service.name": serviceName }) },
            scopeSpans: [{ scope: { name: "pi-rawtree", version }, spans }],
          }] }),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}${captureContent ? `: ${clean(text).slice(0, 300)}` : ""}`);
        const partial = text ? JSON.parse(text).partialSuccess : undefined;
        if (Number(partial?.rejectedSpans) > 0 || partial?.errorMessage) {
          throw new Error(`OTLP rejected ${partial.rejectedSpans ?? 0} spans${captureContent ? `: ${clean(partial.errorMessage ?? "")}` : ""}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const diagnostic = captureContent || /^(HTTP \d{3}|OTLP rejected \d+ spans)$/.test(message) ? clean(message) : "export request failed";
        try { onError(new Error(diagnostic)); } catch { /* Export diagnostics must not fail the agent. */ }
      }
    });
    return sending;
  }

  /** @returns {Span | undefined} */
  function generation() {
    if (!run) return undefined;
    run.generation ??= startSpan(`chat ${run.model?.id ?? "unknown"}`, 3, {
      "gen_ai.operation.name": "chat", "gen_ai.provider.name": run.model?.provider,
      "gen_ai.request.model": run.model?.id, "gen_ai.conversation.id": run.sessionId,
      "gen_ai.input.messages": run.input, "gen_ai.system_instructions": run.system, "pi.turn.index": run.turn,
    }, run.root.spanId);
    return run.generation;
  }

  /** @param {boolean} interrupted @returns {Promise<void>} */
  async function endRun(interrupted) {
    if (!run) return flush();
    if (run.generation) finishSpan(run.generation, { "pi.interrupted": true }, "interrupted");
    for (const tool of run.tools.values()) finishSpan(tool, { "pi.interrupted": true }, "interrupted");
    finishSpan(run.root, {
      "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "text", content: run.output }] }],
      "pi.interrupted": interrupted, "pi.turns": run.turns, "pi.tool_calls": run.toolCalls,
      "gen_ai.usage.input_tokens": run.inputTokens, "gen_ai.usage.output_tokens": run.outputTokens, "pi.cost.usd": run.costUsd,
    }, interrupted ? "interrupted" : run.lastModelFailed ? "agent operation failed" : undefined);
    run = undefined;
    return flush();
  }

  pi.on("before_agent_start", async (event, ctx) => {
    if (run) await endRun(true);
    const input = [{ role: "user", parts: [{ type: "text", content: event.prompt }] }];
    const system = [{ type: "text", content: event.systemPrompt ?? ctx.getSystemPrompt?.() ?? "" }];
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
    const root = startSpan(`invoke_agent ${serviceName}`, 1, {
      "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": serviceName,
      "gen_ai.provider.name": ctx.model?.provider, "gen_ai.request.model": ctx.model?.id,
      "gen_ai.conversation.id": sessionId, "gen_ai.input.messages": input, "gen_ai.system_instructions": system,
      "pi.tools": typeof pi.getActiveTools === "function" ? pi.getActiveTools() : undefined, "pi.cwd": ctx.cwd,
    });
    run = { root, sessionId, turn: 0, turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
      output: "", lastModelFailed: false, model: ctx.model, tools: new Map(), input, system };
  });

  pi.on("turn_start", (event, ctx) => {
    if (!run) return;
    run.turn = event.turnIndex;
    run.turns += 1;
    if (ctx?.model) run.model = ctx.model;
  });

  pi.on("context_with_system", (event) => {
    if (!run) return;
    const system = event.messages.filter((message) => message.role === "system").flatMap((message) => chatMessage(message).parts);
    if (system.length > 0) run.system = system;
    run.input = event.messages.filter((message) => ["user", "assistant", "toolResult"].includes(message.role)).map(chatMessage);
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") generation();
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (!run || message.role !== "assistant") return;
    run.lastModelFailed = ["error", "aborted"].includes(message.stopReason);
    const span = generation();
    const usage = message.usage ?? {};
    const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    const text = blocks(message, "text", "text");
    run.inputTokens += inputTokens;
    run.outputTokens += usage.output ?? 0;
    run.costUsd += usage.cost?.total ?? 0;
    if (text) run.output = text;
    const finishReason = { toolUse: "tool_calls", stop: "stop", length: "length", error: "error", aborted: "error" }[message.stopReason] ?? message.stopReason;
    finishSpan(span, {
      "gen_ai.response.model": message.responseModel ?? message.model, "gen_ai.response.id": message.responseId,
      "gen_ai.request.reasoning.level": message.providerThinkingLevel,
      "gen_ai.output.messages": [chatMessage(message)],
      "gen_ai.response.finish_reasons": finishReason ? [finishReason] : undefined,
      "pi.reasoning": blocks(message, "thinking", "thinking") || undefined,
      "gen_ai.usage.input_tokens": inputTokens, "gen_ai.usage.output_tokens": usage.output,
      "gen_ai.usage.cache_read.input_tokens": usage.cacheRead, "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite,
      "pi.cost.usd": usage.cost?.total,
      "error.type": ["error", "aborted"].includes(message.stopReason) ? message.stopReason : undefined,
    }, ["error", "aborted"].includes(message.stopReason) ? message.errorMessage || message.stopReason : undefined);
    run.generation = undefined;
  });

  pi.on("tool_execution_start", (event) => {
    if (!run) return;
    run.toolCalls += 1;
    run.tools.set(event.toolCallId, startSpan(`execute_tool ${event.toolName}`, 1, {
      "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": event.toolName,
      "gen_ai.tool.call.id": event.toolCallId, "gen_ai.tool.call.arguments": event.args,
      "gen_ai.conversation.id": run.sessionId, "pi.turn.index": run.turn,
    }, run.tools.get(event.parentToolCallId)?.spanId ?? run.root.spanId));
  });

  pi.on("tool_execution_end", (event) => {
    if (!run) return;
    const span = run.tools.get(event.toolCallId);
    if (!span) return;
    run.tools.delete(event.toolCallId);
    finishSpan(span, { "gen_ai.tool.call.result": toolResultText(event.result), "error.type": event.isError ? "tool_error" : undefined }, event.isError ? "tool execution failed" : undefined);
  });

  pi.on("turn_end", () => {
    // A slow export must not delay the next model request.
    void flush();
  });
  pi.on("agent_settled", () => endRun(false));
  pi.on("session_shutdown", () => endRun(true));
}

/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi @returns {void} */
export default function rawtree(pi) {
  try {
    const options = resolveRawtreeOptions();
    if (options) createRawtreeExtension(pi, options);
  } catch (error) {
    console.warn(`RawTree tracing inactive: ${error instanceof Error ? error.message : "invalid configuration"}`);
  }
}
