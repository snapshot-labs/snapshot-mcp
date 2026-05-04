import { randomBytes } from 'node:crypto';
import {
  CdpClient,
  type CreatePolicyBody,
  type EvmServerAccount
} from '@coinbase/cdp-sdk';

const POLICY_DESCRIPTION = 'snapshot mcp v6';

const APP_CONDITION = { path: 'app', match: '^snapshot-mcp$' } as const;

const VOTE_FIELDS_BASE = [
  { name: 'from', type: 'string' },
  { name: 'space', type: 'string' },
  { name: 'timestamp', type: 'uint64' },
  { name: 'proposal', type: 'string' }
] as const;

const VOTE_FIELDS_TAIL = [
  { name: 'reason', type: 'string' },
  { name: 'app', type: 'string' },
  { name: 'metadata', type: 'string' }
] as const;

const voteRule = (choiceType: string): unknown => ({
  action: 'accept',
  operation: 'signEvmTypedData',
  criteria: [
    {
      type: 'evmTypedDataField',
      types: {
        primaryType: 'Vote',
        types: {
          Vote: [
            ...VOTE_FIELDS_BASE,
            { name: 'choice', type: choiceType },
            ...VOTE_FIELDS_TAIL
          ]
        }
      },
      conditions: [APP_CONDITION]
    }
  ]
});

const PROPOSAL_FIELDS = [
  { name: 'from', type: 'string' },
  { name: 'space', type: 'string' },
  { name: 'timestamp', type: 'uint64' },
  { name: 'type', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'body', type: 'string' },
  { name: 'discussion', type: 'string' },
  { name: 'choices', type: 'string[]' },
  { name: 'labels', type: 'string[]' },
  { name: 'start', type: 'uint64' },
  { name: 'end', type: 'uint64' },
  { name: 'snapshot', type: 'uint64' },
  { name: 'plugins', type: 'string' },
  { name: 'privacy', type: 'string' },
  { name: 'app', type: 'string' }
] as const;

const POLICY_RULES = [
  ...['signEvmTransaction', 'sendEvmTransaction'].map(operation => ({
    action: 'reject',
    operation,
    criteria: [{ type: 'ethValue', ethValue: '0', operator: '>=' }]
  })),
  {
    action: 'reject',
    operation: 'signEvmMessage',
    criteria: [{ type: 'evmMessage', match: '.*' }]
  },
  { action: 'reject', operation: 'signEvmHash' },
  voteRule('uint32'),
  voteRule('uint32[]'),
  voteRule('string'),
  {
    action: 'accept',
    operation: 'signEvmTypedData',
    criteria: [
      {
        type: 'evmTypedDataField',
        types: { primaryType: 'Proposal', types: { Proposal: PROPOSAL_FIELDS } },
        conditions: [APP_CONDITION]
      }
    ]
  }
] as const;

const DOMAIN_FIELD_TYPES: Record<string, string> = {
  name: 'string',
  version: 'string',
  chainId: 'uint256',
  verifyingContract: 'address',
  salt: 'bytes32'
};

export type CdpSigner = ReturnType<typeof makeCdpSigner>;

function makeCdpSigner(account: EvmServerAccount): {
  address: string;
  getAddress: () => Promise<string>;
  _signTypedData: (
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>
  ) => Promise<string>;
} {
  return {
    address: account.address,
    getAddress: async () => account.address,
    _signTypedData: async (domain, types, value) => {
      const primaryType = Object.keys(types).find(t => t !== 'EIP712Domain');
      if (primaryType === undefined)
        throw new Error('Could not determine primaryType from types');
      const EIP712Domain = Object.keys(domain)
        .filter(k => domain[k] !== undefined && Object.hasOwn(DOMAIN_FIELD_TYPES, k))
        .map(k => ({ name: k, type: DOMAIN_FIELD_TYPES[k] }));
      const message = Object.fromEntries(
        types[primaryType].map(({ name }) => [name, value[name]])
      );
      return account.signTypedData({
        domain,
        types: { ...types, EIP712Domain },
        primaryType,
        message
      } as Parameters<EvmServerAccount['signTypedData']>[0]);
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

async function ensurePolicy(): Promise<string> {
  const cdp = getCdpClient();
  const { policies } = await cdp.policies.listPolicies({ scope: 'account' });
  const existing = policies.find(p => p.description === POLICY_DESCRIPTION);
  if (existing) return existing.id;

  const created = await cdp.policies.createPolicy({
    policy: {
      scope: 'account',
      description: POLICY_DESCRIPTION,
      rules: POLICY_RULES as unknown as CreatePolicyBody['rules']
    }
  });
  return created.id;
}

export async function getWalletForUser(signerKey: string): Promise<CdpSigner> {
  const cdp = getCdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name: signerKey });
  const accountPolicy = await ensurePolicy();
  if (account.policies?.includes(accountPolicy) !== true) {
    await cdp.evm.updateAccount({
      address: account.address,
      update: { accountPolicy }
    });
  }
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
