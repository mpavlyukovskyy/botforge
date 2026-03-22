import { z } from 'zod';
import { getColumns, findColumnByName, createItem, updateItem, ensureDb } from '../lib/atlas-client.js';
import { getRegisteredChat } from '../lib/db.js';

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
      deadline: args.deadline || undefined,
      subtasks,
      requester,
      requesterChatId: ctx.chatId,
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
      args.deadline || null,
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
    if (ctx.files && ctx.files.length > 0) {
      try {
        const photoData = ctx.files[0].toString('base64');
        let synced = false;
        if (atlasResult) {
          const { syncAttachment } = await import('../lib/atlas-client.js');
          synced = await syncAttachment(ctx, atlasResult.atlasId, {
            type: 'IMAGE',
            imageBase64: photoData,
            filename: 'photo.jpg',
            mimeType: 'image/jpeg',
          });
        }
        // Persist locally for retry
        db.prepare(
          'INSERT INTO task_attachments (task_id, type, filename, mime_type, image_base64, synced_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(taskId, 'IMAGE', 'photo.jpg', 'image/jpeg', photoData, synced ? new Date().toISOString() : null);
      } catch (err) {
        ctx.log.warn(`Failed to sync photo attachment: ${err}`);
      }
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
    if (args.deadline) result += `, due ${args.deadline}`;
    if (!atlasResult) result += ' (saved locally, will sync later)';
    return result;
  },
};

export default createTask;
