package demo;

import io.agentscope.core.tool.Toolkit;
import io.agentscope.core.tool.mcp.McpClientBuilder;
import io.agentscope.core.tool.mcp.McpClientWrapper;
import io.modelcontextprotocol.spec.McpSchema;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * AgentScope Java calling taugraph-mcp over stdio: headless resume, elicitation, and Toolkit registration.
 *
 * <p>The program arguments are the command that starts taugraph-mcp; this example adds {@code --store}
 * itself. See README.md in this directory for how to run it.
 */
public class TaugraphFromAgentScope {
    public static void main(String[] args) {
        if (args.length < 2) throw new IllegalArgumentException("usage: <command> <args...> (the taugraph-mcp command line)");
        String command = args[0];
        String store = java.nio.file.Path.of(System.getProperty("java.io.tmpdir"), "taugraph-agentscope-" + System.nanoTime()).toString();
        String[] serverArgs = java.util.stream.Stream.concat(
                        java.util.Arrays.stream(args, 1, args.length), java.util.stream.Stream.of("--store", store))
                .toArray(String[]::new);

        // 1. Headless: the flow pauses, the agent relays the question, then calls <flow>_resume.
        McpClientWrapper client = McpClientBuilder.create("taugraph")
                .stdioTransport(command, serverArgs)
                .buildAsync()
                .block();
        client.initialize().block();
        List<String> names = client.listTools().block().stream().map(McpSchema.Tool::name).sorted().toList();
        System.out.println("tools: " + names);
        check(names.contains("demo_deploy") && names.contains("demo_deploy_resume") && names.contains("taugraph_runs"), "tools listed");

        McpSchema.CallToolResult first =
                client.callTool("demo_deploy", Map.of("service", "api", "version", "1.2.3")).block();
        @SuppressWarnings("unchecked")
        Map<String, Object> paused = (Map<String, Object>) first.structuredContent();
        System.out.println("first call: status=" + paused.get("status") + " question=" + paused.get("question"));
        check("paused".equals(paused.get("status")), "first call pauses");

        McpSchema.CallToolResult done = client.callTool(
                        "demo_deploy_resume", Map.of("runId", paused.get("runId"), "answer", "Deploy"))
                .block();
        System.out.println("resume: " + text(done));
        check(text(done).startsWith("Deployed api@1.2.3"), "resume deploys");

        // The registered tools carry taugraph's JSON schemas into AgentScope's Toolkit.
        Toolkit toolkit = new Toolkit();
        toolkit.registerMcpClient(client).block();
        System.out.println("toolkit: " + new TreeSet<>(toolkit.getToolNames()));
        check(toolkit.getToolNames().contains("demo_deploy_resume"), "toolkit has the flow tools");
        client.close();

        // 2. Elicitation: AgentScope answers the question itself (a UI would ask the user here).
        //    In AgentScope 2.0.5 only asyncElicitation declares the capability; syncElicitation does not.
        McpClientWrapper asking = McpClientBuilder.create("taugraph-elicit")
                .stdioTransport(command, serverArgs)
                .asyncElicitation(request -> {
                    System.out.println("elicitation: " + request.message() + " schema=" + request.requestedSchema().get("properties"));
                    return reactor.core.publisher.Mono.just(
                            new McpSchema.ElicitResult(McpSchema.ElicitResult.Action.ACCEPT, Map.of("answer", "Cancel")));
                })
                .buildAsync()
                .block();
        asking.initialize().block();
        McpSchema.CallToolResult oneShot =
                asking.callTool("demo_deploy", Map.of("service", "web", "version", "2.0.0")).block();
        System.out.println("one call with elicitation: " + text(oneShot));
        check("Deployment cancelled by the user.".equals(text(oneShot)), "elicitation finishes in one call");
        asking.close();
    }

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError("failed: " + what);
    }

    private static String text(McpSchema.CallToolResult result) {
        return result.content().stream()
                .filter(c -> c instanceof McpSchema.TextContent)
                .map(c -> ((McpSchema.TextContent) c).text())
                .findFirst()
                .orElse("(no text)");
    }
}
