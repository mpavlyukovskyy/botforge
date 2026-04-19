/**
 * Browser Manager — CDP-based headless Chrome automation for CleanCloud
 *
 * Ported from IT/cc_b2b_set_prices.js CDPPage class + login/navigation helpers.
 * Manages Chrome lifecycle, login, navigation, and mutation serialization.
 */
import WebSocket from 'ws';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';

const SCREENSHOT_DIR = '/tmp/cleancloud-bot';
if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Login code error ───────────────────────────────────────────────────────

export class LoginCodeRequiredError extends Error {
  constructor() {
    super('Login requires email confirmation code. Check findlaysnz@icloud.com for the code and reply with it.');
    this.name = 'LoginCodeRequiredError';
  }
}

// ─── CDPPage class (ported from IT/cc_b2b_set_prices.js:78-135) ────────────

export class CDPPage {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.callbacks = new Map();
    this.dialogAccepted = false;

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      // Auto-accept JavaScript dialogs
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: true });
        this.dialogAccepted = true;
      }

      if (msg.id && this.callbacks.has(msg.id)) {
        this.callbacks.get(msg.id)(msg);
        this.callbacks.delete(msg.id);
      }
    });

    ws.on('error', () => {});
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timeout = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`CDP Timeout: ${method}`));
      }, 30000);
      this.callbacks.set(id, (msg) => {
        clearTimeout(timeout);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'Eval error');
    }
    return result.result?.value;
  }

  async screenshot(filepath) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(filepath, Buffer.from(result.data, 'base64'));
    return filepath;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
  }

  get connected() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ─── Browser state ──────────────────────────────────────────────────────────

let _page = null;
let _chromeProcess = null;
let _currentPLId = null;
let _currentSectionId = null;
let _mutexQueue = Promise.resolve();

function getCdpPort() {
  return process.env.CLEANCLOUD_CDP_PORT || '9230';
}

// ─── waitForCondition (replaces fixed sleeps) ───────────────────────────────

async function waitForCondition(page, jsExpr, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await page.evaluate(jsExpr);
      if (result) return result;
    } catch {}
    await sleep(500);
  }
  return false;
}

// ─── Chrome process management ──────────────────────────────────────────────

function isPortInUse(port) {
  try {
    const result = execSync(`curl -s http://localhost:${port}/json/version`, { timeout: 3000 });
    JSON.parse(result.toString());
    return true;
  } catch {
    return false;
  }
}

function killStaleChrome(port) {
  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { timeout: 5000 });
  } catch {}
}

