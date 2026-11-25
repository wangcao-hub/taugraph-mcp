import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFlows } from "../src/loader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const agentFlow = `import { createAgent } from "taugraph/agent";
import { openAICompatible } from "taugraph/openai";
import { defineFlow } from "taugraph-mcp";
import { z } from "zod";

export default defineFlow({
  name: "ask_agent",
  description: "Answers a question with a tool-calling agent.",
  input: z.object({ question: z.string() }),
  toInput: ({ question }) => ({ messages: [{ role: "user", content: question }] }),
  graph: () => createAgent({ model: openAICompatible({ baseURL: "http://localhost:11434/v1", model: "m" }) }),
});
`;

describe("loadFlows", () => {
  it("lets flow files import taugraph/agent and taugraph/openai", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taugraph-mcp-flows-"));
    dirs.push(dir);
    writeFileSync(join(dir, "agent.ts"), agentFlow);
    const flows = await loadFlows([dir]);
    expect(flows.map((f) => f.name)).toEqual(["ask_agent"]);
  });
});
