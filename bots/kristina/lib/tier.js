/**
 * Priority tiers — Mark's prioritization lever (Phase A).
 *
 * In Phase A a tier is a SEQUENCING signal only: it ranks the board and the
 * "Today's Top 3", but does NOT multiply earnedValue (no money change). The
 * weights here double as the future money multipliers, but Phase A uses them
 * solely for ordering. Tier is Mark-only — non-admins are clamped to STANDARD.
 */
export const TIERS = ['ROUTINE', 'STANDARD', 'IMPORTANT', 'P0'];

// Weight used for WSJF-style ranking (and, later, the money multiplier).
export const TIER_WEIGHT = { ROUTINE: 0.5, STANDARD: 1, IMPORTANT: 3, P0: 8 };

/** Canonicalize free-form tier input; default/invalid → STANDARD. */
export function normalizeTier(input) {
  if (!input) return 'STANDARD';
  const s = String(input).trim().toUpperCase().replace(/[\s-]+/g, '');
  if (s === 'P0' || s === 'DROPEVERYTHING' || s === 'URGENT' || s === 'CRITICAL') return 'P0';
  if (s === 'IMPORTANT' || s === 'HIGH' || s === 'P1') return 'IMPORTANT';
  if (s === 'ROUTINE' || s === 'LOW' || s === 'WHENEVER' || s === 'P3') return 'ROUTINE';
  if (s === 'STANDARD' || s === 'NORMAL' || s === 'P2') return 'STANDARD';
  return 'STANDARD';
}

/**
 * WSJF-style rank score for a board item: priority weight + urgency from the
 * deadline (overdue/sooner = higher). Higher score = work it first.
 */
export function rankScore(item, now = new Date()) {
  const weight = TIER_WEIGHT[item.priorityTier || item.priority_tier || 'STANDARD'] ?? 1;
  let urgency = 0;
  if (item.deadline) {
    const due = new Date(item.deadline);
    if (!isNaN(due.getTime())) {
      const hoursLeft = (due.getTime() - now.getTime()) / 3.6e6;
      if (hoursLeft <= 0) urgency = 3;          // overdue → most urgent
      else if (hoursLeft <= 24) urgency = 2;    // due within a day
      else if (hoursLeft <= 72) urgency = 1;    // due within 3 days
      else urgency = 0.5;
    }
  }
  return weight * (1 + urgency);
}

/** Short tag for board display, e.g. "‼️P0" / "★IMP". Empty for STANDARD. */
export function tierTag(tier) {
  switch (tier) {
    case 'P0': return '‼️P0';
    case 'IMPORTANT': return '★IMP';
    case 'ROUTINE': return '·routine';
    default: return '';
  }
}
