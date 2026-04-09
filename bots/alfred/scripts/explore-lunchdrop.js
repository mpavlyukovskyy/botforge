/**
 * LunchDrop DOM exploration script
 *
 * Runs headed Playwright, screenshots each stage, dumps DOM structure.
 * Run: node bots/alfred/scripts/explore-lunchdrop.js
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const DEBUG_DIR = '/tmp/alfred-explore';
const URL = process.env.LUNCHDROP_URL || 'https://raleigh.lunchdrop.com';
const EMAIL = process.env.LUNCHDROP_EMAIL || 'MarkP@Science.xyz';
const PASSWORD = process.env.LUNCHDROP_PASSWORD || 'ScienceLunch';

async function explore() {
  mkdirSync(DEBUG_DIR, { recursive: true });
  console.log(`Exploring ${URL}`);
  console.log(`Screenshots will be saved to ${DEBUG_DIR}/`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Capture all network requests to find API calls
  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('api') || url.includes('graphql') || url.includes('menu') || url.includes('order')) {
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('json')) {
        try {
          const body = await response.json();
          apiCalls.push({ url, status: response.status(), body: JSON.stringify(body).slice(0, 5000) });
        } catch {
          apiCalls.push({ url, status: response.status(), body: '(failed to parse)' });
        }
      } else {
        apiCalls.push({ url, status: response.status(), body: `(${contentType})` });
      }
    }
  });

  try {
    // Step 1: Landing page
    console.log('\n1. Loading landing page...');
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: `${DEBUG_DIR}/01-landing.png`, fullPage: true });

    // Dump all links and buttons
    const landingInfo = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim().slice(0, 100),
        href: a.href,
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent.trim().slice(0, 100),
        type: b.type,
        class: b.className.slice(0, 100),
      }));
      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type,
        name: i.name,
        placeholder: i.placeholder,
        id: i.id,
      }));
      const title = document.title;
      const url = window.location.href;
      return { title, url, links, buttons, inputs };
    });
    writeFileSync(`${DEBUG_DIR}/01-landing-info.json`, JSON.stringify(landingInfo, null, 2));
    console.log(`   Title: ${landingInfo.title}`);
    console.log(`   URL: ${landingInfo.url}`);
    console.log(`   Links: ${landingInfo.links.length}, Buttons: ${landingInfo.buttons.length}, Inputs: ${landingInfo.inputs.length}`);

    // Step 2: Try to find login
    console.log('\n2. Looking for login...');
    const loginSelectors = [
      'a[href*="login"]', 'a[href*="sign-in"]', 'a[href*="signin"]',
      'button:has-text("Sign In")', 'button:has-text("Log In")', 'button:has-text("Login")',
      'a:has-text("Sign In")', 'a:has-text("Log In")', 'a:has-text("Login")',
    ];

    let foundLogin = false;
    for (const sel of loginSelectors) {
      const el = await page.$(sel);
      if (el) {
        console.log(`   Found login element: ${sel}`);
        await el.click();
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.screenshot({ path: `${DEBUG_DIR}/02-after-login-click.png`, fullPage: true });
        foundLogin = true;
        break;
      }
    }
    if (!foundLogin) {
      console.log('   No login link found — might be on login page already or different flow');
    }

    // Dump page state after login click
    const postClickInfo = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, placeholder: i.placeholder, id: i.id,
        class: i.className.slice(0, 100),
      }));
      const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        action: f.action, method: f.method, id: f.id, class: f.className.slice(0, 100),
      }));
      return { url: window.location.href, inputs, forms };
    });
    writeFileSync(`${DEBUG_DIR}/02-login-page-info.json`, JSON.stringify(postClickInfo, null, 2));
    console.log(`   URL: ${postClickInfo.url}`);
    console.log(`   Inputs: ${postClickInfo.inputs.length}, Forms: ${postClickInfo.forms.length}`);

    // Step 3: Fill and submit login
    console.log('\n3. Attempting login...');
    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i], input[name="username"]');
    const passwordInput = await page.$('input[type="password"], input[name="password"]');

    if (emailInput && passwordInput) {
      await emailInput.fill(EMAIL);
      await passwordInput.fill(PASSWORD);
      await page.screenshot({ path: `${DEBUG_DIR}/03-login-filled.png`, fullPage: true });

      const submitBtn = await page.$('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Submit"), input[type="submit"]');
      if (submitBtn) {
        console.log('   Clicking submit...');
        await submitBtn.click();
      } else {
        console.log('   No submit button found, pressing Enter...');
        await passwordInput.press('Enter');
      }

      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000); // Extra wait for SPA routing
      await page.screenshot({ path: `${DEBUG_DIR}/04-post-login.png`, fullPage: true });

      const postLoginInfo = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        bodyTextPreview: document.body.innerText.slice(0, 2000),
      }));
      writeFileSync(`${DEBUG_DIR}/04-post-login-info.json`, JSON.stringify(postLoginInfo, null, 2));
      console.log(`   URL: ${postLoginInfo.url}`);
      console.log(`   Title: ${postLoginInfo.title}`);
    } else {
      console.log('   No email/password inputs found');
      // Maybe it uses SSO or a different flow
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      writeFileSync(`${DEBUG_DIR}/03-no-login-form.txt`, pageText);
    }

    // Step 4: Look for menu page
    console.log('\n4. Looking for menu/order page...');
    const menuSelectors = [
      'a[href*="menu"]', 'a[href*="order"]', 'a[href*="meals"]',
      'a:has-text("Menu")', 'a:has-text("Order")', 'a:has-text("This Week")',
      'a:has-text("Browse")', 'a:has-text("Upcoming")',
      '[class*="menu"]', '[class*="order"]',
    ];

    let foundMenu = false;
    for (const sel of menuSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        console.log(`   Found menu element: ${sel} -> "${text.trim().slice(0, 50)}"`);
        try {
          await el.click();
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(2000);
          foundMenu = true;
        } catch (e) {
          console.log(`   Click failed: ${e.message}`);
        }
        break;
      }
    }

    await page.screenshot({ path: `${DEBUG_DIR}/05-menu-page.png`, fullPage: true });

    // Step 5: Deep DOM exploration of current page (menu or wherever we are)
    console.log('\n5. Deep DOM exploration...');
    const domInfo = await page.evaluate(() => {
      function getStructure(el, depth = 0, maxDepth = 4) {
        if (depth > maxDepth || !el) return [];
        const results = [];
        for (const child of el.children) {
          const info = {
            tag: child.tagName.toLowerCase(),
            id: child.id || undefined,
            class: child.className?.toString().slice(0, 150) || undefined,
            text: child.children.length === 0 ? child.textContent?.trim().slice(0, 100) : undefined,
            dataAttrs: {},
            childCount: child.children.length,
          };

          // Capture data-* attributes
          for (const attr of child.attributes) {
            if (attr.name.startsWith('data-')) {
              info.dataAttrs[attr.name] = attr.value.slice(0, 100);
            }
          }
          if (Object.keys(info.dataAttrs).length === 0) delete info.dataAttrs;

          // Only recurse into promising branches
          const classStr = (child.className?.toString() || '').toLowerCase();
          const isInteresting = classStr.includes('menu') || classStr.includes('meal') ||
            classStr.includes('food') || classStr.includes('item') || classStr.includes('card') ||
            classStr.includes('order') || classStr.includes('product') || classStr.includes('dish') ||
            classStr.includes('day') || classStr.includes('tab') || classStr.includes('list') ||
            classStr.includes('grid') || classStr.includes('container') || classStr.includes('content') ||
            classStr.includes('main') || classStr.includes('app') || classStr.includes('page') ||
            child.tagName === 'MAIN' || child.tagName === 'SECTION' || child.tagName === 'ARTICLE';

          if (isInteresting && depth < maxDepth) {
            info.children = getStructure(child, depth + 1, maxDepth);
          }
          results.push(info);
        }
        return results;
      }

      // Get main content area
      const main = document.querySelector('main, [class*="content"], [class*="app"], #root, #__next') || document.body;
      return {
        url: window.location.href,
        title: document.title,
        structure: getStructure(main, 0, 5),
        allClassNames: Array.from(new Set(
          Array.from(document.querySelectorAll('*'))
            .map(el => el.className?.toString() || '')
            .filter(c => c.length > 0)
        )).slice(0, 200),
        bodyTextFull: document.body.innerText.slice(0, 10000),
      };
    });

    writeFileSync(`${DEBUG_DIR}/05-dom-structure.json`, JSON.stringify(domInfo, null, 2));
    console.log(`   Classes found: ${domInfo.allClassNames.length}`);
    console.log(`   Body text length: ${domInfo.bodyTextFull.length}`);

    // Step 6: Look for day tabs/navigation
    console.log('\n6. Looking for day navigation...');
    const dayElements = await page.evaluate(() => {
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      const found = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const text = el.textContent?.trim();
        if (text && days.some(d => text.includes(d)) && text.length < 50) {
          found.push({
            tag: el.tagName.toLowerCase(),
            class: el.className?.toString().slice(0, 100),
            text: text.slice(0, 50),
            id: el.id,
          });
        }
      }
      return found.slice(0, 30);
    });
    writeFileSync(`${DEBUG_DIR}/06-day-elements.json`, JSON.stringify(dayElements, null, 2));
    console.log(`   Day-related elements found: ${dayElements.length}`);

    // Step 7: Look for price-containing elements
    console.log('\n7. Looking for price elements...');
    const priceElements = await page.evaluate(() => {
      const found = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const text = el.textContent?.trim();
        if (text && /\$\d+/.test(text) && text.length < 100 && el.children.length === 0) {
          found.push({
            tag: el.tagName.toLowerCase(),
            class: el.className?.toString().slice(0, 100),
            text: text.slice(0, 80),
            parentClass: el.parentElement?.className?.toString().slice(0, 100),
          });
        }
      }
      return found.slice(0, 30);
    });
    writeFileSync(`${DEBUG_DIR}/07-price-elements.json`, JSON.stringify(priceElements, null, 2));
    console.log(`   Price elements found: ${priceElements.length}`);

    // Save API calls
    writeFileSync(`${DEBUG_DIR}/08-api-calls.json`, JSON.stringify(apiCalls, null, 2));
    console.log(`\n8. API calls intercepted: ${apiCalls.length}`);

    console.log(`\n✅ Exploration complete! Screenshots and data saved to ${DEBUG_DIR}/`);

  } catch (err) {
    console.error('Exploration error:', err.message);
    await page.screenshot({ path: `${DEBUG_DIR}/error.png` }).catch(() => {});
    writeFileSync(`${DEBUG_DIR}/error.txt`, `${err.message}\n${err.stack}`);
  } finally {
    await browser.close();
  }
}

explore().catch(console.error);
