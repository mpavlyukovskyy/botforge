/**
 * LunchDrop menu scraper using Playwright
 *
 * Site structure (raleigh.lunchdrop.com):
 * - Two-step login: /signin -> email -> password
 * - App at /app with day tabs: /app/YYYY-MM-DD
 * - Each day has restaurant tabs (green buttons with restaurant logos)
 * - Menu is client-rendered SPA -- must use innerText parsing
 * - Menu sections: Favorites, Entrees, Sides, Desserts
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import type { MenuItem } from './db.js';

const DEBUG_DIR = '/tmp/alfred-debug';
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

let _running = false;

interface DayInfo {
  date: string;
  day: string;
  href: string;
}

interface ScrapeResult {
  weekOf: string;
  items: MenuItem[];
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Scrape the LunchDrop weekly menu.
 */
export async function scrapeMenu(log?: Logger): Promise<ScrapeResult | null> {
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

    // Step 1: Two-step login
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

    // Verify login succeeded
    if (!page.url().includes('/app')) {
      await page.screenshot({ path: `${DEBUG_DIR}/login-failed.png` });
      throw new Error(`Login failed -- landed at ${page.url()}`);
    }
    log?.info('Login successful');

    // Step 2: Determine week dates
    const dayLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/app/2"]'));
      return links.map(a => ({
        href: (a as HTMLAnchorElement).href,
        text: a.textContent?.trim() || '',
        date: (a as HTMLAnchorElement).href.match(/\/app\/([\d-]+)/)?.[1] || '',
      })).filter(l => l.date);
    });

    const weekdayDates: DayInfo[] = [];
    const seen = new Set<string>();
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
    weekdayDates.splice(5);

    if (weekdayDates.length === 0) {
      throw new Error('No weekday dates found in day tabs');
    }

    const weekOf = weekdayDates.find(d => d.day === 'Monday')?.date || weekdayDates[0].date;
    log?.info(`Scraping week of ${weekOf}: ${weekdayDates.map(d => d.day).join(', ')}`);

    // Step 3: Scrape each day
    const allItems: MenuItem[] = [];

    for (const dayInfo of weekdayDates) {
      log?.info(`Scraping ${dayInfo.day} (${dayInfo.date})...`);
      await page.goto(`${url}/app/${dayInfo.date}`, { waitUntil: 'networkidle', timeout: 15_000 });
      await page.waitForTimeout(1500);

      const tabSelector = '.flex.flex-wrap.gap-3 > a';
      const tabCount = await page.locator(tabSelector).count();

      if (tabCount <= 1) {
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
        const seenForDay = new Set<string>();

        for (let tabIdx = 0; tabIdx < tabCount; tabIdx++) {
          try {
            const headerBefore = await page.evaluate(() => {
              const h = document.querySelector('.mb-1.text-3xl.font-bold');
              return h?.textContent?.trim() || '';
            });

            await page.locator(tabSelector).nth(tabIdx).click();

            try {
              await page.waitForFunction(
                (prev: string) => {
                  const h = document.querySelector('.mb-1.text-3xl.font-bold');
                  return h && h.textContent?.trim() !== prev;
                },
                headerBefore,
                { timeout: 5000 }
              );
            } catch {
              await page.waitForTimeout(1500);
            }

            const restaurantName = await page.evaluate(() => {
              const h = document.querySelector('.mb-1.text-3xl.font-bold');
              return h?.textContent?.trim() || null;
            });

            const menuItems = await extractMenuItems(page, restaurantName);

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
            log?.warn(`  Tab ${tabIdx} failed: ${(tabErr as Error).message}`);
          }
        }
      }

      await page.screenshot({ path: `${DEBUG_DIR}/${dayInfo.day.toLowerCase()}.png` });
    }

    log?.info(`Scraped ${allItems.length} total menu items across ${weekdayDates.length} days`);
    return { weekOf, items: allItems };

  } catch (err) {
    try {
      writeFileSync(`${DEBUG_DIR}/error.txt`, `${(err as Error).message}\n${(err as Error).stack}`);
    } catch { /* ignore */ }
    throw err;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    _running = false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractMenuItems(page: any, restaurantName: string | null): Promise<MenuItem[]> {
  return page.evaluate((rName: string | null) => {
    const items: Array<{
      day: string;
      name: string;
      price: number | null;
      description: string | null;
      restaurant: string | null;
      tags: string[];
    }> = [];
    const menuSection = document.querySelector('.main-preview-menu') || document.body;
    const bodyText = (menuSection as HTMLElement).innerText;

    const lines = bodyText.split('\n').map((l: string) => l.trim()).filter(Boolean);

    const sectionHeaders = ['Favorites', 'Entrees', 'Sides', 'Desserts', 'Drinks', 'Beverages', 'Appetizers', 'Soups', 'Salads', 'Sandwiches', 'Bowls', 'Wraps', 'Platters', 'Specials', 'Kids'];
    const pricePattern = /^\$[\d.]+(?: - \$[\d.]+)?$/;
    const skipPatterns = [
      /^Gift Cards$/i, /^Help/i, /^Contact/i, /^Ordering for/i,
      /^Terms of/i, /^Privacy/i, /^Do Not Sell/i, /^Offer your/i,
    ];

    let currentSection: string | null = null;
    let pendingName: string | null = null;
    let pendingDesc: string | null = null;
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
            day: '',
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
