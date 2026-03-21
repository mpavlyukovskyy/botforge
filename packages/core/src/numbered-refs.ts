/**
 * Numbered References — per-chat LRU mapping for [N] shorthand.
 * Parses bot responses for [N] patterns and user input for #N shorthand.
 */

const MAX_REFS_PER_CHAT = 100;
const MAX_CHATS = 1000;

const chatRefs = new Map<string, Map<number, string>>();

/** Store a reference mapping for a chat */
export function setRef(chatId: string, num: number, entityId: string): void {
  let refs = chatRefs.get(chatId);
  if (!refs) {
    // Evict oldest chat if at capacity
    if (chatRefs.size >= MAX_CHATS) {
      const oldest = chatRefs.keys().next().value;
      if (oldest) chatRefs.delete(oldest);
    }
    refs = new Map();
    chatRefs.set(chatId, refs);
  }

  // Evict oldest ref if at capacity
  if (refs.size >= MAX_REFS_PER_CHAT && !refs.has(num)) {
    const oldest = refs.keys().next().value;
    if (oldest !== undefined) refs.delete(oldest);
  }

  refs.set(num, entityId);
}

/** Get a reference by number for a chat */
export function getRef(chatId: string, num: number): string | undefined {
  return chatRefs.get(chatId)?.get(num);
}

/** Parse [N] patterns from bot response text and store references */
export function extractRefs(chatId: string, text: string, entityResolver?: (match: string) => string | undefined): void {
  const pattern = /\[(\d+)\]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const num = parseInt(match[1]!, 10);
    const entityId = entityResolver ? entityResolver(match[0]!) : match[0]!;
    if (entityId) setRef(chatId, num, entityId);
  }
}

/** Expand #N shorthand in user input to entity IDs */
export function expandRefs(chatId: string, text: string): string {
  return text.replace(/#(\d+)/g, (full, numStr) => {
    const num = parseInt(numStr, 10);
    const ref = getRef(chatId, num);
    return ref ?? full;
  });
}

/** Clear all references for a chat */
export function clearRefs(chatId: string): void {
  chatRefs.delete(chatId);
}
