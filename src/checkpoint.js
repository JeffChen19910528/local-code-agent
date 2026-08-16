import { loadAppState, saveAppState } from "./config.js";

const DEFAULT_PROMPT_LIMIT = 10;
const DEFAULT_PROMPT_MAX_CHARS = 400;

const EMPTY_REPLY_NUDGE =
  "你的回覆是空的。就算使用者的輸入有錯字、簡短或不完整，也請依照最合理的猜測直接執行或回答，不要保持沉默；如果需要用到工具，回傳一個 <tool_call> 區塊，否則至少用一句話回答。";

export async function loadCheckpoints(config) {
  const state = await loadAppState(config.statePath);
  return Array.isArray(state.checkpoints) ? state.checkpoints : [];
}

export async function saveCheckpoints(config, checkpoints) {
  await saveAppState(config.statePath, { checkpoints });
}

export function findActiveCheckpoint(checkpoints) {
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    if (!checkpoints[index].completed) {
      return checkpoints[index];
    }
  }

  return null;
}

export function extractRecentPrompts(history, limit = DEFAULT_PROMPT_LIMIT, maxChars = DEFAULT_PROMPT_MAX_CHARS) {
  if (!Array.isArray(history)) {
    return [];
  }

  const prompts = history
    .filter(isRealUserPrompt)
    .map((message) => stripCurrentDatetimeTag(message.content.trim()).slice(0, maxChars));

  return prompts.slice(-limit);
}

// ask() prefixes every outgoing user message with <current_datetime>...</current_datetime> so
// the model can resolve "today"/"tomorrow". That's noise in a checkpoint meant to capture what
// the user actually typed, so strip it back off here.
function stripCurrentDatetimeTag(content) {
  return content.replace(/^<current_datetime>[^<]*<\/current_datetime>\n?/, "");
}

function isRealUserPrompt(message) {
  if (!message || message.role !== "user" || typeof message.content !== "string") {
    return false;
  }

  const trimmed = message.content.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("<tool_result ") || trimmed.startsWith("<tool_call_error>")) {
    return false;
  }

  if (trimmed === EMPTY_REPLY_NUDGE) {
    return false;
  }

  return true;
}

export function createCheckpoint({
  goal = "",
  status = "",
  completedSteps = [],
  pendingSteps = [],
  contextNotes = [],
  blockers = [],
  keyFiles = [],
  recentPrompts = []
} = {}) {
  const now = new Date().toISOString();
  return {
    id: now.replace(/[:.]/g, "-"),
    createdAt: now,
    updatedAt: now,
    goal,
    status,
    completedSteps,
    pendingSteps,
    contextNotes,
    blockers,
    keyFiles,
    recentPrompts,
    completed: false,
    completedAt: null
  };
}

export function formatCheckpointSummaryLine(checkpoint) {
  const tag = checkpoint.completed ? "done  " : "active";
  return `[${tag}] ${checkpoint.id}  ${checkpoint.goal || "(no goal)"}  (${checkpoint.createdAt.slice(0, 16)})`;
}

export function formatCheckpoint(checkpoint) {
  const lines = [
    `Checkpoint ${checkpoint.id}${checkpoint.completed ? " (completed)" : ""}`,
    `Saved: ${checkpoint.createdAt}`
  ];

  if (checkpoint.updatedAt && checkpoint.updatedAt !== checkpoint.createdAt) {
    lines.push(`Updated: ${checkpoint.updatedAt}`);
  }

  lines.push("", `Goal: ${checkpoint.goal || "(none)"}`, `Status: ${checkpoint.status || "(none)"}`);

  pushListSection(lines, "Completed", checkpoint.completedSteps, (step) => `  [x] ${step}`);
  pushListSection(lines, "Pending (continue here)", checkpoint.pendingSteps, (step) => `  [ ] ${step}`);
  pushListSection(lines, "Context / decisions", checkpoint.contextNotes, (note) => `  - ${note}`);
  pushListSection(lines, "Blockers", checkpoint.blockers, (blocker) => `  ! ${blocker}`);
  pushListSection(lines, "Key files", checkpoint.keyFiles, (file) => `  - ${file}`);
  pushListSection(lines, "Recent prompts (auto-captured)", checkpoint.recentPrompts, (prompt) => `  - ${prompt}`);

  return lines.join("\n");
}

function pushListSection(lines, title, items, formatItem) {
  if (!items || items.length === 0) {
    return;
  }

  lines.push("", `${title}:`);
  for (const item of items) {
    lines.push(formatItem(item));
  }
}
