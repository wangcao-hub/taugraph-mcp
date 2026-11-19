// Demo: the model only classifies the user's reply into one of four commands; price, routing and
// the (fake) order are code. The LLM step uses TAUGRAPH_BASE_URL/TAUGRAPH_MODEL or MCP sampling.
import { createGraph } from "taugraph";
import { CodeNode, HumanNode, LLMNode } from "taugraph/nodes";
import { defineFlow } from "taugraph-mcp";
import { z } from "zod";

const Command = z.enum(["confirm", "modify", "explore", "cancel"]);
const State = z.object({
  item: z.string(),
  qty: z.number().int().positive().default(1),
  price: z.number().nullable().default(null),
  reply: z.string().nullable().default(null),
  command: Command.nullable().default(null),
  note: z.string().nullable().default(null),
  orderId: z.string().nullable().default(null),
});
type State = z.infer<typeof State>;

export default defineFlow({
  name: "demo_checkout",
  title: "Checkout (taugraph demo)",
  description:
    "Demo: order an item (fake order). Handles the price, asks the user to confirm, and places the order. Never confirm on the user's behalf.",
  input: z.object({ item: z.string(), qty: z.number().int().positive().optional() }),
  annotations: { destructiveHint: true },
  toInput: (args) => ({ item: args.item, qty: args.qty ?? 1 }),
  graph: (env) =>
    createGraph(State, {
      start: "quote",
      nodes: {
        quote: CodeNode<State>((s) => ({ ...s, price: 18 * s.qty, note: null })),
        confirm: HumanNode<State, string>({
          ask: (s) => ({ text: `${s.note ? `${s.note} ` : ""}${s.qty} x ${s.item} for $${s.price}. Place the order?` }),
          update: (s, reply) => ({ ...s, reply }),
        }),
        classify: LLMNode<State, { command: z.infer<typeof Command>; qty?: number | undefined }>({
          model: env.model,
          prompt: (s) => ({
            messages: [
              {
                role: "system",
                content:
                  'The user is replying to an order preview. Reply with JSON only: {"command": "confirm" | "modify" | "explore" | "cancel", "qty"?: number}. Use "qty" only with "modify".',
              },
              { role: "user", content: s.reply ?? "" },
            ],
            temperature: 0,
          }),
          output: z.object({ command: Command, qty: z.number().int().positive().optional() }),
          update: (s, out) => ({
            ...s,
            command: out.command,
            qty: out.command === "modify" ? (out.qty ?? s.qty) : s.qty,
          }),
          retry: { maxAttempts: 2 },
        }),
        explain: CodeNode<State>((s) => ({ ...s, note: "Shipping is free on orders over $30." })),
        place: CodeNode<State>((s) => ({ ...s, orderId: `demo-${s.item.replace(/\W+/g, "-")}-${s.qty}` }), {
          effect: "write",
        }),
        cancelled: CodeNode<State>((s) => s),
      },
      edges: [
        { from: "quote", to: "confirm" },
        { from: "confirm", to: "classify" },
        { from: "explain", to: "confirm" },
      ],
      conditionalEdges: [
        {
          from: "classify",
          route: (s) => {
            if (s.command === "confirm") return "place";
            if (s.command === "modify") return "quote";
            if (s.command === "cancel") return "cancelled";
            return "explain";
          },
          targets: ["place", "quote", "cancelled", "explain"],
        },
      ],
      endNodes: ["place", "cancelled"],
    }),
  summarize: (s) =>
    s.orderId ? `Ordered ${s.qty} x ${s.item} (demo order ${s.orderId}).` : "The user cancelled the order.",
});
