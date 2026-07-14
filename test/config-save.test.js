import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAppState, saveAppState, saveConfigSelections } from "../src/config.js";

test("saveConfigSelections merges selected values into config file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-save-"));
  const configPath = path.join(root, ".local-code.json");

  await fs.writeFile(
    configPath,
    JSON.stringify({
      workspace: ".",
      provider: "",
      temperature: 0.2
    }, null, 2),
    "utf8"
  );

  await saveConfigSelections(configPath, {
    provider: "ollama",
    model: "qwen2.5-coder:7b"
  });

  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(saved.provider, "ollama");
  assert.equal(saved.model, "qwen2.5-coder:7b");
  assert.equal(saved.workspace, ".");
  assert.equal(saved.temperature, 0.2);
});

test("saveAppState persists last task summary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-state-"));
  const statePath = path.join(root, ".local-code-state.json");

  await saveAppState(statePath, {
    lastTaskSummary: "Inspect bug in src/cli.js",
    lastTaskAt: "2026-07-12T12:00:00.000Z"
  });

  const saved = await loadAppState(statePath);
  assert.equal(saved.lastTaskSummary, "Inspect bug in src/cli.js");
  assert.equal(saved.lastTaskAt, "2026-07-12T12:00:00.000Z");
});

test("saveAppState persists chat session state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-chat-state-"));
  const statePath = path.join(root, ".local-code-state.json");

  await saveAppState(statePath, {
    chatSession: {
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      workspace: "F:/demo",
      history: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" }
      ],
      updatedAt: "2026-07-12T12:30:00.000Z"
    }
  });

  const saved = await loadAppState(statePath);
  assert.equal(saved.chatSession.provider, "ollama");
  assert.equal(saved.chatSession.history.length, 2);
  assert.equal(saved.chatSession.updatedAt, "2026-07-12T12:30:00.000Z");
});
