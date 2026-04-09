/**
 * Brain tool: get_current_program
 *
 * Returns the active training program.
 */
import { z } from 'zod';
import { ensureDb, getActiveProgram } from '../lib/db.js';

export default {
  name: 'get_current_program',
  description: 'Get the currently active training program, including weekly template, current week, and progression info.',
  schema: {},
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const program = getActiveProgram(ctx.config);

    if (!program) {
      return 'No active training program. Use /program to design one.';
    }

    let programData;
    try {
      programData = JSON.parse(program.program_json);
    } catch {
      return 'Active program exists but has invalid data.';
    }

    const lines = [];
    lines.push(`Program: ${program.title}`);
    lines.push(`Week ${program.current_week} of ${program.total_weeks}`);
    lines.push(`Block: ${programData.block_name || 'N/A'}`);
    lines.push(`Split: ${programData.split || 'N/A'}`);
    lines.push(`Days/week: ${programData.days_per_week || 'N/A'}`);
    lines.push('');

    // Weekly template
    const template = programData.weekly_template || {};
    for (const [day, session] of Object.entries(template)) {
      const exercises = (session.exercises || [])
        .map(ex => `    - ${ex.name}: ${ex.sets}x${ex.rep_range}${ex.rpe_target ? ` @RPE${ex.rpe_target}` : ''}`)
        .join('\n');
      lines.push(`${day}: ${session.name}${session.focus ? ` (${session.focus})` : ''}`);
      if (exercises) lines.push(exercises);
    }

    if (programData.progression_notes) {
      lines.push(`\nProgression: ${programData.progression_notes}`);
    }
    if (programData.deload_protocol) {
      lines.push(`Deload: ${programData.deload_protocol}`);
    }

    return lines.join('\n');
  },
};
