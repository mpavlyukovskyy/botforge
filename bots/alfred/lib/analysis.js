/**
 * 3-agent health analysis pipeline
 *
 * Sequential Sonnet calls:
 * 1. Nutritionist — scores macros, fiber, sodium, protein quality
 * 2. Longevity researcher — anti-inflammatory, glycemic, Blue Zone alignment
 * 3. Budget optimizer — best pick per day within $20 budget
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

const MIN_ITEM_SCORE = 5;

// High-precision patterns only — no false positives on legitimate food
const JUNK_PATTERNS = [
  /\bcookie/i, /\bbrownie/i, /\bcupcake/i, /\bdonut/i, /\bdoughnut/i,
  /\bice cream/i, /\bgelato/i, /\bsundae/i, /\bchurro/i,
  /\bcinnamon roll/i, /\bcheesecake/i, /\bmilkshake/i, /\bfudge/i,
];

let _client;

function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * Stage 1: Remove obvious junk before any agent sees it.
 * Gate A: tagged ["Desserts"], Gate B: name matches JUNK_PATTERNS.
 */
function preFilterMenu(menuItems) {
  return menuItems.filter(item => {
    const tags = item.tags || [];
    if (tags.some(t => t.toLowerCase() === 'desserts')) return false;
    if (JUNK_PATTERNS.some(p => p.test(item.name))) return false;
    return true;
  });
}

/**
 * Merge Agent 1 + Agent 2 scores into a lookup map keyed by "day||item_name" (lowercased, trimmed).
 */
function mergeScores(nutritionScores, longevityScores) {
  const map = {};
  for (const s of nutritionScores) {
    const key = `${(s.day || '').toLowerCase().trim()}||${(s.item_name || '').toLowerCase().trim()}`;
    if (!map[key]) map[key] = {};
    map[key].nutrition = s.nutrition_score || 0;
  }
  for (const s of longevityScores) {
    const key = `${(s.day || '').toLowerCase().trim()}||${(s.item_name || '').toLowerCase().trim()}`;
    if (!map[key]) map[key] = {};
    map[key].longevity = s.longevity_score || 0;
  }
  return map;
}

/**
 * Stage 2: Remove items scoring below MIN_ITEM_SCORE on either dimension.
 * Also filters the score arrays to match.
 */
function scoreFilter(items, mergedScores, nutritionScores, longevityScores) {
  const passingKeys = new Set();
  for (const item of items) {
    const key = `${(item.day || '').toLowerCase().trim()}||${(item.name || '').toLowerCase().trim()}`;
    const scores = mergedScores[key];
    if (!scores) {
      passingKeys.add(key);
    } else {
      const nutritionOk = !('nutrition' in scores) || scores.nutrition >= MIN_ITEM_SCORE;
      const longevityOk = !('longevity' in scores) || scores.longevity >= MIN_ITEM_SCORE;
      if (nutritionOk && longevityOk) {
        passingKeys.add(key);
      }
    }
  }

  const filteredItems = items.filter(item => {
    const key = `${(item.day || '').toLowerCase().trim()}||${(item.name || '').toLowerCase().trim()}`;
    return passingKeys.has(key);
  });

  const filteredNutrition = nutritionScores.filter(s => {
    const key = `${(s.day || '').toLowerCase().trim()}||${(s.item_name || '').toLowerCase().trim()}`;
    return passingKeys.has(key);
  });

  const filteredLongevity = longevityScores.filter(s => {
    const key = `${(s.day || '').toLowerCase().trim()}||${(s.item_name || '').toLowerCase().trim()}`;
    return passingKeys.has(key);
  });

  return { filteredItems, filteredNutrition, filteredLongevity };
}

/**
 * Run the 3-agent analysis pipeline.
 * @param {Array} menuItems — items with { day, name, restaurant, price, description }
 * @param {number} budget — daily budget in dollars
 * @returns {Array} recommendations — one per day with scores + reasoning
 */
