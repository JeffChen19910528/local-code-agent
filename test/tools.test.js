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
