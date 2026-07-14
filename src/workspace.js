import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  ".DS_Store"
]);

export class Workspace {
  constructor(rootPath, options = {}) {
    this.rootPath = path.resolve(rootPath);
    this.allowCommands = Boolean(options.allowCommands);
  }

  resolvePath(targetPath = ".") {
    const normalizedTarget = targetPath === "" ? "." : targetPath;
    const fullPath = path.resolve(this.rootPath, normalizedTarget);
    const relative = path.relative(this.rootPath, fullPath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes workspace: ${targetPath}`);
    }

    return fullPath;
  }

  async listFiles(targetPath = ".", limit = 200) {
    const startPath = this.resolvePath(targetPath);
    const results = [];
    await walk(startPath, this.rootPath, results, limit);
    return results;
  }

  async listRecentFiles(limit = 5) {
    const results = [];
    await walkRecent(this.rootPath, this.rootPath, results);

    return results
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, limit);
  }

  async readFile(targetPath) {
    const fullPath = this.resolvePath(targetPath);
    return fs.readFile(fullPath, "utf8");
  }

  async writeFile(targetPath, content) {
    const fullPath = this.resolvePath(targetPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    return `Wrote ${path.relative(this.rootPath, fullPath)}`;
  }

  async appendFile(targetPath, content) {
    const fullPath = this.resolvePath(targetPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.appendFile(fullPath, content, "utf8");
    return `Appended to ${path.relative(this.rootPath, fullPath)}`;
  }

  async replaceInFile(targetPath, findText, replaceText, replaceAll = false) {
    const fullPath = this.resolvePath(targetPath);
    const current = await fs.readFile(fullPath, "utf8");
    if (!current.includes(findText)) {
      throw new Error(`Text not found in ${targetPath}`);
    }

    const updated = replaceAll
      ? current.split(findText).join(replaceText)
      : current.replace(findText, replaceText);
    await fs.writeFile(fullPath, updated, "utf8");
    return `Updated ${targetPath}`;
  }

  async searchText(query, targetPath = ".", limit = 50) {
    const files = await this.listFiles(targetPath, 500);
    const matches = [];
    for (const relativePath of files) {
      if (matches.length >= limit) {
        break;
      }

      const content = await this.readFile(relativePath);
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].includes(query)) {
          matches.push({
            path: relativePath,
            line: index + 1,
            text: lines[index].trim()
          });
          if (matches.length >= limit) {
            break;
          }
        }
      }
    }

    return matches;
  }

  async makeDirectory(targetPath) {
    const fullPath = this.resolvePath(targetPath);
    await fs.mkdir(fullPath, { recursive: true });
    return `Created ${path.relative(this.rootPath, fullPath)}`;
  }

  async runCommand(command, args = [], { approved = false } = {}) {
    if (!this.allowCommands && !approved) {
      throw new Error("Command execution was not approved. Re-run with --allow-commands to skip the prompt, or approve it when asked.");
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.rootPath,
        shell: process.platform === "win32",
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        resolve({
          code,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd()
        });
      });
    });
  }
}

const MAX_SCANNED_ENTRIES = 5000;

async function walk(currentPath, rootPath, results, limit) {
  if (results.length >= limit) {
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= limit) {
      return;
    }

    if (DEFAULT_IGNORES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      await walk(fullPath, rootPath, results, limit);
      continue;
    }

    results.push(relativePath);
  }
}

async function walkRecent(currentPath, rootPath, results, scanned = { count: 0 }) {
  if (scanned.count >= MAX_SCANNED_ENTRIES) {
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (scanned.count >= MAX_SCANNED_ENTRIES) {
      return;
    }

    if (DEFAULT_IGNORES.has(entry.name)) {
      continue;
    }

    scanned.count += 1;
    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      await walkRecent(fullPath, rootPath, results, scanned);
      continue;
    }

    try {
      const stat = await fs.stat(fullPath);
      results.push({
        path: relativePath,
        modifiedAt: stat.mtime.toISOString()
      });
    } catch {
      // Skip files we can't stat (permissions, broken symlinks, etc).
    }
  }
}
