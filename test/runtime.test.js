import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProviderProblemMessage,
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
