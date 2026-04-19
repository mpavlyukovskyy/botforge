/**
 * Brain tool: adjust_prices
 *
 * Adjust prices by percentage for all products in a section.
 * e.g. "increase Dry Cleaning by 5%" → multiplies all prices by 1.05
 */
import { z } from 'zod';
import { ensureDb, getSection, getProductsBySection, logOperation, updateProductPrice } from '../lib/db.js';
import {
  withBrowserMutex, LoginCodeRequiredError, navigateToProducts, switchPriceList,
  switchSection, pressEscape, takeScreenshot, waitForCondition,
} from '../lib/browser.js';
import { revalidateDashboardPrices } from '../lib/dashboard-revalidate.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default {
  name: 'adjust_prices',
  description: 'Adjust all prices in a section by a percentage. e.g. +5 means increase by 5%, -10 means decrease by 10%.',
  schema: {
    section_id: z.string().describe('Section ID to adjust prices for'),
    percentage: z.number().describe('Percentage adjustment (e.g. 5 for +5%, -10 for -10%)'),
    price_list_id: z.string().optional().describe('Price list ID (default: "0" for retail)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const section = getSection(ctx.config, args.section_id);
    if (!section) {
      return `Section ${args.section_id} not found. Use list_sections to see available sections.`;
    }

    const priceListId = args.price_list_id || '0';
    const multiplier = 1 + args.percentage / 100;
    const userId = ctx.from?.id ? String(ctx.from.id) : null;
    const userName = ctx.from?.first_name || ctx.from?.username || null;

    // Get all products in section with prices
    const products = getProductsBySection(ctx.config, args.section_id, 200);
    const adjustable = products.filter(p => p.price && Number(p.price) > 0);

    if (adjustable.length === 0) {
      return `No products with prices found in section "${section.name}".`;
    }

    // Calculate new prices
    const changes = adjustable.map(p => {
      const oldPrice = Number(p.price);
      const oldExpress = Number(p.express_price || 0);
      const newPrice = Math.round(oldPrice * multiplier * 100) / 100;
      const newExpress = oldExpress > 0 ? Math.round(oldExpress * multiplier * 100) / 100 : newPrice + 5;
      return {
        product: p,
        oldPrice,
        oldExpress,
        newPrice,
        newExpress,
      };
    });

    try {
      const results = await withBrowserMutex(async (page) => {
        await navigateToProducts(page);

        if (priceListId !== '0') {
          await switchPriceList(page, priceListId);
        }

        await switchSection(page, args.section_id);

        const outcomes = [];

        for (const change of changes) {
          // Click edit
          const editResultJson = await page.evaluate(`
            (function() {
              var prodId = ${JSON.stringify(String(change.product.id))};
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
            outcomes.push({ id: change.product.id, name: change.product.name, success: false, error: 'Not found in table' });
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
            outcomes.push({ id: change.product.id, name: change.product.name, success: false, error: 'Form did not load' });
            continue;
          }

          // Set new prices
          await page.evaluate(`
            void (function() {
              var priceInput = document.getElementById('edit_product_price');
              if (priceInput) {
                priceInput.value = '';
                priceInput.value = '${change.newPrice.toFixed(2)}';
                priceInput.dispatchEvent(new Event('input', { bubbles: true }));
                priceInput.dispatchEvent(new Event('change', { bubbles: true }));
              }
              var expressInput = document.getElementById('edit_product_express');
              if (expressInput) {
                expressInput.value = '${change.newExpress.toFixed(2)}';
                expressInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })()
          `);

          // Submit
          await page.evaluate(`void document.getElementById('edit_product_button')?.click()`);
          await sleep(3000);

          // Update cache
          updateProductPrice(ctx.config, change.product.id, priceListId, String(change.newPrice.toFixed(2)), String(change.newExpress.toFixed(2)));

          outcomes.push({
            id: change.product.id,
            name: change.product.name,
            success: true,
            oldPrice: change.oldPrice,
            newPrice: change.newPrice,
            oldExpress: change.oldExpress,
            newExpress: change.newExpress,
          });
        }

        const screenshotPath = await takeScreenshot(page, `adjust_prices_${args.section_id}`);
        return { outcomes, screenshotPath };
      });

      const succeeded = results.outcomes.filter(o => o.success).length;
      const failed = results.outcomes.filter(o => !o.success).length;

      logOperation(ctx.config, {
        action: 'adjust_prices',
        target_type: 'section',
        target_id: args.section_id,
        description: `${section.name}: ${args.percentage > 0 ? '+' : ''}${args.percentage}% — ${succeeded} succeeded, ${failed} failed`,
        details_json: results.outcomes,
        screenshot_path: results.screenshotPath,
        status: failed === 0 ? 'completed' : 'partial',
        user_id: userId,
        user_name: userName,
      });

      // Revalidate dashboard if any succeeded
      if (succeeded > 0) {
        await revalidateDashboardPrices(ctx.log);
      }

      const lines = [];
      lines.push(`Price adjustment for "${section.name}" (${args.percentage > 0 ? '+' : ''}${args.percentage}%): ${succeeded}/${changes.length} succeeded\n`);

      for (const o of results.outcomes) {
        if (o.success) {
          lines.push(`  ${o.name}: $${o.oldPrice.toFixed(2)} → $${o.newPrice.toFixed(2)} (express: $${o.oldExpress.toFixed(2)} → $${o.newExpress.toFixed(2)})`);
        } else {
          lines.push(`  ${o.name} — FAILED: ${o.error}`);
        }
      }

      lines.push('\nScreenshot taken.');
      return lines.join('\n');
    } catch (err) {
      if (err instanceof LoginCodeRequiredError) {
        return err.message;
      }
      return `Error adjusting prices: ${err.message}`;
    }
  },
};
