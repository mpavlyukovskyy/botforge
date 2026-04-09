/**
 * Explore a specific day's menu page on LunchDrop
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const DEBUG_DIR = '/tmp/alfred-explore';
const URL = 'https://raleigh.lunchdrop.com';
const EMAIL = 'MarkP@Science.xyz';
const PASSWORD = 'ScienceLunch';

async function explore() {
  mkdirSync(DEBUG_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Capture API/XHR responses
  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (ct.includes('json') && url.includes('lunchdrop.com')) {
      try {
        const body = await response.json();
        apiCalls.push({ url, status: response.status(), body });
      } catch { apiCalls.push({ url, status: response.status() }); }
    }
  });

  try {
    // Login (two-step)
    console.log('Logging in...');
    await page.goto(`${URL}/signin`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[name="email"]', EMAIL);
    await page.click('input[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('input[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await page.waitForTimeout(2000);
    console.log(`Logged in: ${page.url()}`);

    // Navigate to weekdays Mon-Fri
    const days = [
      { name: 'Monday', date: '2026-04-06' },
      { name: 'Tuesday', date: '2026-04-07' },
      { name: 'Wednesday', date: '2026-04-08' },
      { name: 'Thursday', date: '2026-04-09' },
      { name: 'Friday', date: '2026-04-10' },
    ];

    for (const day of days) {
      console.log(`\n--- ${day.name} (${day.date}) ---`);
      await page.goto(`${URL}/app/${day.date}`, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${DEBUG_DIR}/day-${day.name.toLowerCase()}.png`, fullPage: true });

      const pageData = await page.evaluate(() => {
        // Get all text content
        const bodyText = document.body.innerText;

        // Find elements with prices
        const priceEls = [];
        document.querySelectorAll('*').forEach(el => {
          if (el.children.length === 0 && /\$\d/.test(el.textContent) && el.textContent.length < 50) {
            priceEls.push({
              tag: el.tagName, text: el.textContent.trim(),
              class: el.className?.toString().slice(0, 100),
              parentTag: el.parentElement?.tagName,
              parentClass: el.parentElement?.className?.toString().slice(0, 100),
            });
          }
        });

        // Find card-like containers
        const cards = [];
        document.querySelectorAll('[class*="card"], [class*="item"], [class*="menu"], [class*="meal"], [class*="restaurant"], [class*="option"], [class*="choice"]').forEach(el => {
          if (el.textContent.length > 20 && el.textContent.length < 500) {
            cards.push({
              tag: el.tagName,
              class: el.className?.toString().slice(0, 150),
              text: el.textContent.trim().slice(0, 200),
              childCount: el.children.length,
            });
          }
        });

        // Get main content HTML (for selector discovery)
        const main = document.querySelector('main, .content, [class*="container"], [class*="restaurants"], [class*="menu"]');
        const html = main ? main.innerHTML.slice(0, 15000) : document.body.innerHTML.slice(0, 15000);

        // All unique class names
        const classes = Array.from(new Set(
          Array.from(document.querySelectorAll('[class]')).map(el => el.className.toString()).filter(c => c.length > 0 && c.length < 200)
        ));

        return { bodyText: bodyText.slice(0, 5000), priceEls, cards, html, classes };
      });

      writeFileSync(`${DEBUG_DIR}/day-${day.name.toLowerCase()}-data.json`, JSON.stringify(pageData, null, 2));
      console.log(`Body text: ${pageData.bodyText.slice(0, 300)}`);
      console.log(`Price elements: ${pageData.priceEls.length}`);
      console.log(`Card elements: ${pageData.cards.length}`);
      console.log(`Classes: ${pageData.classes.length}`);

      // Only do detailed exploration on first day with content
      if (pageData.priceEls.length > 0 || pageData.cards.length > 0) {
        console.log('\nPrice elements:');
        for (const p of pageData.priceEls.slice(0, 10)) {
          console.log(`  ${p.tag}.${p.class} -> "${p.text}" (parent: ${p.parentTag}.${p.parentClass})`);
        }
        console.log('\nCard elements:');
        for (const c of pageData.cards.slice(0, 5)) {
          console.log(`  ${c.tag}.${c.class?.slice(0, 60)} -> "${c.text.slice(0, 100)}"`);
        }
        // Found content, save HTML for analysis and break
        writeFileSync(`${DEBUG_DIR}/day-${day.name.toLowerCase()}-html.html`, pageData.html);
        break;
      }
    }

    // Save API calls
    writeFileSync(`${DEBUG_DIR}/20-day-api-calls.json`, JSON.stringify(apiCalls, null, 2));
    console.log(`\nAPI calls: ${apiCalls.length}`);

  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: `${DEBUG_DIR}/error-day.png` }).catch(() => {});
  } finally {
    await browser.close();
  }
}

explore().catch(console.error);
