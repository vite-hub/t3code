// @effect-diagnostics nodeBuiltinImport:off - A process entry point reads its own argv.
// ACP agents start `<node> acp-mcp-bridge.mjs acp-mcp-bridge` to reach the host's MCP
// endpoint, like the T3 server's own `acp-mcp-bridge` subcommand.
import { runAcpMcpCliFastPath } from "../../../apps/server/src/mcp/AcpMcpStdioBridge.ts";

const command = process.argv[2];
if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
  await runAcpMcpCliFastPath(command, process.argv.slice(3));
} else {
  process.stderr.write(`Unknown command ${JSON.stringify(command)}.\n`);
  process.exitCode = 2;
}
