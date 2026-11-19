// The built CLI, as an MCP client starts it: over stdio and over Streamable HTTP.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import type { ToolResult } from "./helpers.js";

const root = join(import.meta.dirname, "..");
const cli = join(root, "dist", "cli.js");
const flows = join(root, "examples", "flows");

async function stdioClient(storeDir: string) {
  // Run outside the repo so flow files cannot pick up this project's node_modules by accident.
  const cwd = mkdtempSync(join(tmpdir(), "taugraph-mcp-cwd-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, flows, "--store", storeDir],
    cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "cli-test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  return { client, call };
}

describe("stdio", () => {
  it("loads TypeScript flows that import taugraph, zod and taugraph-mcp without a local install", async () => {
    const store = mkdtempSync(join(tmpdir(), "taugraph-mcp-store-"));
    const { client } = await stdioClient(store);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["demo_checkout", "demo_checkout_resume", "demo_deploy", "demo_deploy_resume", "taugraph_runs"].sort(),
    );
    expect(tools.find((t) => t.name === "demo_deploy")?.annotations).toMatchObject({ destructiveHint: true });
    await client.close();
  });

  it("keeps a paused run across server processes", async () => {
    const store = mkdtempSync(join(tmpdir(), "taugraph-mcp-store-"));
    const a = await stdioClient(store);
    const first = await a.call("demo_deploy", { service: "api", version: "1.2.3" });
    expect(first.structuredContent).toMatchObject({
      status: "paused",
      question: { text: "Deploy api@1.2.3 to production?", options: ["Deploy", "Cancel"] },
    });
    await a.client.close();
    expect(readdirSync(join(store, "demo_deploy"))).toEqual([`${first.structuredContent?.runId}.jsonl`]);

    const b = await stdioClient(store);
    const done = await b.call("demo_deploy_resume", { runId: first.structuredContent?.runId, answer: "Deploy" });
    expect(done.structuredContent?.status).toBe("completed");
    expect(done.content[0]?.text).toMatch(/^Deployed api@1\.2\.3 at /);
    await b.client.close();
  });
});

describe("streamable http", () => {
  it("serves the same tools on /mcp, bound to loopback", async () => {
    const store = mkdtempSync(join(tmpdir(), "taugraph-mcp-store-"));
    const child = spawn(process.execPath, [cli, flows, "--store", store, "--http", "0"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let log = "";
        child.stderr.on("data", (d: Buffer) => {
          log += d.toString();
          const match = /http:\/\/(\S+)\/mcp/.exec(log);
          if (match) resolve(`http://${match[1]}/mcp`);
        });
        child.on("exit", (code) => reject(new Error(`server exited ${code}: ${log}`)));
      });
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

      const client = new Client({ name: "http-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const first = (await client.callTool({
        name: "demo_deploy",
        arguments: { service: "web", version: "2.0.0" },
      })) as unknown as ToolResult;
      expect(first.structuredContent?.status).toBe("paused");
      const done = (await client.callTool({
        name: "demo_deploy_resume",
        arguments: { runId: first.structuredContent?.runId, answer: "Cancel" },
      })) as unknown as ToolResult;
      expect(done.content[0]?.text).toBe("Deployment cancelled by the user.");
      await client.close();

      const rebinding = await fetch(url, {
        method: "POST",
        headers: { host: "evil.example", "content-type": "application/json" },
        body: "{}",
      });
      expect(rebinding.status).toBeGreaterThanOrEqual(400);
    } finally {
      child.kill();
    }
  });
});
