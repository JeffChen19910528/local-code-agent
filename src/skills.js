import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RESERVED_NAMES = new Set(["exit", "provider", "model", "status", "skills", "reset"]);

export function parseSkillFile(raw, sourcePath, scope) {
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    throw new Error(`Missing frontmatter in ${sourcePath}`);
  }

  const [, frontmatterBlock, body] = frontmatterMatch;
  const fields = {};
  for (const line of frontmatterBlock.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    fields[key] = value;
  }

  if (!fields.name) {
    throw new Error(`Missing "name" field in ${sourcePath}`);
  }

  if (!fields.description) {
    throw new Error(`Missing "description" field in ${sourcePath}`);
  }

  return {
    name: fields.name,
    description: fields.description,
    keywords: parseList(fields.keywords),
    tools: fields.tools ? parseList(fields.tools) : null,
    body: body.trim(),
    sourcePath,
    scope
  };
}

export async function loadSkills(workspace, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const skills = new Map();

  await loadSkillsFromDir(path.join(homeDir, ".local-code", "skills"), "user", skills);
  await loadSkillsFromDir(path.join(workspace, ".local-code", "skills"), "project", skills);

  return skills;
}

export function matchSkillInvocation(prompt, skills) {
  const match = prompt.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!match) {
    return { type: "none" };
  }

  const [, token, rest] = match;
  const skill = skills.get(token.toLowerCase());
  if (!skill) {
    return { type: "unknown", token };
  }

  return { type: "skill", skill, rest: rest.trim() };
}

export function buildSkillPrompt(skill, rest) {
  return [`[Skill: ${skill.name}]`, skill.body, "", `Task: ${rest}`].join("\n");
}

async function loadSkillsFromDir(dirPath, scope, skills) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);

    let skill;
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      skill = parseSkillFile(raw, fullPath, scope);
    } catch (error) {
      console.error(`Skipping invalid skill file ${fullPath}: ${error.message}`);
      continue;
    }

    const lowerName = skill.name.toLowerCase();
    if (RESERVED_NAMES.has(lowerName)) {
      console.error(`Skipping skill "${skill.name}" in ${fullPath}: name is reserved.`);
      continue;
    }

    skills.set(lowerName, skill);
    for (const keyword of skill.keywords) {
      const lowerKeyword = keyword.toLowerCase();
      if (RESERVED_NAMES.has(lowerKeyword)) {
        console.error(`Skipping keyword "${keyword}" for skill "${skill.name}": name is reserved.`);
        continue;
      }

      skills.set(lowerKeyword, skill);
    }
  }
}

function parseList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
