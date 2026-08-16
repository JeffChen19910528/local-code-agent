import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, createAgentSession, extractToolCall } from "../src/agent.js";

async function withMockedFetch(responses, run) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => responses.shift()
  });

  try {
    await run();
  } finally {
    global.fetch = originalFetch;
  }
}

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

test("buildSystemPrompt tells the model not to claim file changes it didn't make", () => {
  const prompt = buildSystemPrompt({ workspace: process.cwd() }, []);

  assert.match(prompt, /Never claim you created, wrote, saved, or modified a file/);
  assert.match(prompt, /call list_files or read_file to check first/);
});

test("buildSystemPrompt tells the model to use web_search for weather and forbids claiming no real-time access without trying", () => {
  const prompt = buildSystemPrompt({ workspace: process.cwd() }, []);

  assert.match(prompt, /weather, sports scores\/schedules, stock\/crypto prices/);
  assert.match(prompt, /NEVER claim you "don't have access to real-time data\/APIs"/);
  assert.match(prompt, /a plain refusal with no tool_call attempt in the same turn is never an acceptable final answer/);
});

test("buildSystemPrompt tells the model to use the injected <current_datetime> tag to resolve relative dates", () => {
  const prompt = buildSystemPrompt({ workspace: process.cwd() }, []);

  assert.match(prompt, /<current_datetime>\.\.\.<\/current_datetime>/);
  assert.match(prompt, /resolve relative terms like "today", "tomorrow", "this week"/);
});

test("buildSystemPrompt tells the model to retry with render:true when web_fetch only returns JS-app boilerplate", () => {
  const prompt = buildSystemPrompt({ workspace: process.cwd() }, []);

  assert.match(prompt, /web_fetch's plain mode only reads a page's raw HTML - it cannot run JavaScript/);
  assert.match(prompt, /call web_fetch again on the SAME url with render:true/);
  assert.match(prompt, /wttr\.in\/<city>\?format=j1/);
  assert.match(prompt, /wttr\.in\/<city>\?format=4/);
});

test("ask() prefixes every outgoing user message with the current date/time", async () => {
  const responses = [{ message: { content: "done" } }];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    await session.ask("台北天氣如何?");

    const userMessage = session.getHistory().find((message) => message.role === "user");
    assert.match(userMessage.content, /^<current_datetime>\d{4}-\d{2}-\d{2} \(\w+\) \d{2}:\d{2} local time \(UTC[+-]\d{2}:\d{2}\)<\/current_datetime>\n台北天氣如何\?$/);
  });
});

test("createAgentSession preserves sanitized history", () => {
  const session = createAgentSession({
    provider: "ollama",
    model: "demo",
    workspace: process.cwd(),
    allowCommands: false,
    maxSteps: 2
  }, {}, {
    history: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { nope: true }
    ]
  });

  assert.deepEqual(session.getHistory(), [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ]);
});

test("ask() feeds tool errors back to the model instead of throwing", async () => {
  const responses = [
    { message: { content: "<tool_call>\n{\"tool\":\"unknown_tool\",\"args\":{}}\n</tool_call>" } },
    { message: { content: "done" } }
  ];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    const result = await session.ask("do something");
    assert.equal(result.content, "done");

    const toolResultMessage = session
      .getHistory()
      .find((message) => message.content.includes("<tool_result"));
    assert.match(toolResultMessage.content, /Error: Unknown tool: unknown_tool/);
  });
});

test("ask() auto-repairs a <tool_call> block containing raw control characters instead of asking the model to retry", async () => {
  const responses = [
    { message: { content: "<tool_call>\n{\"tool\":\"write_file\",\"args\":{\"path\":\"x.py\",\"content\":\"line1\nline2\"}}\n</tool_call>" } },
    { message: { content: "done" } }
  ];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    const result = await session.ask("write a script");
    assert.equal(result.content, "done");

    const errorMessage = session
      .getHistory()
      .find((message) => message.content.includes("<tool_call_error>"));
    assert.equal(errorMessage, undefined, "should not need a retry round-trip for an auto-repairable JSON error");

    const toolResultMessage = session
      .getHistory()
      .find((message) => message.content.includes("<tool_result"));
    assert.ok(toolResultMessage, "expected the repaired tool call to actually execute");
  });
});

test("ask() fires onModelResponse with duration and usage after each model call", async () => {
  const responses = [
    {
      message: { content: "<tool_call>\n{\"tool\":\"list_files\",\"args\":{}}\n</tool_call>" },
      prompt_eval_count: 450,
      eval_count: 32
    },
    {
      message: { content: "done" },
      prompt_eval_count: 500,
      eval_count: 8
    }
  ];

  const events = [];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {
      onModelResponse(info) {
        events.push(info);
      }
    });

    await session.ask("list files");
  });

  assert.equal(events.length, 2, "one event per model call");
  assert.ok(events[0].durationMs >= 0, "duration should be non-negative");
  assert.deepEqual(events[0].usage, { promptTokens: 450, completionTokens: 32 });
  assert.deepEqual(events[1].usage, { promptTokens: 500, completionTokens: 8 });
});

