/**
 * LunchDrop order placement via Playwright
 *
 * Places real orders on LunchDrop using browser automation.
 * Uses shared browser lock to prevent concurrent sessions with scraper.
 *
 * LunchDrop ordering flow (discovered via explore-ordering.js):
 * - Single-click ordering: clicking a menu item card directly places the order
 * - No modal, cart, or checkout step
 * - Confirmation: green banner "Your order has been placed!" appears
 * - Menu item cards: div.my-4.shadow-sm.border-2.border-gray-200.p-4 with cursor:pointer
 * - Item name inside: div.flex.items-center.font-bold > div
 * - Restaurant tabs: .flex.flex-wrap.gap-3 > a
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { acquireBrowserLock, releaseBrowserLock } from './browser-lock.js';

const STORAGE_PATH = path.join(process.cwd(), 'data', 'lunchdrop-session.json');
const DEBUG_DIR = '/tmp/alfred-order';
const DRY_RUN = process.env.DRY_RUN === 'true';

/**
 * Place an order on LunchDrop.
 *
 * @param {Object} opts
 * @param {string} opts.itemName - Menu item to order
 * @param {string} opts.restaurant - Restaurant name
 * @param {string} opts.date - Date string YYYY-MM-DD
 * @param {string} [opts.comboJson] - JSON string of combo items
 * @param {Function} [log] - Logger with .info/.warn/.error methods
 * @returns {{ success: boolean, orderId?: string, error?: string, errorCode?: string, screenshot?: string }}
 */
