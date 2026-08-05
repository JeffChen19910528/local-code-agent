import { createOllamaProvider } from "./providers/ollama.js";
import { createLmStudioProvider } from "./providers/lmstudio.js";
import { createToolset } from "./tools.js";
import { Workspace } from "./workspace.js";
import { buildSkillPrompt } from "./skills.js";

export async function runAgent(config, prompt, hooks = {}, options = {}) {
  const session = createAgentSession(config, hooks);
  return session.ask(prompt, options);
}

export function createAgentSession(config, hooks = {}, options = {}) {
  const workspace = new Workspace(config.workspace, {
    allowCommands: config.allowCommands,
    allowWrites: config.allowWrites,
    allowNetwork: config.allowNetwork
  });
  const toolset = createToolset(workspace, config);
  const provider = createProvider(config);
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(config, toolset.getManifest())
    },
    ...sanitizeHistory(options.history)
  ];

  return {
    async ask(prompt, options = {}) {
      const skill = options.skill ?? null;
      const outgoingPrompt = skill ? buildSkillPrompt(skill, prompt) : prompt;
      const allowedTools = skill?.tools ?? null;

      messages.push({
        role: "user",
        content: outgoingPrompt
      });

      let lastFailureSignature = null;
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 3;

      for (let step = 1; step <= config.maxSteps; step += 1) {
        hooks.onStep?.(step);
        const stepStartMs = Date.now();
        const reply = await provider.chat(messages);
        const durationMs = Date.now() - stepStartMs;
        const content = String(reply.content ?? "").trim();
        messages.push({ role: "assistant", content });
        hooks.onModelResponse?.({ step, durationMs, usage: reply.usage ?? null });

        let toolCall;
        let failureReason = null;
        let failureMessage = null;
        try {
          toolCall = extractToolCall(content);
        } catch (error) {
          failureReason = "invalid_json";
          failureMessage = error instanceof Error ? error.message : String(error);
        }

        if (!failureReason && !toolCall && isTruncatedToolCall(content)) {
          failureReason = "truncated";
          failureMessage = "Reply was cut off before the closing </tool_call> tag, likely a length limit.";
        }

        if (failureReason) {
          consecutiveFailures = failureReason === lastFailureSignature ? consecutiveFailures + 1 : 1;
          lastFailureSignature = failureReason;
          hooks.onToolCallError?.({ step, reason: failureReason, message: failureMessage, attempt: consecutiveFailures });

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            return {
              content: [
                `此任務自動終止：模型連續 ${consecutiveFailures} 次嘗試呼叫工具都遇到同樣的問題（${failureReason === "truncated" ? "回覆內容被長度限制截斷" : "JSON 格式錯誤"}）。`,
                "建議：把要求拆成更小的步驟（例如先建立空檔案，再用 replace_in_file 分段補內容），或改用其他模型再試一次。"
              ].join("\n"),
              steps: step,
              failed: true
            };
          }

          messages.push({
            role: "user",
            content: failureReason === "invalid_json"
              ? [
                `<tool_call_error>${failureMessage}</tool_call_error>`,
                "Your <tool_call> block was not valid JSON. Escape newlines (\\n), quotes (\\\"), and backslashes inside string values, or split large file writes into smaller pieces. Respond with exactly one corrected <tool_call> block."
              ].join("\n")
              : [
                "<tool_call_error>Your <tool_call> block was cut off before the closing </tool_call> tag, likely because the reply hit a length limit.</tool_call_error>",
                "Keep tool call content shorter, or split large file writes into multiple smaller write_file calls. Respond again with exactly one complete <tool_call> block."
              ].join("\n")
          });
          continue;
        }

        if (!toolCall && !content) {
          consecutiveFailures = lastFailureSignature === "empty_output" ? consecutiveFailures + 1 : 1;
          lastFailureSignature = "empty_output";
          hooks.onToolCallError?.({ step, reason: "empty_output", message: "Model returned an empty reply.", attempt: consecutiveFailures });

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            return {
              content: "此任務沒有拿到最終回覆內容（模型輸出為空），可能是模型中途放棄。建議縮小任務範圍再試一次，或改用其他模型。",
              steps: step,
              failed: true
            };
          }

          messages.push({
            role: "user",
            content: "你的回覆是空的。就算使用者的輸入有錯字、簡短或不完整，也請依照最合理的猜測直接執行或回答，不要保持沉默；如果需要用到工具，回傳一個 <tool_call> 區塊，否則至少用一句話回答。"
          });
          continue;
        }

        if (!toolCall) {
          return {
            content,
            steps: step,
            failed: false
          };
        }

        const reasoningText = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/i, "").trim();
        if (reasoningText) {
          hooks.onReasoning?.({ step, text: reasoningText });
        }

        hooks.onToolCall?.(toolCall);

        let resultText;
        try {
          const result = await toolset.execute(toolCall.tool, toolCall.args, allowedTools);
          resultText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        } catch (error) {
          resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }

        messages.push({
          role: "user",
          content: `<tool_result name="${toolCall.tool}">\n${resultText}\n</tool_result>`
        });
      }

      throw new Error(`Max steps reached (${config.maxSteps}).`);
    },
    getHistory() {
      return messages.slice(1).map((message) => ({
        role: message.role,
        content: message.content
      }));
    }
  };
}

