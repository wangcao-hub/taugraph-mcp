import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tracePath } from "taugraph";
import type { LLMModel } from "taugraph/nodes";
import { z } from "zod";
import { FlowDriver } from "./driver.js";
import { type AnyFlow, readQuestion } from "./flow.js";
import { modelFromEnv, samplingModel } from "./models.js";
import { assertRunId, memoryStore, type RunStore, runState } from "./store.js";

export interface FlowServerOptions {
  readonly name?: string;
  readonly version?: string;
  /** Defaults to memory. The CLI uses a file store so runs survive restarts. */
  readonly store?: RunStore;
  /** Model for LLM nodes. Defaults to TAUGRAPH_BASE_URL / TAUGRAPH_MODEL, else MCP sampling. */
  readonly model?: LLMModel;
  /** Ask paused questions through MCP elicitation when the client supports it. Default true. */
  readonly elicitation?: boolean;
}

const Result = {
  runId: z.string(),
  status: z.enum(["running", "paused", "completed", "failed", "interrupted"]),
  path: z.array(z.string()),
  question: z.object({ text: z.string(), options: z.array(z.string()).optional() }).optional(),
  summary: z.string().optional(),
};

const INSTRUCTIONS = `Each tool of this server runs a deterministic taugraph flow: the steps, branches and confirmations are code, not model decisions.
When a flow pauses it returns a question. Ask the user, wait for their reply, then call <flow>_resume with the runId and their exact words. Never answer on the user's behalf.
Use taugraph_runs to find paused or interrupted runs. An interrupted step that changes the outside world is never retried automatically.`;

/** An MCP server that exposes taugraph flows as tools: `<flow>`, `<flow>_resume`, and `taugraph_runs`. */
export function createFlowServer(flows: readonly AnyFlow[], options: FlowServerOptions = {}): McpServer {
  const store = options.store ?? memoryStore();
  const mcp = new McpServer(
    { name: options.name ?? "taugraph-mcp", version: options.version ?? "0.1.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  const model = options.model ?? modelFromEnv() ?? samplingModel(mcp.server);
  /** One call at a time per run, so a double-submitted answer cannot resume a run twice. */
  const locks = locksFor(store);
  const exclusive = <T>(runId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(runId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(
      runId,
      next.catch(() => {}),
    );
    return next;
  };

  const names = new Set<string>();
  for (const flow of flows) {
    if (names.has(flow.name)) throw new Error(`Two flows are named "${flow.name}"`);
    names.add(flow.name);
    const driver = new FlowDriver(flow, store, mcp.server, options.elicitation !== false);

    mcp.registerTool(
      flow.name,
      {
        ...(flow.title && { title: flow.title }),
        description: flow.description,
        inputSchema: flow.input,
        outputSchema: Result,
        ...(flow.annotations && { annotations: flow.annotations }),
      },
      async (args: unknown, extra) => {
        const graph = flow.graph({ model });
        const input = flow.toInput ? flow.toInput(args) : args;
        return driver.start(graph, input, extra.signal) as never;
      },
    );

    mcp.registerTool(
      `${flow.name}_resume`,
      {
        description: `Continue a paused or interrupted ${flow.name} flow. Pass the user's reply in their own words; omit it only for an interrupted run.`,
        inputSchema: { runId: z.string(), answer: z.string().optional() },
        outputSchema: Result,
      },
      async ({ runId, answer }, extra) =>
        exclusive(runId, async () => {
          assertRunId(runId);
          const trace = store.load(flow.name, runId);
          if (!trace) return error(`No ${flow.name} run ${runId}. Use taugraph_runs to list runs.`);
          const state = runState(trace);
          if (state === "completed") return error(`Run ${runId} already finished.`);
          if (state === "failed") return error(`Run ${runId} failed and cannot be resumed.`);
          if (state === "paused" && answer === undefined)
            return error(`Run ${runId} is waiting for the user's answer.`);
          const graph = flow.graph({ model });
          return driver.resume(graph, trace, state === "paused" ? answer : undefined, extra.signal) as never;
        }),
    );
  }

  mcp.registerTool(
    "taugraph_runs",
    {
      description:
        "List flow runs kept by this server, newest last, with their status and the question of paused runs.",
      inputSchema: { status: z.enum(["paused", "interrupted", "completed", "failed"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      const runs = store.list().flatMap(({ flow, runId }) => {
        const trace = store.load(flow, runId);
        if (!trace) return [];
        const state = runState(trace);
        const pending = trace.findLast((e) => e.type === "pause");
        const started = trace[0]?.timestamp ?? 0;
        const question = state === "paused" && pending ? readQuestion(pending.output) : undefined;
        return [{ flow, runId, status: state, path: tracePath(trace), started, ...(question && { question }) }];
      });
      const selected = runs.filter((r) => !status || r.status === status).sort((a, b) => a.started - b.started);
      return { content: [{ type: "text", text: JSON.stringify(selected, null, 2) }] };
    },
  );
  return mcp;
}

/** Shared by every server on the same store, e.g. all HTTP sessions. Per process only. */
const allLocks = new WeakMap<RunStore, Map<string, Promise<unknown>>>();
function locksFor(store: RunStore): Map<string, Promise<unknown>> {
  let locks = allLocks.get(store);
  if (!locks) {
    locks = new Map();
    allLocks.set(store, locks);
  }
  return locks;
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
