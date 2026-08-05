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
          options: {
            temperature: config.temperature,
            num_ctx: config.ollamaNumCtx ?? 8192
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return {
        content: data?.message?.content ?? ""
      };
    },
    async listModels() {
      const response = await fetch(joinUrl(config.ollamaBaseUrl, "/api/tags"));
      if (!response.ok) {
        throw new Error(`Ollama list models failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return (data.models ?? []).map((item) => item.name);
    }
  };
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
