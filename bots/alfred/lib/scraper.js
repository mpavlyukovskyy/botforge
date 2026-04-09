/**
 * LunchDrop menu scraper using Playwright
 *
 * Site structure (raleigh.lunchdrop.com):
 * - Two-step login: /signin → email → password
 * - App at /app with day tabs: /app/YYYY-MM-DD
 * - Each day has restaurant tabs (green buttons with restaurant logos)
 * - Menu is client-rendered SPA — must use innerText parsing
 * - Menu sections: Favorites, Entrees, Sides, Desserts
 * - Items: div.flex.items-center.justify-between with name + price
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const DEBUG_DIR = '/tmp/alfred-debug';
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

let _running = false;

/**
 * Extract menu items from the currently visible .main-preview-menu on page.
 * Returns array of { name, price, description, restaurant, tags }.
 */
async function extractMenuItems(page, restaurantName) {
  return page.evaluate((rName) => {
    const items = [];
    const menuSection = document.querySelector('.main-preview-menu') || document.body;
    const bodyText = menuSection.innerText;

    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

    const sectionHeaders = ['Favorites', 'Entrees', 'Sides', 'Desserts', 'Drinks', 'Beverages', 'Appetizers', 'Soups', 'Salads', 'Sandwiches', 'Bowls', 'Wraps', 'Platters', 'Specials', 'Kids'];
    const pricePattern = /^\$[\d.]+(?: - \$[\d.]+)?$/;
    const skipPatterns = [
      /^Gift Cards$/i, /^Help/i, /^Contact/i, /^Ordering for/i,
      /^Terms of/i, /^Privacy/i, /^Do Not Sell/i, /^Offer your/i,
    ];

    let currentSection = null;
    let pendingName = null;
    let pendingDesc = null;
    let inMenuArea = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (skipPatterns.some(p => p.test(line))) continue;

      if (sectionHeaders.includes(line)) {
        currentSection = line;
        inMenuArea = true;
        pendingName = null;
        pendingDesc = null;
        continue;
      }

      if (!inMenuArea) continue;

      if (pricePattern.test(line)) {
        if (pendingName) {
          const priceMatch = line.match(/\$([\d.]+)/);
          items.push({
            name: pendingName,
            price: priceMatch ? parseFloat(priceMatch[1]) : null,
            description: pendingDesc || null,
            restaurant: rName || null,
            tags: currentSection ? [currentSection] : [],
          });
        }
        pendingName = null;
        pendingDesc = null;
        continue;
      }

      if (pendingName === null) {
        pendingName = line;
        pendingDesc = null;
      } else {
        pendingDesc = (pendingDesc ? pendingDesc + ' ' : '') + line;
      }
    }

    return items;
  }, restaurantName || null);
}

/**
 * Scrape the LunchDrop weekly menu.
 * Returns { weekOf: string, items: Array<{ day, name, restaurant, price, description, tags }> }
 */
