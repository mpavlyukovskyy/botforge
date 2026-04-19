/**
 * Brain tool: set_price
 *
 * Set the price for a single product via browser automation.
 * Ported from IT/cc_b2b_set_prices.js setPriceBrowser().
 */
import { z } from 'zod';
import { ensureDb, getProduct, getProductWithPriceList, logOperation, updateProductPrice } from '../lib/db.js';
import {
  withBrowserMutex, LoginCodeRequiredError, navigateToProducts, switchPriceList, switchSection,
  pressEscape, takeScreenshot, waitForCondition,
} from '../lib/browser.js';
import { revalidateDashboardPrices } from '../lib/dashboard-revalidate.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default {
  name: 'set_price',
  description: 'Set the price for a product in CleanCloud. Opens the product edit form via the admin panel and updates the price. Takes a few seconds.',
  schema: {
    product_id: z.string().describe('Product ID to update'),
    price: z.number().describe('New standard price (e.g. 5.50)'),
    express_price: z.number().optional().describe('New express price (defaults to price + 5)'),
    price_list_id: z.string().optional().describe('Price list ID (default: "0" for retail)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const priceListId = args.price_list_id || '0';
    const expressPrice = args.express_price ?? (args.price + 5);
    const product = priceListId === '0'
      ? getProduct(ctx.config, args.product_id)
      : getProductWithPriceList(ctx.config, args.product_id, priceListId);

    if (!product) {
      return `Product ${args.product_id} not found in cache. Try search_products first.`;
    }

    const userId = ctx.from?.id ? String(ctx.from.id) : null;
    const userName = ctx.from?.first_name || ctx.from?.username || null;

    try {
      const result = await withBrowserMutex(async (page) => {
        // Navigate to products admin
        await navigateToProducts(page);

        // Switch price list if needed
        if (priceListId !== '0') {
          await switchPriceList(page, priceListId);
        }

        // Switch to correct section
        if (product.section_id) {
          await switchSection(page, product.section_id);
        }

        // Click edit for the product — match by product ID in ePro(id)
        const editResultJson = await page.evaluate(`
          (function() {
            var prodId = ${JSON.stringify(String(args.product_id))};
            var name = ${JSON.stringify(product.name)};
            var rows = document.querySelectorAll('tr');

            // Pass 1: match by product ID in onclick
            if (prodId) {
              for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                var editLink = row.querySelector('a[onclick*="ePro"]');
                if (!editLink) continue;
                var onclick = editLink.getAttribute('onclick') || '';
                if (onclick.indexOf('ePro(' + prodId + ')') !== -1 ||
                    onclick.indexOf('ePro(' + prodId + ',') !== -1 ||
                    onclick.indexOf("ePro('" + prodId + "'") !== -1 ||
                    onclick.indexOf('ePro("' + prodId + '"') !== -1) {
                  editLink.click();
                  return JSON.stringify({ clicked: true, method: 'id-match' });
                }
              }
            }

            // Pass 2: exact name match
            for (var i = 0; i < rows.length; i++) {
              var row = rows[i];
              if (!row.querySelector('a[onclick*="ePro"]')) continue;
              var cells = row.querySelectorAll('td');
              if (cells.length > 8) continue;
              for (var c = 0; c < Math.min(cells.length, 3); c++) {
                if (cells[c].textContent.trim() === name) {
                  row.querySelector('a[onclick*="ePro"]').click();
                  return JSON.stringify({ clicked: true, method: 'exact-name' });
                }
              }
            }

            return JSON.stringify({ clicked: false });
          })()
        `);
        const editClicked = JSON.parse(editResultJson);

        if (!editClicked.clicked) {
          return { success: false, error: `Product "${product.name}" (id=${args.product_id}) not found in admin table` };
        }

        // Wait for edit form
        const formReady = await waitForCondition(page, `
          (function() {
            var box = document.getElementById('edit_product_box');
            var price = document.getElementById('edit_product_price');
            return box && price && window.getComputedStyle(box).display !== 'none';
          })()
        `, 8000);

        if (!formReady) {
          await pressEscape(page);
          return { success: false, error: 'Edit form did not load' };
        }

        // Read old values
        const oldValuesJson = await page.evaluate(`
          (function() {
            var p = document.getElementById('edit_product_price');
            var e = document.getElementById('edit_product_express');
            return JSON.stringify({
              price: p ? p.value : null,
              express: e ? e.value : null,
            });
          })()
        `);
        const oldValues = JSON.parse(oldValuesJson);

        // Set new prices
        await page.evaluate(`
          void (function() {
            var priceInput = document.getElementById('edit_product_price');
            if (priceInput) {
              priceInput.value = '';
              priceInput.value = '${args.price.toFixed(2)}';
              priceInput.dispatchEvent(new Event('input', { bubbles: true }));
              priceInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            var expressInput = document.getElementById('edit_product_express');
            if (expressInput) {
              expressInput.value = '${expressPrice.toFixed(2)}';
              expressInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
          })()
        `);

        // Submit
        await page.evaluate(`
          void (function() {
            var btn = document.getElementById('edit_product_button');
            if (btn) btn.click();
          })()
        `);
        await sleep(3000);

        // Screenshot
        const screenshotPath = await takeScreenshot(page, `set_price_${args.product_id}`);

        return {
          success: true,
          oldValues,
          screenshotPath,
        };
      });

      if (!result.success) {
        logOperation(ctx.config, {
          action: 'set_price',
          target_type: 'product',
          target_id: args.product_id,
          description: `Failed: ${result.error}`,
          status: 'failed',
          error_msg: result.error,
          user_id: userId,
          user_name: userName,
        });
        return `Failed to set price: ${result.error}`;
      }

      // Update cache
      updateProductPrice(ctx.config, args.product_id, priceListId, String(args.price.toFixed(2)), String(expressPrice.toFixed(2)));

      // Log operation
      logOperation(ctx.config, {
        action: 'set_price',
        target_type: 'product',
        target_id: args.product_id,
        description: `${product.name}: $${result.oldValues.price} → $${args.price.toFixed(2)} (express: $${result.oldValues.express} → $${expressPrice.toFixed(2)})`,
        details_json: {
          product_name: product.name,
          old_price: result.oldValues.price,
          new_price: args.price.toFixed(2),
          old_express: result.oldValues.express,
          new_express: expressPrice.toFixed(2),
          price_list_id: priceListId,
        },
        screenshot_path: result.screenshotPath,
        status: 'completed',
        user_id: userId,
        user_name: userName,
      });

      await revalidateDashboardPrices(ctx.log);

      // Send screenshot to Telegram
      try {
        const token = process.env.CLEANCLOUD_BOT_TOKEN;
        const chatId = ctx.chatId || process.env.CLEANCLOUD_CHAT_ID;
        if (token && chatId && result.screenshotPath) {
          const { readFileSync } = await import('node:fs');
          const FormData = (await import('node:buffer')).Blob ? null : null;
          // Use Telegram sendPhoto API
          const photoData = readFileSync(result.screenshotPath);
          const boundary = '----FormBoundary' + Date.now();
          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`),
            photoData,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]);
          await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
          });
        }
      } catch {}

      return `Price updated for "${product.name}":\n  Standard: $${result.oldValues.price} → $${args.price.toFixed(2)}\n  Express: $${result.oldValues.express} → $${expressPrice.toFixed(2)}\nScreenshot taken.`;
    } catch (err) {
      if (err instanceof LoginCodeRequiredError) {
        return err.message;
      }
      logOperation(ctx.config, {
        action: 'set_price',
        target_type: 'product',
        target_id: args.product_id,
        description: `Error: ${err.message}`,
        status: 'failed',
        error_msg: err.message,
        user_id: userId,
        user_name: userName,
      });
      return `Error setting price: ${err.message}`;
    }
  },
};
