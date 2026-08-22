import { loadAppState, saveAppState } from "../config.js";
import { createAgentSession } from "../agent.js";
import { diagnoseProvider, buildRepairGuidance } from "../runtime.js";
import { closeSharedReadline, getSharedReadline, withSpinner } from "../ui.js";
import { Workspace } from "../workspace.js";
import { matchSkillInvocation } from "../skills.js";
import { findActiveCheckpoint, formatCheckpoint, loadCheckpoints } from "../checkpoint.js";
import { applyPendingAttachments, stripQuotes } from "./attachments.js";
import { buildProgressHooks } from "./progress.js";
import { runChatCheckpointCommand } from "./checkpoints.js";
import { loadStartupContext, rememberTask } from "./startup.js";
import { prepareRuntimeConfig } from "./providerWizard.js";

export async function runChat(config, skills, { printResult, printSkills, buildUnknownSkillMessage }) {
  const rl = getSharedReadline();
  let activeConfig = { ...config };
  let chatState = await loadChatState(activeConfig);
  let session = createChatSession(activeConfig, chatState.history);
  let pendingAttachments = [];

  console.log(`local-code chat (${activeConfig.provider}:${activeConfig.model || "no-model"})`);
  console.log("Type /exit to quit. Use /provider, /model, /status, /repair, /checkpoint, /attach, or /reset during chat.");
  if (chatState.history.length > 0) {
    console.log(`restored saved chat history (${countUserTurns(chatState.history)} turn(s))`);
    console.log("If the model keeps repeating an outdated claim (e.g. from before a tool was fixed), try /reset to start fresh.");
  }

  const activeCheckpoint = findActiveCheckpoint(await loadCheckpoints(activeConfig));
  if (activeCheckpoint) {
    console.log("\nUnfinished checkpoint detected:");
    console.log(formatCheckpoint(activeCheckpoint));
    console.log("Continue from the pending steps above, or run /checkpoint complete once done.\n");
  }

  try {
    while (true) {
      const prompt = (await rl.question("> ")).trim();
      if (!prompt) {
        continue;
      }
      if (prompt === "/exit") {
        break;
      }

      if (prompt === "/status") {
        console.log(renderChatStatus(activeConfig, chatState));
        continue;
      }

      if (prompt === "/repair" || prompt === "/doctor") {
        await runRepairCommand(activeConfig);
        continue;
      }

      if (prompt === "/skills") {
        printSkills(skills);
        continue;
      }

      if (prompt === "/attach" || prompt.startsWith("/attach ")) {
        const rawPath = stripQuotes(prompt.slice("/attach".length).trim());
        if (!rawPath) {
          console.log("Usage: /attach <path>   (absolute path, or a path relative to the folder local-code was started in)");
          continue;
        }

        try {
          const attachWorkspace = new Workspace(activeConfig.workspace);
          const { path: resolvedPath, content } = await attachWorkspace.readExternalFile(rawPath);
          pendingAttachments.push({ path: resolvedPath, content });
          console.log(`attached: ${resolvedPath} (${content.length} chars) - will be sent with your next message`);
        } catch (error) {
          console.log(error instanceof Error ? error.message : String(error));
        }
        continue;
      }

      if (prompt === "/checkpoint" || prompt.startsWith("/checkpoint ")) {
        const [, subcommand, ...rest] = prompt.split(/\s+/);
        await runChatCheckpointCommand(rl, activeConfig, session, subcommand, rest);
        continue;
      }

      if (prompt === "/reset") {
        chatState = createEmptyChatState(activeConfig);
        await saveChatState(activeConfig, chatState);
        session = createChatSession(activeConfig, chatState.history);
        console.log("chat history cleared. Starting a fresh conversation (same provider/model/workspace).");
        continue;
      }

      if (prompt === "/provider") {
        activeConfig = await prepareRuntimeConfig(
          {
            ...activeConfig,
            provider: "",
            model: ""
          },
          {
            requireModelSelection: true,
            cliOptions: {},
            command: "chat",
            startupContext: await loadStartupContext(activeConfig, "chat", {
              lastUsedProvider: activeConfig.provider,
              lastUsedModel: activeConfig.model
            })
          }
        );
        chatState = createEmptyChatState(activeConfig);
        await saveChatState(activeConfig, chatState);
        session = createChatSession(activeConfig, chatState.history);
        console.log(`switched to ${activeConfig.provider}:${activeConfig.model}`);
        continue;
      }

      if (prompt === "/model") {
        activeConfig = await prepareRuntimeConfig(
          {
            ...activeConfig,
            model: ""
          },
          {
            requireModelSelection: true,
            cliOptions: {},
            command: "chat",
            startupContext: await loadStartupContext(activeConfig, "chat", {
              lastUsedProvider: activeConfig.provider,
              lastUsedModel: activeConfig.model
            })
          }
        );
        chatState = createEmptyChatState(activeConfig);
        await saveChatState(activeConfig, chatState);
        session = createChatSession(activeConfig, chatState.history);
        console.log(`switched to ${activeConfig.provider}:${activeConfig.model}`);
        continue;
      }

      const invocation = matchSkillInvocation(prompt, skills);
      if (invocation.type === "unknown") {
        console.log(buildUnknownSkillMessage(invocation.token, skills));
        continue;
      }

      const chatPrompt = invocation.type === "skill" ? invocation.rest : prompt;
      const chatSkillOptions = invocation.type === "skill" ? { skill: invocation.skill } : {};
      const outgoingChatPrompt = applyPendingAttachments(chatPrompt, pendingAttachments);
      pendingAttachments = [];

      let result;
      try {
        result = await session.ask(outgoingChatPrompt, chatSkillOptions);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        continue;
      }

      await rememberTask(activeConfig, prompt);
      chatState = {
        ...chatState,
        provider: activeConfig.provider,
        model: activeConfig.model,
        workspace: activeConfig.workspace,
        history: session.getHistory(),
        updatedAt: new Date().toISOString()
      };
      await saveChatState(activeConfig, chatState);
      printResult(result);
    }
  } finally {
    closeSharedReadline();
  }
}

