export function createLmStudioProvider(config) {
  return {
    name: "lmstudio",
    async chat(messages) {
      ensureModel(config);
      const response = await fetch(joinUrl(config.lmStudioBaseUrl, "/v1/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: config.temperature
        })
      });

      if (!response.ok) {
        throw new Error(`LM Studio request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return {
        content: data?.choices?.[0]?.message?.content ?? ""
      };
    },
    async listModels() {
      const response = await fetch(joinUrl(config.lmStudioBaseUrl, "/v1/models"));
      if (!response.ok) {
        throw new Error(`LM Studio list models failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return (data.data ?? []).map((item) => item.id);
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