export async function listProviderModels(config) {
  return createProvider(config).listModels();
}

export function extractToolCall(content) {
  const match = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!match) {
    return null;
  }

  const raw = match[1];
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (firstError) {
    try {
      payload = JSON.parse(repairControlCharacters(raw));
    } catch {
      const repairedRaw = tryExtractLargeContent(raw);
      if (repairedRaw !== null) {
        try {
          payload = JSON.parse(repairedRaw);
        } catch {
          throw new Error(`Invalid tool call JSON: ${firstError.message}`);
        }
      } else {
        throw new Error(`Invalid tool call JSON: ${firstError.message}`);
      }
    }
  }

  if (!payload || typeof payload.tool !== "string") {
    throw new Error("Tool call must include a string 'tool' field.");
  }

  return {
    tool: payload.tool,
    args: payload.args ?? {}
  };
}

// Some local models emit literal control characters (raw newlines/tabs) inside
// JSON string values instead of escaping them, which JSON.parse rejects. Auto-fix
// that common case before giving up and asking the model to retry.
function repairControlCharacters(raw) {
  return raw.replace(/[\x00-\x1f]/g, (char) => {
    switch (char) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return "";
    }
  });
}

// Walk a raw JSON string value (the text between the outer quotes, not yet parsed),
// undoing any JSON escape sequences the model may have partially emitted so that
// JSON.stringify can re-encode everything cleanly from scratch.
function unescapeJsonStringValue(raw) {
  let result = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      switch (next) {
        case '"': result += '"'; i += 2; break;
        case "\\": result += "\\"; i += 2; break;
        case "n": result += "\n"; i += 2; break;
        case "r": result += "\r"; i += 2; break;
        case "t": result += "\t"; i += 2; break;
        case "u": {
          const hex = raw.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            result += "\\";
            i++;
          }
          break;
        }
        default:
          result += "\\" + next;
          i += 2;
          break;
      }
    } else {
      result += raw[i];
      i++;
    }
  }
  return result;
}

