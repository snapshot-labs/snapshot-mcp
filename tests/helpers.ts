import { Wallet } from '@ethersproject/wallet';
import { mock } from 'bun:test';
import { initJwtSecret } from '../src/token.js';

const FIXED_TEST_SECRET =
  'test-secret-must-be-at-least-32-chars-long-please-yes';
initJwtSecret(FIXED_TEST_SECRET);

export const state: {
  jwtSecret: string;
  userSigners: Map<string, Wallet>;
  gqlHandler: (query: string, variables?: any) => unknown;
} = {
  jwtSecret: FIXED_TEST_SECRET,
  userSigners: new Map(),
  gqlHandler: () => ({})
};

export function setJwtSecret(s: string) {
  state.jwtSecret = s;
  initJwtSecret(s);
}

export function setGqlHandler(fn: (query: string, variables?: any) => unknown) {
  state.gqlHandler = fn;
}

export function resetState() {
  state.jwtSecret = FIXED_TEST_SECRET;
  initJwtSecret(FIXED_TEST_SECRET);
  state.userSigners.clear();
  state.gqlHandler = () => ({});
}

mock.module('../src/wallet.ts', () => ({
  getWalletForUser: async (signerKey: string) => {
    let w = state.userSigners.get(signerKey);
    if (!w) {
      w = Wallet.createRandom();
      state.userSigners.set(signerKey, w);
    }
    return w;
  },
  createFreshAccount: async () => {
    const w = Wallet.createRandom();
    const signerKey = `s-${w.address.slice(2, 18).toLowerCase()}`;
    state.userSigners.set(signerKey, w);
    return { signerKey, signerAddress: w.address };
  },
  getStdioWallet: () => Wallet.createRandom(),
  isHttpWalletConfigured: () => true
}));

mock.module('../src/hub.ts', () => ({
  gql: async (q: string, v?: any) => state.gqlHandler(q, v),
  schemaCache: Promise.resolve({}),
  toContent: (r: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(r) }]
  }),
  toError: (e: unknown) => ({
    content: [{ type: 'text', text: String(e) }],
    isError: true
  })
}));
