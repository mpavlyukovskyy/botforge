/**
 * Brain tool: submit_login_code
 *
 * Accept a 6-digit email verification code and complete CleanCloud login.
 * Uses mutex with skipLoginCheck to serialize but avoid re-triggering login.
 */
import { z } from 'zod';
import { withBrowserMutex, login, submitLoginCode, LoginCodeRequiredError } from '../lib/browser.js';

export default {
  name: 'submit_login_code',
  description: 'Submit the 6-digit email verification code to complete CleanCloud login. Use this after receiving a login code notification.',
  schema: {
    code: z.string().describe('6-digit email verification code from findlaysnz@icloud.com'),
  },
  async execute(args, ctx) {
    try {
      await withBrowserMutex(async (page) => {
        // Check if email confirm div is visible
        const confirmVisible = await page.evaluate(
          `window.getComputedStyle(document.getElementById('email_confirm_div') || document.body).display !== 'none'`
        );

        if (!confirmVisible) {
          // Not on confirm page — try navigating to login first which will submit credentials
          // and leave us on the confirm form (throws LoginCodeRequiredError)
          try {
            await login(page);
            // If login succeeds without code, we're already logged in
            return;
          } catch (err) {
            if (!(err instanceof LoginCodeRequiredError)) throw err;
            // Good — now we're on the confirm form, fall through to submitLoginCode
          }
        }

        await submitLoginCode(page, args.code);
      }, { skipLoginCheck: true });

      return 'Login successful. You can now retry your operation.';
    } catch (err) {
      return `Login code failed: ${err.message}`;
    }
  },
};
