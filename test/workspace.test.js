import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/workspace.js";

test("workspace writes and reads files inside root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root, { allowWrites: true });

  await workspace.writeFile("src/demo.txt", "hello");
  const content = await workspace.readFile("src/demo.txt");

  assert.equal(content, "hello");
});

test("workspace appendFile creates a new file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root, { allowWrites: true });

  await workspace.appendFile("notes.txt", "first line\n");
  assert.equal(await workspace.readFile("notes.txt"), "first line\n");
});

test("workspace appendFile adds to existing content without rewriting it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root, { allowWrites: true });

  await workspace.writeFile("notes.txt", "first line\n");
  await workspace.appendFile("notes.txt", "second line\n");

  assert.equal(await workspace.readFile("notes.txt"), "first line\nsecond line\n");
});

test("workspace writeFile rejects when not allowed and not approved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root, { allowWrites: false });

  await assert.rejects(
    workspace.writeFile("notes.txt", "hello"),
    /not approved/i
  );
});

test("workspace writeFile runs when approved for this call, even if allowWrites is off", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root, { allowWrites: false });

  await workspace.writeFile("notes.txt", "hello", { approved: true });
  assert.equal(await workspace.readFile("notes.txt"), "hello");
});

test("workspace runCommand rejects when not allowed and not approved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root, { allowCommands: false });

  await assert.rejects(
    workspace.runCommand("node", ["-e", "console.log(1)"]),
    /not approved/i
  );
});

test("workspace runCommand runs when approved for this call, even if allowCommands is off", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root, { allowCommands: false });

  const result = await workspace.runCommand("node", ["-e", "console.log(1)"], { approved: true });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "1");
});

test("workspace runCommand runs without approval when allowCommands is on", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root, { allowCommands: true });

  const result = await workspace.runCommand("node", ["-e", "console.log(2)"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "2");
});

test("workspace blocks path traversal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root);

  assert.throws(() => workspace.resolvePath("../outside.txt"), /escapes workspace/i);
});

test("workspace readExternalFile reads a file outside the workspace root by absolute path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root);

  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-outside-"));
  const outsideFile = path.join(outsideDir, "notes.txt");
  await fs.writeFile(outsideFile, "external content");

  const result = await workspace.readExternalFile(outsideFile);
  assert.equal(result.path, outsideFile);
  assert.equal(result.content, "external content");
});

test("workspace readExternalFile rejects a missing file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root);

  await assert.rejects(
    workspace.readExternalFile(path.join(root, "does-not-exist.txt")),
    /File not found/i
  );
});

test("workspace readExternalFile rejects a directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root);
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-outside-"));

  await assert.rejects(
    workspace.readExternalFile(outsideDir),
    /Not a file/i
  );
});

test("workspace readExternalFile rejects files larger than the size limit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root);
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-outside-"));
  const bigFile = path.join(outsideDir, "big.txt");
  await fs.writeFile(bigFile, Buffer.alloc(2 * 1024 * 1024 + 1, "a"));

  await assert.rejects(
    workspace.readExternalFile(bigFile),
    /too large/i
  );
});

test("workspace lists recent files in newest-first order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-agent-"));
  const workspace = new Workspace(root, { allowWrites: true });

  await workspace.writeFile("a.txt", "a");
  await workspace.writeFile("b.txt", "b");

  const older = new Date("2026-07-10T00:00:00.000Z");
  const newer = new Date("2026-07-11T00:00:00.000Z");
  await fs.utimes(path.join(root, "a.txt"), older, older);
  await fs.utimes(path.join(root, "b.txt"), newer, newer);

  const recent = await workspace.listRecentFiles(2);
  assert.equal(recent[0].path, "b.txt");
  assert.equal(recent[1].path, "a.txt");
});

async function withMockedFetch(handler, run) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  try {
    await run();
  } finally {
    global.fetch = originalFetch;
  }
}

test("workspace fetchUrl strips HTML tags and extracts the title by default", async () => {
  const workspace = new Workspace(process.cwd());

  await withMockedFetch(
    async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html><head><title>Example</title></head><body><nav>menu</nav><p>Hello <b>world</b></p></body></html>"
    }),
    async () => {
      const result = await workspace.fetchUrl("https://example.com", { approved: true });
      assert.equal(result.title, "Example");
      assert.equal(result.text, "Example menu Hello world");
    }
  );
});

test("workspace fetchUrl with render:true fetches through the Jina reader and returns Markdown as-is", async () => {
  const workspace = new Workspace(process.cwd());
  let requestedUrl;

  await withMockedFetch(
    async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "Title: Example Page\n\nURL Source: https://example.com\n\nMarkdown Content:\n# Real content that only JS would normally render"
      };
    },
    async () => {
      const result = await workspace.fetchUrl("https://example.com", { approved: true, render: true });
      assert.equal(requestedUrl, "https://r.jina.ai/https://example.com/");
      assert.equal(result.title, "Example Page");
      assert.match(result.text, /Real content that only JS would normally render/);
    }
  );
});

test("workspace fetchUrl with render:true strips link-only nav lines so real content isn't pushed past maxChars", async () => {
  const workspace = new Workspace(process.cwd());
  const navLines = Array.from(
    { length: 50 },
    (_, index) => `*   [Nav item ${index}](https://example.com/nav-${index} "Nav item ${index}")`
  ).join("\n");
  const rendered = `Title: County Weather\n\nMarkdown Content:\n${navLines}\n\n今日天氣晴，氣溫27至35度，降雨機率90%。`;

  await withMockedFetch(
    async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => rendered
    }),
    async () => {
      // maxChars is well below the raw nav-menu size, but comfortably above the filtered size,
      // so this only passes if the pure link-list lines were actually dropped before truncating.
      const result = await workspace.fetchUrl("https://example.com/weather", {
        approved: true,
        render: true,
        maxChars: 300
      });

      assert.doesNotMatch(result.text, /Nav item/);
      assert.match(result.text, /氣溫27至35度，降雨機率90%/);
    }
  );
});
