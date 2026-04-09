/**
 * Test the scraper standalone
 * Run: node bots/alfred/scripts/test-scraper.js
 */
import { scrapeMenu } from '../lib/scraper.js';

// Provide env vars
process.env.LUNCHDROP_EMAIL = process.env.LUNCHDROP_EMAIL || 'MarkP@Science.xyz';
process.env.LUNCHDROP_PASSWORD = process.env.LUNCHDROP_PASSWORD || 'ScienceLunch';
process.env.LUNCHDROP_URL = process.env.LUNCHDROP_URL || 'https://raleigh.lunchdrop.com';

const log = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.log('[WARN]', ...args),
  error: (...args) => console.log('[ERROR]', ...args),
};

async function test() {
  console.log('Testing scraper...\n');
  const result = await scrapeMenu(log);

  if (!result) {
    console.log('\nNo result returned.');
    return;
  }

  console.log(`\nWeek of: ${result.weekOf}`);
  console.log(`Total items: ${result.items.length}\n`);

  // Group by day
  const byDay = {};
  for (const item of result.items) {
    if (!byDay[item.day]) byDay[item.day] = [];
    byDay[item.day].push(item);
  }

  for (const [day, items] of Object.entries(byDay)) {
    console.log(`--- ${day} (${items.length} items) ---`);
    for (const item of items.slice(0, 8)) {
      const price = item.price ? `$${item.price.toFixed(2)}` : 'N/A';
      const restaurant = item.restaurant ? ` (${item.restaurant})` : '';
      const desc = item.description ? ` — ${item.description.slice(0, 60)}` : '';
      console.log(`  ${item.name}${restaurant}: ${price}${desc}`);
    }
    if (items.length > 8) console.log(`  ... and ${items.length - 8} more`);
    console.log();
  }
}

test().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
