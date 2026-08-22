import { saveConfigSelections } from "../config.js";
import {
  buildProviderDiagnostics,
  buildProviderProblemMessage,
  getProviderUnavailableReason,
  inspectProviders,
  isProviderReady,
  pickAutoProvider,
  summarizeProvider
} from "../runtime.js";
import {
  color,
  isInteractive,
  printNote,
  renderStartupDashboard,
  renderDiagnostics,
  selectMenu,
  withSpinner
} from "../ui.js";

export async function prepareRuntimeConfig(config, options) {
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
