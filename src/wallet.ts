import { randomBytes } from 'node:crypto';
import { CdpClient } from '@coinbase/cdp-sdk';

const POLICY_DESCRIPTION = 'snapshot mcp vote only v1';

// Blast-radius reduction if CDP_WALLET_SECRET leaks: only signEvmTypedData
// is allowed (what Snapshot votes and our access tokens need). Everything
// else — transactions, arbitrary messages, hashes — is rejected.
const POLICY_RULES = [
  {
    action: 'reject',
    operation: 'signEvmTransaction',
    criteria: [{ type: 'ethValue', ethValue: '0', operator: '>=' }]
  },
  {
    action: 'reject',
    operation: 'sendEvmTransaction',
    criteria: [{ type: 'ethValue', ethValue: '0', operator: '>=' }]
  },
  {
    action: 'reject',
    operation: 'signEvmMessage',
    criteria: [{ type: 'evmMessage', match: '.*' }]
  },
  { action: 'reject', operation: 'signEvmHash' }
] as const;

const DOMAIN_FIELD_TYPES: Record<string, string> = {
  name: 'string',
  version: 'string',
  chainId: 'uint256',
  verifyingContract: 'address',
  salt: 'bytes32'
};

export type CdpSigner = ReturnType<typeof makeCdpSigner>;

function makeCdpSigner(account: any) {
  return {
    address: account.address as string,
    getAddress: async () => account.address as string,
    _signTypedData: async (
      domain: Record<string, any>,
      types: Record<string, Array<{ name: string; type: string }>>,
      value: Record<string, any>
    ): Promise<string> => {
      const primaryType = Object.keys(types).find(t => t !== 'EIP712Domain');
      if (!primaryType)
        throw new Error('Could not determine primaryType from types');
      const EIP712Domain = Object.keys(domain)
        .filter(k => domain[k] !== undefined && DOMAIN_FIELD_TYPES[k])
        .map(k => ({ name: k, type: DOMAIN_FIELD_TYPES[k] }));
      // CDP strictly rejects messages with keys not declared in the primary
      // type. SX's shutter vote path leaks an undeclared `privacy` field,
      // so filter the message down to declared fields here.
      const message = Object.fromEntries(
        types[primaryType].map(({ name }) => [name, value[name]])
      );
      return account.signTypedData({
        domain,
        types: { ...types, EIP712Domain },
        primaryType,
        message
      });
    }
  };
}

let cdpClient: CdpClient | null = null;

function getCdpClient(): CdpClient {
  if (cdpClient) return cdpClient;

  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error(
      'CDP credentials not configured: set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET'
    );
  }

  cdpClient = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });
  return cdpClient;
}

let cachedPolicyId: string | null = null;

async function ensurePolicy(): Promise<string> {
  if (cachedPolicyId) return cachedPolicyId;

  const cdp = getCdpClient();
  const { policies } = await cdp.policies.listPolicies({ scope: 'account' });
  const existing = policies.find(p => p.description === POLICY_DESCRIPTION);
  if (existing) return (cachedPolicyId = existing.id);

  const created = await cdp.policies.createPolicy({
    policy: {
      scope: 'account',
      description: POLICY_DESCRIPTION,
      rules: POLICY_RULES as any
    }
  });
  return (cachedPolicyId = created.id);
}

export async function getWalletForUser(signerKey: string): Promise<CdpSigner> {
  const account = await getCdpClient().evm.getOrCreateAccount({
    name: signerKey
  });
  return makeCdpSigner(account);
}

export async function createFreshAccount(): Promise<{
  signerKey: string;
  signerAddress: string;
}> {
  const signerKey = `s-${randomBytes(16).toString('hex')}`;
  const accountPolicy = await ensurePolicy();
  const account = await getCdpClient().evm.createAccount({
    name: signerKey,
    accountPolicy
  });
  return { signerKey, signerAddress: account.address };
}
