/**
 * Hevy API client
 *
 * Official API with api-key header. Requires Hevy Pro.
 * Docs: https://api.hevyapp.com/docs
 */

const BASE_URL = 'https://api.hevyapp.com/v1';

function getApiKey() {
  const key = process.env.HEVY_API_KEY;
  if (!key) throw new Error('HEVY_API_KEY not set');
  return key;
}

function headers() {
  return {
    'api-key': getApiKey(),
    'Content-Type': 'application/json',
  };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hevy API ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Hevy API POST ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// ─── Workouts ───────────────────────────────────────────────────────────────

/**
 * Fetch recent workouts with pagination.
 * @param {number} page - 1-based page number
 * @param {number} pageSize - items per page (max 10)
 */
export async function getWorkouts(page = 1, pageSize = 10) {
  return apiGet('/workouts', { page, pageSize });
}

/**
 * Fetch all workouts within a date range.
 * Hevy API paginates, so we fetch until we're past the start date.
 */
export async function getWorkoutsInRange(startDate, endDate) {
  const workouts = [];
  let page = 1;
  let done = false;

  while (!done) {
    const data = await getWorkouts(page, 10);
    if (!data.workouts || data.workouts.length === 0) break;

    for (const w of data.workouts) {
      const wDate = w.start_time?.slice(0, 10);
      if (!wDate) continue;
      if (wDate < startDate) { done = true; break; }
      if (wDate <= endDate) workouts.push(w);
    }

    if (data.page >= data.page_count) break;
    page++;
  }

  return workouts;
}

/**
 * Fetch ALL workouts from Hevy history (paginated, no date filter).
 */
export async function getAllWorkouts() {
  const workouts = [];
  let page = 1;
  while (true) {
    const data = await getWorkouts(page, 10);
    if (!data.workouts?.length) break;
    workouts.push(...data.workouts);
    if (data.page >= data.page_count) break;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }
  return workouts;
}

/**
 * Get workout count.
 */
export async function getWorkoutCount() {
  return apiGet('/workouts/count');
}

/**
 * Create a workout in Hevy.
 * @param {object} workout - Hevy workout payload
 */
export async function createWorkout(workout) {
  return apiPost('/workouts', { workout: { is_private: true, ...workout } });
}

// ─── Exercise Templates ─────────────────────────────────────────────────────

/**
 * Fetch a page of exercise templates.
 */
export async function getExerciseTemplates(page = 1, pageSize = 10) {
  return apiGet('/exercise_templates', { page, pageSize });
}

/**
 * Fetch a single exercise template by ID.
 */
export async function getExerciseTemplateById(id) {
  return apiGet(`/exercise_templates/${id}`);
}

/**
 * Fetch ALL exercise templates (paginated, pageSize=100).
 */
export async function fetchAllExerciseTemplates() {
  const templates = [];
  let page = 1;
  while (true) {
    const data = await getExerciseTemplates(page, 100);
    if (!data.exercise_templates?.length) break;
    templates.push(...data.exercise_templates);
    if (data.page >= data.page_count) break;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }
  return templates;
}

// ─── Routines ───────────────────────────────────────────────────────────────

export async function getRoutines(page = 1, pageSize = 10) {
  return apiGet('/routines', { page, pageSize });
}

/**
 * Create a routine in Hevy (for live tracking).
 * @param {object} routine - Hevy routine payload (title, notes, exercises)
 */
export async function createRoutine(routine) {
  return apiPost('/routines', { routine: { notes: 'Workout routine', folder_id: null, ...routine } });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract exercise template IDs from workout history and fetch missing templates.
 * @param {Array} workouts - Array of Hevy workout objects
 * @param {Function} getTemplate - fn(id) → template or null (from DB cache)
 * @param {Function} saveTemplate - fn(template) → void (save to DB cache)
 */
export async function syncTemplatesFromWorkouts(workouts, getTemplate, saveTemplate) {
  const templateIds = new Set();

  for (const w of workouts) {
    for (const ex of (w.exercises || [])) {
      if (ex.exercise_template_id) {
        templateIds.add(ex.exercise_template_id);
      }
    }
  }

  let fetched = 0;
  for (const id of templateIds) {
    const cached = getTemplate(id);
    if (cached) continue;

    try {
      const data = await getExerciseTemplateById(id);
      if (data && data.id) {
        saveTemplate({
          id: data.id,
          title: data.title,
          muscle_group: data.primary_muscle_group || null,
          equipment: data.equipment || null,
        });
        fetched++;
      }
    } catch (err) {
      // Skip failed fetches — will retry next sync
    }

    // Rate limit courtesy
    if (fetched > 0 && fetched % 5 === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return { total: templateIds.size, fetched };
}

/**
 * Parse a Hevy workout into a simplified format for caching.
 */
export function parseWorkoutForCache(workout) {
  const exercises = (workout.exercises || []).map(ex => ({
    template_id: ex.exercise_template_id,
    title: ex.title || 'Unknown',
    sets: (ex.sets || []).map(s => ({
      type: s.type,
      weight_kg: s.weight_kg,
      reps: s.reps,
      distance_meters: s.distance_meters,
      duration_seconds: s.duration_seconds,
      rpe: s.rpe,
    })),
  }));

  return {
    id: workout.id,
    date: workout.start_time?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    title: workout.title || 'Workout',
    exercises_json: exercises,
    duration_seconds: workout.end_time && workout.start_time
      ? Math.round((new Date(workout.end_time) - new Date(workout.start_time)) / 1000)
      : null,
  };
}
