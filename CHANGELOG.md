# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Images: `samplingModel` sends user messages with text and image parts as MCP content blocks, and `openAICompatibleModel` sends them in OpenAI's format. Both take `resolveImage` to read image references. A message with one part is sent as one block; several blocks in one message need a client on MCP 2025-11-25 or later. Requires taugraph 0.3.0.
- Reasoning: `openAICompatibleModel` sends `reasoning_effort` (or `reasoningParams`) for `request.reasoning`, reads `reasoning_content` and `reasoning` into `response.reasoning`, and no longer sends taugraph's own message fields. `samplingModel` ignores `reasoning`, which MCP sampling has no field for. Requires taugraph 0.3.0.
- Tool calling: `samplingModel` sends tools and tool choice through MCP sampling (clients that declare `sampling.tools`, MCP 2025-11-25), tool calls as `tool_use` blocks and tool results as `tool_result` blocks, and reads `tool_use` replies into `toolCalls`, so `taugraph/agent` runs on MCP sampling. `openAICompatibleModel` now forwards to `taugraph/openai`, with its tools, images and reasoning. Requires taugraph 0.3.0.

## [0.1.0] - 2026-11-19

### Added

- `taugraph-mcp` CLI: serve taugraph flow modules (TypeScript or JavaScript) over stdio or Streamable HTTP. Flow files can import `taugraph`, `taugraph/nodes`, `taugraph-mcp` and `zod` without a local install.
- Per flow, a `<flow>` tool (input schema from zod, structured output) and a `<flow>_resume` tool; plus `taugraph_runs`.
- Pauses are asked through MCP elicitation when the client supports it, otherwise returned to the agent.
- LLM nodes use `TAUGRAPH_BASE_URL` / `TAUGRAPH_MODEL`, or the client's model through MCP sampling.
- File store: one append-only JSONL trace per run, written before each next step. Interrupted writes are reported and never retried; interrupted read steps resume.
- Library API: `defineFlow`, `createFlowServer`, `serveHttp`, `loadFlows`, `fileStore`, `memoryStore`, `samplingModel`, `openAICompatibleModel`.
- Example flows and an AgentScope Java 2.0.5 client example, checked in CI.

[Unreleased]: https://github.com/wangcao-hub/taugraph-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wangcao-hub/taugraph-mcp/releases/tag/v0.1.0
