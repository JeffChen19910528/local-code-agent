export function buildProgressHooks() {
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