test("ask() auto-repairs a <tool_call> block with unescaped quotes in file content without retrying", async () => {
  // Model emits Python code with unescaped " inside the JSON content value
  const responses = [
    {
      message: {
        content:
          '<tool_call>\n' +
          '{"tool":"write_file","args":{"path":"x.py","content":"print("hello")"}}\n' +
          '</tool_call>'
      }
    },
    { message: { content: "done" } }
  ];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    const result = await session.ask("write a script");
    assert.equal(result.content, "done");

    const errorMessage = session
      .getHistory()
      .find((message) => message.content.includes("<tool_call_error>"));
    assert.equal(errorMessage, undefined, "should not need a retry round-trip for an auto-repairable unescaped-quote error");

    const toolResultMessage = session
      .getHistory()
      .find((message) => message.content.includes("<tool_result"));
    assert.ok(toolResultMessage, "expected the repaired tool call to actually execute");
  });
});

test("ask() recovers from a malformed <tool_call> block that cannot be auto-repaired", async () => {
  const responses = [
    { message: { content: "<tool_call>\n{\"tool\":\"write_file\", \"args\": {,}}\n</tool_call>" } },
    { message: { content: "done" } }
  ];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    const result = await session.ask("write a script");
    assert.equal(result.content, "done");

    const errorMessage = session
      .getHistory()
      .find((message) => message.content.includes("<tool_call_error>"));
    assert.ok(errorMessage, "expected a tool_call_error message to be recorded");
    assert.match(errorMessage.content, /not valid JSON/);
  });
});

test("ask() recovers from a <tool_call> block truncated by a length limit", async () => {
  const responses = [
    { message: { content: "<tool_call>\n{\"tool\":\"write_file\",\"args\":{\"path\":\"x.py\",\"content\":\"import os\\nprint(" } },
    { message: { content: "done" } }
  ];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    const result = await session.ask("write a script");
    assert.equal(result.content, "done");

    const errorMessage = session
      .getHistory()
      .find((message) => message.content.includes("<tool_call_error>"));
    assert.ok(errorMessage, "expected a tool_call_error message to be recorded");
    assert.match(errorMessage.content, /cut off/);
  });
});

test("ask() nudges the model to try again after an empty reply instead of giving up immediately", async () => {
  const responses = [
    { message: { content: "" } },
    { message: { content: "done" } }
  ];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    const result = await session.ask("dfjk fix teh thign");
    assert.equal(result.content, "done");
    assert.equal(result.failed, false);

    const nudgeMessage = session
      .getHistory()
      .find((message) => message.content.includes("你的回覆是空的"));
    assert.ok(nudgeMessage, "expected an empty-output nudge message to be recorded");
  });
});

test("ask() gives up after repeated empty replies with a friendly message", async () => {
  const responses = [
    { message: { content: "" } },
    { message: { content: "" } },
    { message: { content: "" } }
  ];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    const result = await session.ask("do something");
    assert.equal(result.failed, true);
    assert.match(result.content, /模型輸出為空/);
  });
});

test("ask() rejects tools outside a skill's allow list without crashing", async () => {
  const responses = [
    { message: { content: "<tool_call>\n{\"tool\":\"write_file\",\"args\":{\"path\":\"x.txt\",\"content\":\"x\"}}\n</tool_call>" } },
    { message: { content: "done" } }
  ];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    const result = await session.ask("do something", {
      skill: { name: "reviewer", body: "Only review.", tools: ["read_file"] }
    });
    assert.equal(result.content, "done");

    const toolResultMessage = session
      .getHistory()
      .find((message) => message.content.includes("<tool_result"));
    assert.match(toolResultMessage.content, /not available for this task/);
  });
});

test("ask() gives up early and reports failure after repeated identical tool_call errors", async () => {
  const brokenReply = { message: { content: "<tool_call>\n{\"tool\":\"write_file\" bad json\n</tool_call>" } };
  const responses = [brokenReply, brokenReply, brokenReply, { message: { content: "should not be reached" } }];

  const errorEvents = [];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 10,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {
      onToolCallError(info) {
        errorEvents.push(info);
      }
    });

    const result = await session.ask("write something");
    assert.equal(result.failed, true);
    assert.match(result.content, /連續 3 次/);
    assert.equal(errorEvents.length, 3);
    assert.equal(errorEvents[2].attempt, 3);
  });
});

test("ask() gives up after repeated provider errors and includes repair guidance", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("fetch failed");
  };

  const errorEvents = [];

  try {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 10,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {
      onToolCallError(info) {
        errorEvents.push(info);
      }
    });

    const result = await session.ask("write something");
    assert.equal(result.failed, true);
    assert.match(result.content, /連續 3 次/);
    assert.match(result.content, /診斷結果/);
    assert.equal(errorEvents.length, 3);
    assert.equal(errorEvents[2].reason, "provider_error");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ask() flags a genuinely empty final answer as failed", async () => {
  const responses = [{ message: { content: "" } }];

  await withMockedFetch(responses, async () => {
    const session = createAgentSession({
      provider: "ollama",
      model: "demo",
      workspace: process.cwd(),
      allowCommands: false,
      maxSteps: 3,
      temperature: 0.2,
      ollamaBaseUrl: "http://127.0.0.1:11434"
    }, {});

    const result = await session.ask("do something");
    assert.equal(result.failed, true);
    assert.match(result.content, /模型輸出為空/);
  });
});
