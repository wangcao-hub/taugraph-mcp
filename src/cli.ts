#!/usr/bin/env node
// taugraph-mcp [flow files or directories...] [--store dir | --memory] [--http port [--host h]]
// Logs go to stderr: on stdio, stdout belongs to the MCP protocol.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serveHttp } from "./http.js";
import { loadFlows } from "./loader.js";
import { createFlowServer } from "./server.js";
import { fileStore, memoryStore } from "./store.js";

const HELP = `Usage: taugraph-mcp <flows...> [options]

Serves taugraph flows as MCP tools. <flows> are files or directories of .ts/.js modules
that default-export defineFlow({...}) or an array of flows.

Options:
  --store <dir>      where run traces are kept (default: ./.taugraph/runs)
  --memory           keep runs in memory only
  --http <port>      serve Streamable HTTP on /mcp instead of stdio
  --host <host>      HTTP bind address (default: 127.0.0.1)
  --no-elicitation   never ask through the client; always hand questions to the agent
  -h, --help         show this help
  -v, --version      show the version

LLM nodes use TAUGRAPH_BASE_URL + TAUGRAPH_MODEL (+ TAUGRAPH_API_KEY) when set,
otherwise the client's model through MCP sampling.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      store: { type: "string" },
      memory: { type: "boolean" },
      http: { type: "string" },
      host: { type: "string" },
      "no-elicitation": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(pkg.version);
  if (positionals.length === 0) {
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  const flows = await loadFlows(positionals);
  const storeDir = resolve(values.store ?? ".taugraph/runs");
  const options = {
    version: pkg.version,
    store: values.memory ? memoryStore() : fileStore(storeDir),
    elicitation: !values["no-elicitation"],
  };
  const names = flows.map((f) => f.name).join(", ");
  const where = values.memory ? "memory" : storeDir;

  if (values.http) {
    const port = Number(values.http);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error(`--http needs a port, got "${values.http}"`);
    const server = await serveHttp(flows, { ...options, port, ...(values.host && { host: values.host }) });
    const address = server.address();
    const shown = typeof address === "object" && address ? `${address.address}:${address.port}` : String(port);
    console.error(`taugraph-mcp ${pkg.version}: http://${shown}/mcp | flows: ${names} | runs: ${where}`);
    return;
  }
  await createFlowServer(flows, options).connect(new StdioServerTransport());
  console.error(`taugraph-mcp ${pkg.version}: stdio | flows: ${names} | runs: ${where}`);
}

main().catch((error: unknown) => {
  console.error(`taugraph-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
