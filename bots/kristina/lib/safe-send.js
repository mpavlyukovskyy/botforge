/**
 * sendWithMarkdownFallback — send a Telegram message with Markdown, but fall
 * back to plain text if Telegram rejects the entities.
 *
 * Why: digest/reply text interpolates raw task titles. A title containing an
 * unbalanced `*`, `_`, `[`, or backtick makes Telegram return
 * `400 ... can't parse entities`, which would otherwise drop the ENTIRE message
 * (the 2026-06-14 daily-digest failure). Plain text is a strictly better
 * degradation than no message. Mirrors the standalone taskbot safeSendMessage.
 *
 * @param {{adapter:{send:Function}, log?:{warn?:Function}}} ctx
 * @param {{chatId:(string|number), text:string, [k:string]:any}} msg
 * @returns {Promise<any>} the adapter.send result (e.g. message id)
 */
export async function sendWithMarkdownFallback(ctx, msg) {
  try {
    return await ctx.adapter.send({ ...msg, parseMode: 'Markdown' });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/can't parse|parse entities|parse_mode|\b400\b/i.test(m)) {
      ctx.log?.warn?.(`Markdown send failed (${m}); retrying as plain text`);
      // Strip any parseMode and resend as plain text.
      const { parseMode, parse_mode, ...plain } = msg;
      return await ctx.adapter.send(plain);
    }
    throw err;
  }
}
