import test from "node:test";
import assert from "node:assert/strict";
import { createOllamaProvider } from "../src/providers/ollama.js";
import { createLmStudioProvider } from "../src/providers/lmstudio.js";

async function withMockedFetch(handler, run) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  try {
    await run();
  } finally {
    global.fetch = originalFetch;
  }
}

test("ollama provider surfaces the {\"error\":...} body on a failed chat request", async () => {
  await withMockedFetch(
    async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => JSON.stringify({ error: "model runner terminated unexpectedly" })
    }),
    async () => {
      const provider = createOllamaProvider({
        model: "demo",
        temperature: 0.2,
        ollamaBaseUrl: "http://127.0.0.1:11434"
      });

      await assert.rejects(
        () => provider.chat([{ role: "user", content: "hi" }]),
        /Ollama request failed: 500 Internal Server Error - model runner terminated unexpectedly/
      );
    }
  );
});

test("ollama provider falls back to raw text when the error body isn't JSON", async () => {
  await withMockedFetch(
    async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "panic: out of memory"
    }),
    async () => {
      const provider = createOllamaProvider({
        model: "demo",
        temperature: 0.2,
        ollamaBaseUrl: "http://127.0.0.1:11434"
      });

      await assert.rejects(
        () => provider.chat([{ role: "user", content: "hi" }]),
        /Ollama request failed: 500 Internal Server Error - panic: out of memory/
      );
    }
  );
});

test("lmstudio provider surfaces the {\"error\":{\"message\":...}} body on a failed chat request", async () => {
  await withMockedFetch(
    async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: { message: "model not loaded" } })
    }),
    async () => {
      const provider = createLmStudioProvider({
        model: "demo",
        temperature: 0.2,
        lmStudioBaseUrl: "http://127.0.0.1:1234"
      });

      await assert.rejects(
        () => provider.chat([{ role: "user", content: "hi" }]),
        /LM Studio request failed: 400 Bad Request - model not loaded/
      );
    }
  );
});
