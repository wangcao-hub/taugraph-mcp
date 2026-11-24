import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { MaybePromise } from "taugraph";
import {
  type ContentPart,
  type ImagePart,
  type ImageResolver,
  type LLMModel,
  type LLMRequest,
  type MessageContent,
  resolveImages,
} from "taugraph/nodes";

const shown = (url: string): string => (url.length > 100 ? `${url.slice(0, 100)}…` : url);

type SamplingBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** MCP sampling content: one text block for plain text, otherwise text and image blocks in order. */
function toSamplingContent(content: MessageContent): SamplingBlock | SamplingBlock[] {
  if (typeof content === "string") return { type: "text", text: content };
  return content.map((part): SamplingBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    if ("data" in part) return { type: "image", data: part.data, mimeType: part.mimeType };
    throw new TypeError(`MCP sampling needs image bytes, but got the URL "${shown(part.url)}"; pass resolveImage`);
  });
}

/**
 * Uses the client's model through MCP sampling (`sampling/createMessage`). The client decides
 * which model runs and may ask the user first. Fails clearly if the client does not support it.
 * `resolveImage` reads image references into base64.
 */
export function samplingModel(
  server: Server,
  options: { maxTokens?: number; resolveImage?: ImageResolver } = {},
): LLMModel {
  return {
    id: "mcp:sampling",
    async complete(request: LLMRequest, { signal }) {
      if (!server.getClientCapabilities()?.sampling) {
        throw new Error(
          "This flow needs a model, but the MCP client does not support sampling. Start taugraph-mcp with TAUGRAPH_BASE_URL and TAUGRAPH_MODEL set.",
        );
      }
      const messages = await resolveImages(request.messages, options.resolveImage);
      const systemPrompt = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const result = await server.createMessage(
        {
          messages: messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              content: toSamplingContent(m.content),
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
  /** Reads image URLs other than http(s) and data:, e.g. `media:abc` from your store. */
  readonly resolveImage?: ImageResolver;
}

function toOpenAIPart(part: ContentPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  const url = "data" in part ? `data:${part.mimeType};base64,${part.data}` : part.url;
  return { type: "image_url", image_url: { url } };
}

/** Any OpenAI-compatible `/chat/completions` endpoint: OpenAI, Ollama, vLLM, DeepSeek, Qwen, ... */
export function openAICompatibleModel(options: OpenAICompatibleOptions): LLMModel {
  const url = `${options.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const readImage = (image: string): MaybePromise<ImagePart> => {
    if (/^https?:/i.test(image)) return { type: "image", url: image };
    if (!options.resolveImage) throw new TypeError(`Image "${shown(image)}" needs resolveImage to be read`);
    return options.resolveImage(image);
  };
  return {
    id: `openai-compatible:${options.model}`,
    async complete(request, { signal }) {
      const messages = (await resolveImages(request.messages, readImage)).map((m) =>
        m.role === "user" && typeof m.content !== "string" ? { role: "user", content: m.content.map(toOpenAIPart) } : m,
      );
      const response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(options.apiKey && { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify({
          model: options.model,
          messages,
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
