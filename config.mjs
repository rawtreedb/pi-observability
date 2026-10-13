/** @param {NodeJS.ProcessEnv} env @param {string} name @param {boolean} fallback @returns {boolean} */
function booleanOption(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

/** @param {NodeJS.ProcessEnv} [env] @returns {import("./index.mjs").RawtreeOptions | undefined} */
export function resolveRawtreeOptions(env = process.env) {
  if (!booleanOption(env, "RAWTREE_ENABLED", true)) return undefined;
  if (!env.RAWTREE_API_KEY?.trim()) throw new Error("Set RAWTREE_API_KEY to enable tracing, or RAWTREE_ENABLED=false to disable it");
  const maxFieldChars = env.RAWTREE_MAX_FIELD_CHARS ? Number(env.RAWTREE_MAX_FIELD_CHARS) : undefined;
  if (maxFieldChars !== undefined && (!Number.isSafeInteger(maxFieldChars) || maxFieldChars <= 0)) {
    throw new Error("RAWTREE_MAX_FIELD_CHARS must be a positive safe integer");
  }
  return {
    apiKey: env.RAWTREE_API_KEY.trim(), apiUrl: env.RAWTREE_API_URL || undefined,
    database: env.RAWTREE_DATABASE || undefined, table: env.RAWTREE_TABLE?.trim() || undefined,
    serviceName: env.RAWTREE_SERVICE_NAME || undefined,
    maxFieldChars, captureContent: booleanOption(env, "RAWTREE_CAPTURE_CONTENT", true),
  };
}
