import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { startCollector } from "./helpers/collector.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/scripted-model.mjs", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const SECRET = "synthetic-cli-secret-12345678";

/** @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env @returns {Promise<{stdout: string, stderr: string}>} */
async function runCli(args, cwd, env) {
  const pending = execute(process.execPath, [cli, ...args], { cwd, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  pending.child.stdin?.end();
  return pending;
}

for (const mode of ["installed", "explicit"]) {
  test(`a copied package exports traces through Pi CLI (${mode})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rawtree-cli-"));
    const agentDir = join(root, "agent");
    const copied = join(root, "standalone-plugin");
    mkdirSync(agentDir);
    mkdirSync(copied);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    copyFileSync(join(packageRoot, "package.json"), join(copied, "package.json"));
    for (const name of manifest.files) {
      try { copyFileSync(join(packageRoot, name), join(copied, name)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const collector = await startCollector();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RAWTREE_") && !name.startsWith("PI_")));
    Object.assign(env, {
      PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", RAWTREE_API_KEY: "synthetic-test-key",
      RAWTREE_API_URL: collector.url, RAWTREE_DATABASE: "cli-tests",
      RAWTREE_SERVICE_NAME: `pi-rawtree-cli-${mode}`, TEST_API_TOKEN: SECRET,
    });
    if (mode === "explicit") env.RAWTREE_TABLE = "pi_cli_traces";
    try {
      if (mode === "installed") {
        await runCli(["install", copied], root, env);
        const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
        assert.ok(settings.packages.some((source) => resolve(agentDir, source) === copied));
      }
      const result = await runCli([
        "--mode", "json", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
        "--system-prompt", "You are a synthetic test assistant.",
        ...(mode === "explicit" ? ["--no-extensions", "-e", copied] : []),
        "-e", fixture, "--model", "faux/faux-1", "--tools", "lookup",
        "Validate the synthetic lookup and report its result.",
      ], root, env);
      const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === "agent_settled"));
      assert.doesNotMatch(result.stderr, /Extension failed|Failed to load|RawTree.*failed/);
      const spans = collector.requests.flatMap((request) => request.payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)));
      assert.equal(spans.length, 4);
      assert.ok(collector.requests.every((request) => request.table === (mode === "explicit" ? "pi_cli_traces" : undefined)));
      const rootSpan = spans.find((span) => !span.parentSpanId);
      assert.ok(rootSpan);
      assert.equal(rootSpan.status.code, 1);
      assert.ok(spans.filter((span) => span !== rootSpan).every((span) => span.parentSpanId === rootSpan.spanId));
      assert.deepEqual(spans.map((span) => span.name).sort(), ["chat faux-1", "chat faux-1", "execute_tool lookup", `invoke_agent pi-rawtree-cli-${mode}`].sort());
      const artifact = JSON.stringify(collector.requests.map((request) => request.payload), null, 2);
      assert.doesNotMatch(artifact, new RegExp(SECRET));
      assert.doesNotMatch(artifact, /\/home\/|\/Users\/|Tinybird Analytics Agent Guide/);
      assert.match(artifact, /\[REDACTED\]/);
      const artifacts = join(packageRoot, "artifacts");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, `cli-${mode}-trace.json`), artifact);
      if (mode === "installed") {
        await runCli(["remove", copied], root, env);
        const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
        assert.ok(!settings.packages?.some((source) => resolve(agentDir, source) === copied));
      }
    } finally {
      await collector.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
