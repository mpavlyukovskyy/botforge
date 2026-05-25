/**
 * One-shot trigger: call designProgram + send the 2-message approval card
 * (or the active confirmation) via local-bot-api.
 *
 * Bypasses the cron's needsRollover guard so we can test the new flow even
 * while the current block (Hypertrophy Block 1) is still in week 1/6.
 *
 *   cd /opt/botforge
 *   set -a && source .env && set +a
 *   node bots/trainer/scripts/trigger-design.js
 */
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(`${__dirname}/../../..`);

const TOKEN = process.env.TRAINER_BOT_TOKEN;
const CHAT_ID = process.env.TRAINER_CHAT_ID;
const BOT_API = 'http://localhost:8081';

if (!TOKEN || !CHAT_ID) {
  console.error('Missing TRAINER_BOT_TOKEN or TRAINER_CHAT_ID');
  process.exit(1);
}

const log = {
  info: (m) => console.log('[INFO]', m),
  warn: (m) => console.warn('[WARN]', m),
  error: (m) => console.error('[ERR]', m),
  debug: (m) => console.log('[DBG]', m),
};

const storeMap = new Map();
const ctxStore = { get: (k) => storeMap.get(k), set: (k, v) => storeMap.set(k, v) };

const config = { name: 'Trainer', platform: { chat_ids: [CHAT_ID] } };

async function rawSend({ chatId, text, parseMode, inlineKeyboard }) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard.map((row) =>
    row.map((b) => ({ text: b.text, callback_data: b.callbackData }))
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
}

const adapter = { send: rawSend };
const ctx = { config, store: ctxStore, adapter, log };

// Clear stale state
const { ensureDb, getActiveProgram, getRecentProgramHistory } = await import('../lib/db.js');
const db = ensureDb(config);
db.prepare('DELETE FROM bot_state WHERE key=?').run('pending_program');
log.info('Cleared any stale pending_program');

const { designProgram } = await import('../lib/program-designer.js');
const { sendApprovalCard } = await import('../cron/program-rollover.js');

const fresh = getActiveProgram(config);
let goalsSnapshot = ['Build muscle mass (hypertrophy-focused training)', 'Train consistently 4x per week'];
if (fresh?.goals_snapshot) {
  try {
    const parsed = JSON.parse(fresh.goals_snapshot);
    if (Array.isArray(parsed) && parsed.length > 0) goalsSnapshot = parsed;
  } catch { /* default */ }
}
const history = getRecentProgramHistory(config, 2);
const rotationContext = history?.length
  ? '\nPREVIOUS PROGRAM EXERCISES:\n' + history.map((h) => `- ${h.exercise_title}: ${h.final_status || 'unknown'}`).join('\n')
  : '';

log.info('Calling designProgram — this takes 30-60s...');
const result = await designProgram({
  config,
  goalsSnapshot,
  rotationContext,
  log,
});

console.log('RESULT:', JSON.stringify({ ok: result.ok, status: result.status, novelCount: result.novelList?.length, droppedCount: result.droppedList?.length, error_class: result.error_class, reason: result.reason }, null, 2));

if (!result.ok) {
  log.error(`Design failed: ${result.reason}`);
  await rawSend({ chatId: CHAT_ID, text: `Design failed: ${result.reason}` });
  process.exit(1);
}

if (result.status === 'pending') {
  log.info(`Pending with ${result.novelList.length} novel(s). Sending approval card.`);
  await sendApprovalCard(ctx, CHAT_ID, result.program, result.novelList);
} else {
  log.info('All-USED design — sending summary.');
  const dropped = (result.droppedList?.length || 0) > 0
    ? `\n_Dropped: ${result.droppedList.map((d) => d.name).join(', ')}_`
    : '';
  await rawSend({
    chatId: CHAT_ID,
    parseMode: 'Markdown',
    text: `Designed (no novels): *${result.program.block_name}* — ${result.program.duration_weeks} weeks. Reply \`/approve all\` to activate, \`/cancel\` to discard.${dropped}`,
  });
  // Write pending_program with empty novelList so /approve all activates
  const { setPendingProgram } = await import('../lib/exercise-library.js');
  setPendingProgram(config, {
    program: result.program,
    novelList: [],
    droppedList: result.droppedList || [],
    createdAt: Date.now(),
    designedAgainstWorkoutCountAtTime: null,
  });
}

console.log('TRIGGER DONE');
