import { loadAppState, saveAppState } from "../config.js";
import { Workspace } from "../workspace.js";

export async function loadStartupContext(config, command, overrides = {}) {
  const [state, recentFiles] = await Promise.all([
    loadAppState(config.statePath),
    new Workspace(config.workspace).listRecentFiles(4)
  ]);

  return {
    command,
    lastUsedProvider: overrides.lastUsedProvider ?? config.provider,
    lastUsedModel: overrides.lastUsedModel ?? config.model,
    lastTaskSummary: state.lastTaskSummary ?? "",
    recentFiles: recentFiles.map((item) => item.path)
  };
}

export async function rememberTask(config, prompt) {
  await saveAppState(config.statePath, {
    lastTaskSummary: summarizeTask(prompt),
    lastTaskAt: new Date().toISOString()
  });
}

function summarizeTask(prompt) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) {
    return compact;
  }

  return `${compact.slice(0, 77)}...`;
}
