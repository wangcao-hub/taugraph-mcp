# AgentScope Java + taugraph-mcp

`TaugraphFromAgentScope` starts taugraph-mcp over stdio from AgentScope Java 2.0.5 and checks three things:

1. A flow that pauses hands its question to the caller, and `<flow>_resume` finishes it.
2. `Toolkit.registerMcpClient` turns the flows into AgentScope tools.
3. With an `asyncElicitation` handler, the same flow finishes in one call.

Requires JDK 17+, Maven, and Node 22+. The program arguments are the command that starts the server.

**From a clone of this repository** (this is what CI runs):

```
pnpm install && pnpm build
cd examples/agentscope-java
mvn -q compile exec:java -Dexec.args="node ../../dist/cli.js ../flows"
```

**In your own project**, use the published package:

```
mvn -q compile exec:java -Dexec.args="npx -y taugraph-mcp /absolute/path/to/flows"
```

Do not use `npx taugraph-mcp` inside this repository: npx resolves the name to the repository's own package and finds no installed binary.

In AgentScope 2.0.5 only `asyncElicitation` declares the elicitation capability; `syncElicitation` does not, so the server falls back to handing questions to the agent.
