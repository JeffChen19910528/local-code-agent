#!/usr/bin/env node
const isGlobal = process.env.npm_config_global === "true";

if (isGlobal) {
  console.log("");
  console.log("local-code-agent installed globally. Run `local-code chat` from any folder to start.");
  console.log("");
} else {
  console.log("");
  console.log("local-code-agent installed locally (not global), so `local-code` is not on your PATH yet.");
  console.log("Run it with: npx local-code chat");
  console.log("Or install globally instead: npm install -g @jc20231028/local-code-agent");
  console.log("");
}
