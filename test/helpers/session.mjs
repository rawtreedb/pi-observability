import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/** @typedef {import("@earendil-works/pi-coding-agent").AgentSession} AgentSession */

/** @type {Map<AgentSession, () => void>} */
const cleanup = new Map();

/**
 * @param {import("@earendil-works/pi-ai/providers/faux").FauxResponseStep[]} responses
 * @param {any[]} [tools]
 * @returns {Promise<AgentSession>}
 */
export async function openSession(responses, tools = []) {
  const root = mkdtempSync(join(tmpdir(), "pi-rawtree-sdk-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const faux = fauxProvider();
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../../", import.meta.url))],
    agentsFilesOverride: () => [], systemPromptOverride: () => "You are a synthetic test assistant.",
  });
  await resourceLoader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: root, agentDir: root, modelRuntime, model: faux.getModel(), settingsManager,
    resourceLoader, sessionManager: SessionManager.inMemory(root), tools: tools.map((tool) => tool.name), customTools: tools,
  });
  if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
  await session.bindExtensions({});
  cleanup.set(session, () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return session;
}

/** @param {AgentSession} session @returns {Promise<void>} */
export async function closeSession(session) {
  try {
    const runner = session.extensionRunner;
    if (runner) await runner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    await session.abort();
    session.dispose();
    cleanup.get(session)?.();
    cleanup.delete(session);
  }
}
