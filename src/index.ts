import { randomUUID } from 'node:crypto';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { authCallbackHandler, SnapshotOAuthProvider } from './auth.js';
import { createMcpServer } from './server.js';
import { isWalletConfigured } from './wallet.js';

const port = Number(process.env.PORT ?? 8080);
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;

const app = createMcpExpressApp({ host: '0.0.0.0' });
const transports = new Map<string, StreamableHTTPServerTransport>();

// --- OAuth setup (only when wallet is configured) ---

let authMiddleware: ReturnType<typeof requireBearerAuth> | null = null;

if (isWalletConfigured()) {
  const provider = new SnapshotOAuthProvider();
  const issuerUrl = new URL(baseUrl);

  app.use(mcpAuthRouter({ provider, issuerUrl }));
  app.get('/auth/callback', authCallbackHandler(provider));

  authMiddleware = requireBearerAuth({ verifier: provider });
}

// --- MCP transport handlers ---

const handlePost = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const holder: { transport?: StreamableHTTPServerTransport } = {};
    holder.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        transports.set(sid, holder.transport!);
      }
    });
    holder.transport.onclose = () => {
      if (holder.transport?.sessionId)
        transports.delete(holder.transport.sessionId);
    };
    await createMcpServer().connect(holder.transport);
    await holder.transport.handleRequest(req, res, req.body);
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

const handleGet = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    return void res.status(400).send('Invalid or missing session ID');
  }
  await transports.get(sessionId)!.handleRequest(req, res);
};

const handleDelete = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    return void res.status(400).send('Invalid or missing session ID');
  }
  await transports.get(sessionId)!.handleRequest(req, res);
};

// --- Mount MCP routes ---

if (authMiddleware) {
  app.post('/', authMiddleware, handlePost);
  app.get('/', authMiddleware, handleGet);
  app.delete('/', authMiddleware, handleDelete);
} else {
  app.post('/', handlePost);
  app.get('/', handleGet);
  app.delete('/', handleDelete);
}

app.listen(port);
