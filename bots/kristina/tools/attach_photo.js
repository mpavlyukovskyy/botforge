import { z } from 'zod';
import { ensureDb, syncAttachment } from '../lib/atlas-client.js';
import { findTaskByIdPrefix } from '../lib/db.js';

/**
 * Attach a photo from the current message to an existing task.
 *
 * Uses ctx.files (botforge native media handling) rather than a separate
 * pending-photos buffer like standalone — botforge surfaces uploaded files
 * directly on the ToolContext for the same-turn invocation.
 *
 * Photo is stored as base64 in task_attachments (matches standalone schema)
 * and posted to Atlas via syncAttachment.
 */
const attachPhoto = {
  name: 'attach_photo',
  description: 'Attach the photo from the current message to an existing task. Use the 8-char ID prefix.',
  schema: {
    item_id: z.string().describe('Task ID (or 8-char prefix) to attach the photo to'),
  },
  execute: async (args, ctx) => {
    try {
      const task = findTaskByIdPrefix(ctx, String(args.item_id));
      if (!task) return `No task found matching "${args.item_id}".`;

      // botforge surfaces media as Buffer[] on ctx.files. Take the first file.
      const file = ctx.files?.[0];
      if (!file) return 'No photo found in the current message.';
      if (file.length === 0) return 'Photo buffer is empty — please re-send the image.';

      const db = ensureDb(ctx.config);
      const meta = ctx.fileMetadata?.[0] ?? {};
      const mimeType = meta.mimeType && meta.mimeType.startsWith('image/') ? meta.mimeType : 'image/jpeg';
      const ext = mimeType.split('/')[1]?.split(';')[0] || 'jpg';
      const filename = meta.fileName || `task-${task.id.slice(0, 8)}.${ext}`;
      const imageBase64 = file.toString('base64');

      db.prepare(
        `INSERT INTO task_attachments (task_id, type, filename, mime_type, image_base64, display_order, synced_at)
         VALUES (?, 'IMAGE', ?, ?, ?, 0, NULL)`
      ).run(task.id, filename, mimeType, imageBase64);

      if (task.spok_id) {
        const ok = await syncAttachment(ctx, task.spok_id, {
          type: 'IMAGE',
          filename,
          mimeType,
          imageBase64,
        });
        if (ok) {
          db.prepare(
            "UPDATE task_attachments SET synced_at = datetime('now') WHERE task_id = ? AND image_base64 = ?"
          ).run(task.id, imageBase64);
        }
      }

      return `Photo attached to "${task.title}".`;
    } catch (err) {
      return `Error attaching photo: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export default attachPhoto;
