import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  ".DS_Store"
]);

const NETWORK_TIMEOUT_MS = 15000;
const USER_AGENT = "Mozilla/5.0 (compatible; local-code-agent/1.0)";
const MAX_EXTERNAL_FILE_BYTES = 2 * 1024 * 1024;

export class Workspace {
  constructor(rootPath, options = {}) {
    this.rootPath = path.resolve(rootPath);
    this.allowCommands = Boolean(options.allowCommands);
    this.allowWrites = Boolean(options.allowWrites);
    this.allowNetwork = Boolean(options.allowNetwork);
    this.backgroundCommands = new Map();
    this.backgroundCounter = 0;
  }

  assertWriteApproved(approved) {
    if (!this.allowWrites && !approved) {
      throw new Error("File change was not approved. Re-run with --allow-writes to skip the prompt, or approve it when asked.");
    }
  }

  assertNetworkApproved(approved) {
    if (!this.allowNetwork && !approved) {
      throw new Error("Network access was not approved. Re-run with --allow-network to skip the prompt, or approve it when asked.");
    }
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

  async globFiles(pattern, targetPath = ".", limit = 200) {
    const files = await this.listFiles(targetPath, MAX_SCANNED_ENTRIES);
    const matcher = globToRegExp(pattern);
    return files.filter((relativePath) => matcher.test(relativePath)).slice(0, limit);
  }

  async readExternalFile(targetPath) {
    if (!targetPath) {
      throw new Error("Missing path.");
    }

    const fullPath = path.resolve(targetPath);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      throw new Error(`File not found: ${fullPath}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Not a file: ${fullPath}`);
    }

    if (stat.size > MAX_EXTERNAL_FILE_BYTES) {
      throw new Error(`File too large to read (${stat.size} bytes, limit ${MAX_EXTERNAL_FILE_BYTES} bytes): ${fullPath}`);
    }

    const content = await fs.readFile(fullPath, "utf8");
    return { path: fullPath, content };
  }

