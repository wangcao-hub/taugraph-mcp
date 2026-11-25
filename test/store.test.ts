import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraph } from "taugraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fileStore, runState } from "../src/store.js";

const schema = z.object({ n: z.number() });
const graph = createGraph(schema, {
  start: "a",
  nodes: { a: (s: z.infer<typeof schema>) => ({ n: s.n + 1 }), b: (s: z.infer<typeof schema>) => ({ n: s.n + 1 }) },
  edges: [{ from: "a", to: "b" }],
  endNodes: ["b"],
});

const askSchema = z.object({ n: z.number(), answer: z.string().nullable().default(null) });
type Ask = z.infer<typeof askSchema>;
const asking = createGraph(askSchema, {
  start: "count",
  nodes: {
    count: (s: Ask) => ({ ...s, n: s.n + 1 }),
    ask: (s: Ask, ctx) => ({ ...s, answer: ctx.interrupt<string>("ok?") }),
  },
  edges: [{ from: "count", to: "ask" }],
  endNodes: ["ask"],
});

describe("fileStore", () => {
  it("keeps one v2 file per run under the flow's directory and survives a torn last line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taugraph-mcp-store-"));
    const store = fileStore(dir);
    const { trace, runId } = await graph.run({ n: 0 }, { onEvent: (e) => store.append("count", e) });
    const path = join(dir, "count", `${runId}.jsonl`);
    expect(readFileSync(path, "utf8")).toContain('"version":2');
    expect(store.load("count", runId)).toEqual(JSON.parse(JSON.stringify(trace)));
    expect(store.list()).toEqual([{ flow: "count", runId }]);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"seq":`);
    expect(store.load("count", runId)).toHaveLength(trace.length);
    expect(runState(trace.slice(0, 3))).toBe("interrupted");
    expect(runState(trace)).toBe("completed");
  });

  it("continues a version 1 file with full lines, so it stays version 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taugraph-mcp-store-"));
    const paused = await asking.run({ n: 0 });
    expect(paused.trace.slice(-2).map((e) => e.type)).toEqual(["pause", "run_end"]);
    const v1 = paused.trace.map((e, i) => JSON.stringify(i === 0 ? { ...e, meta: { ...e.meta, version: 1 } } : e));
    const path = join(dir, "ask", `${paused.runId}.jsonl`);
    mkdirSync(join(dir, "ask"));
    writeFileSync(path, `${v1.join("\n")}\n`);
    const store = fileStore(dir);
    const loaded = store.load("ask", paused.runId);
    expect(loaded && runState(loaded)).toBe("paused");
    const done = await asking.resume(loaded as NonNullable<typeof loaded>, "yes", {
      onEvent: (e) => store.append("ask", e),
    });
    expect(done.state).toEqual({ n: 1, answer: "yes" });
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines.slice(0, v1.length)).toEqual(v1);
    expect(lines.length).toBeGreaterThan(v1.length);
    for (const line of lines.slice(v1.length)) expect(line).not.toContain("Patch");
    const reloaded = store.load("ask", paused.runId);
    expect(reloaded?.[0]?.meta?.version).toBe(1);
    expect(reloaded && runState(reloaded)).toBe("completed");
    expect(reloaded).toHaveLength(done.trace.length);
  });

  it("reports a trace that ends in a pause without run_end as paused", async () => {
    const { trace } = await asking.run({ n: 0 });
    expect(trace.at(-1)?.type).toBe("run_end");
    expect(runState(trace.slice(0, -1))).toBe("paused");
  });

  it("does not list lock files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taugraph-mcp-store-"));
    const store = fileStore(dir);
    let listed: { flow: string; runId: string }[] = [];
    const { runId } = await graph.run(
      { n: 0 },
      {
        onEvent: (e) => {
          store.append("count", e);
          if (e.seq === 1) {
            expect(existsSync(join(dir, "count", `${e.runId}.lock`))).toBe(true);
            listed = store.list();
          }
        },
      },
    );
    expect(listed).toEqual([{ flow: "count", runId }]);
    writeFileSync(join(dir, "count", "stray.lock"), "");
    expect(store.list()).toEqual([{ flow: "count", runId }]);
  });
});
