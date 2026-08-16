const LIST_MODELS_TIMEOUT_MS = 15000;

export function createLmStudioProvider(config) {
  return {
    name: "lmstudio",
    async chat(messages) {
      ensureModel(config);
      const response = await fetchWithTimeout(
        joinUrl(config.lmStudioBaseUrl, "/v1/chat/completions"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: config.temperature
          })
        },
        config.requestTimeoutMs ?? 180000
      );

      if (!response.ok) {
        throw new Error(`LM Studio request failed: ${response.status} ${response.statusText}${await describeErrorBody(response)}`);
      }

      const data = await response.json();
      return {
        content: data?.choices?.[0]?.message?.content ?? "",
        usage: {
          promptTokens: data?.usage?.prompt_tokens ?? null,
          completionTokens: data?.usage?.completion_tokens ?? null
        }
      };
    },
    async listModels() {
      const response = await fetchWithTimeout(joinUrl(config.lmStudioBaseUrl, "/v1/models"), {}, LIST_MODELS_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(`LM Studio list models failed: ${response.status} ${response.statusText}${await describeErrorBody(response)}`);
      }

      const data = await response.json();
      return (data.data ?? []).map((item) => item.id);
    }
  };
}

// Mirrors the same protection in the Ollama provider: without a timeout, a stuck local
// server (no response, no error) hangs the whole CLI forever with no feedback.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `LM Studio request timed out after ${Math.round(timeoutMs / 1000)}s with no response. This usually means the local server is stuck. Try restarting the local server in LM Studio, or reloading the model.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// LM Studio's OpenAI-compatible API returns {"error":{"message":"..."}} on failure; the
// status line alone doesn't say why the request failed, so surface the body text too.
async function describeErrorBody(response) {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }

    try {
      const parsed = JSON.parse(text);
      const message = parsed?.error?.message ?? parsed?.error;
      if (typeof message === "string" && message.trim()) {
        return ` - ${message.trim()}`;
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
