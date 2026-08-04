import test from "node:test";
import assert from "node:assert/strict";
import { applyPendingAttachments, formatAttachmentBlock, stripQuotes } from "../src/cli.js";

test("stripQuotes removes matching surrounding quotes and trims whitespace", () => {
  assert.equal(stripQuotes('"C:/Users/me/notes.txt"'), "C:/Users/me/notes.txt");
  assert.equal(stripQuotes("'C:/Users/me/notes.txt'"), "C:/Users/me/notes.txt");
  assert.equal(stripQuotes("  C:/Users/me/notes.txt  "), "C:/Users/me/notes.txt");
  assert.equal(stripQuotes("no-quotes.txt"), "no-quotes.txt");
});

test("formatAttachmentBlock wraps content with the resolved absolute path", () => {
  const block = formatAttachmentBlock("C:/Users/me/notes.txt", "hello");
  assert.equal(block, '<attached_file path="C:/Users/me/notes.txt">\nhello\n</attached_file>');
});

test("applyPendingAttachments returns the prompt unchanged when there are no attachments", () => {
  assert.equal(applyPendingAttachments("summarize this", []), "summarize this");
  assert.equal(applyPendingAttachments("summarize this", undefined), "summarize this");
});

test("applyPendingAttachments prepends each attachment block before the prompt", () => {
  const attachments = [
    { path: "C:/a.txt", content: "content a" },
    { path: "C:/b.txt", content: "content b" }
  ];

  const result = applyPendingAttachments("summarize these", attachments);
  assert.equal(
    result,
    '<attached_file path="C:/a.txt">\ncontent a\n</attached_file>\n\n<attached_file path="C:/b.txt">\ncontent b\n</attached_file>\n\nsummarize these'
  );
});
