/**
 * Per-chat mutex — ensures only one message is processed at a time per chat.
 * In-memory, no persistence needed.
 */

const locks = new Map<string, Promise<void>>();

export async function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(chatId) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>(r => { release = r; });
  locks.set(chatId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
}
