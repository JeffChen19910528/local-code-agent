import test from "node:test";
import assert from "node:assert/strict";
import { extractRecentPrompts } from "../src/checkpoint.js";

test("extractRecentPrompts strips the injected <current_datetime> tag from real user prompts", () => {
  const history = [
    { role: "user", content: "<current_datetime>2026-08-18 (Tuesday) 14:35 local time (UTC+08:00)</current_datetime>\n台北天氣如何?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "<tool_result name=\"web_search\">...</tool_result>" },
    { role: "user", content: "<current_datetime>2026-08-18 (Tuesday) 14:36 local time (UTC+08:00)</current_datetime>\n今天台北天氣如何?" }
  ];

  const prompts = extractRecentPrompts(history);

  assert.deepEqual(prompts, ["台北天氣如何?", "今天台北天氣如何?"]);
});

test("extractRecentPrompts leaves prompts without the tag untouched", () => {
  const history = [{ role: "user", content: "plain prompt with no datetime tag" }];

  assert.deepEqual(extractRecentPrompts(history), ["plain prompt with no datetime tag"]);
});
