import { loadConfig } from "./config.js";
import { runAgent, listProviderModels } from "./agent.js";
import { printSplash } from "./ui.js";
import { loadSkills, matchSkillInvocation } from "./skills.js";
import { parseArgs } from "./cli/args.js";
import { buildProgressHooks } from "./cli/progress.js";
import { applyPendingAttachments, formatAttachmentBlock, stripQuotes } from "./cli/attachments.js";
import { loadStartupContext, rememberTask } from "./cli/startup.js";
import { prepareRuntimeConfig } from "./cli/providerWizard.js";
import { runChat } from "./cli/chat.js";
import { runCheckpointCommand } from "./cli/checkpoints.js";
import { printHelp, printInitExample } from "./cli/help.js";

export { applyPendingAttachments, formatAttachmentBlock, stripQuotes };

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
      await runChat(config, skills, { printResult, printSkills, buildUnknownSkillMessage });
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

function printResult(result) {
  if (result.failed) {
    console.log(`⚠️ ${result.content}`);
    return;
  }

  console.log(result.content);
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

async function printModels(config) {
  const models = await listProviderModels(config);
  for (const model of models) {
    console.log(model);
  }
}
