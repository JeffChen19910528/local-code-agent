import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("loadConfig keeps defaults when env vars are unset", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-config-"));
  const originalProvider = process.env.LOCAL_CODE_PROVIDER;
  const originalModel = process.env.LOCAL_CODE_MODEL;

  delete process.env.LOCAL_CODE_PROVIDER;
  delete process.env.LOCAL_CODE_MODEL;

  try {
    const config = await loadConfig(root);
    assert.equal(config.provider, "");
    assert.equal(config.model, "");
  } finally {
    restoreEnv("LOCAL_CODE_PROVIDER", originalProvider);
    restoreEnv("LOCAL_CODE_MODEL", originalModel);
  }
});

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
