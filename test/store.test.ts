import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
});
