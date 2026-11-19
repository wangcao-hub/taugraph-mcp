import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { LLMModel, LLMRequest } from "taugraph/nodes";

/**
 * Uses the client's model through MCP sampling (`sampling/createMessage`). The client decides
 * which model runs and may ask the user first. Fails clearly if the client does not support it.
 */
export function samplingModel(server: Server, options: { maxTokens?: number } = {}): LLMModel {
  return {
    id: "mcp:sampling",
    async complete(request: LLMRequest, { signal }) {
      if (!server.getClientCapabilities()?.sampling) {
        throw new Error(
          "This flow needs a model, but the MCP client does not support sampling. Start taugraph-mcp with TAUGRAPH_BASE_URL and TAUGRAPH_MODEL set.",
        );
      }
      const systemPrompt = request.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const result = await server.createMessage(
        {
          messages: request.messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              content: { type: "text" as const, text: m.content },
            })),
          maxTokens: request.maxTokens ?? options.maxTokens ?? 1024,
          ...(systemPrompt !== "" && { systemPrompt }),
          ...(request.temperature !== undefined && { temperature: request.temperature }),
        },
        { signal },
      );
      const content = result.content;
      const text = Array.isArray(content)
        ? content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
        : content.type === "text"
          ? content.text
          : "";
      return { content: text, model: result.model, ...(result.stopReason && { finishReason: result.stopReason }) };
    },
  };
}

export interface OpenAICompatibleOptions {
  /** e.g. "https://api.openai.com/v1", or "http://localhost:11434/v1" for Ollama. */
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string;
}

/** Any OpenAI-compatible `/chat/completions` endpoint: OpenAI, Ollama, vLLM, DeepSeek, Qwen, ... */
export function openAICompatibleModel(options: OpenAICompatibleOptions): LLMModel {
  const url = `${options.baseURL.replace(/\/+$/, "")}/chat/completions`;
  return {
    id: `openai-compatible:${options.model}`,
    async complete(request, { signal }) {
      const response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(options.apiKey && { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify({
          model: options.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          ...(request.responseFormat === "json" && { response_format: { type: "json_object" } }),
        }),
      });
      if (!response.ok)
        throw new Error(`${url} responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = (await response.json()) as {
        model?: string;
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = body.choices?.[0];
      return {
        content: choice?.message?.content ?? "",
        ...(body.model && { model: body.model }),
        ...(choice?.finish_reason && { finishReason: choice.finish_reason }),
        usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
      };
    },
  };
}

/** TAUGRAPH_BASE_URL + TAUGRAPH_MODEL (+ TAUGRAPH_API_KEY), or undefined. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): LLMModel | undefined {
  const { TAUGRAPH_BASE_URL: baseURL, TAUGRAPH_MODEL: model, TAUGRAPH_API_KEY: apiKey } = env;
  if (!baseURL || !model) return undefined;
  return openAICompatibleModel({ baseURL, model, ...(apiKey && { apiKey }) });
}
