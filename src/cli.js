import path from "node:path";
import {
  loadAppState,
  loadConfig,
  saveAppState,
  saveConfigSelections
} from "./config.js";
import { createAgentSession, listProviderModels, runAgent } from "./agent.js";
import {
  buildProviderDiagnostics,
  buildProviderProblemMessage,
  getProviderUnavailableReason,
  inspectProviders,
  isProviderReady,
  pickAutoProvider,
  summarizeProvider
} from "./runtime.js";
import {
  closeSharedReadline,
  color,
  getSharedReadline,
  isInteractive,
  printNote,
  printSplash,
  renderStartupDashboard,
  renderDiagnostics,
  selectMenu,
  withSpinner
} from "./ui.js";
import { Workspace } from "./workspace.js";
import { loadSkills, matchSkillInvocation } from "./skills.js";
import {
  createCheckpoint,
  extractRecentPrompts,
  findActiveCheckpoint,
  formatCheckpoint,
  formatCheckpointSummaryLine,
  loadCheckpoints,
  saveCheckpoints
} from "./checkpoint.js";

export async function main(argv) {
  const parsed = parseArgs(argv);
  const cwd = process.cwd();
  let config = await loadConfig(cwd, parsed.options);
  const skills = await loadSkills(config.workspace);
  const startupContext = await loadStartupContext(config, parsed.command);

  if (["run", "chat", "models"].includes(parsed.command)) {
    printSplash({
      workspace: config.workspace,
      command: parsed.command,
      lastUsedProvider: startupContext.lastUsedProvider,
      lastUsedModel: startupContext.lastUsedModel,
      lastTaskSummary: startupContext.lastTaskSummary,
      recentFiles: startupContext.recentFiles
    });
    config = await prepareRuntimeConfig(config, {
      requireModelSelection: parsed.command !== "models",
      cliOptions: parsed.options,
      command: parsed.command,
      startupContext
    });
  }

  switch (parsed.command) {
    case "run":
      await runOnce(config, parsed.prompt, skills);
      return;
    case "chat":
      await runChat(config, skills);
      return;
    case "models":
      await printModels(config);
      return;
    case "init":
      await printInitExample(cwd);
      return;
    case "skills":
      printSkills(skills);
      return;
    case "checkpoint": {
      const [subcommand, ...rest] = parsed.positionals;
      await runCheckpointCommand(config, subcommand, rest);
      return;
    }
    case "help":
    default:
      printHelp();
  }
}

async function runOnce(config, prompt, skills) {
  if (!prompt) {
    throw new Error("Missing prompt. Usage: local-code run \"your task\"");
  }

  const invocation = matchSkillInvocation(prompt, skills);
  if (invocation.type === "unknown") {
    console.error(buildUnknownSkillMessage(invocation.token, skills));
    process.exitCode = 1;
    return;
  }

  const runPrompt = invocation.type === "skill" ? invocation.rest : prompt;
  const skillOptions = invocation.type === "skill" ? { skill: invocation.skill } : {};

  console.error(`provider=${config.provider} model=${config.model} workspace=${config.workspace}`);
  const result = await runAgent(config, runPrompt, buildProgressHooks(), skillOptions);
  await rememberTask(config, prompt);
  printResult(result);
}

