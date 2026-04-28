// Token cryptographic invariants. Each test pins one specific attack
// the verifier must reject. See plan file for justifications.
import { describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { state } from './helpers.js';
import { signAccessToken, verifyAccessToken } from '../src/token.js';

const PAYLOAD = {
  userAddress: '0x000000000000000000000000000000000000aaaa',
  signerKey: 's-fixture',
  clientId: 'client-fixture'
};

describe('access token security', () => {
  test('valid token roundtrips and recovers the original fields', async () => {
    const token = await signAccessToken(PAYLOAD);
    const decoded = await verifyAccessToken(token);
    expect(decoded.userAddress).toBe(PAYLOAD.userAddress);
    expect(decoded.signerKey).toBe(PAYLOAD.signerKey);
    expect(decoded.clientId).toBe(PAYLOAD.clientId);
    expect(typeof decoded.issuedAt).toBe('number');
    expect(typeof decoded.nonce).toBe('string');
  });

  test('tampering with the payload invalidates the signature', async () => {
    const token = await signAccessToken(PAYLOAD);
    // JWT format is `header.payload.signature`. Decode payload, modify
    // the subject (userAddress), re-encode, leave the original signature.
    const [header, payload, sig] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    claims.sub = '0x000000000000000000000000000000000000bbbb';
    const tampered = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect(verifyAccessToken(tampered)).rejects.toThrow();
  });

  test('token signed with a different secret is rejected', async () => {
    // Construct a JWT with the same shape as the server but a different
    // secret. Verification under the server's secret must fail.
    const attackerSecret = new TextEncoder().encode(
      'attacker-secret-also-32-chars-or-more-yes'
    );
    const forged = await new SignJWT({
      signerKey: PAYLOAD.signerKey,
      nonce: 'attacker-nonce'
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(PAYLOAD.userAddress)
      .setAudience(PAYLOAD.clientId)
      .setIssuedAt()
      .sign(attackerSecret);
    expect(verifyAccessToken(forged)).rejects.toThrow();
    expect(attackerSecret).not.toEqual(
      new TextEncoder().encode(state.jwtSecret)
    );
  });

  test('malformed tokens throw rather than silently parsing as garbage', () => {
    expect(verifyAccessToken('')).rejects.toThrow();
    expect(verifyAccessToken('not-a-jwt')).rejects.toThrow();
    expect(verifyAccessToken('a.b')).rejects.toThrow();
    expect(verifyAccessToken('a.b.c.d')).rejects.toThrow();
  });
});
