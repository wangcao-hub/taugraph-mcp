import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type ChatMessage,
  type ImageResolver,
  type LLMModel,
  type LLMRequest,
  type MessageContent,
  resolveImages,
  type ToolCall,
} from "taugraph/nodes";
import { type OpenAICompatibleOptions, openAICompatible } from "taugraph/openai";

export type { OpenAICompatibleOptions } from "taugraph/openai";

const shown = (url: string): string => (url.length > 100 ? `${url.slice(0, 100)}…` : url);

const needsResolver = (url: string): never => {
  throw new TypeError(`Image "${shown(url)}" needs resolveImage to be read`);
};

type SamplingBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: "tool_result"; toolUseId: string; content: SamplingBlock[]; isError?: boolean };
type MessageBlock = SamplingBlock | ToolUseBlock | ToolResultBlock;
type SamplingMessage = { role: "user" | "assistant"; content: MessageBlock | MessageBlock[] };

/** One block alone, several as an array: clients before MCP 2025-11-25 take single blocks only. */
const one = <T>(blocks: T[]): T | T[] => (blocks.length === 1 ? (blocks[0] as T) : blocks);

/** MCP content blocks for a message's content; images must be base64 by now. */
function toBlocks(content: MessageContent): SamplingBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part): SamplingBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    if ("data" in part) return { type: "image", data: part.data, mimeType: part.mimeType };
    throw new TypeError(
      `MCP sampling takes images as base64 only, but got the URL "${shown(part.url)}"; make resolveImage return { data, mimeType }`,
    );
  });
}

/** taugraph messages as MCP sampling messages: tool calls become tool_use blocks, and consecutive tool results one user message of tool_result blocks. */
function toSamplingMessages(messages: readonly ChatMessage[]): SamplingMessage[] {
  const out: SamplingMessage[] = [];
  let results: ToolResultBlock[] = [];
  const flush = () => {
    if (results.length > 0) out.push({ role: "user", content: one(results) });
    results = [];
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      results.push({
        type: "tool_result",
        toolUseId: m.toolCallId,
        content: toBlocks(m.content),
        ...(m.isError && { isError: true }),
      });
      continue;
    }
    flush();
    if (m.role === "user") {
      out.push({ role: "user", content: one(toBlocks(m.content)) });
      continue;
    }
    const calls = (m.toolCalls ?? []).map(
      (c): ToolUseBlock => ({ type: "tool_use", id: c.id, name: c.name, input: { ...c.arguments } }),
    );
    const text = m.content !== "" || calls.length === 0 ? [{ type: "text" as const, text: m.content }] : [];
    out.push({ role: "assistant", content: one([...text, ...calls]) });
  }
  flush();
  return out;
}

const usesTools = (request: LLMRequest): boolean =>
  (request.tools?.length ?? 0) > 0 ||
  request.messages.some((m) => m.role === "tool" || (m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0));

/**
 * Tools and tool choice for MCP sampling. A choice of one tool becomes that tool alone, required. Without tools,
 * `"auto"` and `"none"` send no tool choice, so clients without `sampling.tools` take the request.
 */
function samplingTools(request: LLMRequest): Record<string, unknown> {
  const tools = (request.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.description && { description: t.description }),
    inputSchema: t.inputSchema,
  }));
  const choice = request.toolChoice;
  if (typeof choice === "object") {
    const only = tools.filter((t) => t.name === choice.name);
    if (only.length === 0)
      throw new TypeError(`toolChoice names "${choice.name}", which is not one of the request's tools`);
    return { tools: only, toolChoice: { mode: "required" } };
  }
  if (tools.length === 0) {
    if (choice === "required") throw new TypeError('toolChoice "required" needs tools in the request');
    return {};
  }
  return { tools, ...(choice !== undefined && { toolChoice: { mode: choice } }) };
}

/**
 * Uses the client's model through MCP sampling (`sampling/createMessage`). The client decides
 * which model runs and may ask the user first. Fails clearly if the client does not support it.
 * `resolveImage` reads image references into base64.
 * MCP sampling has no reasoning setting, so `request.reasoning` is not sent.
 * Tools need a client that declares `sampling.tools` (MCP 2025-11-25); a `toolChoice` of one tool is sent as that tool alone, required.
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
      if (usesTools(request) && !server.getClientCapabilities()?.sampling?.tools) {
        throw new Error(
          "This flow uses tools, but the MCP client does not support tools in sampling (sampling.tools).",
        );
      }
      const messages = await resolveImages(request.messages, options.resolveImage ?? needsResolver);
      const systemPrompt = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const result = await server.createMessage(
        {
          messages: toSamplingMessages(messages),
          maxTokens: request.maxTokens ?? options.maxTokens ?? 1024,
          ...(systemPrompt !== "" && { systemPrompt }),
          ...(request.temperature !== undefined && { temperature: request.temperature }),
          ...samplingTools(request),
        },
        { signal },
      );
      const blocks = (Array.isArray(result.content) ? result.content : [result.content]) as { type: string }[];
      const text = blocks
        .flatMap((c) => (c.type === "text" ? [(c as { type: "text"; text: string }).text] : []))
        .join("");
      const toolCalls = blocks.flatMap((c): ToolCall[] => {
        if (c.type !== "tool_use") return [];
        const use = c as ToolUseBlock;
        return [{ id: use.id, name: use.name, arguments: use.input }];
      });
      return {
        content: text,
        model: result.model,
        ...(result.stopReason && { finishReason: result.stopReason }),
        ...(toolCalls.length > 0 && { toolCalls }),
      };
    },
  };
}

/** Any OpenAI-compatible `/chat/completions` endpoint through `taugraph/openai`: tools, images and reasoning included. */
export function openAICompatibleModel(options: OpenAICompatibleOptions): LLMModel {
  return openAICompatible(options);
}

/** TAUGRAPH_BASE_URL + TAUGRAPH_MODEL (+ TAUGRAPH_API_KEY), or undefined. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): LLMModel | undefined {
  const { TAUGRAPH_BASE_URL: baseURL, TAUGRAPH_MODEL: model, TAUGRAPH_API_KEY: apiKey } = env;
  if (!baseURL || !model) return undefined;
  return openAICompatibleModel({ baseURL, model, ...(apiKey && { apiKey }) });
}