function launchChrome(port) {
  // Try common chromium paths
  const chromePaths = [
    'chromium-browser',
    'chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'google-chrome',
  ];

  let chromePath = null;
  for (const p of chromePaths) {
    try {
      execSync(`which ${p}`, { timeout: 2000 });
      chromePath = p;
      break;
    } catch {}
  }

  if (!chromePath) {
    throw new Error('Chromium not found. Install with: apt install -y chromium-browser');
  }

  const proc = spawn(chromePath, [
    '--headless',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    'about:blank',
  ], {
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();
  return proc;
}

async function connectToChrome(port) {
  const res = await fetch(`http://localhost:${port}/json/list`);
  const targets = await res.json();
  let target = targets.find(t => t.type === 'page');
  if (!target) {
    // Create a new tab via browser WS
    const versionRes = await fetch(`http://localhost:${port}/json/version`);
    const versionData = await versionRes.json();
    const browserWs = new WebSocket(versionData.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      browserWs.on('open', resolve);
      browserWs.on('error', reject);
    });
    let id = 1;
    const pending = new Map();
    browserWs.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    await new Promise((resolve) => {
      const myId = id++;
      pending.set(myId, resolve);
      browserWs.send(JSON.stringify({ id: myId, method: 'Target.createTarget', params: { url: 'about:blank' } }));
    });
    browserWs.close();
    await sleep(1000);
    // Re-fetch targets
    const res2 = await fetch(`http://localhost:${port}/json/list`);
    const targets2 = await res2.json();
    target = targets2.find(t => t.type === 'page');
    if (!target) throw new Error('Failed to create Chrome tab');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const page = new CDPPage(ws);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return page;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Ensure Chrome is running and return a connected CDPPage.
 * Reconnects if disconnected, launches if dead.
 */
export async function ensureBrowser() {
  const port = getCdpPort();

  // If we have a live page, check it's still connected
  if (_page && _page.connected) {
    try {
      await _page.evaluate('1+1');
      return _page;
    } catch {
      _page = null;
    }
  }

  // Try connecting to existing Chrome on port
  if (isPortInUse(port)) {
    try {
      _page = await connectToChrome(port);
      return _page;
    } catch {
      // Port in use but can't connect — kill and relaunch
      killStaleChrome(port);
      await sleep(2000);
    }
  }

  // Launch new Chrome
  _chromeProcess = launchChrome(port);
  await sleep(3000); // Give Chrome time to start

  // Wait for Chrome to be ready
  for (let i = 0; i < 10; i++) {
    if (isPortInUse(port)) break;
    await sleep(1000);
  }

  if (!isPortInUse(port)) {
    throw new Error(`Chrome failed to start on port ${port}`);
  }

  _page = await connectToChrome(port);
  return _page;
}

/**
 * Check if browser is running and healthy
 */
export function isBrowserRunning() {
  return _page != null && _page.connected;
}

/**
 * Get browser status for context block
 */
export function getBrowserStatus() {
  return {
    running: isBrowserRunning(),
    port: getCdpPort(),
  };
}

/**
 * Check if currently logged into CleanCloud
 */
export async function isLoggedIn(page) {
  try {
    const url = await page.evaluate('window.location.href');
    return url.includes('/admin/') || url.includes('/store/');
  } catch {
    return false;
  }
}

/**
 * Log into CleanCloud admin.
 *
 * CleanCloud's login flow:
 *   1. Submit email + password
 *   2. Server may send email confirmation code to the account email
 *   3. Page shows #email_confirm_div with a single #emailConfirm input
 *   4. If code needed → throws LoginCodeRequiredError (page stays on confirm form)
 *   5. Caller must use submitLoginCode() to complete login
 */
export async function login(page) {
  const email = process.env.CLEANCLOUD_EMAIL;
  const password = process.env.CLEANCLOUD_PASSWORD;
  const storeId = process.env.CLEANCLOUD_STORE_ID || '40788';

  if (!email || !password) {
    throw new Error('CLEANCLOUD_EMAIL and CLEANCLOUD_PASSWORD required');
  }

  // Navigate to login
  await page.navigate('https://cleancloudapp.com/login');
  await sleep(5000);

  // Check if already logged in (redirect)
  const currentUrl = await page.evaluate('window.location.href');
  if (currentUrl.includes('/admin/') || currentUrl.includes('/store/')) {
    return true;
  }

  // Dismiss cookie consent banner (CookieScript overlay)
  await page.evaluate(`
    void (function() {
      var el = document.getElementById('cookiescript_accept');
      if (el) { el.click(); return; }
      var buttons = document.querySelectorAll('button, a');
      for (var i = 0; i < buttons.length; i++) {
        var t = buttons[i].textContent.trim().toUpperCase();
        if (t === 'ACCEPT ALL' || t === 'ACCEPT') { buttons[i].click(); return; }
      }
    })()
  `);
  await sleep(2000);

  // Fill login form — CleanCloud uses #login_email (type=text) and #login_password
  await page.evaluate(`
    void (function() {
      var emailInput = document.getElementById('login_email');
      if (emailInput) {
        emailInput.focus();
        emailInput.value = ${JSON.stringify(email)};
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      var passInput = document.getElementById('login_password');
      if (passInput) {
        passInput.focus();
        passInput.value = ${JSON.stringify(password)};
        passInput.dispatchEvent(new Event('input', { bubbles: true }));
        passInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await sleep(1000);

  // Click the submit button
  await page.evaluate(`void document.getElementById('submit_login_button')?.click()`);
  await sleep(8000);

  // Check post-submit state
  const afterUrl = await page.evaluate('window.location.href');
  if (afterUrl.includes('/admin/') || afterUrl.includes('/store/')) {
    await page.navigate(`https://cleancloudapp.com/admin/store/${storeId}`);
    await sleep(5000);
    return true;
  }

  // Check if email confirmation is required
  const emailConfirmVisible = await page.evaluate(
    `window.getComputedStyle(document.getElementById('email_confirm_div') || document.body).display !== 'none'`
  );

  if (emailConfirmVisible) {
    // Throw so the caller knows a code is needed — page stays on the confirm form
    throw new LoginCodeRequiredError();
  }

  // Check for rate limiting
  const bodyText = await page.evaluate('document.body?.innerText?.substring(0, 300)');
  if (bodyText?.includes('wait a while')) {
    throw new Error('Login rate-limited by CleanCloud — wait a few minutes and retry');
  }

  throw new Error('Login failed — check credentials');
}

/**
 * Submit the email confirmation code to complete login.
 * Must be called when page is on the email confirm form.
 */
export async function submitLoginCode(page, code) {
  const storeId = process.env.CLEANCLOUD_STORE_ID || '40788';

  // Verify we're on the login page with email confirm visible
  const confirmVisible = await page.evaluate(
    `window.getComputedStyle(document.getElementById('email_confirm_div') || document.body).display !== 'none'`
  );
  if (!confirmVisible) {
    throw new Error('Not on email confirmation page');
  }

  // Focus and fill via CDP insertText (only reliable method)
  await page.evaluate(`void document.getElementById('emailConfirm')?.focus()`);
  await sleep(200);
  await page.send('Input.insertText', { text: code.trim() });
  await sleep(500);

  // Submit
  await page.evaluate(`void document.getElementById('submit_login_button')?.click()`);
  await sleep(10000);

  // Verify redirect
  const url = await page.evaluate('window.location.href');
  if (url.includes('/admin/') || url.includes('/store/')) {
    await page.navigate(`https://cleancloudapp.com/admin/store/${storeId}`);
    await sleep(5000);
    return true;
  }
  throw new Error('Login code rejected — may be expired or incorrect');
}

// ─── Navigation helpers ─────────────────────────────────────────────────────

/**
 * Navigate to Products admin panel
 */
export async function navigateToProducts(page) {
  await page.evaluate(`void document.getElementById('accountShow')?.click()`);
  await sleep(1500);
  await page.evaluate(`void document.getElementById('slide4')?.click()`);
  await sleep(3000);
  await page.evaluate(`void document.getElementById('prNav1')?.click()`);
  await sleep(2000);

  // Verify
  const hasDropdown = await waitForCondition(page,
    `!!document.getElementById('plChange')`,
    5000);
  if (!hasDropdown) {
    throw new Error('Products admin did not load (plChange dropdown missing)');
  }

  _currentPLId = null;
  _currentSectionId = null;
}

/**
 * Navigate to Sections admin panel
 */
export async function navigateToSections(page) {
  await page.evaluate(`void document.getElementById('accountShow')?.click()`);
  await sleep(1000);
  await page.evaluate(`void document.getElementById('slide4')?.click()`);
  await sleep(3000);
  await page.evaluate(`void document.getElementById('prNav3')?.click()`);
  await sleep(3000);
}

/**
 * Switch to a specific price list
 */
export async function switchPriceList(page, priceListId) {
  if (_currentPLId === priceListId) return;

  await page.evaluate(`
    void (function() {
      var sel = document.getElementById('plChange');
      if (sel) {
        var plId = ${JSON.stringify(String(priceListId))};
        for (var i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value === plId || sel.options[i].value === String(plId)) {
            sel.value = sel.options[i].value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
        sel.value = plId;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await sleep(3000);
  _currentPLId = priceListId;
  _currentSectionId = null; // PL switch resets section view
}

/**
 * Switch to a specific section tab
 */
export async function switchSection(page, sectionId) {
  if (_currentSectionId === sectionId) return;

  await page.evaluate(`
    void (function() {
      var secId = ${JSON.stringify(String(sectionId))};
      if (typeof showTabProducts === 'function') {
        showTabProducts(secId);
      } else {
        var tab = document.getElementById('prodShort' + secId);
        if (tab) tab.click();
      }
    })()
  `);
  await sleep(2000);
  _currentSectionId = sectionId;
}

/**
 * Press Escape key to close modals
 */
export async function pressEscape(page) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
}

// ─── Mutation mutex (serializes all browser operations) ─────────────────────

/**
 * Execute a browser mutation with locking, login verification, and retry.
 * Only one mutation runs at a time.
 *
 * @param {Function} fn - async function(page) that performs the mutation
 * @param {object} opts - { maxRetries: 2, skipLoginCheck: false }
 * @returns {Promise<any>} result of fn
 */
export async function withBrowserMutex(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? 2;
  const skipLoginCheck = opts.skipLoginCheck ?? false;

  // Chain onto the mutex queue
  const result = _mutexQueue.then(async () => {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const page = await ensureBrowser();

        if (!skipLoginCheck) {
          // Verify logged in
          const loggedIn = await isLoggedIn(page);
          if (!loggedIn) {
            await login(page); // throws LoginCodeRequiredError if code needed
          }
        }

        return await fn(page);
      } catch (err) {
        lastError = err;

        // Never retry LoginCodeRequiredError — user must provide code
        if (err instanceof LoginCodeRequiredError) throw err;

        // On WebSocket/connection errors, reset and retry
        if (err.message.includes('Timeout') || err.message.includes('WebSocket') || err.message.includes('not open')) {
          _page = null;
          _currentPLId = null;
          _currentSectionId = null;
          await sleep(2000 * (attempt + 1)); // Exponential backoff
          continue;
        }

        throw err; // Non-transient error, don't retry
      }
    }

    throw lastError;
  });

  // Replace the queue tail with our operation
  _mutexQueue = result.catch(() => {});
  return result;
}

/**
 * Take a screenshot and return the file path
 */
export async function takeScreenshot(page, label = 'screenshot') {
  const timestamp = Date.now();
  const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const filepath = `${SCREENSHOT_DIR}/${safeName}_${timestamp}.png`;
  await page.screenshot(filepath);
  return filepath;
}

// ─── Exported constants ─────────────────────────────────────────────────────

export { SCREENSHOT_DIR, waitForCondition };