async function runRepairCommand(config) {
  console.log(`正在檢查目前的 provider（${config.provider}）...`);
  try {
    const status = await withSpinner("Diagnosing provider...", () => diagnoseProvider(config, config.provider));
    console.log(buildRepairGuidance(status, { model: config.model }));
  } catch (error) {
    console.log(`診斷時發生錯誤：${error instanceof Error ? error.message : String(error)}`);
  }
}

function createChatSession(config, history = []) {
  return createAgentSession(config, buildProgressHooks(), {
    history
  });
}

async function loadChatState(config) {
  const state = await loadAppState(config.statePath);
  const saved = state.chatSession;
  if (
    saved &&
    saved.provider === config.provider &&
    saved.model === config.model &&
    saved.workspace === config.workspace &&
    Array.isArray(saved.history)
  ) {
    return saved;
  }

  return createEmptyChatState(config);
}

async function saveChatState(config, chatState) {
  await saveAppState(config.statePath, {
    chatSession: chatState
  });
}

function createEmptyChatState(config) {
  return {
    provider: config.provider,
    model: config.model,
    workspace: config.workspace,
    history: [],
    updatedAt: ""
  };
}

function renderChatStatus(config, chatState) {
  const userTurns = countUserTurns(chatState.history);

  return [
    `provider=${config.provider}`,
    `model=${config.model}`,
    `workspace=${config.workspace}`,
    `saved_turns=${userTurns}`,
    `history_messages=${chatState.history.length}`,
    `history_updated_at=${chatState.updatedAt || "none"}`
  ].join("\n");
}

function countUserTurns(history) {
  return history.filter(
    (message) => message.role === "user" && !message.content.startsWith("<tool_result ")
  ).length;
}
