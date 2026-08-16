import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSession } from "../src/agent.js";

// End-to-end tests that drive a full agent session (agent.js -> tools.js -> workspace.js) through
// a real temp workspace on disk. Only the model HTTP call is mocked (scripted <tool_call> replies)
// - every tool actually executes against the real filesystem/child_process, unlike the unit tests
// in tools.test.js/workspace.test.js which call toolset.execute() directly for one tool at a time.

function toolCall(tool, args) {
  return { message: { content: `<tool_call>\n${JSON.stringify({ tool, args })}\n</tool_call>` } };
}

function finalReply(content) {
  return { message: { content } };
}

async function withScriptedModel(responses, run) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => responses.shift()
  });

  try {
    await run();
  } finally {
    global.fetch = originalFetch;
  }
}

async function makeWorkspaceRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "local-code-integration-"));
}

function baseConfig(workspace) {
  return {
    provider: "ollama",
    model: "demo",
    workspace,
    allowCommands: true,
    allowWrites: true,
    allowNetwork: false,
    maxSteps: 30,
    temperature: 0.2,
    ollamaBaseUrl: "http://127.0.0.1:11434"
  };
}

test("integration: plan -> write -> glob -> grep -> paginated read -> move -> delete round-trip across real tools", async () => {
  const workspace = await makeWorkspaceRoot();

  const responses = [
    toolCall("todo_write", {
      items: [
        { content: "Create hello.ts", status: "in_progress" },
        { content: "Verify and clean up", status: "pending" }
      ]
    }),
    toolCall("write_file", { path: "src/hello.ts", content: "console.log('hi');\nconsole.log('bye');\n" }),
    toolCall("glob_files", { pattern: "**/*.ts" }),
    toolCall("search_text", { query: "console\\.log\\('hi'\\)", regex: true }),
    toolCall("read_file", { path: "src/hello.ts", offset: 2, limit: 1 }),
    toolCall("move_file", { from: "src/hello.ts", to: "archive/hello.ts" }),
    toolCall("delete_file", { path: "archive/hello.ts" }),
    toolCall("todo_write", {
      items: [
        { content: "Create hello.ts", status: "completed" },
        { content: "Verify and clean up", status: "completed" }
      ]
    }),
    finalReply("done")
  ];

  await withScriptedModel(responses, async () => {
    const toolCallsSeen = [];
    const session = createAgentSession(baseConfig(workspace), {
      onToolCall(call) {
        toolCallsSeen.push(call.tool);
      }
    });

    const result = await session.ask("plan, create, verify, and clean up a small TypeScript file");

    assert.equal(result.failed, false);
    assert.equal(result.content, "done");
    assert.deepEqual(toolCallsSeen, [
      "todo_write",
      "write_file",
      "glob_files",
      "search_text",
      "read_file",
      "move_file",
      "delete_file",
      "todo_write"
    ]);

    const history = session.getHistory();
    const resultFor = (tool, index = 0) => {
      const matches = history.filter((message) => message.content.includes(`<tool_result name="${tool}">`));
      return matches[index]?.content ?? "";
    };

    assert.match(resultFor("glob_files"), /src\/hello\.ts/);
    assert.match(resultFor("search_text"), /"line": 1/);
    assert.match(resultFor("read_file"), /2\tconsole\.log\('bye'\);/);
    assert.match(resultFor("move_file"), /Moved src\/hello\.ts -> archive\/hello\.ts/);
    assert.match(resultFor("delete_file"), /Deleted archive\/hello\.ts/);
    assert.match(resultFor("todo_write", 1), /\[x\] Create hello\.ts/);

    // The file should no longer exist anywhere in the workspace after the move+delete sequence.
    await assert.rejects(fs.readFile(path.join(workspace, "src", "hello.ts")));
    await assert.rejects(fs.readFile(path.join(workspace, "archive", "hello.ts")));
  });
});

test("integration: start, inspect, and stop a background command through the real toolset", async () => {
  const workspace = await makeWorkspaceRoot();
  await fs.writeFile(
    path.join(workspace, "server.js"),
    "console.log('server up');\nsetInterval(function () {}, 1000);\n"
  );

  const responses = [
    toolCall("run_command_background", { command: "node", args: ["server.js"] }),
    toolCall("stop_background_command", { id: "bg-1" }),
    toolCall("list_background_commands", {}),
    finalReply("done")
  ];

  await withScriptedModel(responses, async () => {
    const session = createAgentSession(baseConfig(workspace), {});
    const result = await session.ask("start the server, confirm it's up, then stop it");

    assert.equal(result.failed, false);
    assert.equal(result.content, "done");

    const history = session.getHistory();
    const resultFor = (tool) => history.find((message) => message.content.includes(`<tool_result name="${tool}">`))?.content ?? "";

    assert.match(resultFor("run_command_background"), /"status": "running"/);
    assert.match(resultFor("stop_background_command"), /"status": "killed"/);
    assert.match(resultFor("list_background_commands"), /"id": "bg-1"/);
  });
});

test("integration: write denied without a TTY leaves the model informed via the tool result, not a crash", async () => {
  const workspace = await makeWorkspaceRoot();

  const responses = [
    toolCall("write_file", { path: "notes.txt", content: "hello" }),
    finalReply("done")
  ];

  await withScriptedModel(responses, async () => {
    const config = { ...baseConfig(workspace), allowWrites: false };
    const session = createAgentSession(config, {});
    const result = await session.ask("write a note");

    assert.equal(result.failed, false);
    const history = session.getHistory();
    const writeResult = history.find((message) => message.content.includes('<tool_result name="write_file">'));
    assert.match(writeResult.content, /Error:.*not approved/i);
  });

  await assert.rejects(fs.readFile(path.join(workspace, "notes.txt")));
});
