import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { checkSyntax } from "../src/syntaxCheck.js";

const execFile = promisify(execFileCallback);

async function hasPython() {
  for (const command of ["python", "python3", "py"]) {
    try {
      await execFile(command, ["--version"], { timeout: 1500, windowsHide: true });
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

test("checkSyntax skips unrecognized extensions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-syntax-"));
  const filePath = path.join(root, "data.txt");
  await fs.writeFile(filePath, "not code", "utf8");

  const result = await checkSyntax(filePath);
  assert.deepEqual(result, { checked: false, ok: true, message: null });
});

test("checkSyntax accepts valid JavaScript", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-syntax-"));
  const filePath = path.join(root, "valid.js");
  await fs.writeFile(filePath, "function add(a, b) {\n  return a + b;\n}\n", "utf8");

  const result = await checkSyntax(filePath);
  assert.equal(result.checked, true);
  assert.equal(result.ok, true);
});

test("checkSyntax rejects broken JavaScript", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-syntax-"));
  const filePath = path.join(root, "broken.js");
  await fs.writeFile(filePath, "function add(a, b) {\n  return a + b;\n", "utf8");

  const result = await checkSyntax(filePath);
  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
  assert.ok(result.message && result.message.length > 0);
});

test("checkSyntax validates Python when a python interpreter is available", async (t) => {
  if (!(await hasPython())) {
    t.skip("no python interpreter found on PATH");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-syntax-"));

  const validPath = path.join(root, "valid.py");
  await fs.writeFile(validPath, "def add(a, b):\n    return a + b\n", "utf8");
  const validResult = await checkSyntax(validPath);
  assert.equal(validResult.checked, true);
  assert.equal(validResult.ok, true);

  const brokenPath = path.join(root, "broken.py");
  await fs.writeFile(brokenPath, "def add(a, b):\n    text = \"\"\"\n    return a + b\n", "utf8");
  const brokenResult = await checkSyntax(brokenPath);
  assert.equal(brokenResult.checked, true);
  assert.equal(brokenResult.ok, false);
});
