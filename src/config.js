import fs from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  provider: "",
  model: "",
  workspace: process.cwd(),
  ollamaBaseUrl: "http://127.0.0.1:11434",
  lmStudioBaseUrl: "http://127.0.0.1:1234",
  maxSteps: 12,
  allowCommands: false,
  temperature: 0.2
};

export async function loadConfig(cwd, cliOptions = {}) {
  const configPath = path.join(cwd, ".local-code.json");
  const fileConfig = await readConfigFile(configPath);

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...compactObject(readEnvConfig()),
    ...compactObject(cliOptions)
  };

  merged.workspace = path.resolve(cwd, merged.workspace);
  merged.maxSteps = Number(merged.maxSteps) || DEFAULTS.maxSteps;
  merged.temperature = Number(merged.temperature);
  if (Number.isNaN(merged.temperature)) {
    merged.temperature = DEFAULTS.temperature;
  }
  merged.configPath = configPath;
  merged.statePath = path.join(cwd, ".local-code-state.json");

  return merged;
}

export async function saveConfigSelections(configPath, selections) {
  const current = await readConfigFile(configPath);
  const next = {
    ...current,
    ...compactObject(selections)
  };

  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export async function loadAppState(statePath) {
  return readJsonFile(statePath);
}

export async function saveAppState(statePath, patch) {
  const current = await readJsonFile(statePath);
  const next = {
    ...current,
    ...compactObject(patch)
  };

  await fs.writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readEnvConfig() {
  return {
    provider: process.env.LOCAL_CODE_PROVIDER,
    model: process.env.LOCAL_CODE_MODEL,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    lmStudioBaseUrl: process.env.LM_STUDIO_BASE_URL,
    allowCommands: parseBoolean(process.env.LOCAL_CODE_ALLOW_COMMANDS)
  };
}

function parseBoolean(value) {
  if (value == null || value === "") {
    return undefined;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

async function readConfigFile(configPath) {
  const parsed = await readJsonFile(configPath);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }

  return {};
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw new Error(`Failed to read file: ${filePath}\n${error.message}`);
    }
  }

  return {};
}
