/**
 * Exercise pool construction + approval-state helpers.
 *
 * Purpose: enforce the constraint that Opus may only design programs from
 * exercises Mark has actually done in Hevy (USED set), or from a focused
 * RELEVANT_HEVY pool that requires explicit per-exercise approval before use.
 *
 * State lives in bot_state JSON:
 *   - approved_exercises: [{template_id, approved_at, used_at|null}]
 *     - approved_at: ms timestamp when /approve added it
 *     - used_at: ms timestamp when morning_workout's Hevy push actually logged it
 *       (null until that happens; triggers TTL pruning if never set)
 *   - pending_program: {program, novelList[], droppedList[], createdAt, ...}
 *     (managed by program-designer + commands/approve + commands/cancel)
 */
import { ensureDb, getState, setState } from './db.js';

// ─── Tunables ────────────────────────────────────────────────────────────────

export const APPROVED_TTL_DAYS = 30;
export const MAX_RELEVANT = 120;
export const PENDING_TTL_HOURS = 24;
export const ESSENTIAL_MUSCLE_GROUPS = new Set(['abdominals', 'calves']);

// ─── USED pool ───────────────────────────────────────────────────────────────

/**
 * Return all exercises Mark has actually done in Hevy, deduped by template_id.
 * Each row: {template_id, title, muscle_group, equipment, usage_count}
 *
 * Filters out entries with null/empty template_id (pre-Hevy manual workouts).
 * Skips and logs malformed exercises_json rows.
 */
export function getUsedExercises(config, log = console) {
  const db = ensureDb(config);
  const workoutRows = db.prepare('SELECT exercises_json FROM workout_cache').all();

  const counts = new Map(); // template_id -> usage_count
  for (const row of workoutRows) {
    if (!row.exercises_json) continue;
    let exercises;
    try {
      exercises = JSON.parse(row.exercises_json);
    } catch (err) {
      log.warn?.(`getUsedExercises: skipping malformed exercises_json (${err.message})`);
      continue;
    }
    if (!Array.isArray(exercises)) continue;
    for (const ex of exercises) {
      if (!ex?.template_id) continue; // pre-Hevy null IDs
      counts.set(ex.template_id, (counts.get(ex.template_id) || 0) + 1);
    }
  }

  if (counts.size === 0) return [];

  // Enrich with template metadata in one query
  const ids = [...counts.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const tmplRows = db.prepare(
    `SELECT id, title, muscle_group, equipment FROM exercise_templates WHERE id IN (${placeholders})`
  ).all(...ids);
  const tmplById = new Map(tmplRows.map((t) => [t.id, t]));

  const used = ids.map((id) => {
    const t = tmplById.get(id);
    return {
      template_id: id,
      title: t?.title || null,
      muscle_group: t?.muscle_group || null,
      equipment: t?.equipment || null,
      usage_count: counts.get(id),
    };
  }).filter((row) => row.title !== null); // drop entries whose template no longer exists

  used.sort((a, b) => b.usage_count - a.usage_count);
  return used;
}

// ─── Approved (novel-but-Mark-said-yes) pool ─────────────────────────────────

/**
 * Read approved_exercises, lazy-prune stale entries (>TTL with no used_at).
 * Returns array of active template_ids.
 *
 * Backwards compat: if the stored value is the old string-array form
 * `["id1","id2"]`, migrates it on first read to object form.
 */
export function getApprovedExercises(config, log = console) {
  const db = ensureDb(config);
  const raw = getState(config, 'approved_exercises');
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn?.(`getApprovedExercises: malformed JSON (${err.message}) — resetting to []`);
    setState(config, 'approved_exercises', '[]');
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.warn?.('getApprovedExercises: value not an array — resetting');
    setState(config, 'approved_exercises', '[]');
    return [];
  }

  // Migrate string-array → object-array
  const now = Date.now();
  let migrated = false;
  const entries = parsed.map((item) => {
    if (typeof item === 'string') {
      migrated = true;
      return { template_id: item, approved_at: now, used_at: null };
    }
    return item;
  }).filter((e) => e && typeof e.template_id === 'string');

  const ttlMs = APPROVED_TTL_DAYS * 86400_000;
  const before = entries.length;
  const active = entries.filter((e) => {
    if (e.used_at) return true;            // ever used → keep forever (until next prune cycle if unused again — TBD)
    return (now - (e.approved_at || 0)) < ttlMs;
  });

  if (migrated || active.length !== before) {
    // Persist the cleaned/migrated version
    db.transaction(() => {
      setState(config, 'approved_exercises', JSON.stringify(active));
    })();
  }

  return active.map((e) => e.template_id);
}

