/**
 * LunchDrop exploration step 2: Complete two-step login, explore menu
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

  // Capture API calls
  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if ((url.includes('api') || url.includes('menu') || url.includes('order') || url.includes('meal') || url.includes('restaurant')) && ct.includes('json')) {
      try {
        const body = await response.json();
        apiCalls.push({ url, status: response.status(), body });
      } catch { apiCalls.push({ url, status: response.status() }); }
    }
  });

  try {
    // Step 1: Go to sign-in page
    console.log('1. Going to sign-in...');
    await page.goto(`${URL}/signin`, { waitUntil: 'networkidle', timeout: 30000 });

    // Step 2: Fill email and submit
    console.log('2. Filling email...');
    const emailInput = await page.$('input[name="email"]');
    if (!emailInput) {
      console.error('No email input found!');
      await browser.close();
      return;
    }
    await emailInput.fill(EMAIL);
    await page.screenshot({ path: `${DEBUG_DIR}/10-email-filled.png` });

    // Submit the form
    const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await emailInput.press('Enter');
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${DEBUG_DIR}/11-after-email-submit.png`, fullPage: true });

    // Dump page info
    const step2Info = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      inputs: Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, placeholder: i.placeholder, id: i.id,
        class: i.className.slice(0, 100),
      })),
      forms: Array.from(document.querySelectorAll('form')).map(f => ({
        action: f.action, method: f.method, id: f.id,
      })),
      bodyText: document.body.innerText.slice(0, 2000),
    }));
    writeFileSync(`${DEBUG_DIR}/11-step2-info.json`, JSON.stringify(step2Info, null, 2));
    console.log(`   URL: ${step2Info.url}`);
    console.log(`   Inputs: ${step2Info.inputs.map(i => `${i.type}[${i.name}]`).join(', ')}`);
    console.log(`   Body: ${step2Info.bodyText.slice(0, 200)}`);

    // Step 3: Fill password if present
    console.log('\n3. Looking for password field...');
    const passwordInput = await page.$('input[type="password"], input[name="password"]');
    if (passwordInput) {
      console.log('   Found password field, filling...');
      await passwordInput.fill(PASSWORD);
      await page.screenshot({ path: `${DEBUG_DIR}/12-password-filled.png` });

      const submitBtn2 = await page.$('input[type="submit"], button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
      if (submitBtn2) {
        await submitBtn2.click();
      } else {
        await passwordInput.press('Enter');
      }
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
    } else {
      console.log('   No password field found. Checking page content...');
    }

    await page.screenshot({ path: `${DEBUG_DIR}/13-post-login.png`, fullPage: true });

    const postLoginInfo = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 3000),
      links: Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim().slice(0, 80), href: a.href,
      })).filter(l => l.text),
    }));
    writeFileSync(`${DEBUG_DIR}/13-post-login-info.json`, JSON.stringify(postLoginInfo, null, 2));
    console.log(`\n4. Post-login state:`);
    console.log(`   URL: ${postLoginInfo.url}`);
    console.log(`   Body preview: ${postLoginInfo.bodyText.slice(0, 300)}`);

    // Step 4: Navigate around to find menu
    console.log('\n5. Looking for menu content...');
    const navLinks = postLoginInfo.links.filter(l =>
      /menu|order|meal|week|today|upcoming|browse/i.test(l.text + l.href)
    );
    console.log(`   Menu-related links: ${navLinks.length}`);
    for (const l of navLinks.slice(0, 5)) {
      console.log(`     ${l.text} -> ${l.href}`);
    }

    // Try common menu URLs
    const menuUrls = ['/menu', '/order', '/meals', '/today', '/this-week', '/upcoming', '/dashboard', '/home'];
    for (const path of menuUrls) {
      const resp = await page.goto(`${URL}${path}`, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => null);
      if (resp && resp.status() === 200) {
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
        if (bodyText.length > 50 && !bodyText.includes('404') && !bodyText.includes('not found')) {
          console.log(`   ${path} -> OK (${bodyText.length} chars)`);
          await page.screenshot({ path: `${DEBUG_DIR}/14-${path.replace('/', '')}.png`, fullPage: true });

          // Deep dive into this page
          const pageInfo = await page.evaluate(() => {
            const priceEls = Array.from(document.querySelectorAll('*')).filter(el =>
              el.children.length === 0 && /\$\d+/.test(el.textContent) && el.textContent.length < 50
            ).map(el => ({
              tag: el.tagName, class: el.className?.toString().slice(0, 100),
              text: el.textContent.trim(), parentClass: el.parentElement?.className?.toString().slice(0, 100),
              grandparentClass: el.parentElement?.parentElement?.className?.toString().slice(0, 100),
            }));

            const allClasses = Array.from(new Set(
              Array.from(document.querySelectorAll('[class]')).map(el => el.className.toString())
            )).filter(c => c.length > 0);

            return {
              url: window.location.href,
              bodyText: document.body.innerText.slice(0, 5000),
              priceElements: priceEls.slice(0, 30),
              allClasses: allClasses.slice(0, 100),
              html: document.querySelector('main, [role="main"], #app, #root, .content')?.innerHTML?.slice(0, 10000) || document.body.innerHTML.slice(0, 10000),
            };
          });
          writeFileSync(`${DEBUG_DIR}/14-${path.replace('/', '')}-info.json`, JSON.stringify(pageInfo, null, 2));
        } else {
          console.log(`   ${path} -> ${resp.status()} (thin content or 404)`);
        }
      } else {
        console.log(`   ${path} -> ${resp?.status() || 'failed'}`);
      }
    }

    // Save API calls
    writeFileSync(`${DEBUG_DIR}/15-api-calls.json`, JSON.stringify(apiCalls, null, 2));
    console.log(`\n6. API calls intercepted: ${apiCalls.length}`);

    console.log('\nDone!');
  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: `${DEBUG_DIR}/error-step2.png` }).catch(() => {});
  } finally {
    await browser.close();
  }
}

explore().catch(console.error);
