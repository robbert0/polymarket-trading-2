/**
 * Standalone script — derives Polymarket L2 API credentials from a private key.
 *
 * Usage:
 *   POLYMARKET_PRIVATE_KEY=0x... pnpm ts-node apps/api/src/trading/scripts/derive-api-key.ts
 *
 * Output lines (copy into `.env`):
 *   POLYMARKET_API_KEY=...
 *   POLYMARKET_SECRET=...
 *   POLYMARKET_PASSPHRASE=...
 */
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

async function main() {
  const privateKey = process.env['POLYMARKET_PRIVATE_KEY'];
  if (!privateKey) {
    console.error('Set POLYMARKET_PRIVATE_KEY environment variable');
    process.exit(1);
  }

  const host = 'https://clob.polymarket.com';
  const chainId = 137;
  const signer = new Wallet(privateKey);

  console.log(`Deriving API key for address: ${signer.address}`);

  const client = new ClobClient(host, chainId, signer);
  const creds = await client.createOrDeriveApiKey();

  console.log('\nAdd these to your .env file:\n');
  console.log(`POLYMARKET_API_KEY=${creds.key}`);
  console.log(`POLYMARKET_SECRET=${creds.secret}`);
  console.log(`POLYMARKET_PASSPHRASE=${creds.passphrase}`);
}

main().catch((err) => {
  console.error(
    'Failed to derive API key:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
