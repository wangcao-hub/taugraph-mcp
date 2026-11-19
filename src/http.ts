import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AnyFlow } from "./flow.js";
import { createFlowServer, type FlowServerOptions } from "./server.js";

export interface HttpOptions extends FlowServerOptions {
  readonly port: number;
  /** Defaults to 127.0.0.1. Anything else exposes unauthenticated tools; put a gateway in front. */
  readonly host?: string;
  /** Path of the MCP endpoint. Default "/mcp". */
  readonly path?: string;
}

const MAX_BODY = 4 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Streamable HTTP with sessions, so elicitation and sampling work over HTTP too. */
export function serveHttp(flows: readonly AnyFlow[], options: HttpOptions): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "/mcp";
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname !== path) return void res.writeHead(404).end();
      const id = req.headers["mcp-session-id"];
      let transport = typeof id === "string" ? sessions.get(id) : undefined;
      if (typeof id === "string" && !transport) {
        return void res.writeHead(404, { "content-type": "application/json" }).end(rpcError("Unknown session"));
      }
      if (!transport) {
        if (req.method !== "POST") return void res.writeHead(400).end(rpcError("Start a session with initialize"));
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => void sessions.set(sid, created),
          onsessionclosed: (sid) => void sessions.delete(sid),
          ...(LOOPBACK.has(host) && {
            enableDnsRebindingProtection: true,
            allowedHosts: [`127.0.0.1:${actualPort()}`, `localhost:${actualPort()}`, `[::1]:${actualPort()}`],
          }),
        });
        created.onclose = () => {
          if (created.sessionId) sessions.delete(created.sessionId);
        };
        await createFlowServer(flows, options).connect(created);
        transport = created;
      }
      const body = req.method === "POST" ? await readJson(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(rpcError(error instanceof Error ? error.message : "Bad request"));
    }
  });

  const actualPort = () => {
    const address = server.address();
    return typeof address === "object" && address ? address.port : options.port;
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve(server));
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function rpcError(message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}
