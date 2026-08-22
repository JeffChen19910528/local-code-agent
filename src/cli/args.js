export function parseArgs(argv) {
  const command = argv[0] || "help";
  const options = {};
  const positionals = [];

  for (let index = 1; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      positionals.push(current);
      continue;
    }

    const name = current.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      options[camelCase(name)] = true;
      continue;
    }

    options[camelCase(name)] = next;
    index += 1;
  }

  return {
    command,
    prompt: positionals.join(" "),
    positionals,
    options
  };
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
