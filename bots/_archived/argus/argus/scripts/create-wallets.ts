/**
 * Argus Wallet Generator
 *
 * Creates 4 strategy wallets and saves them as encrypted keystores.
 * Run once: npx tsx bots/argus/scripts/create-wallets.ts
 *
 * Wallets are encrypted with a passphrase from ARGUS_KEYSTORE_PASSPHRASE env var.
 * Keystores saved to data/keystores/<name>.json
 */

import { Wallet } from 'ethers';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEYSTORE_DIR = join(process.cwd(), 'data', 'keystores');

const WALLETS = [
  { name: 'funding-arb-spot', description: 'Funding arb spot leg (WETH on Arbitrum)' },
  { name: 'funding-arb-perp', description: 'Funding arb perp leg (USDC on Hyperliquid)' },
  { name: 'yield', description: 'Yield strategy (stablecoins on Arbitrum)' },
  { name: 'reserve', description: 'Cash reserve (USDC on Arbitrum)' },
] as const;

async function main() {
  const passphrase = process.env.ARGUS_KEYSTORE_PASSPHRASE;
  if (!passphrase) {
    console.error('ERROR: Set ARGUS_KEYSTORE_PASSPHRASE env var before running.');
    console.error('  export ARGUS_KEYSTORE_PASSPHRASE="your-strong-passphrase"');
    process.exit(1);
  }

  if (passphrase.length < 16) {
    console.error('ERROR: Passphrase must be at least 16 characters.');
    process.exit(1);
  }

  if (!existsSync(KEYSTORE_DIR)) {
    mkdirSync(KEYSTORE_DIR, { recursive: true });
  }

  console.log('=== Argus Wallet Generator ===\n');
  console.log(`Keystore directory: ${KEYSTORE_DIR}\n`);

  const results: Array<{ name: string; address: string; file: string }> = [];

  for (const { name, description } of WALLETS) {
    const keystorePath = join(KEYSTORE_DIR, `${name}.json`);

    if (existsSync(keystorePath)) {
      // Load existing keystore to show address
      const existing = JSON.parse(readFileSync(keystorePath, 'utf-8'));
      const address = `0x${existing.address}`;
      console.log(`  SKIP  ${name} — already exists (${address})`);
      results.push({ name, address, file: keystorePath });
      continue;
    }

    console.log(`  Creating ${name} — ${description}`);

    // Generate random wallet
    const wallet = Wallet.createRandom();

    // Encrypt with passphrase (scrypt, N=131072 for security)
    const encryptedJson = await wallet.encrypt(passphrase);

    // Save keystore
    writeFileSync(keystorePath, encryptedJson, { mode: 0o600 });

    console.log(`    Address: ${wallet.address}`);
    console.log(`    Saved:   ${keystorePath}`);

    results.push({ name, address: wallet.address, file: keystorePath });
  }

  console.log('\n=== Summary ===\n');
  console.log('| Wallet             | Address                                    |');
  console.log('|--------------------|-------------------------------------------|');
  for (const r of results) {
    console.log(`| ${r.name.padEnd(18)} | ${r.address} |`);
  }

  console.log('\n--- IMPORTANT ---');
  console.log('1. Back up data/keystores/ to a secure location');
  console.log('2. Fund testnet wallets with Arbitrum Sepolia ETH + testnet USDC');
  console.log('3. Deposit USDC to Hyperliquid testnet for funding-arb-perp wallet');
  console.log('4. NEVER commit keystores to git (data/ is in .gitignore)');
  console.log('\nTo load a wallet in code:');
  console.log('  const wallet = await loadWallet("funding-arb-perp");');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
