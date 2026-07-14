import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function inspectProviders(config) {
  const [ollama, lmstudio] = await Promise.all([
    detectOllama(config.ollamaBaseUrl),
    detectLmStudio(config.lmStudioBaseUrl)
  ]);

  return {
    ollama,
    lmstudio
  };
}

export function buildProviderDiagnostics(statusMap) {
  return Object.values(statusMap).map((status) => ({
    heading: `${status.label} (${status.provider})`,
    lines: [
      `  Status: ${summarizeProvider(status)}`,
      `  API: ${status.baseUrl}`,
      ...formatLocations(status.locations),
      ...formatNextSteps(status)
    ]
  }));
}

export function summarizeProvider(status) {
  if (!status.installed) {
    return `${status.label} - not installed`;
  }

  if (!status.serverReachable) {
    return `${status.label} - installed, local API offline`;
  }

  if (status.models.length === 0) {
    return `${status.label} - installed, API online, no local models`;
  }

  return `${status.label} - installed, API online, ${status.models.length} model(s)`;
}

export function buildProviderProblemMessage(status) {
  if (!status.installed) {
    return [
      `${status.label} is not installed.`,
      ...status.installHints
    ].join("\n");
  }

  if (!status.serverReachable) {
    return [
      `${status.label} is installed, but the local API is not reachable at ${status.baseUrl}.`,
      ...status.serverHints
    ].join("\n");
  }

  if (status.models.length === 0) {
    return [
      `${status.label} is reachable, but no local models are available.`,
      ...status.modelHints
    ].join("\n");
  }

  return `${status.label} is ready.`;
}

export function pickAutoProvider(statusMap) {
  const readyProviders = Object.values(statusMap).filter(isProviderReady);
  if (readyProviders.length === 1) {
    return readyProviders[0].provider;
  }

  if (readyProviders.length > 1) {
    return readyProviders[0].provider;
  }

  const installedProviders = Object.values(statusMap).filter((item) => item.installed);
  if (installedProviders.length === 1) {
    return installedProviders[0].provider;
  }

  return null;
}

export function isProviderReady(status) {
  return status.installed && status.serverReachable && status.models.length > 0;
}

export function getProviderUnavailableReason(status) {
  if (!status.installed) {
    return "Install required";
  }

  if (!status.serverReachable) {
    return "Start local API server";
  }

  if (status.models.length === 0) {
    return "Download a local model";
  }

  return "";
}

async function detectOllama(baseUrl) {
  const commandLocations = await findCommandLocations(["ollama"]);
  const installLocations = await existingPaths(getOllamaInstallPaths());
  const locations = uniqueValues([...commandLocations, ...installLocations]);
  const installed = locations.length > 0;
  const api = await probeOllamaApi(baseUrl);

  return {
    provider: "ollama",
    label: "Ollama",
    baseUrl,
    installed,
    locations,
    serverReachable: api.serverReachable,
    models: api.models,
    installHints: [
      "Install Ollama from https://ollama.com/download",
      "After installation, open Ollama once or run `ollama serve`."
    ],
    serverHints: [
      "Start Ollama and confirm the local server is running.",
      "If needed, run `ollama serve` and retry."
    ],
    modelHints: [
      "Download at least one model first, for example: `ollama pull qwen2.5-coder:7b`.",
      "Then run the CLI again."
    ]
  };
}

async function detectLmStudio(baseUrl) {
  const commandLocations = await findCommandLocations(["lms", "lmstudio"]);
  const installLocations = await existingPaths(getLmStudioInstallPaths());
  const locations = uniqueValues([...commandLocations, ...installLocations]);
  const installed = locations.length > 0;
  const api = await probeOpenAiCompatibleModels(baseUrl);

  return {
    provider: "lmstudio",
    label: "LM Studio",
    baseUrl,
    installed,
    locations,
    serverReachable: api.serverReachable,
    models: api.models,
    installHints: [
      "Install LM Studio from https://lmstudio.ai/",
      "After installation, open LM Studio and enable the local server."
    ],
    serverHints: [
      "Open LM Studio and start the local server on the configured port.",
      "By default this CLI expects LM Studio at http://127.0.0.1:1234."
    ],
    modelHints: [
      "Download a local model in LM Studio.",
      "Load the model or expose it through the local server, then retry."
    ]
  };
}

async function findCommandLocations(commands) {
  const results = [];
  for (const command of commands) {
    try {
      const { stdout } = await execFile(getWhichCommand(), getWhichArgs(command), {
        timeout: 1500,
        windowsHide: true
      });
      const lines = stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      results.push(...lines);
    } catch {
      // Command not available in PATH.
    }
  }

  return uniqueValues(results);
}

function getWhichCommand() {
  return process.platform === "win32" ? "where.exe" : "which";
}

function getWhichArgs(command) {
  return process.platform === "win32" ? [command] : [command];
}

async function existingPaths(pathsToCheck) {
  const results = [];
  for (const candidate of pathsToCheck) {
    if (!candidate) {
      continue;
    }

    try {
      await fs.access(candidate);
      results.push(candidate);
    } catch {
      // Path not present.
    }
  }

  return results;
}

async function probeOllamaApi(baseUrl) {
  const response = await fetchJson(`${stripTrailingSlash(baseUrl)}/api/tags`);
  if (!response.ok) {
    return {
      serverReachable: false,
      models: []
    };
  }

  return {
    serverReachable: true,
    models: (response.data.models ?? []).map((item) => item.name).filter(Boolean)
  };
}

async function probeOpenAiCompatibleModels(baseUrl) {
  const response = await fetchJson(`${stripTrailingSlash(baseUrl)}/v1/models`);
  if (!response.ok) {
    return {
      serverReachable: false,
      models: []
    };
  }

  return {
    serverReachable: true,
    models: (response.data.data ?? []).map((item) => item.id).filter(Boolean)
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        data: null
      };
    }

    return {
      ok: true,
      data: await response.json()
    };
  } catch {
    return {
      ok: false,
      data: null
    };
  } finally {
    clearTimeout(timer);
  }
}

function getOllamaInstallPaths() {
  const home = os.homedir();
  return uniqueValues([
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"),
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Ollama", "ollama.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Ollama", "ollama.exe"),
    path.join(home, "AppData", "Local", "Programs", "Ollama", "ollama.exe"),
    "/Applications/Ollama.app",
    path.join(home, "Applications", "Ollama.app"),
    "/usr/local/bin/ollama",
    "/usr/bin/ollama"
  ]);
}

function getLmStudioInstallPaths() {
  const home = os.homedir();
  return uniqueValues([
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "LM Studio", "LM Studio.exe"),
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "LM Studio", "LM Studio.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "LM Studio", "LM Studio.exe"),
    path.join(home, "AppData", "Local", "Programs", "LM Studio", "LM Studio.exe"),
    "/Applications/LM Studio.app",
    path.join(home, "Applications", "LM Studio.app"),
    "/opt/LM Studio",
    "/usr/local/bin/lmstudio"
  ]);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function formatLocations(locations) {
  if (!locations || locations.length === 0) {
    return ["  Install path: not found"];
  }

  return [`  Install path: ${locations[0]}`];
}

function formatNextSteps(status) {
  if (isProviderReady(status)) {
    return [`  Models: ${status.models.slice(0, 4).join(", ")}`];
  }

  if (!status.installed) {
    return status.installHints.map((line) => `  Next: ${line}`);
  }

  if (!status.serverReachable) {
    return status.serverHints.map((line) => `  Next: ${line}`);
  }

  return status.modelHints.map((line) => `  Next: ${line}`);
}
