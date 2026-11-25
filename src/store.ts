import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runStatus, type Trace, type TraceEvent } from "taugraph";
import { type FileStore, fileStore as runFiles } from "taugraph/file";

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

/** One append-only JSONL file per run: `<dir>/<flow>/<runId>.jsonl`, through `taugraph/file`. Survives restarts and crashes. */
export function fileStore(dir: string): RunStore {
  const stores = new Map<string, FileStore>();
  const forFlow = (flow: string): FileStore => {
    let store = stores.get(flow);
    if (!store) {
      store = runFiles(join(dir, flow));
      stores.set(flow, store);
    }
    return store;
  };
  return {
    append(flow, event) {
      assertRunId(event.runId);
      forFlow(flow).sink(event);
    },
    load(flow, runId) {
      assertRunId(runId);
      return forFlow(flow).load(runId);
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
  const status = runStatus(trace);
  if (status !== "running") return status;
  return trace[trace.length - 1]?.type === "pause" ? "paused" : "interrupted";
}