export async function scrapeMenu(log) {
  if (_running) {
    log?.warn('Scraper already running, skipping');
    return null;
  }
  _running = true;

  const url = process.env.LUNCHDROP_URL || 'https://raleigh.lunchdrop.com';
  const email = process.env.LUNCHDROP_EMAIL;
  const password = process.env.LUNCHDROP_PASSWORD;

  if (!email || !password) {
    _running = false;
    throw new Error('LUNCHDROP_EMAIL and LUNCHDROP_PASSWORD must be set');
  }

  let browser;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    // ── Step 1: Two-step login ─────────────────────────────────────────────
    log?.info('Logging into LunchDrop...');
    await page.goto(`${url}/signin`, { waitUntil: 'networkidle', timeout: 30_000 });

    // Step 1a: Email
    await page.fill('input[name="email"]', email);
    await page.click('input[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    // Step 1b: Password
    const passwordInput = await page.$('input[type="password"]');
    if (passwordInput) {
      await passwordInput.fill(password);
      await page.click('input[type="submit"]');
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      await page.waitForTimeout(2000);
    } else {
      throw new Error('Password field not found after email submission');
    }

    // Verify login succeeded — should be at /app
    if (!page.url().includes('/app')) {
      await page.screenshot({ path: `${DEBUG_DIR}/login-failed.png` });
      throw new Error(`Login failed — landed at ${page.url()}`);
    }
    log?.info('Login successful');

    // ── Step 2: Determine week dates ───────────────────────────────────────
    // Extract day links from the day tab bar
    const dayLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/app/2"]'));
      return links.map(a => ({
        href: a.href,
        text: a.textContent.trim(),
        date: a.href.match(/\/app\/([\d-]+)/)?.[1],
      })).filter(l => l.date);
    });

    // Find THIS week's Mon-Fri only (first 5 weekdays found)
    const weekdayDates = [];
    const seen = new Set();
    for (const link of dayLinks) {
      const d = new Date(link.date + 'T12:00:00');
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5 && !seen.has(link.date)) {
        seen.add(link.date);
        weekdayDates.push({
          date: link.date,
          day: WEEKDAYS[dow - 1],
          href: link.href,
        });
      }
    }
    // Only take first 5 weekdays (this week)
    weekdayDates.splice(5);

    if (weekdayDates.length === 0) {
      throw new Error('No weekday dates found in day tabs');
    }

    // weekOf = first Monday
    const weekOf = weekdayDates.find(d => d.day === 'Monday')?.date || weekdayDates[0].date;
    log?.info(`Scraping week of ${weekOf}: ${weekdayDates.map(d => d.day).join(', ')}`);

    // ── Step 3: Scrape each day ────────────────────────────────────────────
    const allItems = [];

    for (const dayInfo of weekdayDates) {
      log?.info(`Scraping ${dayInfo.day} (${dayInfo.date})...`);
      await page.goto(`${url}/app/${dayInfo.date}`, { waitUntil: 'networkidle', timeout: 15_000 });
      await page.waitForTimeout(1500);

      // Count restaurant tabs — direct children of the flex container are <a> tags wrapping each card
      const tabSelector = '.flex.flex-wrap.gap-3 > a';
      const tabCount = await page.locator(tabSelector).count();

      if (tabCount <= 1) {
        // Fallback: 0-1 tabs — extract single restaurant (legacy behavior)
        const restaurantName = await page.evaluate(() => {
          const header = document.querySelector('.mb-1.text-3xl.font-bold');
          return header?.textContent?.trim() || null;
        });
        log?.info(`  ${dayInfo.day}: single restaurant=${restaurantName || 'unknown'} (${tabCount} tabs)`);

        const menuItems = await extractMenuItems(page, restaurantName);
        for (const item of menuItems) {
          item.day = dayInfo.day;
          allItems.push(item);
        }
        log?.info(`  ${restaurantName || 'default'}: ${menuItems.length} items`);
      } else {
        log?.info(`  ${dayInfo.day}: ${tabCount} restaurant tabs found`);
        const seenForDay = new Set(); // dedup by name||price within a day

        for (let tabIdx = 0; tabIdx < tabCount; tabIdx++) {
          try {
            // Read current header before clicking
            const headerBefore = await page.evaluate(() => {
              const h = document.querySelector('.mb-1.text-3xl.font-bold');
              return h?.textContent?.trim() || '';
            });

            // Click the tab
            await page.locator(tabSelector).nth(tabIdx).click();

            // Wait for header text to change (menu re-render)
            try {
              await page.waitForFunction(
                (prev) => {
                  const h = document.querySelector('.mb-1.text-3xl.font-bold');
                  return h && h.textContent.trim() !== prev;
                },
                headerBefore,
                { timeout: 5000 }
              );
            } catch {
              // First tab or same restaurant — just wait for content to settle
              await page.waitForTimeout(1500);
            }

            // Read the restaurant name after click
            const restaurantName = await page.evaluate(() => {
              const h = document.querySelector('.mb-1.text-3xl.font-bold');
              return h?.textContent?.trim() || null;
            });

            // Extract menu items
            const menuItems = await extractMenuItems(page, restaurantName);

            // Deduplicate within this day (Favorites duplicates Entrees)
            let added = 0;
            for (const item of menuItems) {
              const key = `${item.name}||${item.price}`;
              if (!seenForDay.has(key)) {
                seenForDay.add(key);
                item.day = dayInfo.day;
                allItems.push(item);
                added++;
              }
            }

            log?.info(`  ${restaurantName || `tab-${tabIdx}`}: ${added} items (${menuItems.length - added} dupes skipped)`);
          } catch (tabErr) {
            log?.warn(`  Tab ${tabIdx} failed: ${tabErr.message}`);
          }
        }
      }

      await page.screenshot({ path: `${DEBUG_DIR}/${dayInfo.day.toLowerCase()}.png` });
    }

    log?.info(`Scraped ${allItems.length} total menu items across ${weekdayDates.length} days`);
    return { weekOf, items: allItems };

  } catch (err) {
    try {
      writeFileSync(`${DEBUG_DIR}/error.txt`, `${err.message}\n${err.stack}`);
    } catch { /* ignore */ }
    throw err;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    _running = false;
  }
}
