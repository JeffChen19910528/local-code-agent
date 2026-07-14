import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSkillPrompt, loadSkills, matchSkillInvocation, parseSkillFile } from "../src/skills.js";

test("parseSkillFile reads frontmatter and body", () => {
  const raw = [
    "---",
    "name: reviewer",
    "description: Review code for bugs.",
    "keywords: rv, code-review",
    "tools: read_file, search_text",
    "---",
    "",
    "Only look for bugs. Do not edit files."
  ].join("\n");

  const skill = parseSkillFile(raw, "skills/reviewer.md", "project");

  assert.equal(skill.name, "reviewer");
  assert.equal(skill.description, "Review code for bugs.");
  assert.deepEqual(skill.keywords, ["rv", "code-review"]);
  assert.deepEqual(skill.tools, ["read_file", "search_text"]);
  assert.equal(skill.body, "Only look for bugs. Do not edit files.");
  assert.equal(skill.scope, "project");
});

test("parseSkillFile treats missing tools field as unrestricted", () => {
  const raw = ["---", "name: helper", "description: General helper.", "---", "Body text."].join("\n");
  const skill = parseSkillFile(raw, "skills/helper.md", "user");

  assert.equal(skill.tools, null);
  assert.deepEqual(skill.keywords, []);
});

test("parseSkillFile requires name and description", () => {
  assert.throws(() => parseSkillFile("---\ndescription: x\n---\nbody", "x.md", "user"), /name/i);
  assert.throws(() => parseSkillFile("---\nname: x\n---\nbody", "x.md", "user"), /description/i);
});

test("matchSkillInvocation distinguishes none, skill, and unknown", () => {
  const skills = new Map([
    ["reviewer", { name: "reviewer" }],
    ["rv", { name: "reviewer" }]
  ]);

  assert.deepEqual(matchSkillInvocation("plain prompt", skills), { type: "none" });

  const skillMatch = matchSkillInvocation("/rv check src/agent.js", skills);
  assert.equal(skillMatch.type, "skill");
  assert.equal(skillMatch.rest, "check src/agent.js");

  const unknownMatch = matchSkillInvocation("/nope do something", skills);
  assert.deepEqual(unknownMatch, { type: "unknown", token: "nope" });
});

test("buildSkillPrompt injects skill body and task", () => {
  const skill = { name: "reviewer", body: "Only look for bugs." };
  const prompt = buildSkillPrompt(skill, "check src/agent.js");

  assert.match(prompt, /\[Skill: reviewer]/);
  assert.match(prompt, /Only look for bugs\./);
  assert.match(prompt, /Task: check src\/agent\.js/);
});

test("loadSkills merges user and project skills, project wins on name clash", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-workspace-"));

  await writeSkill(path.join(homeDir, ".local-code", "skills", "reviewer.md"), {
    name: "reviewer",
    description: "User-level reviewer.",
    body: "user body"
  });
  await writeSkill(path.join(homeDir, ".local-code", "skills", "onlyuser.md"), {
    name: "onlyuser",
    description: "User-only skill.",
    body: "user only"
  });
  await writeSkill(path.join(workspace, ".local-code", "skills", "reviewer.md"), {
    name: "reviewer",
    description: "Project-level reviewer.",
    body: "project body"
  });

  const skills = await loadSkills(workspace, { homeDir });

  assert.equal(skills.get("reviewer").scope, "project");
  assert.equal(skills.get("reviewer").body, "project body");
  assert.equal(skills.get("onlyuser").scope, "user");
});

test("loadSkills skips reserved names and returns empty map when no dirs exist", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-workspace-"));

  await writeSkill(path.join(workspace, ".local-code", "skills", "status.md"), {
    name: "status",
    description: "Reserved name collision.",
    body: "should be skipped"
  });

  const skills = await loadSkills(workspace, { homeDir });
  assert.equal(skills.size, 0);
});

async function writeSkill(filePath, { name, description, keywords, tools, body }) {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (keywords) {
    lines.push(`keywords: ${keywords}`);
  }
  if (tools) {
    lines.push(`tools: ${tools}`);
  }
  lines.push("---", "", body);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.join("\n"), "utf8");
}
