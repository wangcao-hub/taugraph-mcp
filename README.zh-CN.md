# taugraph-mcp

**把 [taugraph](https://github.com/wangcao-hub/taugraph) 流程作为 MCP 工具提供出去。** 任何支持 Model Context Protocol 的 agent，不管用什么语言写的，都能启动一个确定性流程、回答它提出的问题，并在之后恢复它。

[English](./README.md)

agent 决定**什么时候**启动流程；流程本身是一张类型化的图，决定之后的一切：步骤顺序、分支、什么时候停下来问人、哪些步骤会改变外部世界。这些规则是代码而不是提示词，所以模型跳不过确认，也不会重复下单。

```
npx -y taugraph-mcp ./flows
```

## 写一个流程

流程文件默认导出 `defineFlow({...})`。文件里可以直接 import `taugraph`、`taugraph/nodes`、`taugraph-mcp` 和 `zod`，不用另外安装，服务端会提供自己的那一份。完整示例见 [English README](./README.md#write-a-flow) 和 [`examples/flows`](./examples/flows)。LLM 步骤把 `env.model` 传给 `LLMNode` 即可。

## 工具

每个流程会变成两个工具，服务端再额外提供一个：

| 工具            | 作用                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `<flow>`        | 启动一次运行。输入 schema 来自 `input`，返回 `structuredContent: { runId, status, path, question?, summary? }` |
| `<flow>_resume` | `{ runId, answer? }`。用用户的原话继续一个暂停的运行；继续一个中断的运行时不传 answer                          |
| `taugraph_runs` | 列出所有运行及其状态（`paused`、`interrupted`、`completed`、`failed`），暂停的运行附带它的问题                 |

流程暂停时：

- **客户端支持 elicitation**：服务端通过客户端直接问用户（文本框；有 `options` 时是选择列表），在同一次工具调用里继续。
- **否则**，或者用户关掉了表单：工具把问题返回给 agent，由 agent 去问用户，再用用户的回复调用 `<flow>_resume`。服务端说明和工具结果都会要求模型不得替用户回答。

## 接入客户端

**任何能启动 stdio 服务的 MCP 客户端**，配置方式都一样：

```json
{
  "mcpServers": {
    "taugraph": {
      "command": "npx",
      "args": ["-y", "taugraph-mcp", "/绝对路径/flows", "--store", "/绝对路径/.taugraph/runs"]
    }
  }
}
```

请使用绝对路径：客户端启动服务时的工作目录不一定是你的项目目录。

**AgentScope Java**（2.0.5，已在 CI 中验证，见 [`examples/agentscope-java`](./examples/agentscope-java)）：

```java
McpClientWrapper taugraph = McpClientBuilder.create("taugraph")
        .stdioTransport("npx", "-y", "taugraph-mcp", "/abs/flows", "--store", "/abs/.taugraph/runs")
        .asyncElicitation(request -> askUser(request)) // 可选：在你的界面里回答暂停的问题
        .buildAsync()
        .block();
toolkit.registerMcpClient(taugraph).block(); // 这些流程就成了 ReActAgent 的工具
```

AgentScope 2.0.5 里只有 `asyncElicitation` 会声明 elicitation 能力；用 `syncElicitation` 时服务端看不到这个能力，会改为把问题交回给 agent。

**Streamable HTTP**，用于远程或共享部署：

```
npx -y taugraph-mcp ./flows --http 3000          # http://127.0.0.1:3000/mcp
```

每个客户端有独立会话，所以 elicitation 和 sampling 在 HTTP 下同样可用。默认只绑定 127.0.0.1 并校验 Host 头。服务本身不带鉴权：如果要用 `--host` 绑定到其他地址，请在前面加一层有鉴权的网关。

## 模型

LLM 节点拿到的 `env.model` 按以下顺序确定：

1. `TAUGRAPH_BASE_URL` + `TAUGRAPH_MODEL`（需要时加 `TAUGRAPH_API_KEY`）：任意 OpenAI 兼容接口，如 OpenAI、Ollama、vLLM、DeepSeek、通义千问。
2. 否则，在客户端支持的前提下，**通过 MCP sampling 使用客户端的模型**。用哪个模型由客户端决定，客户端也可以先征求用户同意。

两者都没有时，LLM 步骤会失败，并提示如何配置。

用环境变量配置的模型把请求的 `reasoning` 档位原样作为 `reasoning_effort` 发出（`"off"` 写成 `"none"`）。`reasoningParams` 可以把档位换成别的请求参数，但只有自己构建 `openAICompatibleModel` 时才能用。`samplingModel` 忽略 `reasoning`，因为 MCP sampling 没有这个字段。

两种模型都支持工具调用。`samplingModel` 要求客户端声明 `sampling.tools`（MCP 2025-11-25），否则遇到工具会报错；指定单个工具的 `toolChoice` 会变成只发送这一个工具并要求调用。`openAICompatibleModel` 就是 `taugraph/openai` 的适配器，接受它的全部选项。

## 运行记录与安全

- `--store <dir>`（默认 `./.taugraph/runs`）为每次运行保存一份只追加的 JSONL trace：`<dir>/<flow>/<runId>.jsonl`。每个事件都在运行进入下一步之前写入，所以服务重启后暂停的运行还在，trace 也能直接用于 taugraph 的 `replay` 和 `diffTraces`。`--memory` 表示不落盘。
- 如果服务在执行标记为 `effect: "write"` 的步骤时挂掉，`<flow>_resume` 会报告该操作可能生效也可能没有，不会再执行一次。中断在只读步骤上的运行会直接继续。
- 同一个运行上的两个调用会排队依次处理，重复提交的回答只会恢复一次。这一保证仅限单个服务进程，请不要让两个服务共用一个 store 目录。
- `runId` 参数在访问文件系统之前会先校验。
- 流程文件就是代码，以服务进程的权限运行。只加载你信任的流程。

## 兼容性

Node 22 及以上。已用 MCP TypeScript SDK 客户端（stdio、Streamable HTTP、elicitation、sampling）和 AgentScope Java 2.0.5（stdio、elicitation、Toolkit 注册）测试。

## 许可证

[MIT](./LICENSE)
