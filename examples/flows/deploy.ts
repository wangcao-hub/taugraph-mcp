// Demo: a deployment that only happens after the user approves. No model needed, so it works with
// every MCP client. Nothing is deployed for real.
import { createGraph } from "taugraph";
import { CodeNode, HumanNode } from "taugraph/nodes";
import { defineFlow } from "taugraph-mcp";
import { z } from "zod";

const State = z.object({
  service: z.string(),
  version: z.string(),
  decision: z.string().nullable().default(null),
  deployedAt: z.string().nullable().default(null),
});
type State = z.infer<typeof State>;

export default defineFlow({
  name: "demo_deploy",
  title: "Deploy (taugraph demo)",
  description:
    "Demo: deploy a service version to production after the user approves (nothing is deployed for real). Asks the user itself; never approve on the user's behalf.",
  input: z.object({ service: z.string().describe("Service name"), version: z.string().describe("Version to deploy") }),
  annotations: { destructiveHint: true },
  graph: () =>
    createGraph(State, {
      start: "approve",
      nodes: {
        approve: HumanNode<State, string>({
          ask: (s) => ({ text: `Deploy ${s.service}@${s.version} to production?`, options: ["Deploy", "Cancel"] }),
          update: (s, decision) => ({ ...s, decision }),
        }),
        deploy: CodeNode<State>((s) => ({ ...s, deployedAt: new Date().toISOString() }), { effect: "write" }),
        cancel: CodeNode<State>((s) => s),
      },
      conditionalEdges: [{ from: "approve", route: (s) => (s.decision === "Deploy" ? "deploy" : "cancel") }],
      endNodes: ["deploy", "cancel"],
    }),
  summarize: (s) =>
    s.deployedAt ? `Deployed ${s.service}@${s.version} at ${s.deployedAt}.` : "Deployment cancelled by the user.",
});
