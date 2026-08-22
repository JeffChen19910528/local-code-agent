import { createOllamaProvider } from "./providers/ollama.js";
import { createLmStudioProvider } from "./providers/lmstudio.js";
import { createToolset } from "./tools.js";
import { Workspace } from "./workspace.js";
import { buildSkillPrompt } from "./skills.js";
import { buildRepairGuidance, diagnoseProvider } from "./runtime.js";
import { extractToolCall, isTruncatedToolCall, isUnfinishedIntent } from "./toolCallParser.js";

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
        content: `<current_datetime>${formatCurrentDatetime()}</current_datetime>\n${outgoingPrompt}`
      });

      let lastFailureSignature = null;
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 3;

      for (let step = 1; step <= config.maxSteps; step += 1) {
        hooks.onStep?.(step);
        const stepStartMs = Date.now();
        let reply;
        try {
          reply = await provider.chat(messages);
        } catch (error) {
          const providerMessage = error instanceof Error ? error.message : String(error);
          consecutiveFailures = lastFailureSignature === "provider_error" ? consecutiveFailures + 1 : 1;
          lastFailureSignature = "provider_error";
          hooks.onToolCallError?.({ step, reason: "provider_error", message: providerMessage, attempt: consecutiveFailures });

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            const guidance = await diagnoseProviderFailure(config, providerMessage);
            return {
              content: [
                `此任務自動終止：模型端連續 ${consecutiveFailures} 次回報錯誤（${providerMessage}）。`,
                guidance
              ].join("\n\n"),
              steps: step,
              failed: true
            };
          }

          continue;
        }
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

        if (!toolCall && isUnfinishedIntent(content)) {
          consecutiveFailures = lastFailureSignature === "unfinished_intent" ? consecutiveFailures + 1 : 1;
          lastFailureSignature = "unfinished_intent";
          hooks.onToolCallError?.({ step, reason: "unfinished_intent", message: "Model announced an action but did not issue a <tool_call>.", attempt: consecutiveFailures });

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            return {
              content: [
                content,
                "",
                "（注意：模型連續多次只講「將要做什麼」卻沒有實際呼叫工具，上面這段話可能沒有真的執行。建議换一個模型再試一次。）"
              ].join("\n"),
              steps: step,
              failed: true
            };
          }

          messages.push({
            role: "user",
            content: "你剛才說明了打算做什麼，但沒有在同一則回覆裡附上 <tool_call> 區塊，所以什麼都還沒執行。請直接發出對應的 <tool_call> 區塊來實際執行這個動作，不要只描述意圖。"
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

// The model has no built-in notion of "now" - without this it cannot resolve relative dates
// ("today", "tomorrow", "this week") or judge whether a fetched web page's own timestamp is
// current. Computed fresh per ask() call (not baked into the one-time system prompt) so it
// stays correct across chat sessions that span more than one day.
function formatCurrentDatetime() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offsetMinutes);
  const offset = `UTC${offsetSign}${pad(Math.floor(offsetAbs / 60))}:${pad(offsetAbs % 60)}`;
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${date} (${weekday}) ${time} local time (${offset})`;
}

export async function listProviderModels(config) {
  return createProvider(config).listModels();
}

// Runs an on-demand Ollama/LM Studio diagnosis after repeated live request failures, so the
// user gets a concrete next step (restart service, reinstall, missing model) instead of just
// "try another model". Diagnosis itself talks to the network/filesystem and must never throw
// past this point - fall back to the generic message if it does.
async function diagnoseProviderFailure(config, providerErrorMessage) {
  try {
    const status = await diagnoseProvider(config, config.provider);
    return buildRepairGuidance(status, { model: config.model, providerErrorMessage });
  } catch {
    return "這通常代表目前這個模型/Provider 組合本身有問題（例如與這個工具的 tool-call 格式不相容），而不是暫時性的網路問題。建議換一個模型再試一次，或輸入 /repair 進一步診斷。";
  }
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
    "Never say you are about to do something (e.g. \"let me check\", \"first I will look at\", \"讓我看看\", \"我將確認\") without including the matching <tool_call> block in that same reply. If you intend to act, act in this reply - do not announce an action and stop.",
    "After receiving a tool result, continue until you can provide a final answer.",
    "Prefer small, precise edits.",
    "When writing code longer than about 40 lines, first write_file a small skeleton (imports and function signatures), then use append_file one or more times to add the rest in smaller pieces. Keep each tool call's content short so it stays valid JSON and does not get cut off.",
    "To add content to a file that already has content you want to keep, use append_file instead of write_file, so you never have to retype existing content (retyping risks corrupting it).",
    "If a <tool_result> contains \"Syntax check failed\", read the error, fix the code, and write it again before giving your final answer. Do not ignore it.",
    "Never claim you created, wrote, saved, or modified a file unless a write_file, append_file, or replace_in_file <tool_call> in this conversation actually succeeded (its <tool_result> did not start with \"Error\"). If you have not actually called one of those tools yet, call it before answering - do not just describe what the code would do.",
    "If the user asks whether a file exists, where it is, or what is currently in it, call list_files or read_file to check first. Do not answer from memory or from what you said earlier in the conversation - a file you described earlier may never have actually been written.",
    "read_file/list_files/glob_files/search_text only see files inside the workspace root above. If the user gives you a path outside the project (an absolute path, or a file they attached with /attach), use read_external_file instead - it can read anywhere on the local computer (read-only, max 2MB) and echoes back the resolved absolute path so the user can confirm which file was read. When a message contains an <attached_file path=\"...\"> block, that content was already read for you - use it directly instead of calling a tool again.",
    "For a task with multiple independent pieces (e.g. investigate two unrelated files, or draft two unrelated code changes), you can call spawn_agent to run one piece in the background while you keep working on another, then check_agent(id) later to collect its result. Do not use spawn_agent for a single sequential task, and do not spawn a step that depends on another spawned step's output. Only a limited number of background agents can run at once - if spawn_agent errors saying too many are running, check_agent an existing one (or finish your own current step) before retrying.",
    "You CAN build, test, and run code yourself with run_command (e.g. dotnet run, npm test, python script.py) - use it instead of just telling the user to run something themselves. The user will be asked to approve each command in their terminal before it runs; if they decline, run_command returns an error and you should explain that to the user rather than claiming you are fundamentally unable to run commands.",
    "run_command blocks until the process exits, so it is wrong for anything that stays running (dev servers, watchers, long builds you want to monitor while doing other work). For those, use run_command_background instead - it returns immediately with {id, pid, status}; poll its output with read_background_output(id) and stop it with stop_background_command(id) when you're done. Don't use run_command_background for a quick command that just finishes and returns output - that's what run_command is for.",
    "Use glob_files when you know what kind of file you're looking for (by name pattern like \"**/*.test.js\") but not where it is, instead of list_files plus manual filtering. Use search_text like grep to find matching content - pass regex:true for a regular expression, contextLines for surrounding lines, and glob to restrict to matching files, instead of reading whole files to eyeball them.",
    "delete_file and move_file behave like write_file with respect to approval: unless the session was started with --allow-writes, the user is asked to approve each one in the terminal before it happens.",
    "For any task with 3+ distinct steps, or where the user should be able to see progress, call todo_write early with the planned steps (status pending/in_progress/completed), keep exactly one item in_progress at a time, and update it (a full replacement list, not a diff) as you complete or add steps. Skip it for trivial one-step requests.",
    "Every user message is prefixed with a <current_datetime>...</current_datetime> tag showing the actual current date/time - always use that (not your training cutoff, and not any date you guessed) to resolve relative terms like \"today\", \"tomorrow\", \"this week\", or \"currently\". When you fetch a web page, compare any date/timestamp shown in its content against this current date to judge whether the information is actually up to date - do not assume a timestamp on the page means \"today\" without checking, and say so explicitly if the page's content doesn't clearly correspond to today's date.",
    "Your training data has a cutoff date and cannot see anything newer or anything that changes in real time - this includes recent events, current software versions/releases, prices, weather, sports scores/schedules, stock/crypto prices, and news. For ANY question like this, you must call web_search to find current sources and web_fetch to read a promising result before answering - do not answer from memory alone. NEVER tell the user to go look it up themselves, and NEVER claim you \"don't have access to real-time data/APIs\" or \"cannot browse the internet\" as your final answer - you have web_search and web_fetch for exactly this, so attempt the tool call first. Only report that you couldn't get the answer after a web_search/web_fetch <tool_call> actually ran and failed (e.g. returned a \"not approved\" error, see below) - a plain refusal with no tool_call attempt in the same turn is never an acceptable final answer to this kind of question. Search snippets are often too short or vague (e.g. no actual number) - when that happens, call web_fetch on the most relevant result URL to read the real page before answering, instead of giving a vague answer from the snippet alone.",
    "web_fetch's plain mode only reads a page's raw HTML - it cannot run JavaScript, so pages that render their real content client-side (common on official/government sites and many weather/dashboard sites) come back as mostly navigation/boilerplate with no actual data. If that happens, do not just give up or send the user away - call web_fetch again on the SAME url with render:true, which renders the page's JavaScript server-side and returns the real content as Markdown (slower, so only use it as a fallback, not the default). For a weather question specifically, you can also go straight to web_fetch `https://wttr.in/<city>?format=j1` for a detailed JSON forecast (current conditions plus a few days ahead) or `https://wttr.in/<city>?format=4` for a quick one-line summary - both are plain text, need no JavaScript or render:true, and work with a plain fetch.",
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
