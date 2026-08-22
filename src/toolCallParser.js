// Parses <tool_call> blocks out of a model's reply and tolerates the malformed JSON that
// weaker local models tend to emit (unescaped newlines/quotes, truncated output, etc).
// Kept independent of the agent loop so it can be tested and reasoned about in isolation.

export function extractToolCall(content) {
  const match = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!match) {
    return null;
  }

  const raw = match[1];
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (firstError) {
    try {
      payload = JSON.parse(repairControlCharacters(raw));
    } catch {
      let repaired = lenientParseToolCall(raw);
      if (repaired === null) {
        const repairedRaw = tryExtractLargeContent(raw);
        if (repairedRaw !== null) {
          try {
            repaired = JSON.parse(repairedRaw);
          } catch {
            repaired = null;
          }
        }
      }
      payload = repaired;
      if (payload === null) {
        throw new Error(`Invalid tool call JSON: ${firstError.message}`);
      }
    }
  }

  if (!payload || typeof payload.tool !== "string") {
    throw new Error("Tool call must include a string 'tool' field.");
  }

  return {
    tool: payload.tool,
    args: payload.args ?? {}
  };
}

// Some local models emit literal control characters (raw newlines/tabs) inside
// JSON string values instead of escaping them, which JSON.parse rejects. Auto-fix
// that common case before giving up and asking the model to retry.
function repairControlCharacters(raw) {
  return raw.replace(/[\x00-\x1f]/g, (char) => {
    switch (char) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return "";
    }
  });
}

// Walk a raw JSON string value (the text between the outer quotes, not yet parsed),
// undoing any JSON escape sequences the model may have partially emitted so that
// JSON.stringify can re-encode everything cleanly from scratch.
function unescapeJsonStringValue(raw) {
  let result = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      switch (next) {
        case '"': result += '"'; i += 2; break;
        case "\\": result += "\\"; i += 2; break;
        case "n": result += "\n"; i += 2; break;
        case "r": result += "\r"; i += 2; break;
        case "t": result += "\t"; i += 2; break;
        case "u": {
          const hex = raw.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            result += "\\";
            i++;
          }
          break;
        }
        default:
          result += "\\" + next;
          i += 2;
          break;
      }
    } else {
      result += raw[i];
      i++;
    }
  }
  return result;
}

