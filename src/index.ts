import { randomUUID } from 'node:crypto';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SnapshotOAuthProvider } from './auth.js';
import { createMcpServer } from './server.js';
import { initJwtSecret } from './token.js';
import { isHttpWalletConfigured } from './wallet.js';

if (!isHttpWalletConfigured()) {
  console.error(
    'HTTP server requires CDP credentials. Set CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET.'
  );
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  console.error(
    'JWT_SECRET must be set and at least 32 characters. Generate one with: openssl rand -hex 32'
  );
  process.exit(1);
}
initJwtSecret(jwtSecret);

const port = Number(process.env.PORT ?? 8080);
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;

const app = createMcpExpressApp({ host: '0.0.0.0' });
const transports = new Map<string, StreamableHTTPServerTransport>();

const provider = new SnapshotOAuthProvider();
const issuerUrl = new URL(baseUrl);

app.use(mcpAuthRouter({ provider, issuerUrl }));
app.get('/auth/callback', provider.callback);

const authMiddleware = requireBearerAuth({ verifier: provider });

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
    await createMcpServer({ mode: 'http' }).connect(holder.transport);
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

const handleSession = async (req: any, res: any) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    return void res.status(400).send('Invalid or missing session ID');
  }
  await transports.get(sessionId)!.handleRequest(req, res);
};

app.post('/', authMiddleware, handlePost);
app.get('/', authMiddleware, handleSession);
app.delete('/', authMiddleware, handleSession);

app.listen(port);
