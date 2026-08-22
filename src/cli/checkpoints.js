import {
  createCheckpoint,
  extractRecentPrompts,
  findActiveCheckpoint,
  formatCheckpoint,
  formatCheckpointSummaryLine,
  loadCheckpoints,
  saveCheckpoints
} from "../checkpoint.js";
import { loadAppState } from "../config.js";
import { closeSharedReadline, getSharedReadline } from "../ui.js";

export async function runCheckpointCommand(config, subcommand, rest) {
  switch (subcommand) {
    case undefined:
    case "save":
      await cmdCheckpointSave(config);
      return;
    case "list":
      await cmdCheckpointList(config);
      return;
    case "show":
      await cmdCheckpointShow(config, rest[0]);
      return;
    case "complete":
      await cmdCheckpointComplete(config, rest[0]);
      return;
    default:
      console.log(`Unknown checkpoint subcommand: ${subcommand}`);
      console.log("Usage: local-code checkpoint <save|list|show|complete> [id]");
  }
}

export async function runChatCheckpointCommand(rl, config, session, subcommand, rest) {
  switch (subcommand) {
    case undefined:
    case "save": {
      const fields = await collectCheckpointFields(rl);
      const recentPrompts = extractRecentPrompts(session.getHistory());
      const checkpoint = createCheckpoint({ ...fields, recentPrompts });
      const checkpoints = [...(await loadCheckpoints(config)), checkpoint];
      await saveCheckpoints(config, checkpoints);
      console.log(`\ncheckpoint saved: ${checkpoint.id}`);
      return;
    }
    case "list":
      await cmdCheckpointList(config);
      return;
    case "show":
      await cmdCheckpointShow(config, rest[0]);
      return;
    case "complete":
      await cmdCheckpointComplete(config, rest[0]);
      return;
    default:
      console.log(`Unknown checkpoint subcommand: ${subcommand}`);
      console.log("Usage: /checkpoint [save|list|show|complete] [id]");
  }
}

async function cmdCheckpointSave(config) {
  const rl = getSharedReadline();
  try {
    const fields = await collectCheckpointFields(rl);
    const state = await loadAppState(config.statePath);
    const recentPrompts = extractRecentPrompts(state.chatSession?.history);

    const checkpoint = createCheckpoint({ ...fields, recentPrompts });
    const checkpoints = [...(await loadCheckpoints(config)), checkpoint];
    await saveCheckpoints(config, checkpoints);

    console.log(`\ncheckpoint saved: ${checkpoint.id}`);
  } finally {
    closeSharedReadline();
  }
}

async function cmdCheckpointList(config) {
  const checkpoints = await loadCheckpoints(config);
  if (checkpoints.length === 0) {
    console.log("No checkpoints saved yet.");
    return;
  }

  console.log("");
  for (const checkpoint of [...checkpoints].reverse()) {
    console.log(formatCheckpointSummaryLine(checkpoint));
  }
  console.log("");
}

async function cmdCheckpointShow(config, id) {
  const checkpoints = await loadCheckpoints(config);
  const checkpoint = id ? checkpoints.find((entry) => entry.id === id) : findActiveCheckpoint(checkpoints);
  if (!checkpoint) {
    console.log(id ? `Checkpoint not found: ${id}` : "No active checkpoint.");
    return;
  }

  console.log("");
  console.log(formatCheckpoint(checkpoint));
  console.log("");
}

async function cmdCheckpointComplete(config, id) {
  const checkpoints = await loadCheckpoints(config);
  const target = id ? checkpoints.find((entry) => entry.id === id) : findActiveCheckpoint(checkpoints);
  if (!target) {
    console.log(id ? `Checkpoint not found: ${id}` : "No active checkpoint.");
    return;
  }

  target.completed = true;
  target.completedAt = new Date().toISOString();
  await saveCheckpoints(config, checkpoints);
  console.log(`checkpoint marked complete: ${target.id}`);
}

async function collectCheckpointFields(rl) {
  console.log("\n=== Save checkpoint ===\n");
  const goal = await askLine(rl, "Goal (what is this task trying to do)");
  const status = await askLine(rl, "Current status");
  const completedSteps = await askMultiline(rl, "Completed steps");
  const pendingSteps = await askMultiline(rl, "Pending steps (continue here next time)");
  const contextNotes = await askMultiline(rl, "Context / decisions (optional)");
  const blockers = await askMultiline(rl, "Blockers (optional)");
  const keyFilesRaw = await askLine(rl, "Key files (comma separated, optional)");
  const keyFiles = keyFilesRaw ? keyFilesRaw.split(",").map((file) => file.trim()).filter(Boolean) : [];

  return { goal, status, completedSteps, pendingSteps, contextNotes, blockers, keyFiles };
}

async function askLine(rl, label, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askMultiline(rl, label) {
  console.log(`${label} (one per line, blank line to finish):`);
  const items = [];
  while (true) {
    const line = (await rl.question("  > ")).trim();
    if (!line) {
      break;
    }
    items.push(line);
  }
  return items;
}
