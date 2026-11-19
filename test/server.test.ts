import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraph } from "taugraph";
import { CodeNode, HumanNode, LLMNode } from "taugraph/nodes";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFlow, fileStore, memoryStore } from "../src/index.js";
import { connect } from "./helpers.js";

const State = z.object({
  item: z.string(),
  answer: z.string().nullable().default(null),
  orderId: z.string().nullable().default(null),
});
type State = z.infer<typeof State>;

function buyFlow(options: { onPlace?: () => void; askOptions?: string[]; slowWrite?: boolean } = {}) {
  const placed: string[] = [];
  const flow = defineFlow({
    name: "buy",
    description: "Buy an item after the user confirms",
    input: z.object({ item: z.string() }),
    summarize: (s: State) => `bought ${s.item} as ${s.orderId}`,
    graph: () =>
      createGraph(State, {
        start: "ask",
        nodes: {
          ask: HumanNode<State, string>({
            ask: (s) => ({ text: `Buy ${s.item}?`, ...(options.askOptions && { options: options.askOptions }) }),
            update: (s, answer) => ({ ...s, answer }),
          }),
          place: CodeNode<State>(
            async (s) => {
              if (options.slowWrite) await new Promise((r) => setTimeout(r, 20)); // lets two calls interleave
              options.onPlace?.();
              placed.push(s.item);
              return { ...s, orderId: `o-${placed.length}` };
            },
            { effect: "write" },
          ),
          skip: CodeNode<State>((s) => s),
        },
        conditionalEdges: [
          { from: "ask", route: (s) => (s.answer?.toLowerCase().startsWith("yes") ? "place" : "skip") },
        ],
        endNodes: ["place", "skip"],
      }),
  });
  return { flow, placed };
}

describe("tools", () => {
  it("lists a start tool, a resume tool and taugraph_runs with JSON schemas", async () => {
    const { client, close } = await connect([buyFlow().flow]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["buy", "buy_resume", "taugraph_runs"]);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { item: { type: "string" } },
      required: ["item"],
    });
    expect(tools[0]?.outputSchema).toMatchObject({ properties: { runId: { type: "string" } } });
    expect(tools[1]?.inputSchema).toMatchObject({ properties: { runId: {}, answer: {} }, required: ["runId"] });
    expect((client.getInstructions() ?? "").toLowerCase()).toContain("never answer on the user's behalf");
    await close();
  });

  it("validates tool arguments against the flow's input schema", async () => {
    const { call, close } = await connect([buyFlow().flow]);
    const result = await call("buy", { item: 42 });
    expect(result.isError).toBe(true);
    await close();
  });
});

describe("without elicitation (headless agents)", () => {
  it("returns the question, then finishes through <flow>_resume", async () => {
    const { flow, placed } = buyFlow();
    const { call, close } = await connect([flow]);
    const first = await call("buy", { item: "pen" });
    expect(first.structuredContent).toMatchObject({ status: "paused", path: ["ask"], question: { text: "Buy pen?" } });
    expect(first.content[0]?.text).toContain("Do not answer for them");
    const runId = first.structuredContent?.runId ?? "";

    const done = await call("buy_resume", { runId, answer: "yes please" });
    expect(done.structuredContent).toMatchObject({
      status: "completed",
      path: ["ask", "place"],
      summary: "bought pen as o-1",
    });
    expect(done.content[0]?.text).toBe("bought pen as o-1");
    expect(placed).toEqual(["pen"]);

    const again = await call("buy_resume", { runId, answer: "yes" });
    expect(again.isError).toBe(true);
    expect(again.content[0]?.text).toMatch(/already finished/);
    expect(placed).toEqual(["pen"]);
    await close();
  });

  it("requires an answer for a paused run and rejects unknown or malformed runIds", async () => {
    const { call, close } = await connect([buyFlow().flow]);
    const first = await call("buy", { item: "pen" });
    expect((await call("buy_resume", { runId: first.structuredContent?.runId })).content[0]?.text).toMatch(
      /waiting for the user's answer/,
    );
    expect((await call("buy_resume", { runId: "nope", answer: "yes" })).content[0]?.text).toMatch(/No buy run nope/);
    expect((await call("buy_resume", { runId: "../../etc/passwd", answer: "yes" })).content[0]?.text).toMatch(
      /Invalid runId/,
    );
    await close();
  });

  it("resumes a run only once when the same answer arrives twice at the same time", async () => {
    const { flow, placed } = buyFlow({ slowWrite: true });
    const { call, close } = await connect([flow]);
    const runId = (await call("buy", { item: "pen" })).structuredContent?.runId ?? "";
    const [a, b] = await Promise.all([
      call("buy_resume", { runId, answer: "yes" }),
      call("buy_resume", { runId, answer: "yes" }),
    ]);
    expect([a.structuredContent?.status, b.isError]).toEqual(["completed", true]);
    // The second call waits for the first and is told the truth, not "interrupted".
    expect(b.content[0]?.text).toMatch(/already finished/);
    expect(placed).toEqual(["pen"]);
    await close();
  });

  it("lists paused runs with their question", async () => {
    const { call, close } = await connect([buyFlow().flow]);
    const first = await call("buy", { item: "pen" });
    const runs = JSON.parse((await call("taugraph_runs", { status: "paused" })).content[0]?.text ?? "[]");
    expect(runs).toEqual([
      expect.objectContaining({
        flow: "buy",
        runId: first.structuredContent?.runId,
        status: "paused",
        question: { text: "Buy pen?" },
      }),
    ]);
    await close();
  });
});