/**
 * Add template_ids to approved_exercises. Dedupes against existing entries.
 * Wrapped in db.transaction to be safe against cron-vs-approve races.
 */
export function addApprovedExercises(config, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const db = ensureDb(config);
  const now = Date.now();

  db.transaction(() => {
    const raw = getState(config, 'approved_exercises');
    let entries = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          entries = parsed
            .map((item) => (typeof item === 'string'
              ? { template_id: item, approved_at: now, used_at: null }
              : item))
            .filter((e) => e && typeof e.template_id === 'string');
        }
      } catch { /* fall through to []*/ }
    }

    const existing = new Set(entries.map((e) => e.template_id));
    for (const id of ids) {
      if (!existing.has(id)) {
        entries.push({ template_id: id, approved_at: now, used_at: null });
        existing.add(id);
      }
    }
    setState(config, 'approved_exercises', JSON.stringify(entries));
  })();
}

/**
 * Mark an approved exercise as actually used (called when a workout is
 * successfully pushed to Hevy containing this exercise).
 *
 * Idempotent: if already used_at, leaves it alone. No-op if id not in list.
 */
export function markApprovedExerciseUsed(config, templateId) {
  if (!templateId) return;
  const db = ensureDb(config);
  const now = Date.now();

  db.transaction(() => {
    const raw = getState(config, 'approved_exercises');
    if (!raw) return;
    let entries;
    try {
      entries = JSON.parse(raw);
    } catch { return; }
    if (!Array.isArray(entries)) return;

    let changed = false;
    const updated = entries.map((e) => {
      if (typeof e === 'string') {
        // legacy string form — promote + check
        const obj = { template_id: e, approved_at: now, used_at: null };
        if (e === templateId) { obj.used_at = now; changed = true; }
        return obj;
      }
      if (e.template_id === templateId && !e.used_at) {
        changed = true;
        return { ...e, used_at: now };
      }
      return e;
    });
    if (changed) setState(config, 'approved_exercises', JSON.stringify(updated));
  })();
}

// ─── RELEVANT_HEVY pool ──────────────────────────────────────────────────────

/**
 * Templates from exercise_templates that share a muscle group with USED
 * exercises (plus essentials: abdominals, calves), and are NOT already in USED.
 *
 * Capped at MAX_RELEVANT — if exceeded, samples randomly to keep prompts small.
 */
