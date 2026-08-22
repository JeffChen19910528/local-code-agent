import path from "node:path";

export async function printInitExample(cwd) {
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

export function printHelp() {
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
  --request-timeout-ms 180000

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
  /repair (or /doctor) Diagnose the current provider (install/server/model/version) and
                        print concrete repair steps. Also runs automatically after 3
                        consecutive failed requests to the same provider.
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