// Some local models emit unescaped double quotes inside write_file/append_file content,
// producing JSON that neither JSON.parse nor repairControlCharacters can salvage.
// Heuristic: locate the content value by anchoring on the structural "}} closing at the
// end, undo any partial escaping the model already emitted, then re-encode via JSON.stringify.
function tryExtractLargeContent(raw) {
  const toolMatch = raw.match(/"tool"\s*:\s*"(write_file|append_file)"/);
  if (!toolMatch) return null;
  const tool = toolMatch[1];

  const pathMatch = raw.match(/"path"\s*:\s*"([^"\\]*)"/);
  if (!pathMatch) return null;
  const filePath = pathMatch[1];

  const contentKeyIdx = raw.indexOf('"content"');
  if (contentKeyIdx === -1) return null;
  const colonIdx = raw.indexOf(":", contentKeyIdx + 9);
  if (colonIdx === -1) return null;
  const openQuoteIdx = raw.indexOf('"', colonIdx + 1);
  if (openQuoteIdx === -1) return null;
  const contentStart = openQuoteIdx + 1;

  // The JSON ends with " (closing content string) followed by two closing braces.
  // Match the last such pattern so inner occurrences of "}} in code don't confuse us.
  const closingMatch = raw.match(/"(?:\s*\}){2}\s*$/);
  if (!closingMatch) return null;
  const contentEnd = closingMatch.index;

  if (contentEnd <= contentStart) return null;

  const rawContent = raw.slice(contentStart, contentEnd);
  const properContent = unescapeJsonStringValue(rawContent);
  const repaired = JSON.stringify({ tool, args: { path: filePath, content: properContent } });

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

function isTruncatedToolCall(content) {
  return /<tool_call>/i.test(content) && !/<\/tool_call>/i.test(content);
}

function createProvider(config) {
  if (config.provider === "ollama") {
    return createOllamaProvider(config);
  }

  if (config.provider === "lmstudio") {
    return createLmStudioProvider(config);
  }

  throw new Error(`Unsupported provider: ${config.provider}`);
}

export function buildSystemPrompt(config, tools) {
  return [
    "You are a local coding agent that helps inspect and modify files inside the user's workspace.",
    `Workspace root: ${config.workspace}`,
    "The user's message may contain typos, be very short, or be phrased ambiguously (especially Chinese input). Interpret it charitably and act on your best guess of their intent instead of refusing or staying silent. Only ask a short clarifying question if the request is genuinely impossible to guess.",
    "You can reason normally, but when you need a tool you must respond with exactly one XML block in this format:",
    "<tool_call>",
    "{\"tool\":\"read_file\",\"args\":{\"path\":\"src/index.js\"}}",
    "</tool_call>",
    "Do not wrap the XML block in markdown fences.",
    "After receiving a tool result, continue until you can provide a final answer.",
    "Prefer small, precise edits.",
    "When writing code longer than about 40 lines, first write_file a small skeleton (imports and function signatures), then use append_file one or more times to add the rest in smaller pieces. Keep each tool call's content short so it stays valid JSON and does not get cut off.",
    "To add content to a file that already has content you want to keep, use append_file instead of write_file, so you never have to retype existing content (retyping risks corrupting it).",
    "If a <tool_result> contains \"Syntax check failed\", read the error, fix the code, and write it again before giving your final answer. Do not ignore it.",
    "Never claim you created, wrote, saved, or modified a file unless a write_file, append_file, or replace_in_file <tool_call> in this conversation actually succeeded (its <tool_result> did not start with \"Error\"). If you have not actually called one of those tools yet, call it before answering - do not just describe what the code would do.",
    "If the user asks whether a file exists, where it is, or what is currently in it, call list_files or read_file to check first. Do not answer from memory or from what you said earlier in the conversation - a file you described earlier may never have actually been written.",
    "read_file/list_files/search_text only see files inside the workspace root above. If the user gives you a path outside the project (an absolute path, or a file they attached with /attach), use read_external_file instead - it can read anywhere on the local computer (read-only, max 2MB) and echoes back the resolved absolute path so the user can confirm which file was read. When a message contains an <attached_file path=\"...\"> block, that content was already read for you - use it directly instead of calling a tool again.",
    "For a task with multiple independent pieces (e.g. investigate two unrelated files, or draft two unrelated code changes), you can call spawn_agent to run one piece in the background while you keep working on another, then check_agent(id) later to collect its result. Do not use spawn_agent for a single sequential task, and do not spawn a step that depends on another spawned step's output. Only a limited number of background agents can run at once - if spawn_agent errors saying too many are running, check_agent an existing one (or finish your own current step) before retrying.",
    "You CAN build, test, and run code yourself with run_command (e.g. dotnet run, npm test, python script.py) - use it instead of just telling the user to run something themselves. The user will be asked to approve each command in their terminal before it runs; if they decline, run_command returns an error and you should explain that to the user rather than claiming you are fundamentally unable to run commands.",
    "Your training data has a cutoff date and cannot see anything newer. If the user asks about recent events, current versions/releases, prices, or any fact that could have changed since then, use web_search to find current sources and web_fetch to read a promising result before answering - do not answer from memory alone. NEVER tell the user to go look it up themselves; you have web_search and web_fetch for exactly this. Search snippets are often too short or vague (e.g. no actual number) - when that happens, call web_fetch on the most relevant result URL to read the real page before answering, instead of giving a vague answer from the snippet alone.",
    "Approval for web_search/web_fetch happens ONLY through a [y/N] prompt printed directly in the user's terminal at the moment the tool call runs - there is no other way to grant permission, and you cannot ask for approval by chatting (e.g. do not say things like \"type yes to approve\"). If a <tool_result> for web_search or web_fetch starts with \"Error: Network access was not approved\", it means that terminal prompt was declined or unavailable in this run - just tell the user plainly that the network request needs approval at the terminal prompt (or the session needs to be started with --allow-network), then stop. Do not invent an alternate approval flow and do not just tell the user to search the web on their own.",
    "Available tools:",
    JSON.stringify(tools, null, 2)
  ].join("\n");
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((message) => message && typeof message.role === "string" && typeof message.content === "string")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}
