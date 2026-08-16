import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/workspace.js";
import { createToolset } from "../src/tools.js";

async function makeToolset(options = { allowWrites: true }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-tools-"));
  const workspace = new Workspace(root, options);
  return { root, workspace, toolset: createToolset(workspace) };
}

test("append_file tool adds content without rewriting existing content", async () => {
  const { toolset, workspace } = await makeToolset();

  await toolset.execute("write_file", { path: "notes.txt", content: "first\n" });
  await toolset.execute("append_file", { path: "notes.txt", content: "second\n" });

  assert.equal(await workspace.readFile("notes.txt"), "first\nsecond\n");
});

test("write_file reports a passing syntax check for valid JavaScript", async () => {
  const { toolset } = await makeToolset();

  const result = await toolset.execute("write_file", {
    path: "valid.js",
    content: "function add(a, b) {\n  return a + b;\n}\n"
  });

  assert.match(result, /Syntax OK\./);
});

test("write_file surfaces a syntax check failure for broken JavaScript", async () => {
  const { toolset } = await makeToolset();

  const result = await toolset.execute("write_file", {
    path: "broken.js",
    content: "function add(a, b) {\n  return a + b;\n"
  });

  assert.match(result, /Syntax check failed/);
});

test("append_file also runs the syntax check on the resulting file", async () => {
  const { toolset } = await makeToolset();

  await toolset.execute("write_file", { path: "script.js", content: "function add(a, b) {\n" });
  const result = await toolset.execute("append_file", { path: "script.js", content: "  return a + b;\n}\n" });

  assert.match(result, /Syntax OK\./);
});

test("write_file skips the syntax check for unrecognized extensions", async () => {
  const { toolset } = await makeToolset();

  const result = await toolset.execute("write_file", { path: "notes.txt", content: "hello" });

  assert.doesNotMatch(result, /Syntax/);
});

test("run_command executes without prompting when allowCommands is on", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-tools-"));
  const workspace = new Workspace(root, { allowCommands: true });
  const toolset = createToolset(workspace);

  const result = await toolset.execute("run_command", {
    command: "node",
    args: ["-e", "console.log('hi')"]
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hi");
});

test("run_command is denied without hanging when allowCommands is off and there is no TTY to prompt", async () => {
  const { toolset } = await makeToolset();

  await assert.rejects(
    toolset.execute("run_command", { command: "node", args: ["-e", "console.log(1)"] }),
    /not approved/i
  );
});

test("write_file is denied without hanging when allowWrites is off and there is no TTY to prompt", async () => {
  const { toolset } = await makeToolset({ allowWrites: false });

  await assert.rejects(
    toolset.execute("write_file", { path: "notes.txt", content: "hello" }),
    /not approved/i
  );
});

test("append_file is denied without hanging when allowWrites is off and there is no TTY to prompt", async () => {
  const { toolset } = await makeToolset({ allowWrites: false });

  await assert.rejects(
    toolset.execute("append_file", { path: "notes.txt", content: "hello" }),
    /not approved/i
  );
});

test("make_directory is denied without hanging when allowWrites is off and there is no TTY to prompt", async () => {
  const { toolset } = await makeToolset({ allowWrites: false });

  await assert.rejects(
    toolset.execute("make_directory", { path: "sub" }),
    /not approved/i
  );
});

test("write_file runs without prompting when allowWrites is on", async () => {
  const { toolset, workspace } = await makeToolset({ allowWrites: true });

  await toolset.execute("write_file", { path: "notes.txt", content: "hello" });
  assert.equal(await workspace.readFile("notes.txt"), "hello");
});

test("read_external_file reads a file outside the workspace and echoes its absolute path", async () => {
  const { toolset } = await makeToolset();

  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-tools-outside-"));
  const outsideFile = path.join(outsideDir, "external.txt");
  await fs.writeFile(outsideFile, "hello from outside");

  const result = await toolset.execute("read_external_file", { path: outsideFile });
  assert.match(result, new RegExp(outsideFile.replace(/\\/g, "\\\\")));
  assert.match(result, /hello from outside/);
});

test("glob_files finds files matching a pattern", async () => {
  const { toolset } = await makeToolset();

  await toolset.execute("write_file", { path: "src/a.ts", content: "" });
  await toolset.execute("write_file", { path: "src/b.js", content: "" });

  const result = await toolset.execute("glob_files", { pattern: "**/*.ts" });
  assert.deepEqual(result, ["src/a.ts"]);
});

test("read_file with offset/limit returns a line-numbered slice", async () => {
  const { toolset } = await makeToolset();

  await toolset.execute("write_file", { path: "notes.txt", content: "one\ntwo\nthree\nfour\n" });
  const result = await toolset.execute("read_file", { path: "notes.txt", offset: 2, limit: 2 });

  assert.equal(result, "2\ttwo\n3\tthree");
});

test("read_file without offset/limit returns raw content", async () => {
  const { toolset } = await makeToolset();

  await toolset.execute("write_file", { path: "notes.txt", content: "hello" });
  const result = await toolset.execute("read_file", { path: "notes.txt" });

  assert.equal(result, "hello");
});

test("search_text with regex:true and contextLines finds matches with surrounding lines", async () => {
  const { toolset } = await makeToolset();

  await toolset.execute("write_file", { path: "a.js", content: "before\nfunction foo() {}\nafter\n" });
  const result = await toolset.execute("search_text", { query: "function \\w+\\(\\)", regex: true, contextLines: 1 });

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].before, ["before"]);
  assert.deepEqual(result[0].after, ["after"]);
});

