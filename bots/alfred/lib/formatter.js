/**
 * Telegram message formatter for lunch recommendations
 */

const DAYS_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

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
    const dayRecs = byDay[day];
    let block = `*${day}*\n`;

    for (const rec of dayRecs) {
      const rankLabel = `#${rec.rank || 1}`;
      const check = rec.rank === 1 ? ' ✅' : '';

      // Try to display combo items if combo_json exists
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

      // Reasoning only on #1
      if (rec.rank === 1 && rec.reasoning) {
        block += `  ${rec.reasoning}\n`;
      }
      block += '\n';
    }

    return block;
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
