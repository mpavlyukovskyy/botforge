/**
 * Brain tool: move_product (STUB — deferred to Phase 9)
 *
 * Moving a product between sections requires investigation of the
 * edit form to confirm whether a section dropdown exists.
 */
import { z } from 'zod';

export default {
  name: 'move_product',
  description: 'Move a product to a different section. NOTE: This feature is not yet implemented — the CleanCloud edit form needs investigation to confirm section dropdown availability.',
  schema: {
    product_id: z.string().describe('Product ID to move'),
    target_section_id: z.string().describe('Target section ID'),
  },
  async execute(args, ctx) {
    return 'move_product is not yet implemented. The CleanCloud edit form needs investigation to confirm whether a section dropdown is available in the product edit modal. This is planned for a future update.';
  },
};
