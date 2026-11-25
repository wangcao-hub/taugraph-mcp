import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { MaybePromise } from "taugraph";
import {
  type ContentPart,
  type ImagePart,
  type ImageResolver,
  type LLMModel,
  type LLMRequest,
  type MessageContent,
  type ReasoningLevel,
  resolveImages,
} from "taugraph/nodes";

const shown = (url: string): string => (url.length > 100 ? `${url.slice(0, 100)}…` : url);

const needsResolver = (url: string): never => {
  throw new TypeError(`Image "${shown(url)}" needs resolveImage to be read`);
};

type SamplingBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** MCP sampling content: one block alone (plain text or a single part), otherwise text and image blocks in order. */
function toSamplingContent(content: MessageContent): SamplingBlock | SamplingBlock[] {
  if (typeof content === "string") return { type: "text", text: content };
  const blocks = content.map((part): SamplingBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    if ("data" in part) return { type: "image", data: part.data, mimeType: part.mimeType };
    throw new TypeError(
      `MCP sampling takes images as base64 only, but got the URL "${shown(part.url)}"; make resolveImage return { data, mimeType }`,
    );
  });
  return blocks.length === 1 ? (blocks[0] as SamplingBlock) : blocks;
}

/**
 * Uses the client's model through MCP sampling (`sampling/createMessage`). The client decides
 * which model runs and may ask the user first. Fails clearly if the client does not support it.
 * `resolveImage` reads image references into base64.
 * MCP sampling has no reasoning setting, so `request.reasoning` is not sent.
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
      const messages = await resolveImages(request.messages, options.resolveImage ?? needsResolver);
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
  /** Request parameters for a reasoning level. Default: `{ reasoning_effort }`, with "off" sent as "none". */
  readonly reasoningParams?: (level: ReasoningLevel) => Record<string, unknown>;
}

/** URLs OpenAI takes as they are. */
const SENDABLE = /^(https?|data):/i;

function toOpenAIPart(part: ContentPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  if ("data" in part) return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
  if (!SENDABLE.test(part.url)) {
    throw new TypeError(
      `Image "${shown(part.url)}" cannot be sent as a URL; make resolveImage return { data, mimeType } or an http(s) URL`,
    );
  }
  return { type: "image_url", image_url: { url: part.url } };
}

const defaultReasoningParams = (level: ReasoningLevel): Record<string, unknown> => ({
  reasoning_effort: level === "off" ? "none" : level,
});

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
      const messages = (await resolveImages(request.messages, readImage)).map((m) => {
        if (m.role === "user" && typeof m.content !== "string") {
          return { role: "user", content: m.content.map(toOpenAIPart) };
        }
        // taugraph's own fields (`model`, `reasoning`, `toolCalls`) are not OpenAI's; strict endpoints refuse them
        if (m.role === "system" || m.role === "assistant") return { role: m.role, content: m.content };
        return m;
      });
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
          ...(request.reasoning && (options.reasoningParams ?? defaultReasoningParams)(request.reasoning)),
        }),
      });
      if (!response.ok)
        throw new Error(`${url} responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = (await response.json()) as {
        model?: string;
        choices?: {
          message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
          finish_reason?: string;
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
      const choice = body.choices?.[0];
      const message = choice?.message;
      const thought = message?.reasoning_content || message?.reasoning;
      const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens;
      return {
        content: message?.content ?? "",
        ...(body.model && { model: body.model }),
        ...(choice?.finish_reason && { finishReason: choice.finish_reason }),
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          ...(typeof reasoningTokens === "number" && { reasoningTokens }),
        },
        ...(thought && { reasoning: [{ text: thought }] }),
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
