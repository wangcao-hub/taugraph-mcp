import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
});

describe("openAICompatibleModel", () => {
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
