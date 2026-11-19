import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AnyFlow } from "../src/flow.js";
import { createFlowServer, type FlowServerOptions } from "../src/server.js";

export interface ClientHooks {
  /** Answer elicitation requests. Absent: the client does not declare elicitation. */
  elicit?: (
    message: string,
    schema: unknown,
  ) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
  /** Answer sampling requests. Absent: the client does not declare sampling. */
  sample?: (messages: { role: string; content: { type: string; text?: string } }[], systemPrompt?: string) => string;
}

export type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: {
    runId: string;
    status: string;
    path: string[];
    question?: { text: string; options?: string[] };
    summary?: string;
  };
  isError?: boolean;
};

export async function connect(flows: AnyFlow[], options: FlowServerOptions = {}, hooks: ClientHooks = {}) {
  const server = createFlowServer(flows, options);
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: { ...(hooks.elicit && { elicitation: { form: {} } }), ...(hooks.sample && { sampling: {} }) } },
  );
  if (hooks.elicit) {
    const elicit = hooks.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const params = req.params as { message: string; requestedSchema?: unknown };
      return elicit(params.message, params.requestedSchema) as never;
    });
  }
  if (hooks.sample) {
    const sample = hooks.sample;
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => ({
      role: "assistant",
      model: "test-model",
      content: { type: "text", text: sample(req.params.messages as never, req.params.systemPrompt) },
    }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  return { client, server, call, close: () => client.close() };
}
