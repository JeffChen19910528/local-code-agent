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

export async function diagnoseProvider(config, providerName) {
  if (providerName === "ollama") {
    return detectOllama(config.ollamaBaseUrl);
  }

  if (providerName === "lmstudio") {
    return detectLmStudio(config.lmStudioBaseUrl);
  }

  return null;
}

// Builds a human-readable (Traditional Chinese) repair message for a provider that just
// failed a live request. Reuses the same install/server/model hints as the startup wizard,
// but adds a distinct branch for the "looks ready yet the request still failed" case, which
// is what happens most often right after the user updates Ollama (stale background service,
// or a model file left in a half-migrated state).
export function buildRepairGuidance(status, context = {}) {
  if (!status) {
    return "無法判斷目前 provider 的狀態，建議手動確認 Ollama / LM Studio 是否正常執行。";
  }

  const lines = [`診斷結果：${summarizeProvider(status)}`];

  if (!status.installed) {
    lines.push(...status.installHints.map((line) => `- ${line}`));
    return lines.join("\n");
  }

  if (!status.serverReachable) {
    lines.push(...status.serverHints.map((line) => `- ${line}`));
    return lines.join("\n");
  }

  if (status.models.length === 0) {
    lines.push(...status.modelHints.map((line) => `- ${line}`));
    return lines.join("\n");
  }

  lines.push(
    `${status.label} 的本機 API 目前可以連線，但剛剛的請求仍然失敗。這常發生在剛更新過 ${status.label}、背景服務還沒完全切換乾淨，或模型檔案在更新後損毀時。建議依序嘗試：`
  );
  if (status.provider === "ollama") {
    if (isOllamaRunnerCrashError(context.providerErrorMessage)) {
      lines.push(
        "偵測到錯誤訊息包含 EOF，這通常代表 Ollama 內部負責跑模型的 runner 子行程在處理請求途中當掉或中斷連線，而不是網路問題。常見成因：顯示卡記憶體(VRAM)或系統記憶體不足、模型檔案損毀、或更新後的 GPU 驅動不相容。建議依序嘗試："
      );
      lines.push(`- 換一個佔用空間較小的模型測試同一個問題（${context.model ? `目前用的 ${context.model} 體積較大，` : ""}如果小模型正常，代表是這顆模型太大、記憶體/顯存不夠）`);
      lines.push(`- 執行 \`ollama pull ${context.model ?? "<你的模型名稱>"}\` 重新下載一次模型，排除模型檔案本身損毀的可能`);
      lines.push("- 打開工作管理員，觀察發送請求當下的可用實體記憶體與顯示卡記憶體是否被吃滿");
      lines.push("- 查看 Ollama 的完整錯誤紀錄：Windows 上通常在 `%LOCALAPPDATA%\\Ollama\\logs\\server.log`，或關閉背景服務後另開終端機執行 `ollama serve` 前景模式重現一次，看完整的錯誤堆疊");
    } else {
      lines.push("- 完全結束 Ollama（工作列圖示右鍵結束，或用工作管理員結束 ollama.exe / ollama app.exe），再重新開啟一次");
      lines.push("- 另開一個終端機執行 `ollama serve`，觀察啟動時是否印出錯誤訊息");
      lines.push(`- 執行 \`ollama run ${context.model ?? "<你的模型名稱>"}\` 確認這個模型本身可以正常對話`);
      lines.push("- 執行 `ollama -v` 確認目前版本；若剛更新完，可到 https://ollama.com/download 重新下載安裝檔覆蓋安裝一次");
    }
    if (status.version) {
      lines.push(`  (目前偵測到版本：${status.version})`);
    }
  } else {
    lines.push("- 在 LM Studio 內完全停止並重新啟動本機伺服器");
    lines.push("- 確認模型仍顯示為已載入（Loaded），必要時重新載入一次");
  }
  if (context.providerErrorMessage) {
    lines.push(`- 原始錯誤訊息：${context.providerErrorMessage}`);
  }

  return lines.join("\n");
}

// Ollama's server returns a bare "EOF" body when the model-runner subprocess dies mid-request
// (crash, OOM-kill, corrupted GGUF blob) - the HTTP layer is still fine, so serverReachable
// stays true and this only shows up as a chat failure. It's specific enough to detect and
// worth a distinct, more targeted set of hints than the generic restart/reinstall advice.
function isOllamaRunnerCrashError(providerErrorMessage) {
  return typeof providerErrorMessage === "string" && /\bEOF\b/i.test(providerErrorMessage);
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
  const [api, version] = await Promise.all([
    probeOllamaApi(baseUrl),
    installed ? getOllamaVersion() : Promise.resolve(null)
  ]);

  return {
    provider: "ollama",
    label: "Ollama",
    baseUrl,
    installed,
    locations,
    version,
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

async function getOllamaVersion() {
  try {
    const { stdout } = await execFile("ollama", ["-v"], {
      timeout: 1500,
      windowsHide: true
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
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
