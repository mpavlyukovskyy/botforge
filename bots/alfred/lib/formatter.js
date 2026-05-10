/**
 * Telegram message formatter for lunch recommendations
 */

const DAYS_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const DAY_ABBREV = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri' };

/**
 * Format recommendations into Telegram Markdown messages.
 * Splits into multiple messages if >4096 chars.
 */
export function formatRecommendations(recs, weekOf) {
  if (!recs || recs.length === 0) {
    return ['No recommendations available for this week.'];
  }

  const header = `*🍽 Lunch Picks — Week of ${weekOf}*\n_$20/day budget cap | 3 picks ranked by nutrition + longevity_\n`;
  const divider = '─────────────────────';

  // Group by day
  const byDay = {};
  for (const rec of recs) {
    if (!byDay[rec.day]) byDay[rec.day] = [];
    byDay[rec.day].push(rec);
  }
  // Sort each day by rank
  for (const dayRecs of Object.values(byDay)) {
    dayRecs.sort((a, b) => (a.rank || 1) - (b.rank || 1));
  }

  const dayBlocks = DAYS_ORDER.filter(d => byDay[d]).map(day => {
    return `*${day}*\n` + formatDayBlock(day, byDay[day]);
  });

  // Build full message and split if needed
  const fullText = header + '\n' + dayBlocks.join('\n' + divider + '\n');

  if (fullText.length <= 4096) {
    return [fullText];
  }

  // Split into multiple messages
  const messages = [];
  let current = header + '\n';

  for (const block of dayBlocks) {
    const addition = (current === header + '\n' ? '' : divider + '\n') + block;
    if ((current + addition).length > 4000) {
      messages.push(current.trim());
      current = block;
    } else {
      current += addition;
    }
  }
  if (current.trim()) {
    messages.push(current.trim());
  }

  return messages;
}

/**
 * Format a single day's recommendations into text block.
 * Shared between formatRecommendations and formatRecommendationsWithButtons.
 */
function formatDayBlock(day, dayRecs) {
  let block = '';
  for (const rec of dayRecs) {
    const rankLabel = `#${rec.rank || 1}`;
    const check = rec.rank === 1 ? ' ✅' : '';

    let comboItems = null;
    if (rec.combo_json) {
      try {
        comboItems = JSON.parse(rec.combo_json);
      } catch { /* fall back to single-item display */ }
    }

    if (comboItems && Array.isArray(comboItems) && comboItems.length > 0) {
      block += `${rankLabel}${check} *${rec.restaurant || 'Unknown'}*\n`;
      for (const item of comboItems) {
        const itemPrice = item.price ? `$${item.price.toFixed(2)}` : '';
        block += `  • ${item.name}${itemPrice ? ' — ' + itemPrice : ''}\n`;
      }
      block += `  Total: $${rec.price?.toFixed(2) || '?'} · Score: ${rec.overall_score?.toFixed(1) || '?'}/10\n`;
    } else {
      const price = rec.price ? `$${rec.price.toFixed(2)}` : '—';
      block += `${rankLabel}${check} *${rec.item_name}*`;
      if (rec.restaurant) block += ` — _${rec.restaurant}_`;
      block += `\n  ${price} · Score: ${rec.overall_score?.toFixed(1) || '?'}/10\n`;
    }

    if (rec.rank === 1 && rec.reasoning) {
      block += `  ${rec.reasoning}\n`;
    }
    block += '\n';
  }
  return block;
}

/**
 * Format recommendations with inline order buttons, one message per day.
 * Returns [{ day, text, buttons }] — each entry becomes one Telegram message.
 *
 * @param {Array} recs - Recommendation rows from DB
 * @param {string} weekOf - Week identifier (YYYY-MM-DD Monday)
 * @param {Map<string,number>} existingOrders - Map of day → confirmed rank
 * @returns {Array<{day: string, text: string, buttons: Array<{text: string, callbackData: string}>}>}
 */
export function formatRecommendationsWithButtons(recs, weekOf, existingOrders = new Map()) {
  if (!recs || recs.length === 0) return [];

  // Group by day
  const byDay = {};
  for (const rec of recs) {
    if (!byDay[rec.day]) byDay[rec.day] = [];
    byDay[rec.day].push(rec);
  }
  for (const dayRecs of Object.values(byDay)) {
    dayRecs.sort((a, b) => (a.rank || 1) - (b.rank || 1));
  }

  return DAYS_ORDER.filter(d => byDay[d]).map(day => {
    const dayRecs = byDay[day];
    const abbrev = DAY_ABBREV[day];
    const confirmedRank = existingOrders.get(day);

    let header = `*${day}*`;
    if (confirmedRank != null) {
      header += ` [CONFIRMED #${confirmedRank}]`;
    }
    header += '\n';

    const text = header + formatDayBlock(day, dayRecs);

    // If already confirmed, no buttons
    const buttons = confirmedRank != null ? [] : dayRecs.map(rec => ({
      text: `Order #${rec.rank || 1}`,
      callbackData: `lo:${weekOf}:${abbrev}:${rec.rank || 1}`,
    }));

    return { day, text, buttons };
  });
}

/**
 * Format raw menu items for display.
 */
export function formatMenu(items, day) {
  if (!items || items.length === 0) {
    return day ? `No menu items found for ${day}.` : 'No menu items found for this week.';
  }

  const header = day ? `*Menu for ${day}:*\n` : '*This Week\'s Menu:*\n';

  // Group by day
  const byDay = {};
  for (const item of items) {
    if (!byDay[item.day]) byDay[item.day] = [];
    byDay[item.day].push(item);
  }

  const sections = [];
  for (const d of DAYS_ORDER) {
    if (!byDay[d]) continue;
    let section = day ? '' : `\n*${d}*\n`;
    for (const item of byDay[d]) {
      const price = item.price ? ` — $${item.price.toFixed(2)}` : '';
      const restaurant = item.restaurant ? ` _(${item.restaurant})_` : '';
      section += `• ${item.item_name}${restaurant}${price}\n`;
      if (item.description) {
        section += `  ${item.description}\n`;
      }
    }
    sections.push(section);
  }

  return header + sections.join('');
}
