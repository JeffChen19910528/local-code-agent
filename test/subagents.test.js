import test from "node:test";
import assert from "node:assert/strict";
import { createToolset } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";

async function withMockedFetch(reply, run) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => reply
  });

  try {
    await run();
  } finally {
    global.fetch = originalFetch;
  }
}

function makeConfig() {
  return {
    provider: "ollama",
    model: "demo",
    workspace: process.cwd(),
    allowCommands: false,
    maxSteps: 3,
    temperature: 0.2,
    ollamaBaseUrl: "http://127.0.0.1:11434"
  };
}

test("spawn_agent without a config errors instead of silently doing nothing", async () => {
  const workspace = new Workspace(process.cwd());
  const toolset = createToolset(workspace);

  await assert.rejects(
    toolset.execute("spawn_agent", { task: "do something" }),
    /not available/
  );
});

test("spawn_agent returns immediately, then check_agent/list_agents reflect the finished result", async () => {
  const workspace = new Workspace(process.cwd());
  const toolset = createToolset(workspace, makeConfig());

  let spawned;
  await withMockedFetch({ message: { content: "sub-task done" } }, async () => {
    spawned = await toolset.execute("spawn_agent", { task: "investigate something" });
    assert.equal(spawned.status, "running");
    assert.match(spawned.id, /^agent-/);

    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  const checked = await toolset.execute("check_agent", { id: spawned.id });
  assert.equal(checked.status, "done");
  assert.equal(checked.result, "sub-task done");

  const listed = await toolset.execute("list_agents", {});
  assert.ok(listed.some((entry) => entry.id === spawned.id));
});

test("spawn_agent refuses to exceed the configured concurrency cap", async () => {
  const workspace = new Workspace(process.cwd());
  const toolset = createToolset(workspace, { ...makeConfig(), maxConcurrentAgents: 1 });

  await withMockedFetch({ message: { content: "" } }, async () => {
    // Never resolves within this test, so the first task stays "running".
    global.fetch = () => new Promise(() => {});

    const first = await toolset.execute("spawn_agent", { task: "long running task" });
    assert.equal(first.status, "running");

    await assert.rejects(
      toolset.execute("spawn_agent", { task: "second task" }),
      /Too many background agents already running/
    );
  });
});

test("check_agent errors on an unknown id", async () => {
  const workspace = new Workspace(process.cwd());
  const toolset = createToolset(workspace, makeConfig());

  await assert.rejects(
    toolset.execute("check_agent", { id: "agent-does-not-exist" }),
    /Unknown agent task/
  );
});
