import { checkSyntax } from "./syntaxCheck.js";
import { confirmCommand, confirmNetwork, confirmWrite } from "./ui.js";
import { getAgentTask, listAgentTasks, spawnAgentTask } from "./subagents.js";

export function createToolset(workspace, config = null) {
  let todos = [];

  const tools = {
    list_files: {
      description: "List files under the workspace or a subdirectory.",
      args: { path: "string?", limit: "number?" },
      run: async ({ path = ".", limit = 200 }) => workspace.listFiles(path, limit)
    },
    glob_files: {
      description: [
        "Find files under the workspace whose relative path matches a glob pattern (e.g. \"**/*.ts\", \"src/**/*.test.js\", \"*.md\").",
        "Supports * (any chars except /), ** (any chars including /, spans directories), and ? (single char).",
        "Use this instead of list_files when you know the kind of file you're looking for but not where it is."
      ].join(" "),
      args: { pattern: "string", path: "string?", limit: "number?" },
      run: async ({ pattern, path = ".", limit = 200 }) => workspace.globFiles(pattern, path, limit)
    },
    read_file: {
      description: [
        "Read a UTF-8 text file from the workspace.",
        "For large files, pass offset (1-based starting line) and/or limit (max lines) to read a slice instead of the whole file - when either is given, each returned line is prefixed with its line number and a tab, so you can reference exact line numbers back to the user or in replace_in_file."
      ].join(" "),
      args: { path: "string", offset: "number?", limit: "number?" },
      run: async ({ path, offset, limit }) => {
        const content = await workspace.readFile(path);
        if (offset == null && limit == null) {
          return content;
        }

        const lines = content.split(/\r?\n/);
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit != null ? start + limit : lines.length;
        return lines
          .slice(start, end)
          .map((line, index) => `${start + index + 1}\t${line}`)
          .join("\n");
      }
    },
    read_external_file: {
      description: [
        "Read a UTF-8 text file from anywhere on the local computer by absolute path (or a path relative to the directory local-code was started in) - not just inside the project workspace.",
        "Use this when the user attaches a file (e.g. via /attach) or gives you a path outside the current project and wants it analyzed.",
        "Read-only: it cannot write outside the workspace. Files larger than 2MB are rejected.",
        "The resolved absolute path is echoed back so the user can confirm exactly which file was read."
      ].join(" "),
      args: { path: "string" },
      run: async ({ path: targetPath }) => {
        const result = await workspace.readExternalFile(targetPath);
        return `Read ${result.content.length} chars from ${result.path}\n\n${result.content}`;
      }
    },
    write_file: {
      description: [
        "Create or overwrite a UTF-8 file inside the workspace.",
        "For files longer than ~40 lines, write a small skeleton first (imports and function signatures), then use append_file to add the rest in smaller pieces.",
        "Do not use this to add to a file that already has content you want to keep - use append_file instead, so you never have to retype existing content.",
        "Unless the session was started with --allow-writes, the user is asked to approve each file change in the terminal before it is written."
      ].join(" "),
      args: { path: "string", content: "string" },
      run: async ({ path, content }) => {
        const approved = await approveWrite(workspace, { action: "write", path, preview: content });
        return withSyntaxCheck(workspace, path, () => workspace.writeFile(path, content, { approved }));
      }
    },
    append_file: {
      description: "Append content to the end of a file, creating it if it does not exist. Prefer this over write_file when a file already has content you want to keep.",
      args: { path: "string", content: "string" },
      run: async ({ path, content }) => {
        const approved = await approveWrite(workspace, { action: "append", path, preview: content });
        return withSyntaxCheck(workspace, path, () => workspace.appendFile(path, content, { approved }));
      }
    },
    replace_in_file: {
      description: "Replace text inside an existing file.",
      args: {
        path: "string",
        findText: "string",
        replaceText: "string",
        replaceAll: "boolean?"
      },
      run: async (args) => {
        const approved = await approveWrite(workspace, {
          action: "replace",
          path: args.path,
          preview: `Find:\n${args.findText}\nReplace with:\n${args.replaceText}`
        });
        return withSyntaxCheck(
          workspace,
          args.path,
          () => workspace.replaceInFile(args.path, args.findText, args.replaceText, args.replaceAll, { approved })
        );
      }
    },
    search_text: {
      description: [
        "Search for a text query across workspace files, like grep. By default query is a plain substring; pass regex:true to treat it as a regular expression.",
        "Optional: ignoreCase for case-insensitive matching, contextLines to include N lines before/after each match, glob (e.g. \"*.js\") to only search matching files.",
        "Returns matches as {path, line, text, before?, after?}."
      ].join(" "),
      args: {
        query: "string",
        path: "string?",
        limit: "number?",
        regex: "boolean?",
        ignoreCase: "boolean?",
        contextLines: "number?",
        glob: "string?"
      },
      run: async ({ query, path = ".", limit = 50, regex = false, ignoreCase = false, contextLines = 0, glob = null }) =>
        workspace.searchText(query, path, limit, { regex, ignoreCase, contextLines, glob })
    },
    make_directory: {
      description: "Create a directory recursively in the workspace.",
      args: { path: "string" },
      run: async ({ path }) => {
        const approved = await approveWrite(workspace, { action: "mkdir", path });
        return workspace.makeDirectory(path, { approved });
      }
    },
    delete_file: {
      description: "Delete a single file inside the workspace. Refuses to delete directories. Unless the session was started with --allow-writes, the user is asked to approve each deletion in the terminal before it happens.",
      args: { path: "string" },
      run: async ({ path }) => {
        const approved = await approveWrite(workspace, { action: "delete", path });
        return workspace.deleteFile(path, { approved });
      }
    },
    move_file: {
      description: "Move or rename a file inside the workspace, creating the destination directory if needed. Unless the session was started with --allow-writes, the user is asked to approve each move in the terminal before it happens.",
      args: { from: "string", to: "string" },
      run: async ({ from, to }) => {
        const approved = await approveWrite(workspace, { action: "move", path: `${from} -> ${to}` });
        return workspace.moveFile(from, to, { approved });
      }
    },
    todo_write: {
      description: [
        "Replace the current task todo list. Use this to plan and track progress on a multi-step task so the user can see what's done, in progress, and pending.",
        "items is an array of {id?, content, status} where status is one of pending/in_progress/completed. Pass the full list each time (not a diff) - this call overwrites the previous list.",
        "Keep exactly one item as in_progress at a time. Mark an item completed as soon as it's actually done, not in a later batch."
      ].join(" "),
      args: { items: "array" },
      run: async ({ items }) => {
        if (!Array.isArray(items)) {
          throw new Error("items must be an array of {content, status}.");
        }

        todos = items.map((item, index) => ({
          id: item?.id != null ? String(item.id) : String(index + 1),
          content: String(item?.content ?? ""),
          status: ["pending", "in_progress", "completed"].includes(item?.status) ? item.status : "pending"
        }));

        return formatTodoList(todos);
      }
    },
    todo_read: {
      description: "Read the current task todo list (as set by todo_write).",
      args: {},
      run: async () => (todos.length > 0 ? formatTodoList(todos) : "No todos yet.")
    },
    run_command_background: {
      description: [
        "Start a long-running local shell command in the background (e.g. a dev server) and return immediately with {id, pid, status}.",
        "Use this instead of run_command when the process is not expected to exit on its own. Poll its output with read_background_output(id) and stop it with stop_background_command(id) when done.",
        "Unless the session was started with --allow-commands, the user is asked to approve it in the terminal before it starts."
      ].join(" "),
      args: { command: "string", args: "string[]?" },
      run: async ({ command, args = [] }) => {
        if (workspace.allowCommands) {
          return workspace.runCommandBackground(command, args);
        }

        const approved = await confirmCommand({ command, args, cwd: workspace.rootPath });
        return workspace.runCommandBackground(command, args, { approved });
      }
    },
    read_background_output: {
      description: "Read the accumulated stdout/stderr and status of a background command started with run_command_background. Pass tail to only get the last N characters of each stream.",
      args: { id: "string", tail: "number?" },
      run: async ({ id, tail }) => workspace.readBackgroundOutput(id, { tail })
    },
    stop_background_command: {
      description: "Kill a still-running background command started with run_command_background.",
      args: { id: "string" },
      run: async ({ id }) => workspace.stopBackgroundCommand(id)
    },
    list_background_commands: {
      description: "List all background commands started so far in this session, most recent first, with their status.",
      args: {},
      run: async () => [...workspace.listBackgroundCommands()].reverse()
    },
    run_command: {
      description: "Run a local shell command inside the workspace (e.g. dotnet run, npm test, python script.py) to build, test, or execute code. Unless the session was started with --allow-commands, the user is asked to approve each command in the terminal before it runs.",
      args: { command: "string", args: "string[]?" },
      run: async ({ command, args = [] }) => {
        if (workspace.allowCommands) {
          return workspace.runCommand(command, args);
        }

        const approved = await confirmCommand({ command, args, cwd: workspace.rootPath });
        return workspace.runCommand(command, args, { approved });
      }
    },
    web_search: {
      description: [
        "Search the public web (DuckDuckGo) and return up to `limit` results as {title, url, snippet}.",
        "Use this when the user asks about recent events, current versions/releases, prices, or anything that may have changed since your training data - do not answer from memory alone in those cases.",
        "Follow up with web_fetch on a promising result to read the full page.",
        "Unless the session was started with --allow-network, the user is asked to approve each network request in the terminal before it runs."
      ].join(" "),
      args: { query: "string", limit: "number?" },
      run: async ({ query, limit = 5 }) => {
        const approved = await approveNetwork(workspace, { action: "web_search", detail: query });
        return workspace.searchWeb(query, { approved, limit });
      }
    },
    web_fetch: {
      description: [
        "Fetch a web page by URL and return its title and readable text content (HTML tags stripped, truncated to maxChars).",
        "Use this to read a specific page, e.g. a result from web_search or a URL the user gave you.",
        "Plain fetch (render omitted/false) only gets raw HTML - it cannot run JavaScript. If the result comes back as mostly navigation/menu boilerplate with no real content (common on official/government sites and many weather/dashboard-style sites that render their content client-side), call web_fetch again on the SAME url with render:true - this renders the page's JavaScript server-side via a reader service and returns the actual content as Markdown (with obvious link-only nav lines already filtered out). It takes longer, so only use it as a fallback after a plain fetch clearly failed to get useful content, not as the default. Default maxChars is larger for render:true (20000 vs 8000) since real content can still sit well past the fold on a nav-heavy page - if it's still all boilerplate at that point, retry once more with an even larger maxChars rather than giving up.",
        "Unless the session was started with --allow-network, the user is asked to approve each network request in the terminal before it runs."
      ].join(" "),
      args: { url: "string", maxChars: "number?", render: "boolean?" },
      run: async ({ url, maxChars, render = false }) => {
        const approved = await approveNetwork(workspace, { action: "web_fetch", detail: url });
        const effectiveMaxChars = maxChars ?? (render ? 20000 : 8000);
        return workspace.fetchUrl(url, { approved, maxChars: effectiveMaxChars, render });
      }
    },
    spawn_agent: {
      description: [
        "Spawn a background sub-agent to work on an independent piece of the task while you continue (same workspace and permissions as the current session).",
        "Returns immediately with {id, status:\"running\"} - it does not block. Use check_agent to poll for its result later.",
        "There is a limit on how many background agents can run at the same time (each one keeps its own context/KV-cache in the local model server's memory). If the limit is reached, this errors instead of queueing - call check_agent on an existing task or wait for one to finish, then retry.",
        "Only use this for genuinely independent sub-tasks (e.g. investigate two unrelated files, or draft two unrelated pieces of code) that don't depend on each other's output. Do not use it for a single sequential task - just do that yourself."
      ].join(" "),
      args: { task: "string" },
      run: async ({ task }) => {
        if (!config) {
          throw new Error("spawn_agent is not available in this context.");
        }
        const record = spawnAgentTask(config, task);
        return { id: record.id, status: record.status };
      }
    },
    check_agent: {
      description: "Check the status and result of a sub-agent previously spawned with spawn_agent. status is one of running/done/failed.",
      args: { id: "string" },
      run: async ({ id }) => {
        const record = getAgentTask(id);
        if (!record) {
          throw new Error(`Unknown agent task: ${id}`);
        }
        return record;
      }
    },
    list_agents: {
      description: "List all sub-agent tasks spawned so far in this session (running, done, or failed), most recent first.",
      args: {},
      run: async () => [...listAgentTasks()].reverse()
    }
  };

  return {
    tools,
    getManifest() {
      return Object.entries(tools).map(([name, value]) => ({
        name,
        description: value.description,
        args: value.args
      }));
    },
    async execute(name, args, allowedTools = null) {
      const tool = tools[name];
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      if (allowedTools && !allowedTools.includes(name)) {
        throw new Error(`Tool "${name}" is not available for this task. Allowed tools: ${allowedTools.join(", ")}`);
      }

      return tool.run(args ?? {});
    }
  };
}

const TODO_STATUS_MARK = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]"
};

function formatTodoList(items) {
  return items.map((item) => `${TODO_STATUS_MARK[item.status]} ${item.content}`).join("\n");
}

async function approveWrite(workspace, { action, path, preview }) {
  if (workspace.allowWrites) {
    return true;
  }

  return confirmWrite({ action, path, preview, cwd: workspace.rootPath });
}

async function approveNetwork(workspace, { action, detail }) {
  if (workspace.allowNetwork) {
    return true;
  }

  return confirmNetwork({ action, detail, cwd: workspace.rootPath });
}

async function withSyntaxCheck(workspace, targetPath, writeAction) {
  const message = await writeAction();
  const result = await checkSyntax(workspace.resolvePath(targetPath));

  if (!result.checked) {
    return message;
  }

  if (result.ok) {
    return `${message}\nSyntax OK.`;
  }

  return `${message}\n⚠️ Syntax check failed:\n${result.message}`;
}