// Last-resort repair for weak local models: reparses the tool call by hand, tolerant of
// unescaped quotes/newlines inside ANY string argument (not just write_file/append_file's
// "content"), and independent of key order. Only kicks in once JSON.parse and the narrower
// repairs above have already failed. Walks the args object field by field; for each string
// value it scans forward for the first unescaped `"` that is plausibly a real terminator
// (immediately followed by `,"nextKey":` or by `}`) rather than stopping at the first quote,
// which is what breaks JSON.parse when the model forgets to escape a quote mid-content.
function lenientParseToolCall(raw) {
  const toolMatch = raw.match(/"tool"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (!toolMatch) return null;
  const tool = unescapeJsonStringValue(toolMatch[1]);

  const argsKeyMatch = raw.match(/"args"\s*:\s*\{/);
  if (!argsKeyMatch) return null;

  let i = argsKeyMatch.index + argsKeyMatch[0].length;
  const args = {};
  let firstField = true;

  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (i >= raw.length) return null;
    if (raw[i] === "}") {
      i += 1;
      return { tool, args };
    }

    if (!firstField) {
      if (raw[i] !== ",") return null;
      i += 1;
      while (i < raw.length && /\s/.test(raw[i])) i += 1;
    }
    firstField = false;

    const keyMatch = raw.slice(i).match(/^"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*/);
    if (!keyMatch) return null;
    const key = keyMatch[1];
    i += keyMatch[0].length;

    if (raw[i] === '"') {
      const start = i + 1;
      const end = findLenientStringEnd(raw, start);
      if (end === -1) return null;
      args[key] = unescapeJsonStringValue(raw.slice(start, end));
      i = end + 1;
    } else if (raw[i] === "[") {
      const end = findMatchingBracket(raw, i, "[", "]");
      if (end === -1) return null;
      try {
        args[key] = JSON.parse(raw.slice(i, end + 1));
      } catch {
        return null;
      }
      i = end + 1;
    } else if (raw[i] === "{") {
      const end = findMatchingBracket(raw, i, "{", "}");
      if (end === -1) return null;
      try {
        args[key] = JSON.parse(raw.slice(i, end + 1));
      } catch {
        return null;
      }
      i = end + 1;
    } else {
      const tokenMatch = raw.slice(i).match(/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
      if (!tokenMatch) return null;
      args[key] = JSON.parse(tokenMatch[1]);
      i += tokenMatch[0].length;
    }
  }

  return null;
}

// Finds the end of a lenient string value starting right after its opening quote: the first
// unescaped `"` that looks like a genuine terminator (followed by `,"nextKey":` or `}`),
// rather than the first unescaped quote encountered (which may just be inside the content).
function findLenientStringEnd(raw, start) {
  let i = start;
  while (i < raw.length) {
    if (raw[i] === '"') {
      let backslashes = 0;
      let j = i - 1;
      while (j >= start - 1 && raw[j] === "\\") {
        backslashes += 1;
        j -= 1;
      }
      if (backslashes % 2 === 0) {
        const rest = raw.slice(i + 1);
        if (/^\s*(,\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:|\})/.test(rest)) {
          return i;
        }
      }
    }
    i += 1;
  }
  return -1;
}

// Finds the index of the bracket/brace matching the one at `start`, treating quoted strings
// (with JSON escaping) as opaque so brackets inside string content don't confuse the count.
function findMatchingBracket(raw, start, open, close) {
  let depth = 0;
  let i = start;
  while (i < raw.length) {
    const char = raw[i];
    if (char === '"') {
      i += 1;
      while (i < raw.length) {
        if (raw[i] === "\\") {
          i += 2;
          continue;
        }
        if (raw[i] === '"') break;
        i += 1;
      }
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

// Some local models emit unescaped double quotes inside write_file/append_file content,
// producing JSON that neither JSON.parse nor repairControlCharacters can salvage.
// Heuristic: locate the content value by anchoring on the structural "}} closing at the
// end, undo any partial escaping the model already emitted, then re-encode via JSON.stringify.
function tryExtractLargeContent(raw) {
  const toolMatch = raw.match(/"tool"\s*:\s*"(write_file|append_file)"/);
  if (!toolMatch) return null;
  const tool = toolMatch[1];

  const pathMatch = raw.match(/"path"\s*:\s*"([^"\\]*)"/);
  if (!pathMatch) return null;
  const filePath = pathMatch[1];

  const contentKeyIdx = raw.indexOf('"content"');
  if (contentKeyIdx === -1) return null;
  const colonIdx = raw.indexOf(":", contentKeyIdx + 9);
  if (colonIdx === -1) return null;
  const openQuoteIdx = raw.indexOf('"', colonIdx + 1);
  if (openQuoteIdx === -1) return null;
  const contentStart = openQuoteIdx + 1;

  // The JSON ends with " (closing content string) followed by two closing braces.
  // Match the last such pattern so inner occurrences of "}} in code don't confuse us.
  const closingMatch = raw.match(/"(?:\s*\}){2}\s*$/);
  if (!closingMatch) return null;
  const contentEnd = closingMatch.index;

  if (contentEnd <= contentStart) return null;

  const rawContent = raw.slice(contentStart, contentEnd);
  const properContent = unescapeJsonStringValue(rawContent);
  const repaired = JSON.stringify({ tool, args: { path: filePath, content: properContent } });

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

export function isTruncatedToolCall(content) {
  return /<tool_call>/i.test(content) && !/<\/tool_call>/i.test(content);
}

// Weaker local models sometimes announce an action ("let me check...", "讓我看看...")
// instead of actually issuing a <tool_call>, then stop - the harness would otherwise treat
// that announcement as the final answer. Heuristic: short reply, no tool_call, and it ends
// on an intent phrase rather than a completed statement.
const INTENT_PHRASE = /(讓我|我來|我將|我會|首先讓我|接下來我|我先|我需要先|let me |i will |i'll |i am going to |i'm going to |first,? i |i need to first)/i;

export function isUnfinishedIntent(content) {
  if (!content || content.length > 200) return false;
  if (/<tool_call>/i.test(content)) return false;
  return INTENT_PHRASE.test(content);
}
