import { readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { AnyFlow } from "./flow.js";

const EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);

/**
 * Flow files import `taugraph`, `taugraph/nodes`, `taugraph-mcp` and `zod`. These resolve to the
 * server's own copies, so `npx taugraph-mcp ./flows` works without a local install and every
 * flow shares one instance of each (one TaugraphError class, one zod).
 */
function aliases(): Record<string, string> {
  const own = (spec: string) => fileURLToPath(import.meta.resolve(spec));
  return {
    "taugraph-mcp": fileURLToPath(new URL("./index.js", import.meta.url)),
    "taugraph/nodes": own("taugraph/nodes"),
    taugraph: own("taugraph"),
    "zod/v4": own("zod/v4"),
    zod: own("zod"),
  };
}

function flowFiles(paths: readonly string[]): string[] {
  return paths.flatMap((p) => {
    const abs = resolve(p);
    if (!statSync(abs).isDirectory()) return [abs];
    return readdirSync(abs)
      .filter((f) => EXTENSIONS.has(extname(f)) && !f.endsWith(".d.ts") && !/\.(test|spec)\./.test(f))
      .sort()
      .map((f) => join(abs, f));
  });
}

function isFlow(value: unknown): value is AnyFlow {
  const v = value as Partial<AnyFlow> | null;
  return !!v && typeof v === "object" && typeof v.name === "string" && typeof v.graph === "function";
}

/** Loads flows from files or directories. Each module default-exports a flow or an array of flows. */
export async function loadFlows(paths: readonly string[]): Promise<AnyFlow[]> {
  const jiti = createJiti(import.meta.url, { alias: aliases(), interopDefault: true });
  const flows: AnyFlow[] = [];
  for (const file of flowFiles(paths)) {
    const mod = (await jiti.import(file)) as { default?: unknown; flows?: unknown } | unknown;
    const exported = (mod as { default?: unknown })?.default ?? (mod as { flows?: unknown })?.flows ?? mod;
    const list = Array.isArray(exported) ? exported : [exported];
    const found = list.filter(isFlow);
    if (found.length === 0) throw new Error(`${file} does not export a flow (export default defineFlow({ ... }))`);
    flows.push(...found);
  }
  return flows;
}