describe("with elicitation", () => {
  it("asks the user through the client and finishes in one call", async () => {
    const asked: unknown[] = [];
    const { flow, placed } = buyFlow({ askOptions: ["yes", "no"] });
    const { call, close } = await connect(
      [flow],
      {},
      {
        elicit: (message, schema) => {
          asked.push({ message, schema });
          return { action: "accept", content: { answer: "yes" } };
        },
      },
    );
    const done = await call("buy", { item: "pen" });
    expect(done.structuredContent?.status).toBe("completed");
    expect(asked).toEqual([
      {
        message: "Buy pen?",
        schema: expect.objectContaining({ properties: { answer: expect.objectContaining({ enum: ["yes", "no"] }) } }),
      },
    ]);
    expect(placed).toEqual(["pen"]);
    await close();
  });

  it("hands the question to the agent when the user declines the form", async () => {
    const { call, close } = await connect([buyFlow().flow], {}, { elicit: () => ({ action: "decline" }) });
    const first = await call("buy", { item: "pen" });
    expect(first.structuredContent?.status).toBe("paused");
    await close();
  });
});

describe("models", () => {
  const classify = (model: Parameters<typeof LLMNode>[0]["model"]) =>
    createGraph(State, {
      start: "llm",
      nodes: {
        llm: LLMNode<State, { ok: boolean }>({
          model,
          prompt: (s) => ({
            messages: [
              { role: "system", content: "judge" },
              { role: "user", content: s.item },
            ],
          }),
          output: z.object({ ok: z.boolean() }),
          update: (s, out) => ({ ...s, answer: String(out.ok) }),
        }),
      },
      endNodes: ["llm"],
    });
  const flow = defineFlow({
    name: "judge",
    description: "judge",
    input: z.object({ item: z.string() }),
    graph: (env) => classify(env.model),
  });

  it("uses the client's model through MCP sampling", async () => {
    const seen: unknown[] = [];
    const { call, close } = await connect(
      [flow],
      {},
      {
        sample: (messages, systemPrompt) => {
          seen.push({ messages, systemPrompt });
          return '{"ok": true}';
        },
      },
    );
    const done = await call("judge", { item: "pen" });
    expect(done.structuredContent?.status).toBe("completed");
    expect(seen).toEqual([
      { systemPrompt: "judge", messages: [{ role: "user", content: { type: "text", text: "pen" } }] },
    ]);
    await close();
  });

  it("explains how to configure a model when the client has no sampling", async () => {
    const { call, close } = await connect([flow]);
    const result = await call("judge", { item: "pen" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/TAUGRAPH_BASE_URL/);
    await close();
  });
});

describe("file store", () => {
  it("survives a server restart and writes every event before the next step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taugraph-mcp-"));
    let fileDuringWrite = "";
    const { flow, placed } = buyFlow({ onPlace: () => (fileDuringWrite = readFileSync(file(), "utf8")) });
    let runId = "";
    const file = () => join(dir, "buy", `${runId}.jsonl`);

    const first = await connect([flow], { store: fileStore(dir) });
    runId = (await first.call("buy", { item: "pen" })).structuredContent?.runId ?? "";
    await first.close();

    const second = await connect([flow], { store: fileStore(dir) }); // a new process, same directory
    const done = await second.call("buy_resume", { runId, answer: "yes" });
    expect(done.structuredContent?.status).toBe("completed");
    expect(fileDuringWrite.trim().split("\n").at(-1)).toContain('"effect":"write"'); // write-ahead
    expect(placed).toEqual(["pen"]);
    await second.close();
  });

  it("never retries a write that was interrupted, and recovers interrupted read steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taugraph-mcp-"));
    const { flow, placed } = buyFlow();
    const s1 = await connect([flow], { store: fileStore(dir) });
    const runId = (await s1.call("buy", { item: "pen" })).structuredContent?.runId ?? "";
    await s1.call("buy_resume", { runId, answer: "yes" });
    await s1.close();

    // Crash during the write: keep the file up to the write step's enter event.
    const path = join(dir, "buy", `${runId}.jsonl`);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const cut = lines.findIndex((l) => l.includes('"type":"enter"') && l.includes('"effect":"write"'));
    writeFileSync(path, `${lines.slice(0, cut + 1).join("\n")}\n`);

    const s2 = await connect([flow], { store: fileStore(dir) });
    const runs = JSON.parse((await s2.call("taugraph_runs", { status: "interrupted" })).content[0]?.text ?? "[]");
    expect(runs.map((r: { runId: string }) => r.runId)).toEqual([runId]);
    const result = await s2.call("buy_resume", { runId });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/may or may not have taken effect/);
    expect(placed).toEqual(["pen"]);
    await s2.close();

    // Crash during a read step: resume continues it.
    const readCut = lines.findIndex((l) => l.includes('"type":"resume"'));
    writeFileSync(path, `${lines.slice(0, readCut + 1).join("\n")}\n`);
    const s3 = await connect([flow], { store: fileStore(dir) });
    // Agents often pass an answer anyway; for an interrupted run it is ignored, not an error.
    const recovered = await s3.call("buy_resume", { runId, answer: "yes" });
    expect(recovered.structuredContent?.status).toBe("completed");
    expect(placed).toEqual(["pen", "pen"]); // this time the write had not started, so it runs once
    await s3.close();
  });

  it("keeps separate flows and stores apart", async () => {
    const store = memoryStore();
    const { call, close } = await connect([buyFlow().flow], { store });
    const runId = (await call("buy", { item: "pen" })).structuredContent?.runId ?? "";
    expect(store.load("other", runId)).toBeUndefined();
    expect(store.load("buy", runId)?.length).toBeGreaterThan(0);
    await close();
  });
});
