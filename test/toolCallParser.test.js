import test from "node:test";
import assert from "node:assert/strict";
import { extractToolCall, isTruncatedToolCall, isUnfinishedIntent } from "../src/toolCallParser.js";

test("extractToolCall returns parsed tool data", () => {
  const input = [
    "Need to inspect a file first.",
    "<tool_call>",
    "{\"tool\":\"read_file\",\"args\":{\"path\":\"src/index.js\"}}",
    "</tool_call>"
  ].join("\n");

  assert.deepEqual(extractToolCall(input), {
    tool: "read_file",
    args: { path: "src/index.js" }
  });
});

test("extractToolCall returns null when no tool call exists", () => {
  assert.equal(extractToolCall("final answer"), null);
});

test("extractToolCall auto-repairs raw control characters inside string values", () => {
  const input = "<tool_call>\n{\"tool\":\"write_file\",\"args\":{\"path\":\"x.py\",\"content\":\"line1\nline2\"}}\n</tool_call>";
  assert.deepEqual(extractToolCall(input), {
    tool: "write_file",
    args: { path: "x.py", content: "line1\nline2" }
  });
});

test("extractToolCall auto-repairs unescaped quotes inside file content", () => {
  const input =
    '<tool_call>\n' +
    '{"tool":"write_file","args":{"path":"x.py","content":"print("hello")"}}\n' +
    '</tool_call>';
  const result = extractToolCall(input);
  assert.equal(result.tool, "write_file");
  assert.equal(result.args.path, "x.py");
  assert.equal(result.args.content, 'print("hello")');
});

test("extractToolCall throws with a helpful message on unrecoverable JSON", () => {
  const input = "<tool_call>\n{\"tool\":\"write_file\", \"args\": {,}}\n</tool_call>";
  assert.throws(() => extractToolCall(input), /not valid JSON|Invalid tool call JSON/);
});

test("isTruncatedToolCall detects a missing closing tag", () => {
  assert.equal(isTruncatedToolCall("<tool_call>\n{\"tool\":\"write_file\""), true);
  assert.equal(isTruncatedToolCall("<tool_call></tool_call>"), false);
  assert.equal(isTruncatedToolCall("no tool call here"), false);
});

test("isUnfinishedIntent flags short intent-only replies with no tool_call", () => {
  assert.equal(isUnfinishedIntent("let me check that file for you"), true);
  assert.equal(isUnfinishedIntent("讓我看看這個檔案"), true);
  assert.equal(isUnfinishedIntent("here is the final answer"), false);
  assert.equal(isUnfinishedIntent("let me check <tool_call>{}</tool_call>"), false);
  assert.equal(isUnfinishedIntent("let me " + "a".repeat(200)), false);
});
