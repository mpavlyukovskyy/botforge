#!/usr/bin/env node

/**
 * Hevy API Smoke Test
 *
 * Validates every Hevy API interaction the Trainer bot uses.
 * Standalone — no imports from bot code.
 *
 * Usage:
 *   HEVY_API_KEY=xxx node bots/trainer/scripts/hevy-smoke-test.js
 *   # or from botforge root with .env:
 *   source .env && node bots/trainer/scripts/hevy-smoke-test.js
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from botforge root if HEVY_API_KEY not already set
if (!process.env.HEVY_API_KEY) {
  try {
    const envPath = resolve(__dirname, '..', '..', '..', '.env');
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^HEVY_API_KEY=(.+)$/);
      if (match) {
        process.env.HEVY_API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
        break;
      }
    }
  } catch {
    // ignore
  }
}

const API_KEY = process.env.HEVY_API_KEY;
if (!API_KEY) {
  console.error('HEVY_API_KEY not set and not found in .env');
  process.exit(1);
}

const BASE = 'https://api.hevyapp.com/v1';
const headers = { 'api-key': API_KEY, 'Content-Type': 'application/json' };

let passed = 0;
let failed = 0;

function pass(name, detail) {
  passed++;
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}

function fail(name, detail) {
  failed++;
  console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
}

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers });
  const body = await res.text();
  return { status: res.status, data: JSON.parse(body) };
}

async function apiPost(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { data = body; }
  return { status: res.status, data };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

console.log('\nHevy API Smoke Test\n');

// Test 1: GET /workouts
console.log('1. GET /workouts (auth + response shape)');
let templateId;
try {
  const { status, data } = await apiGet('/workouts?page=1&pageSize=1');
  if (status !== 200) { fail('GET /workouts', `status ${status}`); }
  else if (!Array.isArray(data.workouts)) { fail('GET /workouts', `missing workouts array — got: ${JSON.stringify(Object.keys(data))}`); }
  else if (typeof data.page !== 'number' || typeof data.page_count !== 'number') { fail('GET /workouts', `missing page/page_count`); }
  else {
    pass('GET /workouts', `${data.workouts.length} workout(s), page ${data.page}/${data.page_count}`);
    // grab a template ID from first workout if available
    if (data.workouts[0]?.exercises?.[0]?.exercise_template_id) {
      templateId = data.workouts[0].exercises[0].exercise_template_id;
    }
  }
} catch (e) {
  fail('GET /workouts', e.message);
}

// Test 2: GET /exercise_templates (list)
console.log('2. GET /exercise_templates (list shape)');
let firstTemplateId;
try {
  const { status, data } = await apiGet('/exercise_templates?page=1&pageSize=1');
  if (status !== 200) { fail('GET /exercise_templates', `status ${status}`); }
  else if (!Array.isArray(data.exercise_templates)) { fail('GET /exercise_templates', `missing exercise_templates array — got: ${JSON.stringify(Object.keys(data))}`); }
  else {
    firstTemplateId = data.exercise_templates[0]?.id;
    pass('GET /exercise_templates', `${data.exercise_templates.length} template(s)`);
  }
} catch (e) {
  fail('GET /exercise_templates', e.message);
}

// Test 3: GET /exercise_templates/{id} (single template shape)
const testTemplateId = templateId || firstTemplateId;
console.log('3. GET /exercise_templates/{id} (flat object shape)');
if (!testTemplateId) {
  fail('GET /exercise_templates/{id}', 'no template ID available from previous tests');
} else {
  try {
    const { status, data } = await apiGet(`/exercise_templates/${testTemplateId}`);
    if (status !== 200) { fail('GET /exercise_templates/{id}', `status ${status}`); }
    else if (!data.id || !data.title) { fail('GET /exercise_templates/{id}', `missing id/title — got keys: ${JSON.stringify(Object.keys(data))}`); }
    else if (!('primary_muscle_group' in data)) { fail('GET /exercise_templates/{id}', `missing primary_muscle_group — got keys: ${JSON.stringify(Object.keys(data))}`); }
    else { pass('GET /exercise_templates/{id}', `"${data.title}" (${data.primary_muscle_group})`); }
  } catch (e) {
    fail('GET /exercise_templates/{id}', e.message);
  }
}

// Test 4: POST /workouts (create with is_private)
console.log('4. POST /workouts (create workout with is_private: true)');
let createdWorkoutId;
if (!testTemplateId) {
  fail('POST /workouts', 'no template ID for exercise — skipping');
} else {
  try {
    const now = new Date().toISOString();
    const endTime = new Date(Date.now() + 60000).toISOString();
    const smokeTitle = `Smoke Test ${Date.now()}`;
    const payload = {
      workout: {
        is_private: true,
        title: smokeTitle,
        start_time: now,
        end_time: endTime,
        exercises: [
          {
            exercise_template_id: testTemplateId,
            sets: [
              {
                type: 'normal',
                weight_kg: 20,
                reps: 10,
              },
            ],
          },
        ],
      },
    };

    const { status, data } = await apiPost('/workouts', payload);
    if (status === 201) {
      // Response may nest under data.workout or be flat
      createdWorkoutId = data.id || data.workout?.id;
      pass('POST /workouts', `status 201, response keys: ${JSON.stringify(Object.keys(data))}`);
    } else {
      fail('POST /workouts', `status ${status} — ${JSON.stringify(data)}`);
    }
  } catch (e) {
    fail('POST /workouts', e.message);
  }
}

// Test 5: Verify created workout appears in list
console.log('5. GET /workouts (verify created workout appears)');
try {
  // Small delay for API consistency
  await new Promise(r => setTimeout(r, 2000));
  const { status, data } = await apiGet('/workouts?page=1&pageSize=5');
  if (status !== 200) { fail('GET /workouts (verify)', `status ${status}`); }
  else {
    // Match by title (unique timestamp) or ID if we got one
    const found = data.workouts.find(w =>
      (createdWorkoutId && w.id === createdWorkoutId) || w.title?.startsWith('Smoke Test')
    );
    if (found) {
      pass('GET /workouts (verify)', `workout "${found.title}" (${found.id}) found in list`);
    } else {
      fail('GET /workouts (verify)', `smoke test workout not in first 5 results — titles: ${data.workouts.map(w => w.title).join(', ')}`);
    }
  }
} catch (e) {
  fail('GET /workouts (verify)', e.message);
}

// Test 6: POST /routines (create routine)
console.log('6. POST /routines (create routine for live tracking)');
let createdRoutineId;
if (!testTemplateId) {
  fail('POST /routines', 'no template ID for exercise — skipping');
} else {
  try {
    const smokeRoutineTitle = `Smoke Test Routine ${Date.now()}`;
    const payload = {
      routine: {
        title: smokeRoutineTitle,
        notes: 'Smoke test routine — safe to delete',
        folder_id: null,
        exercises: [
          {
            exercise_template_id: testTemplateId,
            sets: [
              {
                type: 'normal',
                weight_kg: 20,
                reps: 10,
              },
            ],
          },
        ],
      },
    };

    const { status, data } = await apiPost('/routines', payload);
    if (status === 201 || status === 200) {
      createdRoutineId = data.id || data.routine?.id;
      pass('POST /routines', `status ${status}, response keys: ${JSON.stringify(Object.keys(data))}`);
    } else {
      fail('POST /routines', `status ${status} — ${JSON.stringify(data)}`);
    }
  } catch (e) {
    fail('POST /routines', e.message);
  }
}

// Test 7: GET /routines (verify created routine appears)
console.log('7. GET /routines (verify created routine appears)');
try {
  await new Promise(r => setTimeout(r, 2000));
  const { status, data } = await apiGet('/routines?page=1&pageSize=5');
  if (status !== 200) { fail('GET /routines (verify)', `status ${status}`); }
  else {
    const routines = data.routines || [];
    const found = routines.find(r =>
      (createdRoutineId && r.id === createdRoutineId) || r.title?.startsWith('Smoke Test Routine')
    );
    if (found) {
      pass('GET /routines (verify)', `routine "${found.title}" (${found.id}) found in list`);
    } else {
      fail('GET /routines (verify)', `smoke test routine not in first 5 results — titles: ${routines.map(r => r.title).join(', ')}`);
    }
  }
} catch (e) {
  fail('GET /routines (verify)', e.message);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (createdWorkoutId) {
  console.log(`\nNote: A "Smoke Test" workout (${createdWorkoutId}) was created in your Hevy history.`);
}
if (createdRoutineId) {
  console.log(`Note: A "Smoke Test Routine" (${createdRoutineId}) was created in your Hevy routines.`);
}
console.log('');

process.exit(failed > 0 ? 1 : 0);
