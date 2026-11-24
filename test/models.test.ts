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

  it("needs resolveImage for image references", async () => {
    await expect(
      samplingModel(samplingServer()).complete({ messages: [{ role: "user", content: photo }] }, { signal }),
    ).rejects.toThrow(/no resolver for image URL "media:a"/);
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
    await expect(plain.complete({ messages: [{ role: "user", content }] }, { signal })).rejects.toThrow(/media:a/);
  });
});
