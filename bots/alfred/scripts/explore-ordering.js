/**
 * LunchDrop ordering flow exploration script
 *
 * Extends the explore pattern to discover the ordering UI:
 * - Click a menu item and capture what appears (modal, cart, drawer)
 * - Find Add/Order/Checkout buttons and screenshot each state
 * - Intercept ALL network requests (not just api/graphql)
 * - Do NOT click final submit — stop before committing
 *
 * Run on acemagic: ssh acemagic 'cd /opt/botforge && node bots/alfred/scripts/explore-ordering.js'
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const DEBUG_DIR = '/tmp/alfred-explore/ordering';
const URL = process.env.LUNCHDROP_URL || 'https://raleigh.lunchdrop.com';
const EMAIL = process.env.LUNCHDROP_EMAIL;
const PASSWORD = process.env.LUNCHDROP_PASSWORD;

async function exploreOrdering() {
  if (!EMAIL || !PASSWORD) {
    console.error('Set LUNCHDROP_EMAIL and LUNCHDROP_PASSWORD');
    process.exit(1);
  }

  mkdirSync(DEBUG_DIR, { recursive: true });
  console.log(`Exploring ordering flow at ${URL}`);
  console.log(`Output: ${DEBUG_DIR}/\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  // Intercept ALL network requests (broader than explore-lunchdrop.js)
  const allRequests = [];
  page.on('request', (req) => {
    allRequests.push({
      method: req.method(),
      url: req.url(),
      postData: req.postData()?.slice(0, 2000) || null,
      resourceType: req.resourceType(),
    });
  });

  const allResponses = [];
  page.on('response', async (res) => {
    const url = res.url();
    const contentType = res.headers()['content-type'] || '';
    if (contentType.includes('json') || url.includes('api') || url.includes('order') || url.includes('cart')) {
      try {
        const body = await res.json();
        allResponses.push({ url, status: res.status(), body: JSON.stringify(body).slice(0, 5000) });
      } catch {
        allResponses.push({ url, status: res.status(), body: `(${contentType})` });
      }
    }
  });

  let stepNum = 0;
  function step(name) {
    stepNum++;
    const prefix = String(stepNum).padStart(2, '0');
    console.log(`\n${prefix}. ${name}`);
    return prefix;
  }

  try {
    // ── Login ──────────────────────────────────────────────────────────────
    let s = step('Logging in...');
    await page.goto(`${URL}/signin`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.fill('input[name="email"]', EMAIL);
    await page.click('input[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      await pwInput.fill(PASSWORD);
      await page.click('input[type="submit"]');
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      await page.waitForTimeout(2000);
    }

    if (!page.url().includes('/app')) {
      await page.screenshot({ path: `${DEBUG_DIR}/${s}-login-failed.png` });
      throw new Error(`Login failed — at ${page.url()}`);
    }
    await page.screenshot({ path: `${DEBUG_DIR}/${s}-logged-in.png` });
    console.log(`   Logged in at ${page.url()}`);

    // ── Find day links ─────────────────────────────────────────────────────
    s = step('Finding day links...');
    const dayLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/app/2"]'));
      return links.map(a => ({
        href: a.href,
        text: a.textContent.trim(),
        date: a.href.match(/\/app\/([\d-]+)/)?.[1],
      })).filter(l => l.date);
    });
    writeFileSync(`${DEBUG_DIR}/${s}-day-links.json`, JSON.stringify(dayLinks, null, 2));
    console.log(`   Found ${dayLinks.length} day links`);

    // Pick a future weekday (prefer tomorrow or first available)
    const today = new Date().toISOString().slice(0, 10);
    const futureDays = dayLinks.filter(d => d.date > today);
    const targetDay = futureDays[0] || dayLinks[0];
    if (!targetDay) throw new Error('No day links found');
    console.log(`   Target day: ${targetDay.date} (${targetDay.text})`);

    // ── Navigate to target day ─────────────────────────────────────────────
    s = step(`Navigating to ${targetDay.date}...`);
    await page.goto(`${URL}/app/${targetDay.date}`, { waitUntil: 'networkidle', timeout: 15_000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${DEBUG_DIR}/${s}-day-page.png`, fullPage: true });

    // ── Find restaurant tabs ───────────────────────────────────────────────
    s = step('Finding restaurant tabs...');
    const tabSelector = '.flex.flex-wrap.gap-3 > a';
    const tabCount = await page.locator(tabSelector).count();
    console.log(`   ${tabCount} restaurant tabs`);

    // Get restaurant name from header
    const restaurantName = await page.evaluate(() => {
      const h = document.querySelector('.mb-1.text-3xl.font-bold');
      return h?.textContent?.trim() || 'unknown';
    });
    console.log(`   Current restaurant: ${restaurantName}`);

    // ── Find menu items and look for cheapest ──────────────────────────────
    s = step('Finding clickable menu items...');

    // Explore the menu item structure
    const menuStructure = await page.evaluate(() => {
      const menuSection = document.querySelector('.main-preview-menu') || document.body;
      const allElements = menuSection.querySelectorAll('*');
      const clickables = [];

      for (const el of allElements) {
        const text = el.textContent?.trim();
        const tag = el.tagName.toLowerCase();
        // Look for elements that might be clickable menu items
        if ((tag === 'div' || tag === 'a' || tag === 'button' || tag === 'li') &&
            text && text.length > 3 && text.length < 200) {
          const hasPrice = /\$\d/.test(text);
          const style = getComputedStyle(el);
          const isClickable = style.cursor === 'pointer' || el.onclick || tag === 'a' || tag === 'button';
          if (hasPrice || isClickable) {
            clickables.push({
              tag,
              class: el.className?.toString().slice(0, 200),
              text: text.slice(0, 200),
              hasPrice,
              cursor: style.cursor,
              role: el.getAttribute('role'),
              href: el.getAttribute('href'),
              childCount: el.children.length,
              rect: el.getBoundingClientRect(),
            });
          }
        }
      }
      return clickables.slice(0, 50);
    });
    writeFileSync(`${DEBUG_DIR}/${s}-clickable-items.json`, JSON.stringify(menuStructure, null, 2));
    console.log(`   Found ${menuStructure.length} potentially clickable elements`);

    // ── Click a menu item ──────────────────────────────────────────────────
    s = step('Clicking a menu item...');

    // Find items with prices and try to click one
    const itemsWithPrices = menuStructure.filter(i => i.hasPrice && i.cursor === 'pointer');
    console.log(`   ${itemsWithPrices.length} items with prices and pointer cursor`);

    if (itemsWithPrices.length > 0) {
      // Pick a cheap item (sort by text to find low-price items)
      const target = itemsWithPrices[0];
      console.log(`   Clicking: "${target.text.slice(0, 80)}"`);

      // Click element at coordinates
      await page.mouse.click(
        target.rect.x + target.rect.width / 2,
        target.rect.y + target.rect.height / 2
      );
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${DEBUG_DIR}/${s}-after-item-click.png`, fullPage: true });

      // ── Explore what appeared ────────────────────────────────────────────
      const afterClickState = await page.evaluate(() => {
        // Look for modals, drawers, overlays
        const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="Overlay"], [class*="drawer"], [class*="Drawer"], [class*="popup"], [class*="Popup"]');
        const modalInfo = Array.from(modals).map(m => ({
          tag: m.tagName.toLowerCase(),
          class: m.className?.toString().slice(0, 200),
          text: m.innerText?.slice(0, 1000),
          visible: m.offsetHeight > 0,
          rect: m.getBoundingClientRect(),
        }));

        // Look for cart-related elements
        const cartElements = document.querySelectorAll('[class*="cart"], [class*="Cart"], [class*="basket"], [class*="Basket"], [class*="checkout"], [class*="Checkout"]');
        const cartInfo = Array.from(cartElements).map(c => ({
          tag: c.tagName.toLowerCase(),
          class: c.className?.toString().slice(0, 200),
          text: c.innerText?.slice(0, 500),
          visible: c.offsetHeight > 0,
        }));

        // Look for "Add", "Order", "Checkout", "Add to" buttons
        const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
        const orderButtons = Array.from(buttons).filter(b => {
          const text = b.textContent?.toLowerCase() || '';
          return text.includes('add') || text.includes('order') || text.includes('checkout') ||
                 text.includes('confirm') || text.includes('submit') || text.includes('place') ||
                 text.includes('buy') || text.includes('cart');
        }).map(b => ({
          tag: b.tagName.toLowerCase(),
          class: b.className?.toString().slice(0, 200),
          text: b.textContent?.trim().slice(0, 100),
          type: b.type,
          disabled: b.disabled,
          visible: b.offsetHeight > 0,
          rect: b.getBoundingClientRect(),
        }));

        // Check for quantity selectors
        const quantityEls = document.querySelectorAll('[class*="quantity"], [class*="Quantity"], [class*="qty"], input[type="number"]');
        const quantityInfo = Array.from(quantityEls).map(q => ({
          tag: q.tagName.toLowerCase(),
          class: q.className?.toString().slice(0, 200),
          text: q.innerText?.slice(0, 100),
          value: q.value,
        }));

        return { modals: modalInfo, cart: cartInfo, orderButtons, quantity: quantityInfo };
      });
      writeFileSync(`${DEBUG_DIR}/${s}-after-click-state.json`, JSON.stringify(afterClickState, null, 2));
      console.log(`   Modals: ${afterClickState.modals.length}`);
      console.log(`   Cart elements: ${afterClickState.cart.length}`);
      console.log(`   Order buttons: ${afterClickState.orderButtons.length}`);
      console.log(`   Quantity selectors: ${afterClickState.quantity.length}`);

      // ── If we found an "Add to Order" type button, screenshot it ─────────
      if (afterClickState.orderButtons.length > 0) {
        const sBtn = step('Found order-related buttons');
        for (const btn of afterClickState.orderButtons) {
          console.log(`   Button: "${btn.text}" (${btn.class?.slice(0, 60)})`);
        }

        // Click the first "Add" type button to see what happens next
        const addBtn = afterClickState.orderButtons.find(b =>
          b.text?.toLowerCase().includes('add') && !b.disabled && b.visible
        );
        if (addBtn) {
          console.log(`   Clicking add button: "${addBtn.text}"`);
          await page.mouse.click(
            addBtn.rect.x + addBtn.rect.width / 2,
            addBtn.rect.y + addBtn.rect.height / 2
          );
          await page.waitForTimeout(2000);
          await page.screenshot({ path: `${DEBUG_DIR}/${sBtn}-after-add-click.png`, fullPage: true });

          // Check what happened after add
          const afterAddState = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
            const relevantBtns = buttons.filter(b => {
              const text = b.textContent?.toLowerCase() || '';
              return text.includes('checkout') || text.includes('order') || text.includes('place') ||
                     text.includes('confirm') || text.includes('submit') || text.includes('cart') ||
                     text.includes('view');
            }).map(b => ({
              tag: b.tagName.toLowerCase(),
              class: b.className?.toString().slice(0, 200),
              text: b.textContent?.trim().slice(0, 100),
              disabled: b.disabled,
              visible: b.offsetHeight > 0,
              rect: b.getBoundingClientRect(),
            }));

            // Look for cart badge/count
            const badges = document.querySelectorAll('[class*="badge"], [class*="Badge"], [class*="count"], [class*="Count"]');
            const badgeInfo = Array.from(badges).filter(b => /\d/.test(b.textContent)).map(b => ({
              class: b.className?.toString().slice(0, 100),
              text: b.textContent?.trim(),
            }));

            // Full page text to understand state
            const bodyPreview = document.body.innerText.slice(0, 3000);

            return { buttons: relevantBtns, badges: badgeInfo, bodyPreview };
          });
          writeFileSync(`${DEBUG_DIR}/${sBtn}-after-add-state.json`, JSON.stringify(afterAddState, null, 2));
          console.log(`   Checkout/order buttons after add: ${afterAddState.buttons.length}`);
          console.log(`   Badges: ${afterAddState.badges.length}`);

          // Look for checkout/place order button but DO NOT CLICK IT
          const checkoutBtn = afterAddState.buttons.find(b =>
            (b.text?.toLowerCase().includes('checkout') || b.text?.toLowerCase().includes('place order')) &&
            !b.disabled && b.visible
          );
          if (checkoutBtn) {
            const sCheckout = step('Found checkout button (NOT clicking)');
            console.log(`   CHECKOUT BUTTON: "${checkoutBtn.text}" at (${checkoutBtn.rect.x}, ${checkoutBtn.rect.y})`);
            console.log(`   Class: ${checkoutBtn.class}`);
            await page.screenshot({ path: `${DEBUG_DIR}/${sCheckout}-checkout-button.png`, fullPage: true });
          }
        }
      }
    } else {
      console.log('   No clickable price items found. Trying alternative selectors...');

      // Try clicking any element inside .main-preview-menu that looks like a menu item
      const altItems = await page.evaluate(() => {
        const menu = document.querySelector('.main-preview-menu');
        if (!menu) return [];
        const divs = menu.querySelectorAll('div');
        return Array.from(divs).filter(d => {
          const text = d.textContent?.trim();
          return text && /\$\d/.test(text) && text.length < 200 && d.children.length < 10;
        }).map(d => ({
          class: d.className?.toString().slice(0, 200),
          text: d.textContent?.trim().slice(0, 200),
          rect: d.getBoundingClientRect(),
        })).slice(0, 10);
      });
      writeFileSync(`${DEBUG_DIR}/${s}-alt-items.json`, JSON.stringify(altItems, null, 2));
      console.log(`   Alternative items: ${altItems.length}`);

      if (altItems.length > 0) {
        const target = altItems[0];
        console.log(`   Clicking alt item: "${target.text.slice(0, 80)}"`);
        await page.mouse.click(target.rect.x + target.rect.width / 2, target.rect.y + target.rect.height / 2);
        await page.waitForTimeout(2000);
        await page.screenshot({ path: `${DEBUG_DIR}/${s}-after-alt-click.png`, fullPage: true });
      }
    }

    // ── Check "My Orders" page if it exists ────────────────────────────────
    s = step('Looking for My Orders / order history...');
    const orderLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.filter(a => {
        const text = (a.textContent + ' ' + a.href).toLowerCase();
        return text.includes('order') || text.includes('cart') || text.includes('history');
      }).map(a => ({
        text: a.textContent?.trim().slice(0, 100),
        href: a.href,
      }));
    });
    writeFileSync(`${DEBUG_DIR}/${s}-order-links.json`, JSON.stringify(orderLinks, null, 2));
    console.log(`   Order-related links: ${orderLinks.length}`);
    for (const link of orderLinks) {
      console.log(`   ${link.text} → ${link.href}`);
    }

    // ── Save all captured requests ─────────────────────────────────────────
    s = step('Saving captured network traffic...');
    writeFileSync(`${DEBUG_DIR}/${s}-all-requests.json`, JSON.stringify(allRequests, null, 2));
    writeFileSync(`${DEBUG_DIR}/${s}-all-responses.json`, JSON.stringify(allResponses, null, 2));
    console.log(`   Requests: ${allRequests.length}`);
    console.log(`   JSON responses: ${allResponses.length}`);

    console.log(`\nExploration complete! Output: ${DEBUG_DIR}/`);

  } catch (err) {
    console.error(`\nError: ${err.message}`);
    await page.screenshot({ path: `${DEBUG_DIR}/error.png` }).catch(() => {});
    writeFileSync(`${DEBUG_DIR}/error.txt`, `${err.message}\n${err.stack}`);
  } finally {
    await browser.close();
  }
}

exploreOrdering().catch(console.error);
