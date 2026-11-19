import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type Graph, isTaugraphError, type RunResult, type Trace } from "taugraph";
import type { FlowDefinition, Question } from "./flow.js";
import { readQuestion } from "./flow.js";
import type { RunState, RunStore } from "./store.js";

export interface FlowResult {
  readonly runId: string;
  readonly status: RunState;
  readonly path: string[];
  readonly question?: Question;
  readonly summary?: string;
}

export interface CallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: FlowResult & Record<string, unknown>;
  isError?: boolean;
}

/** Runs and resumes one flow. Every event reaches the store before the run continues. */
export class FlowDriver<S, I, K extends string, A> {
  constructor(
    private readonly flow: FlowDefinition<S, I, K, A>,
    private readonly store: RunStore,
    private readonly server: Server,
    private readonly useElicitation: boolean,
  ) {}

  private get ask() {
    return this.flow.question ?? readQuestion;
  }

  private onEvent = (event: Trace[number]) => this.store.append(this.flow.name, event);

  async start(graph: Graph<S, I, K>, input: I, signal: AbortSignal): Promise<CallResult> {
    return this.settle(graph, () => graph.run(input, { onEvent: this.onEvent, signal }), signal);
  }

  async resume(
    graph: Graph<S, I, K>,
    trace: Trace,
    answer: string | undefined,
    signal: AbortSignal,
  ): Promise<CallResult> {
    return this.settle(graph, () => graph.resume(trace, answer, { onEvent: this.onEvent, signal }), signal);
  }

  /** Runs a segment, then keeps asking through elicitation while the client supports it. */
  private async settle(graph: Graph<S, I, K>, segment: () => Promise<RunResult<S, K>>, signal: AbortSignal) {
    let result: RunResult<S, K>;
    try {
      result = await segment();
      while (result.status === "paused") {
        const answer = await this.elicit(this.ask(result.pending.request), signal);
        if (answer === undefined) break;
        const trace = result.trace;
        result = await graph.resume(trace, answer, { onEvent: this.onEvent, signal });
      }
    } catch (error) {
      return this.failure(error);
    }
    const base = { runId: result.runId, path: [...result.path] };
    if (result.status === "completed") {
      const summary =
        this.flow.summarize?.(result.state) ?? truncate(`${this.flow.name} finished: ${JSON.stringify(result.state)}`);
      return reply(summary, { ...base, status: "completed", summary });
    }
    const question = this.ask(result.pending.request);
    const options = question.options ? ` Options: ${question.options.join(" | ")}.` : "";
    return reply(
      `The ${this.flow.name} flow (runId ${result.runId}) is waiting for the user: "${question.text}"${options} ` +
        `Ask the user and wait for their reply, then call ${this.flow.name}_resume with this runId and their exact words. Do not answer for them.`,
      { ...base, status: "paused", question },
    );
  }

  /** Asks the user directly through the client, or returns undefined to hand the question to the agent. */
  private async elicit(question: Question, signal: AbortSignal): Promise<string | undefined> {
    if (!this.useElicitation || !this.server.getClientCapabilities()?.elicitation) return undefined;
    const answer = question.options
      ? { type: "string" as const, title: "Answer", enum: [...question.options] }
      : { type: "string" as const, title: "Answer" };
    try {
      const result = await this.server.elicitInput(
        {
          mode: "form",
          message: question.text,
          requestedSchema: { type: "object", properties: { answer }, required: ["answer"] },
        },
        { signal },
      );
      const value = result.action === "accept" ? result.content?.answer : undefined;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined; // the client could not show it; fall back to the agent
    }
  }

  private failure(error: unknown): CallResult {
    const message = error instanceof Error ? error.message : String(error);
    if (isTaugraphError(error) && error.code === "UNKNOWN_OUTCOME") {
      return {
        content: [
          {
            type: "text",
            text: `The run was interrupted while "${error.nodeId}" was changing the outside world, so it may or may not have taken effect. It will not be retried automatically; ask the user to check first.`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: `${this.flow.name} failed: ${message}` }], isError: true };
  }
}

function reply(text: string, result: FlowResult): CallResult {
  return { content: [{ type: "text", text }], structuredContent: { ...result } };
}

export function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}
