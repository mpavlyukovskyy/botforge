/**
 * Brain tool: add_product
 *
 * Add a new product to CleanCloud via the admin panel.
 * Ported from IT/cc_add_products.js addProduct().
 */
import { z } from 'zod';
import { ensureDb, getSection, logOperation } from '../lib/db.js';
import {
  withBrowserMutex, LoginCodeRequiredError, navigateToProducts, takeScreenshot, waitForCondition,
} from '../lib/browser.js';
import { revalidateDashboardPrices } from '../lib/dashboard-revalidate.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default {
  name: 'add_product',
  description: 'Add a new product to a section in CleanCloud. Opens the add product form and fills in the details.',
  schema: {
    name: z.string().describe('Product name'),
    section_id: z.string().describe('Section ID to add the product to'),
    type: z.enum(['normal', 'parent']).optional().describe('Product type: "normal" (default) or "parent"'),
    price: z.number().optional().describe('Initial price (default: 0)'),
    express_price: z.number().optional().describe('Express price (default: 0)'),
    pieces: z.number().optional().describe('Number of pieces (default: 1)'),
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

    const ccType = args.type === 'parent' ? '4' : '0';
    const price = args.price ?? 0;
    const expressPrice = args.express_price ?? 0;
    const pieces = args.pieces ?? 1;

    const userId = ctx.from?.id ? String(ctx.from.id) : null;
    const userName = ctx.from?.first_name || ctx.from?.username || null;

    try {
      const result = await withBrowserMutex(async (page) => {
        await navigateToProducts(page);

        // Click Add Product button
        await page.evaluate(`void document.getElementById('btnAddProduct')?.click()`);
        await sleep(1500);

        // Check form is visible
        const formVisible = await waitForCondition(page, `
          (function() {
            var box = document.getElementById('add_product');
            return box ? window.getComputedStyle(box).display !== 'none' : false;
          })()
        `, 5000);

        if (!formVisible) {
          // Try clicking again
          await page.evaluate(`void document.getElementById('btnAddProduct')?.click()`);
          await sleep(2000);
        }

        // Fill name
        await page.evaluate(`
          void (function() {
            var input = document.getElementById('add_product_name');
            if (input) {
              input.value = '';
              input.value = ${JSON.stringify(args.name)};
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()
        `);
        await sleep(300);

        // Set section
        await page.evaluate(`
          void (function() {
            var sel = document.getElementById('add_product_section');
            if (sel) {
              sel.value = ${JSON.stringify(args.section_id)};
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()
        `);
        await sleep(300);

        // Set type
        await page.evaluate(`
          void (function() {
            var sel = document.getElementById('add_product_type');
            if (sel) {
              sel.value = '${ccType}';
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()
        `);
        await sleep(300);

        // Set price, express, pieces
        await page.evaluate(`
          void (function() {
            var priceInput = document.getElementById('add_product_price');
            if (priceInput) {
              priceInput.value = '${price.toFixed(2)}';
              priceInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            var expressInput = document.getElementById('add_product_express');
            if (expressInput) {
              expressInput.value = '${expressPrice.toFixed(2)}';
              expressInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            var piecesInput = document.getElementById('add_product_pieces');
            if (piecesInput && !piecesInput.value) {
              piecesInput.value = '${pieces}';
            }
          })()
        `);
        await sleep(300);

        // Submit
        await page.evaluate(`void document.getElementById('add_product_button')?.click()`);
        await sleep(2500);

        // Check for success/error
        const resultStatus = await page.evaluate(`
          (function() {
            var success = document.getElementById('add_product_success');
            var error = document.getElementById('add_product_error');
            if (success && window.getComputedStyle(success).display !== 'none') return 'success';
            if (error && window.getComputedStyle(error).display !== 'none') return 'error';
            return 'unknown';
          })()
        `);

        // Close the form
        try {
          await page.evaluate(`void hideBox('add_product')`);
        } catch {
          // hideBox may not exist
        }
        await sleep(500);

        const screenshotPath = await takeScreenshot(page, `add_product_${args.name.replace(/\s/g, '_').substring(0, 20)}`);

        return {
          success: resultStatus !== 'error',
          status: resultStatus,
          screenshotPath,
        };
      });

      const statusText = result.success
        ? `Product "${args.name}" added to section "${section.name}" (${result.status})`
        : `Failed to add product "${args.name}" — CleanCloud returned error`;

      logOperation(ctx.config, {
        action: 'add_product',
        target_type: 'product',
        description: statusText,
        details_json: {
          name: args.name,
          section_id: args.section_id,
          section_name: section.name,
          type: args.type || 'normal',
          price: price.toFixed(2),
          express_price: expressPrice.toFixed(2),
          result_status: result.status,
        },
        screenshot_path: result.screenshotPath,
        status: result.success ? 'completed' : 'failed',
        user_id: userId,
        user_name: userName,
      });

      if (result.success) {
        await revalidateDashboardPrices(ctx.log);
      }

      return result.success
        ? `Added "${args.name}" to ${section.name} (type: ${args.type || 'normal'}, price: $${price.toFixed(2)}). Use refresh_cache to update the local cache with the new product.`
        : `Failed to add "${args.name}". Screenshot taken for debugging.`;
    } catch (err) {
      if (err instanceof LoginCodeRequiredError) {
        return err.message;
      }
      logOperation(ctx.config, {
        action: 'add_product',
        target_type: 'product',
        description: `Error: ${err.message}`,
        status: 'failed',
        error_msg: err.message,
        user_id: userId,
        user_name: userName,
      });
      return `Error adding product: ${err.message}`;
    }
  },
};
