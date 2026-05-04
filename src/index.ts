import { randomUUID } from 'node:crypto';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { type Request, type Response } from 'express';
import pkg from '../package.json' with { type: 'json' };
import { SnapshotOAuthProvider } from './auth.js';
import instructions from './instructions.md' with { type: 'text' };
import {
  createResolveContext,
  registerFollowTool,
  registerProposeTool,
  registerQueryTool,
  registerSchemaTool,
  registerVoteTool
} from './tools.js';

function createMcpServer(mode: 'http' | 'stdio'): McpServer {
  const server = new McpServer(
    {
      name: 'snapshot',
      title: 'Snapshot',
      version: pkg.version,
      websiteUrl: 'https://snapshot.box',
      icons: [
        {
          src: 'https://snapshot.box/favicon-dark.svg',
          mimeType: 'image/svg+xml',
          sizes: ['any'],
          theme: 'light'
        },
        {
          src: 'https://snapshot.box/favicon.svg',
          mimeType: 'image/svg+xml',
          sizes: ['any'],
          theme: 'dark'
        }
      ]
    },
    { instructions }
  );
  const resolveContext = createResolveContext(mode);
  registerSchemaTool(server);
  registerQueryTool(server, resolveContext);
  registerVoteTool(server, resolveContext);
  registerProposeTool(server, resolveContext);
  registerFollowTool(server, resolveContext);
  return server;
}

if (process.argv.includes('--stdio')) {
  await createMcpServer('stdio').connect(new StdioServerTransport());
} else {
  const port = Number(process.env.PORT ?? 8080);
  const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;

  const app = createMcpExpressApp({ host: '0.0.0.0' });
  app.set('trust proxy', 1);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const provider = new SnapshotOAuthProvider();
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(baseUrl) }));
  app.get('/auth/callback', provider.callback);

  const authMiddleware = requireBearerAuth({ verifier: provider });

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const existing = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId === undefined && isInitializeRequest(req.body)) {
      const transport: StreamableHTTPServerTransport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: sid => {
            transports.set(sid, transport);
          }
        });
      transport.onclose = () => {
        if (transport.sessionId !== undefined) transports.delete(transport.sessionId);
      };
      await createMcpServer('http').connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided'
      },
      id: null
    });
  };

  const handleSession = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.post('/', authMiddleware, handlePost);
  app.get('/', authMiddleware, handleSession);
  app.delete('/', authMiddleware, handleSession);

  app.listen(port);
}
