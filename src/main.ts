import { runCli } from './cli/cli.ts';
import { parseCommand } from './project/config.ts';
import { runEditorDiagnosticsWorker } from './editor/editor_diagnostics_worker.ts';
import { createServer } from './lsp/server.ts';
import { createStdioTransport } from './lsp/transport.ts';
import { runtimeArgs, runtimeCwd, runtimeExit, writeStdout } from './platform/host.ts';

async function main(): Promise<void> {
  const args = runtimeArgs();
  const command = parseCommand(args, runtimeCwd());
  if (command.kind === 'lsp') {
    const transport = createStdioTransport();
    const server = createServer(transport);
    await server.start();
    return;
  }

  if (command.kind === 'editor-worker') {
    await runEditorDiagnosticsWorker();
    return;
  }

  const result = await runCli(args);
  writeStdout(result.output);
  runtimeExit(result.exitCode);
}

await main();
