/**
 * Brain tool: screenshot
 *
 * Take a screenshot of the current CleanCloud admin page.
 * Sends it to Telegram via sendPhoto API.
 */
import { z } from 'zod';
import {
  withBrowserMutex, navigateToProducts, navigateToSections,
  takeScreenshot,
} from '../lib/browser.js';
import { readFileSync } from 'node:fs';

export default {
  name: 'screenshot',
  description: 'Take a screenshot of the CleanCloud admin panel and send it to the chat. Useful for verifying the current state.',
  schema: {
    page: z.enum(['products', 'sections', 'current']).optional().describe('Which page to screenshot (default: current)'),
  },
  async execute(args, ctx) {
    const targetPage = args.page || 'current';

    try {
      const result = await withBrowserMutex(async (page) => {
        if (targetPage === 'products') {
          await navigateToProducts(page);
        } else if (targetPage === 'sections') {
          await navigateToSections(page);
        }
        // 'current' — just take a screenshot of whatever is showing

        const screenshotPath = await takeScreenshot(page, `manual_${targetPage}`);
        return screenshotPath;
      });

      // Send screenshot to Telegram
      const token = process.env.CLEANCLOUD_BOT_TOKEN;
      const chatId = ctx.chatId || process.env.CLEANCLOUD_CHAT_ID;
      if (token && chatId && result) {
        try {
          const photoData = readFileSync(result);
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
          return `Screenshot of ${targetPage} page sent.`;
        } catch (err) {
          return `Screenshot saved to ${result} but failed to send to Telegram: ${err.message}`;
        }
      }

      return `Screenshot saved to ${result}`;
    } catch (err) {
      return `Screenshot failed: ${err.message}`;
    }
  },
};
