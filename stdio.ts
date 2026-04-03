import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './src/server.js';

await createMcpServer().connect(new StdioServerTransport());
