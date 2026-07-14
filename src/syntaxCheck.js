import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const CHECK_TIMEOUT_MS = 5000;
const PYTHON_CANDIDATES = ["python", "python3", "py"];

export async function checkSyntax(fullPath) {
  const extension = path.extname(fullPath).toLowerCase();

  if (extension === ".py") {
    return checkWithPython(fullPath);
  }

  if (extension === ".js" || extension === ".mjs") {
    return checkWithNode(fullPath);
  }

  return { checked: false, ok: true, message: null };
}

async function checkWithPython(fullPath) {
  for (const command of PYTHON_CANDIDATES) {
    try {
      await execFile(command, ["-m", "py_compile", fullPath], {
        timeout: CHECK_TIMEOUT_MS,
        windowsHide: true
      });
      return { checked: true, ok: true, message: null };
    } catch (error) {
      if (isMissingCommand(error)) {
        continue;
      }

      return { checked: true, ok: false, message: extractErrorText(error) };
    }
  }

  return { checked: false, ok: true, message: null };
}

async function checkWithNode(fullPath) {
  try {
    await execFile(process.execPath, ["--check", fullPath], {
      timeout: CHECK_TIMEOUT_MS,
      windowsHide: true
    });
    return { checked: true, ok: true, message: null };
  } catch (error) {
    return { checked: true, ok: false, message: extractErrorText(error) };
  }
}

function isMissingCommand(error) {
  return error && (error.code === "ENOENT" || error.errno === "ENOENT");
}

function extractErrorText(error) {
  const text = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join("\n").trim();
  return text || "Unknown syntax error.";
}
