/**
 * Brain tool: rename_section
 *
 * Rename a section in CleanCloud via the admin panel.
 * Ported from IT/cc_fix_section10.js.
 */
import { z } from 'zod';
import { ensureDb, getSection, logOperation, updateSectionName } from '../lib/db.js';
import {
  withBrowserMutex, LoginCodeRequiredError, navigateToSections, takeScreenshot, waitForCondition,
} from '../lib/browser.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default {
  name: 'rename_section',
  description: 'Rename a product section in CleanCloud. Navigates to the sections admin, finds the section input, changes the name, and saves.',
  schema: {
    section_id: z.string().describe('Section ID to rename'),
    new_name: z.string().describe('New section name'),
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

    const oldName = section.name;
    const userId = ctx.from?.id ? String(ctx.from.id) : null;
    const userName = ctx.from?.first_name || ctx.from?.username || null;

    try {
      const result = await withBrowserMutex(async (page) => {
        await navigateToSections(page);

        // Find and rename the section
        const renameResultJson = await page.evaluate(`
          (function() {
            var nameInputs = document.querySelectorAll('input[name="e_section_name[]"]');
            for (var i = 0; i < nameInputs.length; i++) {
              var row = nameInputs[i].closest('tr');
              if (!row) continue;
              var hiddenId = row.querySelector('input[name="e_section_ID[]"]');
              if (hiddenId && hiddenId.value === ${JSON.stringify(args.section_id)}) {
                var old = nameInputs[i].value;
                nameInputs[i].value = ${JSON.stringify(args.new_name)};
                nameInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                nameInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
                return JSON.stringify({ success: true, old: old });
              }
            }
            return JSON.stringify({ success: false, error: 'Section input not found' });
          })()
        `);
        const renameResult = JSON.parse(renameResultJson);

        if (!renameResult.success) {
          return { success: false, error: renameResult.error };
        }

        // Click save button
        const saveResultJson = await page.evaluate(`
          (function() {
            var buttons = document.querySelectorAll('button, input[type="submit"], a.btn');
            for (var i = 0; i < buttons.length; i++) {
              var btn = buttons[i];
              var text = (btn.textContent || btn.value || '').trim().toLowerCase();
              if ((text.indexOf('save') !== -1 || text.indexOf('update section') !== -1) && btn.offsetParent !== null) {
                btn.click();
                return JSON.stringify({ success: true, text: (btn.textContent || btn.value || '').trim() });
              }
            }
            var form = document.querySelector('input[name="e_section_name[]"]')?.closest('form');
            if (form) {
              form.submit();
              return JSON.stringify({ success: true, text: 'form.submit()' });
            }
            return JSON.stringify({ success: false, error: 'No save button found' });
          })()
        `);
        const saveResult = JSON.parse(saveResultJson);
        await sleep(5000);

        const screenshotPath = await takeScreenshot(page, `rename_section_${args.section_id}`);

        return {
          success: saveResult.success,
          oldName: renameResult.old,
          saveMethod: saveResult.text || saveResult.error,
          screenshotPath,
        };
      });

      if (!result.success) {
        logOperation(ctx.config, {
          action: 'rename_section',
          target_type: 'section',
          target_id: args.section_id,
          description: `Failed: ${result.error || result.saveMethod}`,
          status: 'failed',
          error_msg: result.error || result.saveMethod,
          user_id: userId,
          user_name: userName,
        });
        return `Failed to rename section: ${result.error || result.saveMethod}`;
      }

      // Update cache
      updateSectionName(ctx.config, args.section_id, args.new_name);

      logOperation(ctx.config, {
        action: 'rename_section',
        target_type: 'section',
        target_id: args.section_id,
        description: `"${result.oldName}" → "${args.new_name}"`,
        details_json: {
          old_name: result.oldName,
          new_name: args.new_name,
          save_method: result.saveMethod,
        },
        screenshot_path: result.screenshotPath,
        status: 'completed',
        user_id: userId,
        user_name: userName,
      });

      return `Section renamed: "${result.oldName}" → "${args.new_name}"\nScreenshot taken.`;
    } catch (err) {
      if (err instanceof LoginCodeRequiredError) {
        return err.message;
      }
      logOperation(ctx.config, {
        action: 'rename_section',
        target_type: 'section',
        target_id: args.section_id,
        description: `Error: ${err.message}`,
        status: 'failed',
        error_msg: err.message,
        user_id: userId,
        user_name: userName,
      });
      return `Error renaming section: ${err.message}`;
    }
  },
};
