import { z } from 'zod';
import { getColumns, findColumnByName, createItem, updateItem, ensureDb } from '../lib/atlas-client.js';
import { getRegisteredChat } from '../lib/db.js';
import { normalizeDeadline } from '../lib/deadline.js';

const createTask = {
  name: 'create_task',
  description: 'Create a new task on the board. Always provide a title. Column defaults to "To Do" if not specified.',
  schema: {
    title: z.string().describe('Task title in imperative form'),
    column: z.string().optional().describe('Column name to place the task in'),
    assignee: z.string().optional().describe('Person to assign the task to'),
    deadline: z.string().optional().describe('Deadline as ISO date (YYYY-MM-DD)'),
    done: z.boolean().optional().describe('If true, create and immediately mark as done (places in Done column with DONE status)'),
    subtasks: z.array(z.string()).optional().describe('Checklist items / subtasks to create with the task'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const taskId = crypto.randomUUID();
    const title = args.title;

    // Dedup guard: structurally prevent the "recreate a task that already
    // exists" duplicate class (e.g. the brain calling create_task instead of
    // hand_off, or recreating a task it momentarily couldn't see — incidents
    // 2026-06-07/09). If an OPEN task with the same normalized title already
    // exists locally, don't create a second one; point the brain at it.
    if (!args.done) {
      const norm = title.trim().toLowerCase();
      const existing = db.prepare(
        "SELECT id, spok_id, column_name FROM tasks WHERE status = 'OPEN' AND lower(trim(title)) = ?"
      ).get(norm);
      if (existing) {
        const shortId = (existing.spok_id || existing.id).slice(0, 8);
        return `A task "${title}" already exists (ID:${shortId}${existing.column_name ? `, in ${existing.column_name}` : ''}). Not creating a duplicate — update or hand off that one instead if needed.`;
      }
    }

    // Normalize the deadline before it touches Atlas or SQLite. The brain has
    // emitted values like "+2h" that crash Atlas (Invalid Date → 500) and
    // break local datetime() comparisons — normalizeDeadline yields a valid
    // date string or null. See lib/deadline.js + the 2026-06-07 incident.
    const deadline = normalizeDeadline(args.deadline);
    const columns = await getColumns(ctx);

    // Resolve column
    let columnId;
    let columnName;
    if (args.column) {
      const col = findColumnByName(args.column, columns);
      if (col) { columnId = col.id; columnName = col.name; }
    }
    if (!columnId && columns.length > 0) {
      // Default to first column (usually "To Do")
      columnId = columns[0].id;
      columnName = columns[0].name;
    }

    // Handle done=true: override column to Done
    if (args.done) {
      const doneCol = findColumnByName('Done', columns);
      if (doneCol) { columnId = doneCol.id; columnName = doneCol.name; }
    }

    // Build subtasks array
    const subtasks = args.subtasks?.map(t => ({ title: t }));

    // Resolve requester dynamically
    const registered = getRegisteredChat({ config: ctx.config }, ctx.chatId, ctx.userId);
    const requester = registered?.requester_name || ctx.userName || 'Unknown';

    // Create in Atlas
    const atlasResult = await createItem(ctx, {
      title,
      columnId,
      assignee: args.assignee || undefined,
      deadline: deadline || undefined,
      subtasks,
      requester,
      requesterChatId: ctx.chatId,
      // Idempotency key: a retried/replayed POST with this externalId returns
      // the existing Atlas row instead of creating a duplicate (the duplicate
      // class the 2026-06 incidents kept hitting). externalId == local id.
      externalId: taskId,
    });

    // Save locally
    db.prepare(
      `INSERT INTO tasks (id, spok_id, title, column_name, column_id, assignee, deadline, status, synced_at, requester, requester_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).run(
      taskId,
      atlasResult?.atlasId || null,
      title,
      columnName || null,
      columnId || null,
      args.assignee || null,
      deadline || null,
      args.done ? 'DONE' : 'OPEN',
      atlasResult ? new Date().toISOString() : null,
      requester,
      ctx.chatId,
    );

    // Mark done on Atlas if requested
    if (args.done && atlasResult) {
      await updateItem(ctx, atlasResult.atlasId, { status: 'DONE' });
    }

    // Store subtasks locally
    if (subtasks && subtasks.length > 0) {
      const insertSubtask = db.prepare(
        `INSERT INTO task_subtasks (task_id, title, display_order, synced_at) VALUES (?, ?, ?, ?)`
      );
      subtasks.forEach((st, idx) => {
        insertSubtask.run(taskId, st.title, idx, atlasResult ? new Date().toISOString() : null);
      });
    }

    // Store photo attachment if files present
    if (ctx.files && ctx.files.length > 0 && ctx.files[0]?.length > 0) {
      try {
        const buf = ctx.files[0];
        const meta = ctx.fileMetadata?.[0] ?? {};
        const mimeType = meta.mimeType && meta.mimeType.startsWith('image/') ? meta.mimeType : 'image/jpeg';
        const ext = mimeType.split('/')[1]?.split(';')[0] || 'jpg';
        const filename = meta.fileName || `task-${taskId.slice(0, 8)}.${ext}`;
        const photoData = buf.toString('base64');
        let synced = false;
        if (atlasResult) {
          const { syncAttachment } = await import('../lib/atlas-client.js');
          synced = await syncAttachment(ctx, atlasResult.atlasId, {
            type: 'IMAGE',
            imageBase64: photoData,
            filename,
            mimeType,
          });
        }
        // Persist locally for retry
        db.prepare(
          'INSERT INTO task_attachments (task_id, type, filename, mime_type, image_base64, synced_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(taskId, 'IMAGE', filename, mimeType, photoData, synced ? new Date().toISOString() : null);
        ctx.log.info(`Photo attached: filename=${filename} mime=${mimeType} bytes=${buf.length} synced=${synced}`);
      } catch (err) {
        ctx.log.warn(`Failed to sync photo attachment: ${err}`);
      }
    } else if (ctx.files && ctx.files.length > 0) {
      ctx.log.warn('Skipping photo attachment: empty buffer');
    }

    // Extract and attach URLs from title
    const urlMatch = title.match(/https?:\/\/[^\s<>"')\]]+/g);
    if (urlMatch && atlasResult) {
      try {
        const { syncAttachment } = await import('../lib/atlas-client.js');
        for (const url of urlMatch) {
          await syncAttachment(ctx, atlasResult.atlasId, {
            type: 'LINK',
            url,
          });
        }
      } catch (err) {
        ctx.log.warn(`Failed to sync URL attachment: ${err}`);
      }
    }

    // Set post-response inline buttons (Undo / Edit / Column)
    const shortId = taskId.slice(0, 8);
    ctx.store.set('postResponse', {
      buttons: [[
        { text: 'Undo', callbackData: `u:${shortId}` },
        { text: 'Edit', callbackData: `e:${shortId}` },
        { text: 'Column', callbackData: `c:${shortId}` },
      ]],
    });

    let result = `Created: "${title}" (ID:${shortId})`;
    if (columnName) result += ` in ${columnName}`;
    if (args.assignee) result += `, assigned to ${args.assignee}`;
    if (deadline) result += `, due ${deadline}`;
    if (!atlasResult) result += ' (saved locally, will sync later)';
    return result;
  },
};

export default createTask;