export function getRelevantHevyTemplates(config, used) {
  const db = ensureDb(config);
  const usedIds = new Set(used.map((u) => u.template_id));
  const usedMuscles = new Set();
  for (const u of used) {
    if (u.muscle_group) usedMuscles.add(u.muscle_group);
  }
  for (const m of ESSENTIAL_MUSCLE_GROUPS) usedMuscles.add(m);

  if (usedMuscles.size === 0) return [];

  const placeholders = [...usedMuscles].map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, title, muscle_group, equipment
     FROM exercise_templates
     WHERE muscle_group IN (${placeholders})
     ORDER BY title`
  ).all(...usedMuscles);

  const filtered = rows.filter((r) => !usedIds.has(r.id));

  if (filtered.length <= MAX_RELEVANT) return filtered;

  // Random sample (deterministic-ish — sort then take stride for stability across calls)
  const stride = Math.ceil(filtered.length / MAX_RELEVANT);
  const sampled = [];
  for (let i = 0; i < filtered.length && sampled.length < MAX_RELEVANT; i += stride) {
    sampled.push(filtered[i]);
  }
  return sampled;
}

// ─── Runtime allowlist filter (session-generation time) ─────────────────────

/**
 * Filter a list of exercises (from an active program's weekly_template) down
 * to ONLY those Mark has actually done (USED) or has explicitly approved
 * (approved_exercises with active TTL).
 *
 * This is the second-layer constraint that complements the program-design
 * layer. designProgram() already filters Opus's picks, but pre-existing
 * programs in `training_programs` may contain novels from before the
 * constraint shipped. This filter prevents those novels from reaching the
 * daily-session generator (cron/morning-workout.js::generateAdaptedWorkout).
 *
 * @param {object} config       — bot config (for DB access)
 * @param {Array}  exercises    — list of {name, template_id?, ...} from program JSON
 * @param {object} [log]        — optional logger
 * @returns {{kept: Array, dropped: Array<{name, reason}>}}
 */
export function filterToAllowedExercises(config, exercises, log = console) {
  if (!Array.isArray(exercises) || exercises.length === 0) {
    return { kept: [], dropped: [] };
  }

  const used = getUsedExercises(config, log);
  const approved = getApprovedExercises(config, log);
  const allowed = new Set([
    ...used.map((u) => u.template_id),
    ...approved,
  ]);

  // Lazily build the templates list only if we encounter exercises without
  // template_id (legacy program JSON). Resolves them by name.
  let allTemplates = null;
  const usedTemplates = used.map((u) => ({
    id: u.template_id,
    title: u.title,
    muscle_group: u.muscle_group,
    equipment: u.equipment,
  }));

  const kept = [];
  const dropped = [];

  for (const ex of exercises) {
    if (!ex || typeof ex !== 'object') continue;

    // Fast path: explicit template_id is in the allowed set
    if (ex.template_id && allowed.has(ex.template_id)) {
      kept.push(ex);
      continue;
    }

    // Legacy path: no template_id — resolve by name against USED templates
    if (!ex.template_id) {
      const db = ensureDb(config);
      if (allTemplates === null) {
        allTemplates = db.prepare(
          'SELECT id, title, muscle_group, equipment FROM exercise_templates'
        ).all();
      }
      // Prefer matching to USED first
      const match = usedTemplates.find((t) => t.title === ex.name)
                 || allTemplates.find((t) => t.title === ex.name);
      if (match && allowed.has(match.id)) {
        kept.push({ ...ex, template_id: match.id });
        continue;
      }
    }

    dropped.push({ name: ex.name, reason: 'not in USED or approved set' });
  }

  if (dropped.length > 0) {
    log.info?.(`filterToAllowedExercises: kept ${kept.length}, dropped ${dropped.length} (${dropped.map((d) => d.name).join(', ')})`);
  }

  return { kept, dropped };
}

// ─── Prompt formatting ───────────────────────────────────────────────────────

export function formatExercisePoolsForPrompt(used, relevantHevy) {
  const lines = [];
  lines.push('## USED (free to pick — Mark has done these):');
  if (used.length === 0) {
    lines.push('  (none — Mark has no Hevy workout history yet)');
  } else {
    for (const u of used) {
      const parts = [u.title];
      const mg = [u.muscle_group, u.equipment].filter(Boolean).join('/');
      if (mg) parts.push(`(${mg})`);
      parts.push(`— used ${u.usage_count}×`);
      lines.push(`  - ${parts.join(' ')}`);
    }
  }
  lines.push('');
  lines.push('## RELEVANT_HEVY (asks user first — fine to pick if needed):');
  if (relevantHevy.length === 0) {
    lines.push('  (none in matching muscle groups)');
  } else {
    for (const r of relevantHevy) {
      const mg = [r.muscle_group, r.equipment].filter(Boolean).join('/');
      lines.push(`  - ${r.title}${mg ? ` (${mg})` : ''}`);
    }
  }
  return lines.join('\n');
}

// ─── History analysis ────────────────────────────────────────────────────────

/**
 * Build a one-paragraph summary of Mark's recent training:
 * top exercises by total volume, frequency by muscle group.
 * Returns "" on empty/all-corrupted input.
 */
export function buildHistoryAnalysisBlock(workouts) {
  if (!Array.isArray(workouts) || workouts.length === 0) return '';

  const volumeByEx = new Map(); // exercise title -> total kg*reps
  const freqByMuscle = new Map(); // muscle_group -> session count
  const muscleByEx = new Map();

  for (const w of workouts) {
    if (!w?.exercises_json) continue;
    let exs;
    try {
      exs = JSON.parse(w.exercises_json);
    } catch { continue; }
    if (!Array.isArray(exs)) continue;

    const musclesThisWorkout = new Set();
    for (const ex of exs) {
      const title = ex?.title;
      if (!title) continue;
      const sets = Array.isArray(ex.sets) ? ex.sets : [];
      let vol = 0;
      for (const s of sets) {
        const w = Number(s?.weight_kg) || 0;
        const r = Number(s?.reps) || 0;
        vol += w * r;
      }
      volumeByEx.set(title, (volumeByEx.get(title) || 0) + vol);
      if (ex.muscle_group) {
        musclesThisWorkout.add(ex.muscle_group);
        muscleByEx.set(title, ex.muscle_group);
      }
    }
    for (const m of musclesThisWorkout) {
      freqByMuscle.set(m, (freqByMuscle.get(m) || 0) + 1);
    }
  }

  if (volumeByEx.size === 0) return '';

  const top5 = [...volumeByEx.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([title, vol]) => `${title} (${Math.round(vol)}kg vol)`);

  const muscles = [...freqByMuscle.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m}: ${n}×`);

  const parts = [`Top 5 exercises by volume: ${top5.join(', ')}.`];
  if (muscles.length > 0) {
    parts.push(`Muscle-group frequency (last ${workouts.length} workouts): ${muscles.join(', ')}.`);
  }
  return parts.join(' ');
}

