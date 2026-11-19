# taugraph-mcp

[![CI](https://github.com/wangcao-hub/taugraph-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/wangcao-hub/taugraph-mcp/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/taugraph-mcp)](https://www.npmjs.com/package/taugraph-mcp) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**Serve [taugraph](https://github.com/wangcao-hub/taugraph) flows as MCP tools.** Any agent that speaks the Model Context Protocol, in any language, can start a deterministic flow, answer its questions, and resume it later.

[中文文档](./README.zh-CN.md)

An agent decides _when_ to start a flow. The flow, a typed graph, decides everything after that: the order of steps, the branches, when to stop and ask, and which steps change the outside world. Those rules are code instead of prompt text, so the model cannot skip a confirmation or repeat an order.

```
npx -y taugraph-mcp ./flows
```

## Write a flow

A flow file default-exports `defineFlow({...})`. It can import `taugraph`, `taugraph/nodes`, `taugraph-mcp` and `zod` without installing them; the server provides its own copies.

```ts
// flows/deploy.ts
import { createGraph } from "taugraph";
import { CodeNode, HumanNode } from "taugraph/nodes";
import { defineFlow } from "taugraph-mcp";
import { z } from "zod";

const State = z.object({
  service: z.string(),
  version: z.string(),
  decision: z.string().nullable().default(null),
});
type State = z.infer<typeof State>;

export default defineFlow({
  name: "deploy",
  description: "Deploy a service version after the user approves. Never approve on the user's behalf.",
  input: z.object({ service: z.string(), version: z.string() }),
  annotations: { destructiveHint: true },
  graph: () =>
    createGraph(State, {
      start: "approve",
      nodes: {
        approve: HumanNode<State, string>({
          ask: (s) => ({ text: `Deploy ${s.service}@${s.version}?`, options: ["Deploy", "Cancel"] }),
          update: (s, decision) => ({ ...s, decision }),
        }),
        deploy: CodeNode<State>(
          async (s) => {
            await rollout(s.service, s.version); // your deployment call
            return s;
          },
          { effect: "write" },
        ),
        cancel: CodeNode<State>((s) => s),
      },
      conditionalEdges: [{ from: "approve", route: (s) => (s.decision === "Deploy" ? "deploy" : "cancel") }],
      endNodes: ["deploy", "cancel"],
    }),
  summarize: (s) => (s.decision === "Deploy" ? `Deployed ${s.service}@${s.version}.` : "Cancelled."),
});
```

For LLM steps, pass `env.model` to `LLMNode`: `graph: (env) => createGraph(..., { nodes: { classify: LLMNode({ model: env.model, ... }) } })`. See [`examples/flows`](./examples/flows) for a checkout flow where the model only picks one of four commands.

## Tools

Every flow becomes two tools, and the server adds one more:

| Tool            | What it does                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `<flow>`        | Starts a run. Input schema comes from `input`. Returns `structuredContent: { runId, status, path, question?, summary? }`. |
| `<flow>_resume` | `{ runId, answer? }`. Continues a paused run with the user's words, or an interrupted run with no answer.                 |
| `taugraph_runs` | Lists runs with status `paused`, `interrupted`, `completed` or `failed`, and the question of paused runs.                 |

When a flow pauses:

- **Client supports elicitation**: the server asks the user through the client (a text field, or a choice list for `options`), and the run continues in the same tool call.
- **Otherwise**, or if the user dismisses the form: the tool returns the question. The agent asks the user and calls `<flow>_resume` with their reply. Server instructions and the tool result tell the model never to answer for the user.

## Connect a client

**Any MCP client that launches stdio servers** uses the same command:

```json
{
  "mcpServers": {
    "taugraph": {
      "command": "npx",
      "args": ["-y", "taugraph-mcp", "/absolute/path/to/flows", "--store", "/absolute/path/to/.taugraph/runs"]
    }
  }
}
```

Use absolute paths: clients start servers from a working directory of their choosing.

**AgentScope Java** (2.0.5, checked in CI, see [`examples/agentscope-java`](./examples/agentscope-java)):

```java
McpClientWrapper taugraph = McpClientBuilder.create("taugraph")
        .stdioTransport("npx", "-y", "taugraph-mcp", "/abs/flows", "--store", "/abs/.taugraph/runs")
        .asyncElicitation(request -> askUser(request)) // optional: answer pauses in your UI
        .buildAsync()
        .block();
toolkit.registerMcpClient(taugraph).block(); // the flows are now ReActAgent tools
```

In AgentScope 2.0.5 only `asyncElicitation` declares the elicitation capability; with `syncElicitation` the server cannot see it and hands questions to the agent instead.

**Streamable HTTP**, for remote or shared servers:

```
npx -y taugraph-mcp ./flows --http 3000          # http://127.0.0.1:3000/mcp
```

Sessions are kept per client, so elicitation and sampling work over HTTP too. The server binds to 127.0.0.1 and checks the Host header by default. It has no authentication: before binding to another address (`--host`), put it behind a gateway that does.

## Models

LLM nodes get `env.model`, which is, in order:

1. `TAUGRAPH_BASE_URL` + `TAUGRAPH_MODEL` (+ `TAUGRAPH_API_KEY`): any OpenAI-compatible endpoint, such as OpenAI, Ollama, vLLM, DeepSeek or Qwen.
2. Otherwise the **client's model through MCP sampling**, if the client supports it. The client chooses the model and can ask the user first.

If neither is available, the LLM step fails with a message that says how to configure one.

## Runs and safety

- `--store <dir>` (default `./.taugraph/runs`) keeps one append-only JSONL trace per run, `<dir>/<flow>/<runId>.jsonl`. Each event is written before the run takes its next step, so a paused run survives a server restart, and traces work with taugraph's `replay` and `diffTraces`. `--memory` keeps nothing on disk.
- If the server dies while a step marked `effect: "write"` is running, `<flow>_resume` reports that the effect may or may not have happened and does not run it again. An interrupted read step is simply resumed.
- Two calls on the same run are handled one after the other, so a double-submitted answer resumes a run once. This holds within one server process; do not point two servers at one store directory.
- `runId` arguments are validated before they touch the file system.
- Flow files are code and run with the server's permissions. Load only flows you trust.

## Library

```ts
import { createFlowServer, fileStore, loadFlows, serveHttp } from "taugraph-mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const flows = await loadFlows(["./flows"]); // or import them directly
await createFlowServer(flows, { store: fileStore(".taugraph/runs") }).connect(new StdioServerTransport());
```

Also exported: `defineFlow`, `memoryStore`, `samplingModel`, `openAICompatibleModel`, `modelFromEnv`, `readQuestion`, `runState`.

## Compatibility

Node 22 or newer. Tested with the MCP TypeScript SDK client (stdio, Streamable HTTP, elicitation, sampling) and AgentScope Java 2.0.5 (stdio, elicitation, Toolkit registration).

## License

[MIT](./LICENSE)
