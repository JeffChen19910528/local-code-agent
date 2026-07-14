import test from "node:test";
import assert from "node:assert/strict";
import { confirmCommand, renderDiagnostics, renderStartupDashboard } from "../src/ui.js";

test("renderDiagnostics formats multiple sections", () => {
  const output = renderDiagnostics("Local provider check failed", [
    {
      heading: "Ollama (ollama)",
      lines: ["  Status: Ollama - not installed"]
    },
    {
      heading: "LM Studio (lmstudio)",
      lines: ["  Status: LM Studio - installed, local API offline"]
    }
  ]);

  assert.match(output, /Local provider check failed/);
  assert.match(output, /Ollama \(ollama\)/);
  assert.match(output, /LM Studio \(lmstudio\)/);
});

test("renderStartupDashboard includes last used values", () => {
  const output = renderStartupDashboard({
    workspace: "F:/demo",
    command: "chat",
    lastUsedProvider: "ollama",
    lastUsedModel: "qwen2.5-coder:7b",
    lastTaskSummary: "Inspect src/runtime.js",
    readyCount: 1,
    totalProviders: 2,
    readyProviders: ["Ollama"],
    recentFiles: ["src/cli.js", "src/ui.js"]
  });

  assert.match(output, /Workspace/);
  assert.match(output, /chat/);
  assert.match(output, /ollama \/ qwen2\.5-coder:7b/);
  assert.match(output, /Inspect src\/runtime\.js/);
  assert.match(output, /src\/cli\.js, src\/ui\.js/);
  assert.match(output, /1\/2/);
  assert.match(output, /Ollama/);
});

test("confirmCommand denies without prompting when not running in an interactive terminal", async () => {
  const approved = await confirmCommand({ command: "dotnet", args: ["run"], cwd: process.cwd() });
  assert.equal(approved, false);
});