export async function analyzeMenu(menuItems, budget = 20) {
  const client = getClient();

  if (!menuItems || menuItems.length === 0) {
    return [];
  }

  // Stage 1: remove obvious junk before agents see it
  const preFiltered = preFilterMenu(menuItems);
  const menuText = formatMenuForPrompt(preFiltered);

  // ── Agent 1: Nutritionist ────────────────────────────────────────────────
  const nutritionResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    messages: [{
      role: 'user',
      content: `You are an expert nutritionist. Score each menu item 1-10 on nutritional quality.

Focus on scoring entrees, bowls, mains, and sides — skip appetizers and drinks if the list is very long.
COVERAGE: You MUST score items from EVERY restaurant listed for each day — at least 3-5 items per restaurant. Do not skip any restaurant entirely.

Consider: macronutrient balance, fiber content, sodium levels, protein quality, micronutrient density, added sugars, processing level.

Score desserts, cookies, brownies, pastries, and sugary drinks very low (1-3).

For each item, output a JSON array of objects with: { "day", "item_name", "nutrition_score" (1-10), "nutrition_notes" (one sentence) }

Menu items:
${menuText}

Output ONLY valid JSON, no other text.`,
    }],
  });

  let nutritionScores;
  try {
    const raw = nutritionResponse.content[0].text.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    nutritionScores = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    nutritionScores = [];
  }

  // ── Agent 2: Longevity Researcher ────────────────────────────────────────
  const longevityResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    messages: [{
      role: 'user',
      content: `You are a longevity researcher specializing in dietary patterns of centenarians. Score each menu item 1-10 on longevity promotion.

Focus on scoring entrees, bowls, mains, and sides — skip appetizers and drinks if the list is very long.
COVERAGE: You MUST score items from EVERY restaurant listed for each day — at least 3-5 items per restaurant. Do not skip any restaurant entirely.

Consider: anti-inflammatory properties, glycemic load, Blue Zone diet alignment (plants, legumes, whole grains, fish), polyphenol content, gut microbiome impact, absence of processed ingredients.

Score desserts, cookies, brownies, pastries, and sugary drinks very low (1-3) — they promote inflammation and glycemic spikes.

Previous nutritionist assessment:
${JSON.stringify(nutritionScores, null, 2)}

Menu items:
${menuText}

For each item, output a JSON array of objects with: { "day", "item_name", "longevity_score" (1-10), "longevity_notes" (one sentence) }

Output ONLY valid JSON, no other text.`,
    }],
  });

  let longevityScores;
  try {
    const raw = longevityResponse.content[0].text.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    longevityScores = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    longevityScores = [];
  }

  // ── Stage 2: Remove low-scoring items before Agent 3 ────────────────────
  const merged = mergeScores(nutritionScores, longevityScores);
  const { filteredItems, filteredNutrition, filteredLongevity } =
    scoreFilter(preFiltered, merged, nutritionScores, longevityScores);
  const filteredMenuText = formatMenuForPrompt(filteredItems);

  // ── Agent 3: Budget Optimizer (Combo Builder) ───────────────────────────
  const optimizerResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    messages: [{
      role: 'user',
      content: `You are a budget-conscious meal optimizer. Build up to 3 MEAL COMBINATIONS ranked by quality for each day (Monday-Friday).

Each combo = one main dish + 1-2 complementary items (side or drink).
NEVER include desserts, cookies, pastries, brownies, candy, ice cream, or sugary drinks. Every item must promote health.
All items in a combo MUST be from the SAME restaurant. ONLY use items from the provided menu. Do not invent items.

HARD BUDGET RULE: Each combo's total MUST NOT exceed $${budget}. Do NOT return any combo over $${budget}. Prioritize nutritional value over spending the full budget. A $14 healthy meal is BETTER than a $19 meal padded with low-quality items.

If fewer than 3 distinct quality combos exist for a day, return fewer. Never pad with low-quality options.

IMPORTANT: Scores are available for only a subset of menu items. Consider ALL items based on their ingredients and descriptions, not just items with pre-computed scores. An unscored item with excellent ingredients may be a better pick than a scored item.

Where scores exist, use them as supporting data (weight longevity 60%, nutrition 40%). For unscored items, assess nutrition and longevity value from the ingredient list yourself.

Nutrition scores:
${JSON.stringify(filteredNutrition, null, 2)}

Longevity scores:
${JSON.stringify(filteredLongevity, null, 2)}

Menu items (pre-filtered for health quality):
${filteredMenuText}

For each combo, output a JSON array of objects:
{
  "day": "Monday",
  "restaurant": "...",
  "items": [
    { "name": "Main Dish Name", "price": 12.99 },
    { "name": "Side Name", "price": 4.99 }
  ],
  "total_price": 17.98,
  "nutrition_score": 8.0,
  "longevity_score": 7.5,
  "overall_score": 7.7,
  "reasoning": "1-2 sentences"
}

Output ONLY valid JSON array, no other text.`,
    }],
  });

  let recommendations;
  try {
    const raw = optimizerResponse.content[0].text.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    recommendations = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    recommendations = [];
  }

  // Post-safety: remove any junk items Agent 3 may have hallucinated back in
  for (const rec of recommendations) {
    if (rec.items && Array.isArray(rec.items)) {
      rec.items = rec.items.filter(i => !JUNK_PATTERNS.some(p => p.test(i.name || '')));
    }
  }
  recommendations = recommendations.filter(rec =>
    rec.items && Array.isArray(rec.items) && rec.items.length > 0
  );

  // 1. Normalize: ensure combo_json, item_name, price fields
  for (const rec of recommendations) {
    if (rec.items && Array.isArray(rec.items)) {
      rec.combo_json = JSON.stringify(rec.items);
      rec.item_name = rec.items.map(i => i.name).join(' + ');
      rec.total_price = rec.total_price || rec.items.reduce((s, i) => s + (i.price || 0), 0);
      rec.price = rec.total_price;
    }
  }

  // 2. Filter over-budget combos
  const allRecs = [...recommendations];
  recommendations = recommendations.filter(rec => {
    const total = rec.total_price || rec.price || 0;
    return total <= budget;
  });

  // 3. Group by day, sort by score, assign rank 1-3
  const byDay = {};
  for (const rec of recommendations) {
    if (!byDay[rec.day]) byDay[rec.day] = [];
    byDay[rec.day].push(rec);
  }

  // If a day lost ALL combos to budget filter, keep the cheapest from raw output
  const allDays = [...new Set(allRecs.map(r => r.day))];
  for (const day of allDays) {
    if (!byDay[day]) {
      const dayCombos = allRecs.filter(r => r.day === day);
      dayCombos.sort((a, b) => (a.total_price || a.price || 999) - (b.total_price || b.price || 999));
      if (dayCombos.length > 0) {
        byDay[day] = [dayCombos[0]];
      }
    }
  }

  const ranked = [];
  for (const [day, dayRecs] of Object.entries(byDay)) {
    dayRecs.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
    dayRecs.slice(0, 3).forEach((rec, i) => {
      rec.rank = i + 1;
      ranked.push(rec);
    });
  }

  return ranked;
}

function formatMenuForPrompt(items) {
  // Group by day
  const byDay = {};
  for (const item of items) {
    const day = item.day || 'Unknown';
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(item);
  }

  const lines = [];
  for (const [day, dayItems] of Object.entries(byDay)) {
    lines.push(`\n## ${day}`);
    for (const item of dayItems) {
      const price = item.price ? `$${item.price.toFixed(2)}` : 'price unknown';
      const restaurant = item.restaurant ? ` (${item.restaurant})` : '';
      const desc = item.description ? ` — ${item.description}` : '';
      lines.push(`- ${item.name}${restaurant}: ${price}${desc}`);
    }
  }

  return lines.join('\n');
}
