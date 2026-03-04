import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';

const transports = new Map<string, StreamableHTTPServerTransport>();

createServer(async (req, res) => {
  if (req.url !== '/') {
    return void res.writeHead(404).end();
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;

  if (!sessionId && req.method === 'POST') {
    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });

    await createMcpServer().connect(t);
    await t.handleRequest(req, res);

    if (t.sessionId) {
      transports.set(t.sessionId, t);
      t.onclose = () => transports.delete(t.sessionId!);
    }
  } else if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.writeHead(400).end('Bad Request');
  }
}).listen(process.env.PORT ?? 8080);