export async function placeOrder({ itemName, restaurant, date, comboJson }, log) {
  const startTime = Date.now();

  // Acquire browser lock — wait up to 90s
  const acquired = await acquireBrowserLock(90_000);
  if (!acquired) {
    return { success: false, error: 'Browser busy (lock timeout)', errorCode: 'browser_busy' };
  }

  let browser;
  let stepScreenshot;

  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const url = process.env.LUNCHDROP_URL || 'https://raleigh.lunchdrop.com';
    const email = process.env.LUNCHDROP_EMAIL;
    const password = process.env.LUNCHDROP_PASSWORD;

    if (!email || !password) {
      return { success: false, error: 'LUNCHDROP_EMAIL/PASSWORD not set', errorCode: 'unknown' };
    }

    // Load saved session state if available
    let storageState = undefined;
    if (existsSync(STORAGE_PATH)) {
      try {
        const raw = readFileSync(STORAGE_PATH, 'utf-8');
        storageState = JSON.parse(raw);
        log?.info('Loaded saved session state');
      } catch {
        log?.warn('Corrupt session file, starting fresh');
        storageState = undefined;
      }
    }

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const contextOpts = { viewport: { width: 1280, height: 900 } };
    if (storageState) contextOpts.storageState = storageState;
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    async function screenshot(name) {
      const p = `${DEBUG_DIR}/${name}.png`;
      try {
        await page.screenshot({ path: p, fullPage: true });
        stepScreenshot = p;
      } catch { /* best effort */ }
      return p;
    }

    // ── Navigate to app — check if session is still valid ─────────────────
    log?.info('Navigating to LunchDrop...');
    await page.goto(`${url}/app`, { waitUntil: 'networkidle', timeout: 30_000 });
    await screenshot('01-initial');

    // If redirected to signin, re-authenticate (two-step: email then password)
    if (page.url().includes('/signin') || page.url().includes('/login')) {
      log?.info('Session expired, re-authenticating...');
      await page.fill('input[name="email"]', email);
      await page.click('input[type="submit"]');
      await page.waitForLoadState('networkidle', { timeout: 15_000 });

      const pwInput = await page.$('input[type="password"]');
      if (pwInput) {
        await pwInput.fill(password);
        await page.click('input[type="submit"]');
        await page.waitForLoadState('networkidle', { timeout: 15_000 });
        await page.waitForTimeout(2000);
      }

      if (!page.url().includes('/app')) {
        await screenshot('login-failed');
        return { success: false, error: 'Login failed', errorCode: 'session_expired', screenshot: stepScreenshot };
      }

      // Save new session state
      const state = await context.storageState();
      writeFileSync(STORAGE_PATH, JSON.stringify(state));
      log?.info('Saved new session state');
    }

    // ── Check if already ordered for this date ────────────────────────────
    // Navigate to the target day and check for existing order
    log?.info(`Navigating to ${date}...`);
    await page.goto(`${url}/app/${date}`, { waitUntil: 'networkidle', timeout: 15_000 });
    await page.waitForTimeout(1500);
    await screenshot('02-day-page');

    // Check for existing order on this day (idempotency check per H5)
    const existingOrder = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/order placed at (.+?) estimated/i);
      return match ? match[1].trim() : null;
    });

    if (existingOrder) {
      log?.info(`Already ordered at "${existingOrder}" for this day`);
      // Save session state
      const state = await context.storageState();
      writeFileSync(STORAGE_PATH, JSON.stringify(state));
      return {
        success: true,
        orderId: 'already_ordered',
        error: `Already ordered at ${existingOrder}`,
        screenshot: stepScreenshot,
      };
    }

    // ── Select restaurant tab ─────────────────────────────────────────────
    if (restaurant) {
      log?.info(`Looking for restaurant: ${restaurant}`);
      const tabSelector = '.flex.flex-wrap.gap-3 > a';
      const tabCount = await page.locator(tabSelector).count();

      if (tabCount > 1) {
        // Read current header before clicking
        const headerBefore = await page.evaluate(() => {
          const h = document.querySelector('.mb-1.text-3xl.font-bold');
          return h?.textContent?.trim() || '';
        });

        let found = false;
        for (let i = 0; i < tabCount; i++) {
          const tab = page.locator(tabSelector).nth(i);
          const tabText = await tab.textContent();
          if (tabText && tabText.toLowerCase().includes(restaurant.toLowerCase())) {
            await tab.click();

            // Wait for restaurant header to change (same pattern as scraper.js)
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
              await page.waitForTimeout(1500);
            }

            found = true;
            log?.info(`Selected restaurant tab: ${tabText.trim()}`);
            break;
          }
        }
        if (!found) {
          log?.warn(`Restaurant tab "${restaurant}" not found among ${tabCount} tabs`);
        }
      }
      await screenshot('03-restaurant');
    }

    // ── Determine items to order ─────────────────────────────────────────
    // Combos have multiple items in combo_json; single items just use itemName
    let itemsToOrder = [];
    if (comboJson) {
      try {
        const combo = JSON.parse(comboJson);
        if (Array.isArray(combo) && combo.length > 0) {
          itemsToOrder = combo.map(c => c.name);
        }
      } catch { /* fall through to single item */ }
    }
    if (itemsToOrder.length === 0) {
      itemsToOrder = [itemName];
    }

    log?.info(`Ordering ${itemsToOrder.length} item(s): ${itemsToOrder.join(', ')}`);

    // Helper: find and click a menu item by name on the current page
    async function findAndClickItem(targetName) {
      return page.evaluate((target) => {
        const menuSection = document.querySelector('.main-preview-menu');
        if (!menuSection) return { found: false, clicked: false };

        // Search card divs with cursor:pointer
        const cards = menuSection.querySelectorAll('div.my-4, div[class*="shadow"]');
        for (const card of cards) {
          const style = getComputedStyle(card);
          if (style.cursor !== 'pointer') continue;

          const nameEl = card.querySelector('.flex.items-center.font-bold div, .font-bold');
          if (!nameEl) continue;

          if (nameEl.textContent.trim().toLowerCase() === target.toLowerCase()) {
            card.click();
            return { found: true, clicked: true, text: nameEl.textContent.trim() };
          }
        }

        // Fallback: broader text search
        const allClickables = menuSection.querySelectorAll(
          'div[style*="cursor: pointer"], div.cursor-pointer, div[class*="hover"]'
        );
        for (const el of allClickables) {
          const text = (el.textContent || '').split('$')[0].trim();
          if (text.toLowerCase() === target.toLowerCase()) {
            el.click();
            return { found: true, clicked: true, text, fallback: true };
          }
        }

        return { found: false, clicked: false };
      }, targetName);
    }

    if (DRY_RUN) {
      // In dry-run mode, just verify items exist without clicking
      for (const name of itemsToOrder) {
        const check = await page.evaluate((target) => {
          const menuSection = document.querySelector('.main-preview-menu');
          if (!menuSection) return false;
          const cards = menuSection.querySelectorAll('div.my-4, div[class*="shadow"]');
          for (const card of cards) {
            const nameEl = card.querySelector('.flex.items-center.font-bold div, .font-bold');
            if (nameEl && nameEl.textContent.trim().toLowerCase() === target.toLowerCase()) return true;
          }
          return false;
        }, name);
        log?.info(`DRY_RUN: Item "${name}" ${check ? 'found' : 'NOT FOUND'}`);
      }
      await screenshot('04-dry-run');
      return { success: true, orderId: 'DRY_RUN', screenshot: stepScreenshot };
    }

    // ── Click each item to place the order ────────────────────────────────
    // LunchDrop single-click ordering: each click adds an item to the order
    const clickedItems = [];
    const failedItems = [];

    for (let i = 0; i < itemsToOrder.length; i++) {
      const name = itemsToOrder[i];
      log?.info(`Clicking item ${i + 1}/${itemsToOrder.length}: ${name}`);

      const result = await findAndClickItem(name);
      if (result.clicked) {
        clickedItems.push(name);
        log?.info(`  Clicked: ${result.text}${result.fallback ? ' (fallback)' : ''}`);
        await page.waitForTimeout(2000);
        await screenshot(`04-after-click-${i + 1}`);
      } else {
        failedItems.push(name);
        log?.warn(`  Item "${name}" not found on page`);
      }
    }

    if (clickedItems.length === 0) {
      await screenshot('item-not-found');
      return {
        success: false,
        error: `No items found on page: ${failedItems.join(', ')}`,
        errorCode: 'item_not_found',
        screenshot: stepScreenshot,
      };
    }

    // Wait for final page state to settle
    await page.waitForTimeout(2000);
    await screenshot('05-final-state');

    // ── Check for order confirmation ──────────────────────────────────────
    // LunchDrop shows: "Your order has been placed!" green banner
    // Also: "Order placed at {restaurant} estimated for {time}"
    const bodyText = await page.evaluate(() => document.body.innerText);
    const isConfirmed = bodyText.toLowerCase().includes('order has been placed') ||
                        bodyText.toLowerCase().includes('order placed at');

    if (isConfirmed) {
      const msg = failedItems.length > 0
        ? `Order placed (${clickedItems.length}/${itemsToOrder.length} items)`
        : 'Order confirmed!';
      log?.info(msg);

      // Save session state after successful order
      const state = await context.storageState();
      writeFileSync(STORAGE_PATH, JSON.stringify(state));

      return {
        success: true,
        orderId: 'confirmed',
        screenshot: stepScreenshot,
        error: failedItems.length > 0 ? `Missing items: ${failedItems.join(', ')}` : undefined,
      };
    }

    // Check if item was sold out or unavailable
    if (bodyText.toLowerCase().includes('sold out') || bodyText.toLowerCase().includes('unavailable')) {
      return { success: false, error: 'Item is sold out', errorCode: 'item_sold_out', screenshot: stepScreenshot };
    }

    // Check if ordering deadline has passed
    if (bodyText.toLowerCase().includes('order by') && bodyText.toLowerCase().includes('closed')) {
      return { success: false, error: 'Ordering window has closed', errorCode: 'checkout_failed', screenshot: stepScreenshot };
    }

    // Unknown state — no confirmation detected
    await screenshot('06-unknown-state');
    return {
      success: false,
      error: 'Clicked item but no order confirmation detected',
      errorCode: 'checkout_failed',
      screenshot: stepScreenshot,
    };

  } catch (err) {
    const duration = Date.now() - startTime;
    log?.error(`Order failed after ${duration}ms: ${err.message}`);
    return {
      success: false,
      error: err.message,
      errorCode: err.message.includes('timeout') ? 'timeout' : 'unknown',
      screenshot: stepScreenshot,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    releaseBrowserLock();
  }
}

/**
 * Delete the stored session file (e.g., on session_expired retry).
 */
export function clearSession() {
  if (existsSync(STORAGE_PATH)) {
    try {
      unlinkSync(STORAGE_PATH);
    } catch { /* ignore */ }
  }
}
