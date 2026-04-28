import { randomUUID } from 'node:crypto';
import { JWTPayload, jwtVerify, SignJWT } from 'jose';

const ALG = 'HS256';

export interface AccessTokenPayload {
  userAddress: string;
  signerKey: string;
  clientId: string;
  issuedAt: number;
  nonce: string;
}

let secret: Uint8Array | null = null;

export function initJwtSecret(raw: string): void {
  if (raw.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }
  secret = new TextEncoder().encode(raw);
}

function requireSecret(): Uint8Array {
  if (!secret) throw new Error('JWT secret not initialized');
  return secret;
}

async function sign(claims: JWTPayload): Promise<string> {
  return new SignJWT({ ...claims, nonce: randomUUID() })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .sign(requireSecret());
}

async function verify(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, requireSecret(), {
    algorithms: [ALG]
  });
  return payload;
}

export async function signAccessToken(
  payload: Pick<AccessTokenPayload, 'userAddress' | 'signerKey' | 'clientId'>
): Promise<string> {
  return sign({
    sub: payload.userAddress,
    aud: payload.clientId,
    signerKey: payload.signerKey
  });
}

export async function verifyAccessToken(
  token: string
): Promise<AccessTokenPayload> {
  const p = await verify(token);
  if (
    typeof p.sub !== 'string' ||
    typeof p.aud !== 'string' ||
    typeof p.signerKey !== 'string' ||
    typeof p.iat !== 'number' ||
    typeof p.nonce !== 'string'
  ) {
    throw new Error('Invalid token');
  }
  return {
    userAddress: p.sub,
    signerKey: p.signerKey,
    clientId: p.aud,
    issuedAt: p.iat,
    nonce: p.nonce
  };
}

export async function signClientId(metadata: unknown): Promise<string> {
  return sign({ metadata: JSON.stringify(metadata) });
}

export async function verifyClientId(clientId: string): Promise<any> {
  const p = await verify(clientId);
  if (typeof p.metadata !== 'string') throw new Error('Invalid client_id');
  return JSON.parse(p.metadata);
}
