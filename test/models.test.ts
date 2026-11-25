import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAgent, tool } from "taugraph/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAICompatibleModel, samplingModel } from "../src/models.js";

afterEach(() => vi.unstubAllGlobals());

const signal = new AbortController().signal;
const photo = [
  { type: "text" as const, text: "what is this?" },
  { type: "image" as const, url: "media:a" },
  { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" },
];
const readMedia = () => ({ type: "image" as const, data: "QUJD", mimeType: "image/jpeg" });

function samplingServer(seen: { params?: { messages?: unknown[] } } = {}): Server {
  return {
    getClientCapabilities: () => ({ sampling: {} }),
    createMessage: async (params: { messages?: unknown[] }) => {
      seen.params = params;
      return { role: "assistant", model: "m", content: { type: "text", text: "a cat" } };
    },
  } as unknown as Server;
}

type Params = Record<string, unknown> & { messages?: unknown[] };

/** A fake server whose client may or may not support tools in sampling. */
function toolServer(replies: unknown[], seen: Params[] = [], tools = true): Server {
  return {
    getClientCapabilities: () => ({ sampling: tools ? { tools: {} } : {} }),
    createMessage: async (params: Params) => {
      seen.push(params);
      return replies.shift();
    },
  } as unknown as Server;
}

/** A real MCP server and client over an in-memory transport; the client answers sampling with the given replies. */
async function samplingPair(replies: unknown[], seen: Params[], tools = true): Promise<Server> {
  const server = new Server({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const client = new Client(
    { name: "client", version: "0.0.0" },
    { capabilities: { sampling: tools ? { tools: {} } : {} } },
  );
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    seen.push(request.params as Params);
    return replies.shift() as never;
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return server;
}

const weatherSpec = { name: "weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } };
const weather = tool({ ...weatherSpec, run: (args) => `${String(args.city)}: 晴` });
const text = (t: string) => ({ role: "assistant", model: "m", content: { type: "text", text: t } });

describe("samplingModel", () => {
  it("sends text and images as MCP content blocks", async () => {
    const seen: { params?: { messages?: unknown[] } } = {};
    const reply = await samplingModel(samplingServer(seen), { resolveImage: readMedia }).complete(
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: photo },
        ],
      },
      { signal },
    );
    expect(reply.content).toBe("a cat");
    expect(seen.params?.messages).toEqual([
      { role: "user", content: { type: "text", text: "hi" } },
      { role: "assistant", content: { type: "text", text: "hello" } },
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", data: "QUJD", mimeType: "image/jpeg" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
      },
    ]);
  });

  it("sends a single part as one block", async () => {
    const seen: { params?: { messages?: unknown[] } } = {};
    await samplingModel(samplingServer(seen)).complete(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "user", content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
        ],
      },
      { signal },
    );
    expect(seen.params?.messages).toEqual([
      { role: "user", content: { type: "text", text: "hi" } },
      { role: "user", content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } },
    ]);
  });

  it("needs resolveImage for image references, and base64 from it", async () => {
    await expect(
      samplingModel(samplingServer()).complete({ messages: [{ role: "user", content: photo }] }, { signal }),
    ).rejects.toThrow('Image "media:a" needs resolveImage to be read');
    const toURL = samplingModel(samplingServer(), { resolveImage: () => ({ type: "image", url: "media:b" }) });
    await expect(toURL.complete({ messages: [{ role: "user", content: photo }] }, { signal })).rejects.toThrow(
      'MCP sampling takes images as base64 only, but got the URL "media:b"; make resolveImage return { data, mimeType }',
    );
  });

  it("works with a reasoning level, which MCP sampling has no field for", async () => {
    const seen: { params?: { messages?: unknown[] } } = {};
    const reply = await samplingModel(samplingServer(seen)).complete(
      { messages: [{ role: "user", content: "hi" }], reasoning: "high" },
      { signal },
    );
    expect(reply.content).toBe("a cat");
    expect(seen.params).not.toHaveProperty("reasoning");
  });

  it("needs a client that supports tools in sampling when the flow uses tools", async () => {
    const plain = samplingModel(toolServer([], [], false));
    await expect(
      plain.complete({ messages: [{ role: "user", content: "q" }], tools: [weatherSpec] }, { signal }),
    ).rejects.toThrow("This flow uses tools, but the MCP client does not support tools in sampling (sampling.tools).");
    const seen: Params[] = [];
    const reply = await samplingModel(toolServer([text("hi")], seen, false)).complete(
      { messages: [{ role: "user", content: "q" }] },
      { signal },
    );
    expect(reply.content).toBe("hi");
    expect(seen[0]).not.toHaveProperty("tools");
  });

  it("passes tools and maps tool choices to MCP modes", async () => {
    const seen: Params[] = [];
    const model = samplingModel(toolServer([text("a"), text("b"), text("c"), text("d")], seen));
    const other = { name: "clock", inputSchema: { type: "object" } };
    const ask = (toolChoice: unknown) =>
      model.complete({ messages: [{ role: "user", content: "q" }], tools: [weatherSpec, other], toolChoice } as never, {
        signal,
      });
    await ask("auto");
    await ask("required");
    await ask("none");
    await ask({ name: "clock" });
    expect(seen.map((p) => p.toolChoice)).toEqual([
      { mode: "auto" },
      { mode: "required" },
      { mode: "none" },
      { mode: "required" },
    ]);
    expect(seen[0]?.tools).toEqual([weatherSpec, other]);
    expect(seen[3]?.tools).toEqual([other]);
    await expect(ask({ name: "zzz" })).rejects.toThrow(
      'toolChoice names "zzz", which is not one of the request\'s tools',
    );
  });

  it('sends no tool choice without tools, and refuses "required" without tools', async () => {
    const seen: Params[] = [];
    const model = samplingModel(await samplingPair([text("a"), text("b")], seen, false));
    const ask = (toolChoice: "auto" | "none" | "required") =>
      model.complete({ messages: [{ role: "user", content: "q" }], toolChoice }, { signal });
    expect((await ask("none")).content).toBe("a");
    expect((await ask("auto")).content).toBe("b");
    expect(seen).toHaveLength(2);
    for (const params of seen) {
      expect(params).not.toHaveProperty("toolChoice");
      expect(params).not.toHaveProperty("tools");
    }
    const required = ask("required");
    await expect(required).rejects.toThrow(TypeError);
    await expect(required).rejects.toThrow('toolChoice "required" needs tools in the request');
    expect(seen).toHaveLength(2);
  });

  it("sends tool calls as tool_use blocks and consecutive results as one message of tool_result blocks", async () => {
    const seen: Params[] = [];
    const reply = await samplingModel(
      toolServer(
        [
          {
            role: "assistant",
            model: "m",
            stopReason: "toolUse",
            content: [
              { type: "text", text: "checking" },
              { type: "tool_use", id: "c3", name: "weather", input: { city: "北京" } },
            ],
          },
        ],
        seen,
      ),
    ).complete(
      {
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: "two cities",
            toolCalls: [
              { id: "c1", name: "weather", arguments: { city: "南京" } },
              { id: "c2", name: "weather", arguments: { city: "上海" } },
            ],
          },
          { role: "tool", toolCallId: "c1", content: "晴" },
          { role: "tool", toolCallId: "c2", content: [{ type: "text", text: "down" }], isError: true },
        ],
        tools: [weatherSpec],
      },
      { signal },
    );
    expect(seen[0]?.messages).toEqual([
      { role: "user", content: { type: "text", text: "q" } },
      {
        role: "assistant",
        content: [
          { type: "text", text: "two cities" },
          { type: "tool_use", id: "c1", name: "weather", input: { city: "南京" } },
          { type: "tool_use", id: "c2", name: "weather", input: { city: "上海" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "晴" }] },
          { type: "tool_result", toolUseId: "c2", content: [{ type: "text", text: "down" }], isError: true },
        ],
      },
    ]);
    expect(reply).toEqual({
      content: "checking",
      model: "m",
      finishReason: "toolUse",
      toolCalls: [{ id: "c3", name: "weather", arguments: { city: "北京" } }],
    });
  });

  it("runs a tool loop with createAgent through a real MCP client", async () => {
    const seen: Params[] = [];
    const server = await samplingPair(
      [
        {
          role: "assistant",
          model: "m",
          stopReason: "toolUse",
          content: [{ type: "tool_use", id: "c1", name: "weather", input: { city: "南京" } }],
        },
        { role: "assistant", model: "m", stopReason: "endTurn", content: { type: "text", text: "南京晴" } },
      ],
      seen,
    );
    const { state } = await createAgent({ model: samplingModel(server), tools: [weather] }).run({
      messages: [{ role: "user", content: "南京天气" }],
    });
    expect(state.final).toBe("南京晴");
    expect(seen[0]?.tools).toEqual([weatherSpec]);
    expect(seen[1]?.messages).toEqual([
      { role: "user", content: { type: "text", text: "南京天气" } },
      { role: "assistant", content: { type: "tool_use", id: "c1", name: "weather", input: { city: "南京" } } },
      {
        role: "user",
        content: { type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "南京: 晴" }] },
      },
    ]);
  });
});

