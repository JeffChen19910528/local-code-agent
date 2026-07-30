import { createAgentSession } from "./agent.js";

const DEFAULT_MAX_CONCURRENT_AGENTS = 3;

// Process-wide registry of background sub-agent tasks spawned via the
// spawn_agent tool. Intentionally in-memory only - tasks don't need to
// survive a CLI restart, unlike chat history or checkpoints.
const tasks = new Map();
let counter = 0;

export function countRunningAgentTasks() {
  let count = 0;
  for (const record of tasks.values()) {
    if (record.status === "running") {
      count += 1;
    }
  }
  return count;
}

export function spawnAgentTask(config, prompt) {
  const maxConcurrent = config.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS;
  const running = countRunningAgentTasks();
  if (running >= maxConcurrent) {
    throw new Error(
      `Too many background agents already running (${running}/${maxConcurrent}). Each parallel chat request keeps the local model server's context/KV-cache in memory, so running too many at once can exhaust it. Use check_agent to wait for one to finish before spawning another.`
    );
  }

  counter += 1;
  const id = `agent-${counter}`;
  const record = {
    id,
    task: prompt,
    status: "running",
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };
  tasks.set(id, record);

  const session = createAgentSession(config, {
    onToolCall(toolCall) {
      console.error(`[${id}] tool: ${toolCall.tool}`);
    }
  });

  session
    .ask(prompt)
    .then((result) => {
      record.status = result.failed ? "failed" : "done";
      record.result = result.content;
      record.finishedAt = new Date().toISOString();
    })
    .catch((error) => {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = new Date().toISOString();
    });

  return record;
}

export function getAgentTask(id) {
  return tasks.get(id) ?? null;
}

export function listAgentTasks() {
  return [...tasks.values()];
}
