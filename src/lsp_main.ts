import { createServer } from './lsp/server.ts';
import { createStdioTransport } from './lsp/transport.ts';

const transport = createStdioTransport();
const server = createServer(transport);

await server.start();
