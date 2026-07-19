import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  gray: "\u001b[90m"
};

export async function selectMenu({ title, subtitle = "", headerLines = [], options, footer = "" }) {
  if (!isInteractive()) {
    throw new Error("Interactive menu requires a TTY.");
  }

  const enabledIndexes = options
    .map((option, index) => ({ option, index }))
    .filter((entry) => !entry.option.disabled)
    .map((entry) => entry.index);

  if (enabledIndexes.length === 0) {
    throw new Error("Interactive menu has no selectable options.");
  }

  let selectedIndex = enabledIndexes[0];

  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(input);
    const previousRawMode = typeof input.setRawMode === "function" ? input.isRaw : false;
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
    }

    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      if (typeof input.setRawMode === "function") {
        input.setRawMode(previousRawMode);
      }
      output.write("\n");
    };

    const render = () => {
      console.clear();
      const lines = [];
      lines.push(style(title, "bold"));
      if (subtitle) {
        lines.push(style(subtitle, "dim"));
      }
      if (headerLines.length > 0) {
        lines.push("");
        lines.push(...headerLines);
      }
      lines.push("");

      for (let index = 0; index < options.length; index += 1) {
        const option = options[index];
        const focused = index === selectedIndex;
        const pointer = focused ? color("> ", "cyan") : "  ";
        const label = focused ? style(option.label, "bold") : option.label;
        const status = color(
          option.badgeLabel ?? (option.disabled ? "unavailable" : "ready"),
          option.badgeTone ?? (option.disabled ? "red" : "green")
        );
        lines.push(`${pointer}${label} ${style(`[${status}]`, "dim")}`);

        if (option.description) {
          lines.push(`  ${style(option.description, option.disabled ? "gray" : "dim")}`);
        }

        if (option.hint) {
          lines.push(`  ${style(option.hint, option.disabled ? "yellow" : "gray")}`);
        }

        lines.push("");
      }

      if (footer) {
        lines.push(style(footer, "dim"));
      }

      output.write(lines.join("\n"));
    };

    const onKeypress = (_, key) => {
      if (!key) {
        return;
      }

      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Cancelled by user."));
        return;
      }

      if (key.name === "up") {
        selectedIndex = moveSelection(options, enabledIndexes, selectedIndex, -1);
        render();
        return;
      }

      if (key.name === "down") {
        selectedIndex = moveSelection(options, enabledIndexes, selectedIndex, 1);
        render();
        return;
      }

      if (key.name === "return") {
        const option = options[selectedIndex];
        cleanup();
        resolve(option.value);
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

export function printSplash({ workspace, command }) {
  if (!isInteractive()) {
    return;
  }

  console.log(renderStartupDashboard({ workspace, command }));
}

export async function withSpinner(message, task) {
  if (!isInteractive()) {
    return task();
  }

  const frames = ["|", "/", "-", "\\"];
  let frameIndex = 0;
  const render = () => {
    output.write(`\r${color(frames[frameIndex], "cyan")} ${message}`);
    frameIndex = (frameIndex + 1) % frames.length;
  };

  render();
  const timer = setInterval(render, 90);

  try {
    const result = await task();
    clearInterval(timer);
    output.write(`\r${color("OK", "green")} ${message}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    output.write(`\r${color("ERR", "red")} ${message}\n`);
    throw error;
  }
}

export async function confirmCommand({ command, args = [], cwd }) {
  if (!isInteractive()) {
    return false;
  }

  const commandLine = [command, ...args].join(" ");
  output.write(`\n${style("Model wants to run:", "yellow")} ${commandLine}\n`);
  output.write(`${style("Working directory:", "dim")} ${cwd}\n`);

  const rl = readlinePromises.createInterface({ input, output });
  try {
    const answer = (await rl.question("Allow this command? [y/N]: ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

const WRITE_ACTION_LABELS = {
  write: "create/overwrite file",
  append: "append to file",
  replace: "replace text in file",
  mkdir: "create directory"
};

export async function confirmWrite({ action, path: targetPath, preview = "", cwd }) {
  if (!isInteractive()) {
    return false;
  }

  const label = WRITE_ACTION_LABELS[action] ?? action;
  output.write(`\n${style("Model wants to " + label + ":", "yellow")} ${targetPath}\n`);
  if (cwd) {
    output.write(`${style("Working directory:", "dim")} ${cwd}\n`);
  }

  if (preview) {
    const snippet = preview.length > 400 ? `${preview.slice(0, 400)}...` : preview;
    output.write(`${style("Preview:", "dim")}\n${snippet}\n`);
  }

  const rl = readlinePromises.createInterface({ input, output });
  try {
    const answer = (await rl.question("Allow this change? [y/N]: ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export function printNote(message) {
  console.log(style(message, "dim"));
}

export function renderStartupDashboard({
  workspace,
  command,
  lastUsedProvider = "",
  lastUsedModel = "",
  lastTaskSummary = "",
  readyCount,
  totalProviders,
  readyProviders = [],
  recentFiles = []
}) {
  const lines = [
    style("local-code-agent", "bold"),
    style("Local coding CLI for Ollama and LM Studio", "dim"),
    style("--------------------------------------------------", "gray"),
    `${style("Workspace", "cyan")} : ${workspace}`,
    `${style("Command", "cyan")}   : ${command}`
  ];

  if (lastUsedProvider || lastUsedModel) {
    lines.push(`${style("Last used", "cyan")} : ${formatLastUsed(lastUsedProvider, lastUsedModel)}`);
  } else {
    lines.push(`${style("Last used", "cyan")} : none saved yet`);
  }

  if (lastTaskSummary) {
    lines.push(`${style("Last task", "cyan")} : ${lastTaskSummary}`);
  }

  if (typeof readyCount === "number" && typeof totalProviders === "number") {
    lines.push(`${style("Ready now", "cyan")}  : ${readyCount}/${totalProviders}`);
  }

  if (readyProviders.length > 0) {
    lines.push(`${style("Online", "cyan")}    : ${readyProviders.join(", ")}`);
  }

  if (recentFiles.length > 0) {
    lines.push(`${style("Recent files", "cyan")} : ${recentFiles.join(", ")}`);
  }

  lines.push("");
  return lines.join("\n");
}

export function renderDiagnostics(title, sections) {
  const lines = [style(title, "bold"), ""];

  for (const section of sections) {
    lines.push(section.heading);
    for (const line of section.lines) {
      lines.push(line);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function color(text, tone) {
  if (!supportsAnsi()) {
    return text;
  }

  const code = ANSI[tone];
  if (!code) {
    return text;
  }

  return `${code}${text}${ANSI.reset}`;
}

export function style(text, tone) {
  return color(text, tone);
}

export function supportsAnsi() {
  return Boolean(output.isTTY && process.env.TERM !== "dumb");
}

export function isInteractive() {
  return Boolean(input.isTTY && output.isTTY);
}

function moveSelection(options, enabledIndexes, currentIndex, direction) {
  const currentPosition = enabledIndexes.indexOf(currentIndex);
  const nextPosition = (currentPosition + direction + enabledIndexes.length) % enabledIndexes.length;
  const nextIndex = enabledIndexes[nextPosition];

  if (options[nextIndex]?.disabled) {
    return currentIndex;
  }

  return nextIndex;
}

function formatLastUsed(provider, model) {
  const savedProvider = provider || "unknown provider";
  const savedModel = model || "no model saved";
  return `${savedProvider} / ${savedModel}`;
}
