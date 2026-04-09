/**
 * Brain tool: adjust_workout
 *
 * Modify the proposed workout (e.g. swap exercises, change volume).
 * Stores the adjustment in the shared store for the callback handler.
 */
import { z } from 'zod';

export default {
  name: 'adjust_workout',
  description: 'Adjust the proposed workout. Describe changes and the brain will generate an updated workout card.',
  schema: {
    adjustment: z.string().describe('Description of the adjustment (e.g. "swap squats for leg press", "reduce to 3 sets each", "add face pulls")'),
  },
  async execute(args, ctx) {
    // Store the adjustment request — the brain will use this context
    // to regenerate the workout with modifications
    return `Adjustment noted: "${args.adjustment}". I'll modify the workout accordingly. Use get_current_program and get_recovery_data to regenerate with these changes.`;
  },
};
