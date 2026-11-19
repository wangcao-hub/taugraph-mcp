import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromJSONL, type Trace, type TraceEvent } from "taugraph";

/**
 * Where runs live between tool calls. `append` is called for every event before the run
 * continues (taugraph's `onEvent`), so a store that writes synchronously is a write-ahead log.
 */
export interface RunStore {
  append(flow: string, event: TraceEvent): void;
  load(flow: string, runId: string): Trace | undefined;
  list(): { flow: string; runId: string }[];
}

const RUN_ID = /^[A-Za-z0-9-]{1,100}$/;

/** runIds come from tool arguments; never let one escape the store directory. */
export function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid runId "${runId.slice(0, 40)}"`);
}

/** One append-only JSONL file per run: `<dir>/<flow>/<runId>.jsonl`. Survives process restarts. */
export function fileStore(dir: string): RunStore {
  const file = (flow: string, runId: string) => {
    assertRunId(runId);
    return join(dir, flow, `${runId}.jsonl`);
  };
  return {
    append(flow, event) {
      mkdirSync(join(dir, flow), { recursive: true });
      appendFileSync(file(flow, event.runId), `${JSON.stringify(event)}\n`);
    },
    load(flow, runId) {
      const path = file(flow, runId);
      return existsSync(path) ? fromJSONL(readFileSync(path, "utf8")) : undefined;
    },
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) =>
          readdirSync(join(dir, d.name))
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ flow: d.name, runId: f.slice(0, -".jsonl".length) })),
        );
    },
  };
}

/** Keeps runs in memory. For tests, or servers whose runs need not survive a restart. */
export function memoryStore(): RunStore {
  const runs = new Map<string, { flow: string; events: TraceEvent[] }>();
  return {
    append(flow, event) {
      const run = runs.get(event.runId) ?? { flow, events: [] };
      run.events.push(event);
      runs.set(event.runId, run);
    },
    load(flow, runId) {
      const run = runs.get(runId);
      return run && run.flow === flow ? [...run.events] : undefined;
    },
    list() {
      return [...runs].map(([runId, run]) => ({ flow: run.flow, runId }));
    },
  };
}

export type RunState = "running" | "paused" | "completed" | "failed" | "interrupted";

/** `interrupted`: the trace ends without `run_end`, e.g. the server died mid-step. */
export function runState(trace: Trace): RunState {
  const last = trace[trace.length - 1];
  if (last?.type === "run_end") {
    const status = last.meta?.status;
    return status === "paused" || status === "completed" || status === "failed" ? status : "failed";
  }
  return last?.type === "pause" ? "paused" : "interrupted";
}