// ─── Approval parsing ────────────────────────────────────────────────────────

/**
 * Parse Mark's /approve reply.
 *   "1, 3"            → { indices: Set{1,3} }
 *   "all" / "yes"     → { indices: Set{1..total} }
 *   "none" / "no"     → { indices: Set{} }
 *   "1-3"             → { indices: Set{1,2,3} }
 *   "I have 1 and 3"  → { indices: Set{1,3} }
 *   "1, 99" (out)     → { error: 'out_of_range', invalid: [99] }
 *   "garbage"         → { error: 'unparseable' }
 *   "-1" alone        → { error: 'unparseable' }  (standalone negatives ignored)
 */
export function parseApproval(text, total) {
  if (typeof text !== 'string') return { error: 'unparseable' };
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '') return { error: 'unparseable' };

  if (trimmed === 'all' || trimmed === 'yes') {
    const indices = new Set();
    for (let i = 1; i <= total; i++) indices.add(i);
    return { indices };
  }
  if (trimmed === 'none' || trimmed === 'no') {
    return { indices: new Set() };
  }

  // Extract ranges (\d+-\d+) and singletons (standalone \d+)
  const indices = new Set();
  const invalid = [];

  // Ranges first
  const rangeRe = /(\d+)\s*-\s*(\d+)/g;
  let m;
  let consumed = trimmed;
  while ((m = rangeRe.exec(trimmed)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) {
      if (i >= 1 && i <= total) indices.add(i);
      else if (i >= 1) invalid.push(i);
    }
    consumed = consumed.replace(m[0], ' ');
  }

  // Singletons — accept \d+ that is NOT preceded by '-' (avoids negatives)
  const singleRe = /(?<![\d-])\d+/g;
  let s;
  while ((s = singleRe.exec(consumed)) !== null) {
    const n = parseInt(s[0], 10);
    if (!Number.isFinite(n)) continue;
    if (n >= 1 && n <= total) indices.add(n);
    else if (n >= 1) invalid.push(n);
  }

  if (indices.size === 0 && invalid.length === 0) {
    return { error: 'unparseable' };
  }
  if (invalid.length > 0) {
    return { error: 'out_of_range', invalid: [...new Set(invalid)].sort((a, b) => a - b) };
  }
  return { indices };
}

// ─── Substitution ────────────────────────────────────────────────────────────

/**
 * Find a substitute for a rejected novel exercise.
 *
 * Strategy: pick the USED exercise that shares the same muscle group, ordered
 * by usage_count (most-used wins).
 *
 * Returns {template_id, title} or null.
 *
 * Does NOT fall back to RELEVANT_HEVY — that would just introduce another novel
 * pick. If no USED match exists, the caller decides (drop or re-design).
 */
export function findMuscleGroupSubstitute(rejectedTemplateId, muscleGroup, used) {
  if (!muscleGroup) return null;
  const candidates = used
    .filter((u) => u.template_id !== rejectedTemplateId && u.muscle_group === muscleGroup);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.usage_count - a.usage_count);
  return { template_id: candidates[0].template_id, title: candidates[0].title };
}

// ─── pending_program helpers ─────────────────────────────────────────────────

/**
 * Read bot_state.pending_program, return parsed object or null.
 * Auto-deletes if older than PENDING_TTL_HOURS.
 */
export function getPendingProgram(config, log = console) {
  const raw = getState(config, 'pending_program');
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn?.(`getPendingProgram: malformed JSON (${err.message}) — clearing`);
    setState(config, 'pending_program', '');
    return null;
  }
  const ttlMs = PENDING_TTL_HOURS * 3600_000;
  if (parsed.createdAt && (Date.now() - parsed.createdAt) > ttlMs) {
    log.info?.('getPendingProgram: stale (>24h), deleting');
    clearPendingProgram(config);
    return null;
  }
  return parsed;
}

export function setPendingProgram(config, payload) {
  const db = ensureDb(config);
  db.transaction(() => {
    setState(config, 'pending_program', JSON.stringify(payload));
  })();
}

export function clearPendingProgram(config) {
  const db = ensureDb(config);
  db.transaction(() => {
    db.prepare('DELETE FROM bot_state WHERE key = ?').run('pending_program');
  })();
}
