import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli/args.js";

test("parseArgs defaults to help with no arguments", () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.command, "help");
  assert.deepEqual(parsed.options, {});
  assert.deepEqual(parsed.positionals, []);
});

test("parseArgs collects the command and joins positionals into a prompt", () => {
  const parsed = parseArgs(["run", "fix", "the", "bug"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.prompt, "fix the bug");
  assert.deepEqual(parsed.positionals, ["fix", "the", "bug"]);
});

test("parseArgs reads a flag's following value", () => {
  const parsed = parseArgs(["run", "--provider", "ollama", "do it"]);
  assert.equal(parsed.options.provider, "ollama");
  assert.equal(parsed.prompt, "do it");
});

test("parseArgs treats a flag with no following value (or followed by another flag) as boolean true", () => {
  const parsed = parseArgs(["chat", "--allow-writes", "--allow-network"]);
  assert.equal(parsed.options.allowWrites, true);
  assert.equal(parsed.options.allowNetwork, true);
});

test("parseArgs camelCases dashed flag names", () => {
  const parsed = parseArgs(["run", "--max-steps", "5"]);
  assert.equal(parsed.options.maxSteps, "5");
});