test("delete_file removes a file when approved", async () => {
  const { toolset } = await makeToolset();

  await toolset.execute("write_file", { path: "notes.txt", content: "hello" });
  const result = await toolset.execute("delete_file", { path: "notes.txt" });

  assert.match(result, /Deleted/);
  await assert.rejects(toolset.execute("read_file", { path: "notes.txt" }));
});

test("delete_file is denied without hanging when allowWrites is off and there is no TTY to prompt", async () => {
  const { toolset } = await makeToolset({ allowWrites: false });

  await assert.rejects(
    toolset.execute("delete_file", { path: "notes.txt" }),
    /not approved/i
  );
});

test("move_file renames a file when approved", async () => {
  const { toolset } = await makeToolset();

  await toolset.execute("write_file", { path: "notes.txt", content: "hello" });
  const result = await toolset.execute("move_file", { from: "notes.txt", to: "archive/notes.txt" });

  assert.match(result, /Moved/);
  assert.equal(await toolset.execute("read_file", { path: "archive/notes.txt" }), "hello");
});

test("todo_write and todo_read round-trip the current task list", async () => {
  const { toolset } = await makeToolset();

  assert.equal(await toolset.execute("todo_read", {}), "No todos yet.");

  const writeResult = await toolset.execute("todo_write", {
    items: [
      { content: "Investigate bug", status: "completed" },
      { content: "Fix bug", status: "in_progress" },
      { content: "Write test", status: "pending" }
    ]
  });

  assert.equal(writeResult, "[x] Investigate bug\n[~] Fix bug\n[ ] Write test");
  assert.equal(await toolset.execute("todo_read", {}), writeResult);
});

test("run_command_background, read_background_output, and stop_background_command manage a long-running process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-tools-"));
  const workspace = new Workspace(root, { allowCommands: true });
  const toolset = createToolset(workspace);

  // Run from a script file rather than -e: on Windows, run_command/run_command_background go
  // through "cmd.exe /c" (shell: true), whose parsing of parens/braces inside an inline -e
  // snippet is unreliable. A file path has no such metacharacters to trip over.
  await fs.writeFile(path.join(root, "server.js"), "console.log('running');\nsetInterval(function () {}, 1000);\n");
  const started = await toolset.execute("run_command_background", {
    command: "node",
    args: ["server.js"]
  });
  assert.equal(started.status, "running");

  let output;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    output = await toolset.execute("read_background_output", { id: started.id });
    if (output.stdout.includes("running")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(output.stdout, /running/);
  assert.equal(output.status, "running");

  const stopped = await toolset.execute("stop_background_command", { id: started.id });
  assert.equal(stopped.status, "killed");

  const listed = await toolset.execute("list_background_commands", {});
  assert.equal(listed[0].id, started.id);
});

test("read_external_file rejects a missing file", async () => {
  const { toolset, root } = await makeToolset();

  await assert.rejects(
    toolset.execute("read_external_file", { path: path.join(root, "missing.txt") }),
    /File not found/i
  );
});