function buildProgressHooks() {
  return {
    onStep(step) {
      console.error(`step ${step}: waiting for model...`);
    },
    onModelResponse({ step, durationMs, usage }) {
      const parts = [];
      parts.push(durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`);
      if (usage?.promptTokens != null) {
        parts.push(`prompt ${usage.promptTokens.toLocaleString()} tok`);
      }
      if (usage?.completionTokens != null) {
        parts.push(`gen ${usage.completionTokens.toLocaleString()} tok`);
      }
      console.error(`step ${step}: ${parts.join(" · ")}`);
    },
    onReasoning({ step, text }) {
      console.error(`step ${step} thinking: ${truncateForLog(text, 200)}`);
    },
    onToolCall(toolCall) {
      console.error(`step result: called tool "${toolCall.tool}" -> ${summarizeToolCall(toolCall)}`);
    },
    onToolCallError({ step, reason, message, attempt }) {
      const labels = {
        truncated: "reply cut off (length limit)",
        invalid_json: "invalid tool call JSON",
        empty_output: "empty reply",
        unfinished_intent: "model announced an action but didn't call a tool",
        provider_error: "provider/model request failed"
      };
      const label = labels[reason] ?? reason;
      console.error(`step ${step} result: ${label}, asking model to retry (attempt ${attempt})`);
      if (message) {
        console.error(`  ${message}`);
      }
    }
  };
}

function summarizeToolCall(toolCall) {
  const args = toolCall.args ?? {};
  switch (toolCall.tool) {
    case "read_file":
    case "read_external_file":
    case "make_directory":
      return args.path ?? "";
    case "write_file":
    case "append_file":
      return `${args.path ?? ""} (${String(args.content ?? "").length} chars)`;
    case "replace_in_file":
      return `${args.path ?? ""} (find: "${truncateForLog(args.findText ?? "", 40)}")`;
    case "search_text":
      return `"${args.query ?? ""}" in ${args.path ?? "."}`;
    case "list_files":
      return args.path ?? ".";
    case "run_command":
      return [args.command, ...(args.args ?? [])].join(" ");
    case "web_search":
      return `"${args.query ?? ""}"`;
    case "web_fetch":
      return args.url ?? "";
    default:
      return JSON.stringify(args);
  }
}

function truncateForLog(text, max) {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > max ? `${flattened.slice(0, max)}...` : flattened;
}

function printResult(result) {
  if (result.failed) {
    console.log(`⚠️ ${result.content}`);
    return;
  }

  console.log(result.content);
}

export function stripQuotes(rawPath) {
  return rawPath.replace(/^["']|["']$/g, "").trim();
}

export function formatAttachmentBlock(absolutePath, content) {
  return `<attached_file path="${absolutePath}">\n${content}\n</attached_file>`;
}

export function applyPendingAttachments(prompt, attachments) {
  if (!attachments || attachments.length === 0) {
    return prompt;
  }

  const blocks = attachments.map((attachment) => formatAttachmentBlock(attachment.path, attachment.content));
  return [...blocks, prompt].join("\n\n");
}

function printSkills(skills) {
  const uniqueSkills = [...new Set(skills.values())];
  if (uniqueSkills.length === 0) {
    console.log("No skills found. Add .md files under .local-code/skills/ (project) or ~/.local-code/skills/ (user).");
    return;
  }

  for (const skill of uniqueSkills) {
    const keywords = skill.keywords.length > 0 ? skill.keywords.join(", ") : "-";
    const tools = skill.tools ? skill.tools.join(", ") : "all";
    console.log(`/${skill.name}  [${skill.scope}]`);
    console.log(`  ${skill.description}`);
    console.log(`  keywords: ${keywords}`);
    console.log(`  tools: ${tools}`);
    console.log(`  source: ${skill.sourcePath}`);
    console.log("");
  }
}

function buildUnknownSkillMessage(token, skills) {
  const names = [...new Set(skills.values())].map((skill) => skill.name);
  const available = names.length > 0 ? names.join(", ") : "(none)";
  return `Unknown skill /${token}. Available skills: ${available}`;
}

async function runChat(config, skills) {
  const rl = getSharedReadline();
  let activeConfig = { ...config };
  let chatState = await loadChatState(activeConfig);
  let session = createChatSession(activeConfig, chatState.history);
  let pendingAttachments = [];

  console.log(`local-code chat (${activeConfig.provider}:${activeConfig.model || "no-model"})`);
  console.log("Type /exit to quit. Use /provider, /model, /status, /checkpoint, /attach, or /reset during chat.");
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

async function runChatCheckpointCommand(rl, config, session, subcommand, rest) {
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

async function runCheckpointCommand(config, subcommand, rest) {
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

async function printModels(config) {
  const models = await listProviderModels(config);
  for (const model of models) {
    console.log(model);
  }
}

async function printInitExample(cwd) {
  const example = {
    provider: "",
    model: "",
    workspace: ".",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    lmStudioBaseUrl: "http://127.0.0.1:1234",
    maxSteps: 12,
    allowCommands: false,
    allowWrites: false,
    allowNetwork: false,
    temperature: 0.2
  };

  console.log(`Create ${path.join(cwd, ".local-code.json")} with:`);
  console.log(JSON.stringify(example, null, 2));
  console.log("");
  console.log("If provider or model is empty, the CLI will ask the user to choose at startup.");
  console.log("Wizard selections are saved back to .local-code.json unless you override them with CLI flags.");
}

function parseArgs(argv) {
  const command = argv[0] || "help";
  const options = {};
  const positionals = [];

  for (let index = 1; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      positionals.push(current);
      continue;
    }

    const name = current.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      options[camelCase(name)] = true;
      continue;
    }

    options[camelCase(name)] = next;
    index += 1;
  }

  return {
    command,
    prompt: positionals.join(" "),
    positionals,
    options
  };
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`local-code

Usage:
  local-code init
  local-code models --provider ollama
  local-code run "read the repo and fix the bug"
  local-code run "/reviewer look for bugs in src/agent.js"
  local-code chat
  local-code skills
  local-code checkpoint save
  local-code checkpoint list
  local-code checkpoint show [id]
  local-code checkpoint complete [id]

Options:
  --provider ollama|lmstudio
  --model MODEL_NAME
  --workspace PATH
  --allow-commands
  --allow-writes
  --allow-network
  --max-steps 12
  --max-concurrent-agents 3
  --temperature 0.2
  --ollama-base-url http://127.0.0.1:11434
  --lm-studio-base-url http://127.0.0.1:1234

Startup behavior:
  If provider or model is missing, the CLI will detect local Ollama / LM Studio
  and ask the user to choose an available option.
  If a provider is offline, the wizard offers Retry detection.
  Provider and model chosen in the wizard are saved to .local-code.json.
  Chat sessions are restored automatically when provider, model, and workspace match.

Skills:
  Put .md files under .local-code/skills/ (project) or ~/.local-code/skills/
  (user). Trigger one with a leading /name, e.g. /reviewer or /rv, in both
  "run" and "chat". Run "local-code skills" to list what's available.

Chat commands:
  /provider            Switch provider and model without restarting chat
  /model               Switch model for the current provider
  /status              Show current provider, model, workspace, and saved chat info
  /reset               Clear saved chat history and start fresh (same provider/model/workspace)
  /checkpoint          Save a checkpoint (goal/status/pending steps), auto-attaches recent prompts
  /checkpoint list     List saved checkpoints
  /checkpoint show     Show the active checkpoint (or a specific one by id)
  /checkpoint complete Mark the active checkpoint (or a specific one by id) as done
  /attach <path>       Read a file from anywhere on disk (outside the project) and
                        include it with your next message. Prints the resolved
                        absolute path so you can confirm which file was read.
  /skills              List available skills
  /name                Invoke a skill by name or keyword (e.g. /reviewer ...)
  /exit                Quit chat

Reading files outside the project:
  /attach <path> works in "chat" mode and queues a file to be sent with your
  next message. The agent can also call the read_external_file tool directly
  if you just mention an absolute path in your prompt - either way, the
  resolved absolute path is always shown so you know exactly what was read.
  Files are read-only and capped at 2MB.

Restored chat history persists across restarts. If the model keeps repeating
something that is no longer true (e.g. it saw a tool fail before you upgraded
local-code, or before you enabled --allow-commands), use /reset instead of
trying to convince it in the same conversation.

Checkpoints track task progress across restarts, separate from chat history.
An unfinished checkpoint is shown automatically when "chat" starts. Saving one
(via /checkpoint or "local-code checkpoint save") auto-attaches the most
recent real user prompts from the conversation, so you don't have to retype
what you were doing.
`);
}

async function prepareRuntimeConfig(config, options) {
  let nextConfig = { ...config };
  const selectedValues = {};
  const lastUsed = {
    provider: options.startupContext.lastUsedProvider || config.provider,
    model: options.startupContext.lastUsedModel || config.model
  };

  while (true) {
    const providerStatuses = await scanProviderStatuses(config);

    if (!nextConfig.provider) {
      const providerSelection = await resolveProvider(providerStatuses, {
        workspace: config.workspace,
        command: options.command,
        lastUsed,
        startupContext: options.startupContext
      });

      if (providerSelection === "__retry__") {
        continue;
      }

      nextConfig.provider = providerSelection;
      nextConfig.model = "";
      selectedValues.provider = nextConfig.provider;
    }

    const selectedStatus = providerStatuses[nextConfig.provider];
    if (!selectedStatus) {
      throw new Error(`Unsupported provider: ${nextConfig.provider}`);
    }

    if (!isProviderReady(selectedStatus)) {
      const recoveryAction = await resolveProviderRecovery(selectedStatus, providerStatuses, {
        cliOptions: options.cliOptions,
        workspace: config.workspace,
        command: options.command,
        lastUsed,
        startupContext: options.startupContext
      });

      if (recoveryAction === "__retry__") {
        continue;
      }

      if (recoveryAction === "__switch__") {
        nextConfig.provider = "";
        nextConfig.model = "";
        continue;
      }

      throw new Error(buildProviderProblemMessage(selectedStatus));
    }

    if (options.requireModelSelection) {
      if (!nextConfig.model || !selectedStatus.models.includes(nextConfig.model)) {
        if (nextConfig.model && !selectedStatus.models.includes(nextConfig.model) && !isInteractive()) {
          throw new Error(
            [
              `Model not found for ${selectedStatus.label}: ${nextConfig.model}`,
              `Available models: ${selectedStatus.models.join(", ")}`
            ].join("\n")
          );
        }

        nextConfig.model = await resolveModel(nextConfig.model, selectedStatus.models, {
          workspace: config.workspace,
          command: options.command,
          provider: nextConfig.provider,
          lastUsed,
          startupContext: options.startupContext
        });
        selectedValues.model = nextConfig.model;
      }
    }

    await persistSelectionsIfNeeded(config, options.cliOptions, selectedValues);
    return nextConfig;
  }
}

async function resolveProvider(providerStatuses, context) {
  if (!isInteractive()) {
    const autoProvider = pickAutoProvider(providerStatuses);
    if (autoProvider) {
      return autoProvider;
    }

    throw new Error(buildProviderSelectionMessage(providerStatuses));
  }

  const optionList = [providerStatuses.ollama, providerStatuses.lmstudio];
  const readyCount = optionList.filter(isProviderReady).length;
  const options = optionList.map((status) => ({
    value: status.provider,
    label: `${status.label}  ${color(`(${summarizeProvider(status)})`, isProviderReady(status) ? "green" : "yellow")}`,
    description: `API ${status.baseUrl}`,
    hint: isProviderReady(status)
      ? `Models: ${status.models.slice(0, 4).join(", ")}`
      : getProviderUnavailableReason(status),
    disabled: !isProviderReady(status)
  }));

  if (readyCount === 0) {
    options.push({
      value: "__retry__",
      label: "Retry detection",
      description: "Scan Ollama and LM Studio again.",
      hint: "Use this after starting the local server or loading a model.",
      disabled: false,
      badgeLabel: "action",
      badgeTone: "cyan"
    });
  }

  return selectMenu({
    title: "Local Model Provider",
    subtitle: "Use arrow keys to choose a ready provider. Unavailable entries show the missing requirement.",
    headerLines: buildStartupHeaderLines(context, providerStatuses),
    footer: "Enter = confirm, Ctrl+C = cancel",
    options
  });
}

async function resolveModel(currentModel, models, context) {
  if (currentModel) {
    return currentModel;
  }

  if (models.length === 1) {
    return models[0];
  }

  if (!isInteractive()) {
    throw new Error(
      [
        "No model configured.",
        `Available models: ${models.join(", ")}`,
        "Set --model or LOCAL_CODE_MODEL."
      ].join("\n")
    );
  }

  return selectMenu({
    title: "Local Model",
    subtitle: "Choose the model this session should use.",
    headerLines: buildModelHeaderLines(context, models),
    footer: "Enter = confirm, Ctrl+C = cancel",
    options: models.map((model) => ({
      value: model,
      label: model,
      description: "",
      hint: "",
      disabled: false
    }))
  });
}

async function resolveProviderRecovery(selectedStatus, providerStatuses, context) {
  if (!isInteractive()) {
    return "__exit__";
  }

  const hasAlternativeProvider = Object.values(providerStatuses).some(
    (status) => status.provider !== selectedStatus.provider
  );
  const options = [
    {
      value: "__retry__",
      label: "Retry detection",
      description: `Scan ${selectedStatus.label} again.`,
      hint: "Use this after starting the local API server or loading a model.",
      disabled: false,
      badgeLabel: "action",
      badgeTone: "cyan"
    }
  ];

  if (!context.cliOptions.provider && hasAlternativeProvider) {
    options.push({
      value: "__switch__",
      label: "Choose another provider",
      description: "Go back to the provider list.",
      hint: "Use this if the other provider becomes ready first.",
      disabled: false,
      badgeLabel: "action",
      badgeTone: "yellow"
    });
  }

  options.push({
    value: "__exit__",
    label: "Exit",
    description: "Stop startup and keep the current diagnosis.",
    hint: "",
    disabled: false,
    badgeLabel: "action",
    badgeTone: "red"
  });

  return selectMenu({
    title: `${selectedStatus.label} Needs Attention`,
    subtitle: buildProviderProblemMessage(selectedStatus),
    headerLines: buildStartupHeaderLines(context, providerStatuses),
    footer: "Enter = confirm, Ctrl+C = cancel",
    options
  });
}

function buildProviderSelectionMessage(providerStatuses) {
  return renderDiagnostics(
    "Local provider check failed",
    buildProviderDiagnostics(providerStatuses)
  );
}

async function scanProviderStatuses(config) {
  return withSpinner("Scanning local providers and models...", () => inspectProviders(config));
}

async function persistSelectionsIfNeeded(config, cliOptions, selectedValues) {
  const providerSelected = typeof selectedValues.provider === "string";
  const modelSelected = typeof selectedValues.model === "string";
  if (!providerSelected && !modelSelected) {
    return;
  }

  if (cliOptions.provider || cliOptions.model) {
    return;
  }

  await saveConfigSelections(config.configPath, selectedValues);
  if (isInteractive()) {
    const pieces = [];
    if (providerSelected) {
      pieces.push(`provider=${selectedValues.provider}`);
    }
    if (modelSelected) {
      pieces.push(`model=${selectedValues.model}`);
    }
    printNote(`Saved selection to .local-code.json: ${pieces.join(" ")}`);
  }
}

function buildStartupHeaderLines(context, providerStatuses) {
  const readyProviders = Object.values(providerStatuses)
    .filter(isProviderReady)
    .map((status) => status.label);

  return renderStartupDashboard({
    workspace: context.workspace,
    command: context.command,
    lastUsedProvider: context.lastUsed.provider,
    lastUsedModel: context.lastUsed.model,
    lastTaskSummary: context.startupContext.lastTaskSummary,
    readyCount: readyProviders.length,
    totalProviders: Object.keys(providerStatuses).length,
    readyProviders,
    recentFiles: context.startupContext.recentFiles
  }).split("\n");
}

function buildModelHeaderLines(context, models) {
  return renderStartupDashboard({
    workspace: context.workspace,
    command: context.command,
    lastUsedProvider: context.lastUsed.provider || context.provider,
    lastUsedModel: context.lastUsed.model,
    lastTaskSummary: context.startupContext.lastTaskSummary,
    readyCount: 1,
    totalProviders: 1,
    readyProviders: [context.provider],
    recentFiles: context.startupContext.recentFiles
  })
    .split("\n")
    .concat([
      "",
      `Available models: ${models.length}`
    ]);
}

function createChatSession(config, history = []) {
  return createAgentSession(config, buildProgressHooks(), {
    history
  });
}

async function loadStartupContext(config, command, overrides = {}) {
  const [state, recentFiles] = await Promise.all([
    loadAppState(config.statePath),
    new Workspace(config.workspace).listRecentFiles(4)
  ]);

  return {
    command,
    lastUsedProvider: overrides.lastUsedProvider ?? config.provider,
    lastUsedModel: overrides.lastUsedModel ?? config.model,
    lastTaskSummary: state.lastTaskSummary ?? "",
    recentFiles: recentFiles.map((item) => item.path)
  };
}

async function rememberTask(config, prompt) {
  await saveAppState(config.statePath, {
    lastTaskSummary: summarizeTask(prompt),
    lastTaskAt: new Date().toISOString()
  });
}

function summarizeTask(prompt) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) {
    return compact;
  }

  return `${compact.slice(0, 77)}...`;
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
