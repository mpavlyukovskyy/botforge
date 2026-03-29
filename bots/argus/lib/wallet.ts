/**
 * Argus Trading System — Wallet Management
 *
 * Loads encrypted keystores and provides wallets for each strategy.
 * Supports both ethers.js Wallet and viem account formats.
 */

import { Wallet } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const KEYSTORE_DIR = join(process.cwd(), 'data', 'keystores');

type WalletName = 'funding-arb-spot' | 'funding-arb-perp' | 'yield' | 'reserve';

// Cache decrypted wallets in memory (they're needed repeatedly)
const walletCache = new Map<WalletName, Wallet>();
const viemAccountCache = new Map<WalletName, PrivateKeyAccount>();

/**
 * Load an ethers.js Wallet from encrypted keystore.
 * Wallets are cached after first decryption.
 */
export async function loadWallet(name: WalletName): Promise<Wallet> {
  const cached = walletCache.get(name);
  if (cached) return cached;

  const passphrase = process.env.ARGUS_KEYSTORE_PASSPHRASE;
  if (!passphrase) {
    throw new Error('ARGUS_KEYSTORE_PASSPHRASE env var not set');
  }

  const keystorePath = join(KEYSTORE_DIR, `${name}.json`);
  if (!existsSync(keystorePath)) {
    throw new Error(`Keystore not found: ${keystorePath}. Run create-wallets.ts first.`);
  }

  const encryptedJson = readFileSync(keystorePath, 'utf-8');
  const wallet = await Wallet.fromEncryptedJson(encryptedJson, passphrase);

  walletCache.set(name, wallet);
  return wallet;
}

/**
 * Load a viem PrivateKeyAccount from encrypted keystore.
 * Used by the Hyperliquid SDK which prefers viem wallets.
 */
export async function loadViemAccount(name: WalletName): Promise<PrivateKeyAccount> {
  const cached = viemAccountCache.get(name);
  if (cached) return cached;

  const wallet = await loadWallet(name);
  const account = privateKeyToAccount(wallet.privateKey as `0x${string}`);

  viemAccountCache.set(name, account);
  return account;
}

/**
 * Get the address for a wallet without decrypting (reads from keystore JSON).
 */
export function getWalletAddress(name: WalletName): string {
  // Check cache first
  const cached = walletCache.get(name);
  if (cached) return cached.address;

  const keystorePath = join(KEYSTORE_DIR, `${name}.json`);
  if (!existsSync(keystorePath)) {
    throw new Error(`Keystore not found: ${keystorePath}`);
  }

  const keystore = JSON.parse(readFileSync(keystorePath, 'utf-8'));
  return `0x${keystore.address}`;
}

/**
 * Clear all cached wallets from memory.
 * Call on shutdown to minimize key exposure time.
 */
export function clearWalletCache(): void {
  walletCache.clear();
  viemAccountCache.clear();
}
