import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProviderProblemMessage,
  buildRepairGuidance,
  pickAutoProvider,
  summarizeProvider
} from "../src/runtime.js";

test("summarizeProvider reports not installed state", () => {
  const summary = summarizeProvider({
    label: "Ollama",
    installed: false,
    serverReachable: false,
    models: []
  });

  assert.equal(summary, "Ollama - not installed");
});

test("pickAutoProvider prefers a ready provider", () => {
  const selected = pickAutoProvider({
    ollama: {
      provider: "ollama",
      installed: true,
      serverReachable: true,
      models: ["qwen2.5-coder:7b"]
    },
    lmstudio: {
      provider: "lmstudio",
      installed: true,
      serverReachable: false,
      models: []
    }
  });

  assert.equal(selected, "ollama");
});

test("buildProviderProblemMessage explains missing models", () => {
  const message = buildProviderProblemMessage({
    label: "LM Studio",
    installed: true,
    serverReachable: true,
    models: [],
    baseUrl: "http://127.0.0.1:1234",
    installHints: [],
    serverHints: [],
    modelHints: ["Download a local model in LM Studio."]
  });

  assert.match(message, /no local models/i);
  assert.match(message, /Download a local model in LM Studio\./);
});

test("buildRepairGuidance tells the user to install when Ollama is missing", () => {
  const guidance = buildRepairGuidance({
    provider: "ollama",
    label: "Ollama",
    installed: false,
    serverReachable: false,
    models: [],
    installHints: ["Install Ollama from https://ollama.com/download"],
    serverHints: [],
    modelHints: []
  });

  assert.match(guidance, /not installed/);
  assert.match(guidance, /Install Ollama from https:\/\/ollama\.com\/download/);
});

test("buildRepairGuidance suggests restarting the service when the API is offline", () => {
  const guidance = buildRepairGuidance({
    provider: "ollama",
    label: "Ollama",
    installed: true,
    serverReachable: false,
    models: [],
    installHints: [],
    serverHints: ["Start Ollama and confirm the local server is running."],
    modelHints: []
  });

  assert.match(guidance, /local API offline/);
  assert.match(guidance, /Start Ollama and confirm the local server is running\./);
});

test("buildRepairGuidance gives restart/reinstall steps when the provider looks ready but a request just failed", () => {
  const guidance = buildRepairGuidance(
    {
      provider: "ollama",
      label: "Ollama",
      installed: true,
      serverReachable: true,
      models: ["qwen2.5-coder:7b"],
      version: "ollama version is 0.4.1",
      installHints: [],
      serverHints: [],
      modelHints: []
    },
    { model: "qwen2.5-coder:7b", providerErrorMessage: "Ollama request failed: 500 Internal Server Error" }
  );

  assert.match(guidance, /剛更新過/);
  assert.match(guidance, /ollama serve/);
  assert.match(guidance, /ollama run qwen2\.5-coder:7b/);
  assert.match(guidance, /ollama version is 0\.4\.1/);
  assert.match(guidance, /500 Internal Server Error/);
});

test("buildRepairGuidance recognizes an Ollama runner-crash (EOF) error and gives memory/corruption-specific hints", () => {
  const guidance = buildRepairGuidance(
    {
      provider: "ollama",
      label: "Ollama",
      installed: true,
      serverReachable: true,
      models: ["qwen3.8:latest"],
      version: "ollama version is 0.32.13",
      installHints: [],
      serverHints: [],
      modelHints: []
    },
    { model: "qwen3.8:latest", providerErrorMessage: "Ollama request failed: 500 Internal Server Error - EOF" }
  );

  assert.match(guidance, /runner 子行程/);
  assert.match(guidance, /ollama pull qwen3\.8:latest/);
  assert.match(guidance, /server\.log/);
  assert.doesNotMatch(guidance, /完全結束 Ollama/);
  assert.doesNotMatch(guidance, /重新下載安裝檔覆蓋安裝/);
});