  async writeFile(targetPath, content, { approved = false } = {}) {
    this.assertWriteApproved(approved);
    const fullPath = this.resolvePath(targetPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    return `Wrote ${path.relative(this.rootPath, fullPath)}`;
  }

  async appendFile(targetPath, content, { approved = false } = {}) {
    this.assertWriteApproved(approved);
    const fullPath = this.resolvePath(targetPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.appendFile(fullPath, content, "utf8");
    return `Appended to ${path.relative(this.rootPath, fullPath)}`;
  }

  async replaceInFile(targetPath, findText, replaceText, replaceAll = false, { approved = false } = {}) {
    this.assertWriteApproved(approved);
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

  async searchText(query, targetPath = ".", limit = 50, options = {}) {
    const { regex = false, ignoreCase = false, contextLines = 0, glob = null } = options;
    const files = await this.listFiles(targetPath, 500);
    const filtered = glob ? files.filter((relativePath) => globToRegExp(glob).test(relativePath)) : files;

    let matcher = null;
    if (regex) {
      matcher = new RegExp(query, ignoreCase ? "i" : "");
    }

    const matches = [];
    for (const relativePath of filtered) {
      if (matches.length >= limit) {
        break;
      }

      let content;
      try {
        content = await this.readFile(relativePath);
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const hit = matcher
          ? matcher.test(line)
          : ignoreCase
            ? line.toLowerCase().includes(query.toLowerCase())
            : line.includes(query);

        if (!hit) {
          continue;
        }

        const entry = { path: relativePath, line: index + 1, text: line.trim() };
        if (contextLines > 0) {
          entry.before = lines.slice(Math.max(0, index - contextLines), index).map((text) => text.trim());
          entry.after = lines.slice(index + 1, index + 1 + contextLines).map((text) => text.trim());
        }

        matches.push(entry);
        if (matches.length >= limit) {
          break;
        }
      }
    }

    return matches;
  }

  async makeDirectory(targetPath, { approved = false } = {}) {
    this.assertWriteApproved(approved);
    const fullPath = this.resolvePath(targetPath);
    await fs.mkdir(fullPath, { recursive: true });
    return `Created ${path.relative(this.rootPath, fullPath)}`;
  }

  async deleteFile(targetPath, { approved = false } = {}) {
    this.assertWriteApproved(approved);
    const fullPath = this.resolvePath(targetPath);

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      throw new Error(`File not found: ${targetPath}`);
    }

    if (stat.isDirectory()) {
      throw new Error(`Refusing to delete a directory: ${targetPath}. Use run_command for that.`);
    }

    await fs.unlink(fullPath);
    return `Deleted ${targetPath}`;
  }

  async moveFile(fromPath, toPath, { approved = false } = {}) {
    this.assertWriteApproved(approved);
    const fullFrom = this.resolvePath(fromPath);
    const fullTo = this.resolvePath(toPath);

    try {
      await fs.stat(fullFrom);
    } catch {
      throw new Error(`File not found: ${fromPath}`);
    }

    await fs.mkdir(path.dirname(fullTo), { recursive: true });
    await fs.rename(fullFrom, fullTo);
    return `Moved ${fromPath} -> ${toPath}`;
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

  runCommandBackground(command, args = [], { approved = false } = {}) {
    if (!this.allowCommands && !approved) {
      throw new Error("Command execution was not approved. Re-run with --allow-commands to skip the prompt, or approve it when asked.");
    }

    this.backgroundCounter += 1;
    const id = `bg-${this.backgroundCounter}`;

    const child = spawn(command, args, {
      cwd: this.rootPath,
      shell: process.platform === "win32",
      // On Windows, shell:true spawns cmd.exe as the direct child and the real process as its
      // grandchild - killing child.pid only kills the cmd.exe wrapper, orphaning the grandchild.
      // On POSIX, detaching puts the child in its own process group so killing -pid (the group)
      // reaches any of its own children too, instead of leaving them behind.
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }
    });

    const record = {
      id,
      command,
      args,
      pid: child.pid ?? null,
      status: "running",
      exitCode: null,
      stdout: "",
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      child
    };

    child.stdout.on("data", (chunk) => {
      record.stdout = trimBuffer(record.stdout + chunk.toString(), MAX_BACKGROUND_BUFFER);
    });
    child.stderr.on("data", (chunk) => {
      record.stderr = trimBuffer(record.stderr + chunk.toString(), MAX_BACKGROUND_BUFFER);
    });
    child.on("error", (error) => {
      record.status = "failed";
      record.stderr = trimBuffer(`${record.stderr}\n[spawn error] ${error.message}`, MAX_BACKGROUND_BUFFER);
      record.finishedAt = new Date().toISOString();
    });
    child.on("close", (code) => {
      if (record.status !== "failed" && record.status !== "killed") {
        record.status = "exited";
      }
      record.exitCode = code;
      record.finishedAt = new Date().toISOString();
    });

    this.backgroundCommands.set(id, record);
    return { id, pid: record.pid, status: record.status };
  }

  readBackgroundOutput(id, { tail = null } = {}) {
    const record = this.backgroundCommands.get(id);
    if (!record) {
      throw new Error(`Unknown background command: ${id}`);
    }

    return {
      id: record.id,
      command: [record.command, ...record.args].join(" "),
      status: record.status,
      exitCode: record.exitCode,
      pid: record.pid,
      stdout: tail ? record.stdout.slice(-tail) : record.stdout,
      stderr: tail ? record.stderr.slice(-tail) : record.stderr
    };
  }

  stopBackgroundCommand(id) {
    const record = this.backgroundCommands.get(id);
    if (!record) {
      throw new Error(`Unknown background command: ${id}`);
    }

    if (record.status !== "running") {
      return { id, status: record.status, message: "Already finished." };
    }

    if (process.platform === "win32" && record.pid) {
      // Kills the whole process tree rooted at the cmd.exe wrapper (/t), not just that wrapper,
      // so the real process it launched doesn't get orphaned. See the note in runCommandBackground.
      spawn("taskkill", ["/pid", String(record.pid), "/t", "/f"]);
    } else if (record.pid) {
      try {
        process.kill(-record.pid, "SIGTERM");
      } catch {
        record.child.kill();
      }
    } else {
      record.child.kill();
    }

    record.status = "killed";
    record.finishedAt = new Date().toISOString();
    return { id, status: record.status };
  }

  listBackgroundCommands() {
    return [...this.backgroundCommands.values()].map(({ child, ...rest }) => rest);
  }

  async fetchUrl(targetUrl, { approved = false, maxChars = 8000, render = false } = {}) {
    this.assertNetworkApproved(approved);

    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }

    if (render) {
      return fetchRenderedUrl(parsed.toString(), maxChars);
    }

    const response = await fetchWithTimeout(parsed.toString());
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : "";
    const text = stripTags(html);

    return {
      url: parsed.toString(),
      title,
      text: text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
    };
  }

  async searchWeb(query, { approved = false, limit = 5 } = {}) {
    this.assertNetworkApproved(approved);

    const response = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `q=${encodeURIComponent(query)}`
    });
    if (!response.ok) {
      throw new Error(`Search failed: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const snippets = [];
    const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let snippetMatch;
    while ((snippetMatch = snippetPattern.exec(html)) !== null) {
      snippets.push(stripTags(snippetMatch[1]));
    }

    const results = [];
    const linkPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    while ((linkMatch = linkPattern.exec(html)) !== null && results.length < limit) {
      results.push({
        title: stripTags(linkMatch[2]),
        url: resolveDuckDuckGoUrl(linkMatch[1]),
        snippet: snippets[results.length] ?? ""
      });
    }

    return results;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...options.headers }
    });
  } finally {
    clearTimeout(timer);
  }
}

// Renders a page's JavaScript server-side via the public Jina AI Reader (r.jina.ai) and
// returns the resulting clean Markdown - a plain fetchUrl() only gets raw HTML and cannot
// execute JS, so client-side-rendered pages (common on official/government sites and many
// weather sites) come back as near-empty navigation/app-shell boilerplate with none of the
// actual content. Reader rendering takes longer than a plain fetch, hence the larger timeout.
const RENDER_TIMEOUT_MS = 45000;

async function fetchRenderedUrl(url, maxChars) {
  const response = await fetchWithTimeout(`https://r.jina.ai/${url}`, {}, RENDER_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Rendered fetch failed: ${response.status} ${response.statusText}`);
  }

  const markdown = await response.text();
  const titleMatch = markdown.match(/^Title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const text = stripNavLinkLines(markdown);

  return {
    url,
    title,
    text: text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
  };
}

// Reader-rendered Markdown from a nav-heavy site is dominated by lines that are just a bullet
// wrapping a single link ("*   [標題](https://... \"title\")") - these are menu/nav items, not
// page content, and on sites with deep mega-menus they can push the actual content tens of
// thousands of characters past maxChars before it's ever seen. Real content (prose, tables,
// numbers) is essentially never formatted as one lone link per line, so dropping those lines
// is a safe, site-agnostic way to raise the useful-content density before truncating.
const NAV_LINK_LINE = /^\s*[*-]\s*\[.*\]\([^)]*\)\s*$/;

function stripNavLinkLines(markdown) {
  return markdown
    .split("\n")
    .filter((line) => !NAV_LINK_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function resolveDuckDuckGoUrl(href) {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return href;
  }
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_SCANNED_ENTRIES = 5000;
const MAX_BACKGROUND_BUFFER = 200000;

function trimBuffer(text, maxChars) {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

// Converts a simple glob pattern (`*`, `**`, `?`) into a RegExp matched against
// forward-slash-separated relative paths. Not a full minimatch implementation
// (no brace expansion, no character classes) but covers the common cases
// ("**/*.ts", "src/**/*.js", "*.md") that tools actually need.
function globToRegExp(pattern) {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 2;
        if (pattern[i] === "/") {
          i += 1;
        }
        continue;
      }
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    if (".+^$()[]{}|\\".includes(char)) {
      source += `\\${char}`;
      i += 1;
      continue;
    }
    source += char;
    i += 1;
  }

  return new RegExp(`^${source}$`);
}

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
