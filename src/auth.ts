import { randomUUID } from 'node:crypto';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  AuthorizationParams,
  OAuthServerProvider
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  OAuthClientInformationFull,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Request, Response } from 'express';
import { gql } from './hub.js';
import {
  signAccessToken,
  signClientId,
  verifyClientId,
  verifyAccessToken as verifyTokenSig
} from './token.js';
import { createFreshAccount } from './wallet.js';

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    try {
      const metadata = await verifyClientId(clientId);
      return { ...metadata, client_id: clientId };
    } catch {
      return undefined;
    }
  },
  async registerClient(client) {
    const metadata = {
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000)
    };
    const client_id = await signClientId(metadata);
    return { ...metadata, client_id } as OAuthClientInformationFull;
  }
};

interface PendingSession {
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  clientId: string;
  signerKey: string;
  signerAddress: string;
}

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  userAddress: string;
  redirectUri: string;
  signerKey: string;
}

export class SnapshotOAuthProvider implements OAuthServerProvider {
  clientsStore = clientsStore;
  private pendingSessions = new Map<string, PendingSession>();
  private codes = new Map<string, CodeRecord>();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const sessionId = randomUUID();
    const { signerKey, signerAddress } = await createFreshAccount();

    this.pendingSessions.set(sessionId, {
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      clientId: client.client_id,
      signerKey,
      signerAddress
    });

    const baseUrl =
      process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`;
    const callbackUrl = `${baseUrl}/auth/callback?session=${sessionId}`;

    const snapshotUrl = `https://snapshot.box/#/settings/alias/authorize/${signerAddress}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
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

    const accessToken = await signAccessToken({
      userAddress: record.userAddress,
      signerKey: record.signerKey,
      clientId: client.client_id
    });

    return { access_token: accessToken, token_type: 'bearer' };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error('Refresh tokens are not supported');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = await verifyTokenSig(token);
    return {
      token,
      clientId: payload.clientId,
      scopes: [],
      // SDK's bearerAuth middleware requires a valid expiresAt; tokens never
      // actually expire (only invalidated by JWT_SECRET rotation), so use
      // a far-future timestamp.
      expiresAt: Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 3600,
      extra: {
        userAddress: payload.userAddress,
        signerKey: payload.signerKey
      }
    };
  }

  async revokeToken(): Promise<void> {
    // no-op: stateless tokens can't be revoked without a deny-list
  }

  async handleCallback(sessionId: string): Promise<string> {
    const session = this.pendingSessions.get(sessionId);
    if (!session) throw new Error('Unknown session');

    const result = await gql(
      `query Aliases($where: AliasWhere) {
        aliases(first: 1, skip: 0, where: $where) { address }
      }`,
      { where: { alias: session.signerAddress } }
    );
    const userAddress = ((result as any)?.aliases ?? [])[0]?.address;
    if (!userAddress) throw new Error('Alias not authorized');

    const code = randomUUID();
    this.codes.set(code, {
      clientId: session.clientId,
      codeChallenge: session.codeChallenge,
      userAddress,
      redirectUri: session.redirectUri,
      signerKey: session.signerKey
    });
    this.pendingSessions.delete(sessionId);

    const url = new URL(session.redirectUri);
    url.searchParams.set('code', code);
    if (session.state) url.searchParams.set('state', session.state);
    return url.toString();
  }

  callback = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.query.session as string | undefined;
    if (!sessionId) return void res.status(400).send('Missing session');
    try {
      res.redirect(await this.handleCallback(sessionId));
    } catch (e) {
      res.status(400).send(e instanceof Error ? e.message : String(e));
    }
  };
}
