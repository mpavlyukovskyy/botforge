// One-shot trigger for sendWorkoutPrompt — fires the same flow the 7am cron would.
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { sendWorkoutPrompt } from '../cron/morning-workout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(`${__dirname}/../../..`); // /opt/botforge — so ensureDb's relative path works

const TOKEN = process.env.TRAINER_BOT_TOKEN;
const CHAT_ID = process.env.TRAINER_CHAT_ID;
const BOT_API = process.env.TRAINER_LOCAL_BOT_API || 'http://localhost:8081';

if (!TOKEN || !CHAT_ID) {
  console.error('Missing TRAINER_BOT_TOKEN or TRAINER_CHAT_ID');
  process.exit(1);
}

const log = {
  info: (m) => console.log('[INFO]', m),
  warn: (m) => console.warn('[WARN]', m),
  error: (m) => console.error('[ERR]', m),
};

const store = new Map();
const ctxStore = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };

const config = { name: 'Trainer' };

const adapter = {
  send: async ({ chatId, text, parseMode, inlineKeyboard }) => {
    const body = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard.map(row =>
      row.map(b => ({ text: b.text, callback_data: b.callbackData }))
    )};
    const res = await fetch(`${BOT_API}/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      log.error(`sendMessage failed: ${JSON.stringify(json)}`);
      return null;
    }
    log.info(`sent msg_id=${json.result.message_id}`);
    return json.result.message_id;
  },
};

const ctx = { config, store: ctxStore, adapter, log };

try {
  await sendWorkoutPrompt(ctx, CHAT_ID, { source: 'command' });
  console.log('DONE');
} catch (err) {
  console.error('Trigger failed:', err);
  process.exit(1);
}
