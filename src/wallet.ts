import { CdpClient } from '@coinbase/cdp-sdk';
import { Wallet } from '@ethersproject/wallet';

/**
 * Adapter that wraps a Coinbase CDP EvmServerAccount to implement
 * the ethers v5 Signer & TypedDataSigner interface required by sx.js.
 */
class CdpSignerAdapter {
  readonly address: string;
  private account: any; // CDP EvmServerAccount

  constructor(account: any) {
    this.address = account.address;
    this.account = account;
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async _signTypedData(
    domain: Record<string, any>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, any>
  ): Promise<string> {
    const primaryType = Object.keys(types).find(t => t !== 'EIP712Domain');
    if (!primaryType)
      throw new Error('Could not determine primaryType from types');

    return this.account.signTypedData({
      domain,
      types: { ...types, EIP712Domain: [] },
      primaryType,
      message: value
    });
  }
}

async function initWallet(): Promise<Wallet | CdpSignerAdapter> {
  const privateKey = process.env.ALIAS_PRIVATE_KEY;
  if (privateKey) return new Wallet(privateKey);

  const cdpKeyId = process.env.CDP_API_KEY_ID;
  const cdpKeySecret = process.env.CDP_API_KEY_SECRET;
  const cdpWalletSecret = process.env.CDP_WALLET_SECRET;

  if (cdpKeyId && cdpKeySecret && cdpWalletSecret) {
    const cdp = new CdpClient({
      apiKeyId: cdpKeyId,
      apiKeySecret: cdpKeySecret,
      walletSecret: cdpWalletSecret
    });
    const account = await cdp.evm.createAccount();
    return new CdpSignerAdapter(account);
  }

  throw new Error(
    'No wallet configured. Set ALIAS_PRIVATE_KEY or CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET.'
  );
}

let walletPromise: Promise<Wallet | CdpSignerAdapter> | null = null;

export function getWallet() {
  return (walletPromise ??= initWallet());
}

export function isWalletConfigured(): boolean {
  return !!(
    process.env.ALIAS_PRIVATE_KEY ||
    (process.env.CDP_API_KEY_ID &&
      process.env.CDP_API_KEY_SECRET &&
      process.env.CDP_WALLET_SECRET)
  );
}
