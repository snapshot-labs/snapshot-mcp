import { randomUUID } from 'node:crypto';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  AuthorizationParams,
  OAuthServerProvider
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Request, Response } from 'express';
import { gql } from './hub.js';
import { getWallet } from './wallet.js';

const TOKEN_TTL = 86400; // 24 hours

// --- Clients store ---

class ClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string) {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<
      OAuthClientInformationFull,
      'client_id' | 'client_id_issued_at'
    >
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000)
    } as OAuthClientInformationFull;
    this.clients.set(full.client_id, full);
    return full;
  }
}

// --- Provider ---

interface PendingSession {
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  clientId: string;
}

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  userAddress: string;
  redirectUri: string;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  userAddress: string;
}

export class SnapshotOAuthProvider implements OAuthServerProvider {
  private _clientsStore = new ClientsStore();
  private pendingSessions = new Map<string, PendingSession>();
  private codes = new Map<string, CodeRecord>();
  private tokens = new Map<string, TokenRecord>();

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const sessionId = randomUUID();
    this.pendingSessions.set(sessionId, {
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      clientId: client.client_id
    });

    const alias = await (await getWallet()).getAddress();
    const baseUrl =
      process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`;
    const callbackUrl = `${baseUrl}/auth/callback?session=${sessionId}`;

    const snapshotUrl = `https://snapshot.box/#/settings/alias/authorize/${alias}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
    res.redirect(snapshotUrl);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record) throw new Error('Unknown authorization code');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (!record) throw new Error('Unknown authorization code');
    if (record.clientId !== client.client_id)
      throw new Error('Client mismatch');
    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    this.tokens.set(accessToken, {
      clientId: client.client_id,
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL,
      userAddress: record.userAddress
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_TTL
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error('Refresh tokens are not supported');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.tokens.get(token);
    if (!record) throw new Error('Invalid token');
    if (record.expiresAt < Date.now() / 1000) {
      this.tokens.delete(token);
      throw new Error('Token expired');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      extra: { userAddress: record.userAddress }
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.tokens.delete(request.token);
  }

  // Called by the /auth/callback handler
  async handleCallback(sessionId: string): Promise<string> {
    const session = this.pendingSessions.get(sessionId);
    if (!session) throw new Error('Unknown session');

    const alias = await (await getWallet()).getAddress();
    const result = await gql(
      `query Aliases($where: AliasWhere) {
        aliases(first: 1, skip: 0, where: $where) { address }
      }`,
      { where: { alias } }
    );
    const userAddress = ((result as any)?.aliases ?? [])[0]?.address;
    if (!userAddress) throw new Error('Alias not authorized');

    const code = randomUUID();
    this.codes.set(code, {
      clientId: session.clientId,
      codeChallenge: session.codeChallenge,
      userAddress,
      redirectUri: session.redirectUri
    });
    this.pendingSessions.delete(sessionId);

    const url = new URL(session.redirectUri);
    url.searchParams.set('code', code);
    if (session.state) url.searchParams.set('state', session.state);
    return url.toString();
  }
}

// Express handler for GET /auth/callback
export function authCallbackHandler(provider: SnapshotOAuthProvider) {
  return async (req: Request, res: Response) => {
    const sessionId = req.query.session as string | undefined;
    if (!sessionId) return void res.status(400).send('Missing session');

    try {
      const redirectUrl = await provider.handleCallback(sessionId);
      res.redirect(redirectUrl);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(400).send(message);
    }
  };
}
