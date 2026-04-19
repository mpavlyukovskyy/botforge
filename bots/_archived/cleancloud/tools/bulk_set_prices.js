/**
 * Brain tool: bulk_set_prices
 *
 * Set prices for multiple products in one operation.
 * Groups by section to minimize navigation.
 */
import { z } from 'zod';
import { ensureDb, getProduct, logOperation, updateProductPrice } from '../lib/db.js';
import {
  withBrowserMutex, LoginCodeRequiredError, navigateToProducts, switchPriceList, switchSection,
  pressEscape, takeScreenshot, waitForCondition,
} from '../lib/browser.js';
import { revalidateDashboardPrices } from '../lib/dashboard-revalidate.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default {
  name: 'bulk_set_prices',
  description: 'Set prices for multiple products at once. Groups changes by section to minimize navigation. Each change takes a few seconds.',
  schema: {
    changes: z.array(z.object({
      product_id: z.string().describe('Product ID'),
      price: z.number().describe('New standard price'),
      express_price: z.number().optional().describe('Express price (default: price + 5)'),
    })).describe('Array of price changes'),
    price_list_id: z.string().optional().describe('Price list ID (default: "0" for retail)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const priceListId = args.price_list_id || '0';
    const userId = ctx.from?.id ? String(ctx.from.id) : null;
    const userName = ctx.from?.first_name || ctx.from?.username || null;

    // Resolve all products and group by section
    const changes = [];
    for (const c of args.changes) {
      const product = getProduct(ctx.config, c.product_id);
      if (!product) {
        return `Product ${c.product_id} not found in cache. Aborting bulk operation.`;
      }
      changes.push({
        ...c,
        product,
        express_price: c.express_price ?? (c.price + 5),
      });
    }

    // Sort by section_id to minimize switches
    changes.sort((a, b) => (a.product.section_id || '').localeCompare(b.product.section_id || ''));

    try {
      const results = await withBrowserMutex(async (page) => {
        await navigateToProducts(page);

        if (priceListId !== '0') {
          await switchPriceList(page, priceListId);
        }

        const outcomes = [];
        let currentSection = null;

        for (const change of changes) {
          // Switch section if needed
          if (change.product.section_id && change.product.section_id !== currentSection) {
            await switchSection(page, change.product.section_id);
            currentSection = change.product.section_id;
          }

          // Click edit
          const editResultJson = await page.evaluate(`
            (function() {
              var prodId = ${JSON.stringify(String(change.product_id))};
              var rows = document.querySelectorAll('tr');
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
                  return JSON.stringify({ clicked: true });
                }
              }
              return JSON.stringify({ clicked: false });
            })()
          `);
          const editClicked = JSON.parse(editResultJson);

          if (!editClicked.clicked) {
            outcomes.push({ product_id: change.product_id, name: change.product.name, success: false, error: 'Not found in table' });
            continue;
          }

          // Wait for form
          const formReady = await waitForCondition(page, `
            (function() {
              var box = document.getElementById('edit_product_box');
              var price = document.getElementById('edit_product_price');
              return box && price && window.getComputedStyle(box).display !== 'none';
            })()
          `, 8000);

          if (!formReady) {
            await pressEscape(page);
            outcomes.push({ product_id: change.product_id, name: change.product.name, success: false, error: 'Form did not load' });
            continue;
          }

          // Set prices
          await page.evaluate(`
            void (function() {
              var priceInput = document.getElementById('edit_product_price');
              if (priceInput) {
                priceInput.value = '';
                priceInput.value = '${change.price.toFixed(2)}';
                priceInput.dispatchEvent(new Event('input', { bubbles: true }));
                priceInput.dispatchEvent(new Event('change', { bubbles: true }));
              }
              var expressInput = document.getElementById('edit_product_express');
              if (expressInput) {
                expressInput.value = '${change.express_price.toFixed(2)}';
                expressInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })()
          `);

          // Submit
          await page.evaluate(`void document.getElementById('edit_product_button')?.click()`);
          await sleep(3000);

          // Update cache
          updateProductPrice(ctx.config, change.product_id, priceListId, String(change.price.toFixed(2)), String(change.express_price.toFixed(2)));

          outcomes.push({ product_id: change.product_id, name: change.product.name, success: true, price: change.price, express: change.express_price });
        }

        // Take final screenshot
        const screenshotPath = await takeScreenshot(page, 'bulk_set_prices');
        return { outcomes, screenshotPath };
      });

      // Log operations
      const succeeded = results.outcomes.filter(o => o.success).length;
      const failed = results.outcomes.filter(o => !o.success).length;

      logOperation(ctx.config, {
        action: 'bulk_set_prices',
        target_type: 'product',
        description: `Bulk price update: ${succeeded} succeeded, ${failed} failed`,
        details_json: results.outcomes,
        screenshot_path: results.screenshotPath,
        status: failed === 0 ? 'completed' : 'partial',
        user_id: userId,
        user_name: userName,
      });

      const lines = [];
      lines.push(`Bulk price update: ${succeeded}/${changes.length} succeeded`);
      lines.push('');

      for (const o of results.outcomes) {
        if (o.success) {
          lines.push(`  [${o.product_id}] ${o.name} → $${o.price.toFixed(2)} (express: $${o.express.toFixed(2)})`);
        } else {
          lines.push(`  [${o.product_id}] ${o.name} — FAILED: ${o.error}`);
        }
      }

      lines.push('');
      lines.push('Screenshot taken.');

      // Revalidate dashboard if any succeeded
      if (results.outcomes.some(o => o.success)) {
        await revalidateDashboardPrices(ctx.log);
      }

      return lines.join('\n');
    } catch (err) {
      if (err instanceof LoginCodeRequiredError) {
        return err.message;
      }
      return `Bulk price update error: ${err.message}`;
    }
  },
};