describe("openAICompatibleModel", () => {
  it("calls tools through taugraph/openai", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "weather", arguments: '{"city":"南京"}' } }],
            },
          },
        ],
      });
    });
    const reply = await openAICompatibleModel({ baseURL: "http://x/v1", model: "m" }).complete(
      { messages: [{ role: "user", content: "q" }], tools: [weatherSpec], toolChoice: "required" },
      { signal },
    );
    expect(body.tools).toEqual([
      { type: "function", function: { name: "weather", parameters: weatherSpec.inputSchema } },
    ]);
    expect(body.tool_choice).toBe("required");
    expect(reply.toolCalls).toEqual([{ id: "c1", name: "weather", arguments: { city: "南京" } }]);
  });

  it("sends images in OpenAI's format", async () => {
    let body: { messages?: unknown[] } = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: "a cat" } }] });
    });
    const model = openAICompatibleModel({ baseURL: "http://x/v1", model: "m", resolveImage: readMedia });
    const content = [...photo, { type: "image" as const, url: "https://x/b.png" }];
    await model.complete({ messages: [{ role: "user", content }] }, { signal });
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "image_url", image_url: { url: "https://x/b.png" } },
        ],
      },
    ]);
    const plain = openAICompatibleModel({ baseURL: "http://x/v1", model: "m" });
    await expect(plain.complete({ messages: [{ role: "user", content }] }, { signal })).rejects.toThrow(
      'Image "media:a" needs resolveImage to be read',
    );
    const toURL = openAICompatibleModel({
      baseURL: "http://x/v1",
      model: "m",
      resolveImage: () => ({ type: "image", url: "media:b" }),
    });
    await expect(toURL.complete({ messages: [{ role: "user", content }] }, { signal })).rejects.toThrow(
      'Image "media:b" cannot be sent as a URL; make resolveImage return { data, mimeType } or an http(s) URL',
    );
  });

  it("asks for a reasoning level, reads what the model thought, and sends only OpenAI's fields", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        choices: [{ message: { content: "ok", reasoning_content: "hmm" } }],
        usage: { prompt_tokens: 1, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 3 } },
      });
    });
    const model = openAICompatibleModel({ baseURL: "http://x/v1", model: "m" });
    const reply = await model.complete(
      {
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a", model: "x", reasoning: [{ text: "r" }] },
        ],
        reasoning: "off",
      },
      { signal },
    );
    expect(body.reasoning_effort).toBe("none");
    expect(body.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    expect(reply.reasoning).toEqual([{ text: "hmm" }]);
    expect(reply.usage).toEqual({ inputTokens: 1, outputTokens: 4, reasoningTokens: 3 });
    const custom = openAICompatibleModel({
      baseURL: "http://x/v1",
      model: "m",
      reasoningParams: () => ({ chat_template_kwargs: { enable_thinking: false } }),
    });
    await custom.complete({ messages: [{ role: "user", content: "q" }], reasoning: "off" }, { signal });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("sends no reasoning setting when the request has no level", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    await openAICompatibleModel({ baseURL: "http://x/v1", model: "m" }).complete(
      { messages: [{ role: "user", content: "q" }] },
      { signal },
    );
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("leaves reasoningTokens out when the provider does not count them", async () => {
    const replies = [
      { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: null } },
      { prompt_tokens: 1, completion_tokens: 2 },
    ];
    for (const usage of replies) {
      vi.stubGlobal("fetch", async () => Response.json({ choices: [{ message: { content: "ok" } }], usage }));
      const reply = await openAICompatibleModel({ baseURL: "http://x/v1", model: "m" }).complete(
        { messages: [{ role: "user", content: "q" }] },
        { signal },
      );
      expect(reply.usage).toStrictEqual({ inputTokens: 1, outputTokens: 2 });
    }
  });
});
