import { DateTime } from 'luxon';
import { getConfig } from '../config.js';
import * as queries from '../db/queries.js';
import { getCurrentWeekOf, getRecommendationsForWeek, getMenuForWeek } from '../lunch/index.js';

/**
 * Build XML context block with current board state.
 * Called fresh every explicit NL message.
 */
export function buildContextBlock(): string {
  const config = getConfig();
  let context = '';

  // Current time
  const now = DateTime.now().setZone(config.TIMEZONE);
  context += `<current_time>${now.toISO()} (${now.toFormat("EEE d MMM yyyy, h:mm a")} ${config.TIMEZONE})</current_time>\n\n`;

  try {
    const tasks = queries.getOpenTasks();

    if (tasks.length === 0) {
      context += '<board_state>No open items on the board.</board_state>\n';
      context += '<columns>To Do, In Progress, Done</columns>\n';
      return context;
    }

    // Group by category then by column
    const byCategory = new Map<string, Map<string, queries.Task[]>>();
    for (const task of tasks) {
      const cat = task.category || 'home';
      if (!byCategory.has(cat)) byCategory.set(cat, new Map());
      const catMap = byCategory.get(cat)!;
      const col = task.column_name || 'To Do';
      if (!catMap.has(col)) catMap.set(col, []);
      catMap.get(col)!.push(task);
    }

    const boardLines: string[] = [];
    for (const [category, columns] of byCategory) {
      boardLines.push(`== ${category.toUpperCase()} ==`);
      for (const [colName, colTasks] of columns) {
        boardLines.push(`[${colName}]`);
        for (const task of colTasks) {
          let line = `  - ID:${task.id.slice(0, 8)} | ${task.title}`;
          if (task.assignee) line += ` | @${task.assignee}`;
          if (task.deadline) {
            line += ` | due:${task.deadline}`;
            if (task.deadline_time) line += ` ${task.deadline_time}`;
            const dl = DateTime.fromISO(task.deadline);
            if (dl < now.startOf('day')) line += ' OVERDUE';
          }
          if (task.priority === 1) line += ' | HIGH';
          if (task.priority === 3) line += ' | low';
          boardLines.push(line);
        }
      }
    }
    boardLines.push(`Total: ${tasks.length} open items`);
    context += `<board_state>\n${boardLines.join('\n')}\n</board_state>\n\n`;

    // Overdue items
    const overdue = queries.getOverdueTasks();
    if (overdue.length > 0) {
      const overdueList = overdue.map(i => `"${i.title}" (${i.deadline})`).join(', ');
      context += `<overdue_items>${overdue.length} overdue: ${overdueList}</overdue_items>\n\n`;
    }

    // Next deadline
    const upcoming = queries.getDueWithin(7);
    if (upcoming.length > 0) {
      const next = upcoming[0];
      context += `<next_deadline>"${next.title}" due ${next.deadline}${next.deadline_time ? ' ' + next.deadline_time : ''}</next_deadline>\n\n`;
    }

    context += '<columns>To Do, In Progress, Done</columns>\n';
  } catch (err) {
    console.error('[context-builder] Failed to build context:', err);
    context += '<board_state>Failed to fetch board state.</board_state>\n';
  }

  // Lunch context
  try {
    const weekOf = getCurrentWeekOf();
    const recs = getRecommendationsForWeek(weekOf);
    const menu = getMenuForWeek(weekOf);

    if (recs.length > 0) {
      const days = [...new Set(recs.map(r => r.day))];
      context += `\n<lunch_this_week>${recs.length} recommendations across ${days.length} day(s): ${days.join(', ')}. Week of ${weekOf}. Use get_recommendations tool for details.</lunch_this_week>\n`;
    } else if (menu.length > 0) {
      context += `\n<lunch_this_week>Menu scraped (${menu.length} items) but not yet analyzed. Week of ${weekOf}. Use get_menu tool or suggest /refresh to run analysis.</lunch_this_week>\n`;
    } else {
      context += '\n<lunch_this_week>No menu data for this week yet. Suggest /refresh to scrape and analyze.</lunch_this_week>\n';
    }
  } catch {
    // Lunch DB not initialized yet -- skip
  }

  return context;
}
