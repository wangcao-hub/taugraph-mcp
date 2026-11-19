import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Graph } from "taugraph";
import type { LLMModel } from "taugraph/nodes";
import type { z } from "zod";

/** What the server gives a flow when it builds the graph for a call. */
export interface FlowEnv {
  /**
   * The model for LLM nodes: the server's configured model, or else the client's model through
   * MCP sampling. Calls fail with a clear error when neither is available.
   */
  readonly model: LLMModel;
}

/** What a paused flow asks. Return `{ text, options? }` from `ctx.interrupt` or `HumanNode.ask`. */
export interface Question {
  readonly text: string;
  /** Fixed choices. Clients that support elicitation show them as a choice list. */
  readonly options?: readonly string[];
}

export interface FlowDefinition<S = unknown, I = unknown, K extends string = string, A = unknown> {
  /** MCP tool name. A second tool, `<name>_resume`, continues paused runs. Letters, digits, `_` and `-`. */
  readonly name: string;
  readonly title?: string;
  /** Tell the calling agent what the flow does and what it handles itself, such as confirmation. */
  readonly description: string;
  /** Tool arguments as a zod object. Becomes the tool's JSON input schema. */
  readonly input: z.ZodType<A>;
  /** Built per call. Use `env.model` for LLM nodes. */
  readonly graph: (env: FlowEnv) => Graph<S, I, K>;
  /** Maps validated tool arguments to the graph's run input. Defaults to passing them through. */
  readonly toInput?: (args: A) => I;
  /** Turns an interrupt request into a question. Defaults to reading `{ text | question, options? }`. */
  readonly question?: (request: unknown) => Question;
  /** What the agent reads when the flow finishes. Keep it short. Defaults to the final state as JSON. */
  readonly summarize?: (state: S) => string;
  /** MCP tool annotations for the start tool, e.g. `{ destructiveHint: true }` when the flow writes. */
  readonly annotations?: ToolAnnotations;
}

/** A flow of any state, input and argument types, for collections of flows. */
// biome-ignore lint/suspicious/noExplicitAny: flows in one server have unrelated type parameters
export type AnyFlow = FlowDefinition<any, any, any, any>;

/** Identity function that infers the flow's types. */
export function defineFlow<S, I, K extends string, A>(flow: FlowDefinition<S, I, K, A>): FlowDefinition<S, I, K, A> {
  if (!/^[A-Za-z0-9_-]{1,56}$/.test(flow.name)) {
    throw new Error(`Flow name "${flow.name}" must be 1-56 letters, digits, "_" or "-"`);
  }
  return flow;
}

/** Reads `"text"`, `{ text }`, `{ question }` and optional `options: string[]` from an interrupt request. */
export function readQuestion(request: unknown): Question {
  if (typeof request === "string") return { text: request };
  if (request !== null && typeof request === "object") {
    const r = request as Record<string, unknown>;
    const text =
      typeof r.text === "string" ? r.text : typeof r.question === "string" ? r.question : JSON.stringify(request);
    const options = r.options;
    const valid = Array.isArray(options) && options.length > 0 && options.every((o) => typeof o === "string");
    return { text, ...(valid && { options: options as string[] }) };
  }
  return { text: "The flow is waiting for your input." };
}
