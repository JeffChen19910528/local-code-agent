export function createOllamaProvider(config) {
  return {
    name: "ollama",
    async chat(messages) {
      ensureModel(config);
      const response = await fetch(joinUrl(config.ollamaBaseUrl, "/api/chat"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: false,
          think: false,
          options: {
            temperature: config.temperature,
            num_ctx: config.ollamaNumCtx ?? 32768
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.status} ${response.statusText}${await describeErrorBody(response)}`);
      }

      const data = await response.json();
      return {
        content: data?.message?.content ?? "",
        usage: {
          promptTokens: data?.prompt_eval_count ?? null,
          completionTokens: data?.eval_count ?? null
        }
      };
    },
    async listModels() {
      const response = await fetch(joinUrl(config.ollamaBaseUrl, "/api/tags"));
      if (!response.ok) {
        throw new Error(`Ollama list models failed: ${response.status} ${response.statusText}${await describeErrorBody(response)}`);
      }

      const data = await response.json();
      return (data.models ?? []).map((item) => item.name);
    }
  };
}

// Ollama returns a JSON body like {"error":"..."} even on 4xx/5xx responses, with the actual
// cause (bad model name, template error, out of memory, etc). The status line alone ("500
// Internal Server Error") is not actionable, so surface the body text whenever present.
async function describeErrorBody(response) {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
        return ` - ${parsed.error.trim()}`;
      }
    } catch {
      // Not JSON; fall through to raw text below.
    }

    return ` - ${text.slice(0, 500)}`;
  } catch {
    return "";
  }
}

function ensureModel(config) {
  if (!config.model) {
    throw new Error("A model is required. Set --model or LOCAL_CODE_MODEL.");
  }
}

function joinUrl(baseUrl, pathname) {
  return new URL(pathname, ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
