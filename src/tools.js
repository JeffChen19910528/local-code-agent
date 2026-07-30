import { checkSyntax } from "./syntaxCheck.js";
import { confirmCommand, confirmNetwork, confirmWrite } from "./ui.js";
import { getAgentTask, listAgentTasks, spawnAgentTask } from "./subagents.js";

export function createToolset(workspace, config = null) {
  const tools = {
    list_files: {
      description: "List files under the workspace or a subdirectory.",
      args: { path: "string?", limit: "number?" },
      run: async ({ path = ".", limit = 200 }) => workspace.listFiles(path, limit)
    },
    read_file: {
      description: "Read a UTF-8 text file from the workspace.",
      args: { path: "string" },
      run: async ({ path }) => workspace.readFile(path)
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
      description: "Search for a plain text query across workspace files.",
      args: { query: "string", path: "string?", limit: "number?" },
      run: async ({ query, path = ".", limit = 50 }) => workspace.searchText(query, path, limit)
    },
    make_directory: {
      description: "Create a directory recursively in the workspace.",
      args: { path: "string" },
      run: async ({ path }) => {
        const approved = await approveWrite(workspace, { action: "mkdir", path });
        return workspace.makeDirectory(path, { approved });
      }
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
        "Unless the session was started with --allow-network, the user is asked to approve each network request in the terminal before it runs."
      ].join(" "),
      args: { url: "string", maxChars: "number?" },
      run: async ({ url, maxChars = 8000 }) => {
        const approved = await approveNetwork(workspace, { action: "web_fetch", detail: url });
        return workspace.fetchUrl(url, { approved, maxChars });
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
