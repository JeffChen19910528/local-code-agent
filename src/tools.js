import { checkSyntax } from "./syntaxCheck.js";
import { confirmCommand } from "./ui.js";

export function createToolset(workspace) {
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
        "Do not use this to add to a file that already has content you want to keep - use append_file instead, so you never have to retype existing content."
      ].join(" "),
      args: { path: "string", content: "string" },
      run: async ({ path, content }) => withSyntaxCheck(workspace, path, () => workspace.writeFile(path, content))
    },
    append_file: {
      description: "Append content to the end of a file, creating it if it does not exist. Prefer this over write_file when a file already has content you want to keep.",
      args: { path: "string", content: "string" },
      run: async ({ path, content }) => withSyntaxCheck(workspace, path, () => workspace.appendFile(path, content))
    },
    replace_in_file: {
      description: "Replace text inside an existing file.",
      args: {
        path: "string",
        findText: "string",
        replaceText: "string",
        replaceAll: "boolean?"
      },
      run: async (args) => withSyntaxCheck(
        workspace,
        args.path,
        () => workspace.replaceInFile(args.path, args.findText, args.replaceText, args.replaceAll)
      )
    },
    search_text: {
      description: "Search for a plain text query across workspace files.",
      args: { query: "string", path: "string?", limit: "number?" },
      run: async ({ query, path = ".", limit = 50 }) => workspace.searchText(query, path, limit)
    },
    make_directory: {
      description: "Create a directory recursively in the workspace.",
      args: { path: "string" },
      run: async ({ path }) => workspace.makeDirectory(path)
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
