import { randomUUID } from 'node:crypto';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SnapshotOAuthProvider } from './auth.js';
import { createMcpServer } from './server.js';

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
    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: sid => {
          transports.set(sid, transport);
        }
      });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await createMcpServer({ mode: 'http' }).connect(transport);
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
