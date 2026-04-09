import { CSS, JS } from './static.js';
import { getConfig } from '../config.js';
import * as queries from '../db/queries.js';
import { DateTime } from 'luxon';

export function layout(title: string, content: string, isAuthed: boolean): string {
  const config = getConfig();
  const nav = isAuthed ? `
    <nav>
      <a href="/board">Board</a>
      <a href="/task/new">+ New</a>
      <a href="/settings">Settings</a>
      <a href="#" onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.href='/login')">Logout</a>
    </nav>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ${config.BOT_NAME}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="header"><div class="container"><h1>${config.BOT_NAME}</h1>${nav}</div></div>
  <div class="container">${content}</div>
  <script>${JS}</script>
</body>
</html>`;
}

export function loginPage(): string {
  return layout('Login', `
    <div class="login-container">
      <div class="card">
        <h2 style="margin-bottom:16px">Login</h2>
        <form method="POST" action="/api/auth">
          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" autofocus required>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%">Login</button>
        </form>
      </div>
    </div>`, false);
}

export function boardPage(categoryFilter?: string): string {
  const config = getConfig();
  const now = DateTime.now().setZone(config.TIMEZONE);
  const tasks = categoryFilter
    ? queries.getOpenTasks(categoryFilter)
    : queries.getOpenTasks();
  const stats = queries.getTaskStats();

  const columns = ['To Do', 'In Progress', 'Done'];
  const columnColors: Record<string, string> = {
    'To Do': '#3b82f6',
    'In Progress': '#f97316',
    'Done': '#22c55e',
  };
  const doneTasks = queries.getAllTasks('DONE').slice(0, 10);

  // Group tasks by column
  const grouped: Record<string, queries.Task[]> = {};
  for (const col of columns) grouped[col] = [];
  for (const task of tasks) {
    let col = task.column_name || 'To Do';
    if (col === 'Done') col = 'To Do';
    if (grouped[col]) grouped[col].push(task);
    else grouped['To Do'].push(task);
  }
  // Add recent done tasks
  grouped['Done'] = doneTasks;

  const activeTab = categoryFilter || 'all';

  const statsHtml = `
    <div class="stats-bar">
      <div class="stat"><div class="num">${stats.open}</div><div class="label">Open</div></div>
      <div class="stat"><div class="num">${stats.overdue}</div><div class="label">Overdue</div></div>
      <div class="stat"><div class="num">${stats.byCategory['home'] || 0}</div><div class="label">Home</div></div>
      <div class="stat"><div class="num">${stats.byCategory['professional'] || 0}</div><div class="label">Work</div></div>
    </div>`;

  const tabsHtml = `
    <div class="tabs">
      <a href="/board" class="tab ${activeTab === 'all' ? 'active' : ''}">All</a>
      <a href="/board?category=home" class="tab ${activeTab === 'home' ? 'active' : ''}">Home</a>
      <a href="/board?category=professional" class="tab ${activeTab === 'professional' ? 'active' : ''}">Work</a>
    </div>`;

  const columnsHtml = columns.map(col => {
    const colTasks = grouped[col];
    const cardsHtml = colTasks.length > 0
      ? colTasks.map(task => taskCard(task, now)).join('')
      : '<div class="empty-state">Drop items here</div>';
    return `
      <div class="column" data-column="${col}">
        <div class="column-header">
          <div class="column-header-left">
            <span class="column-dot" style="background:${columnColors[col]}"></span>
            <span class="column-name">${col}</span>
            <span class="column-count">${colTasks.length}</span>
          </div>
          <a href="/task/new" class="column-add" title="Add task">+</a>
        </div>
        <div class="column-items">
          ${cardsHtml}
        </div>
      </div>`;
  }).join('');

  const mobileHtml = columns.map(col => {
    const colTasks = grouped[col];
    const cardsHtml = colTasks.length > 0
      ? colTasks.map(task => taskCard(task, now)).join('')
      : '<div class="empty-state">Drop items here</div>';
    const isCollapsed = col === 'Done';
    return `
      <div class="accordion-column">
        <button class="accordion-header" onclick="toggleAccordion(this)">
          <div class="column-header-left">
            <span class="column-dot" style="background:${columnColors[col]}"></span>
            <span class="column-name">${col}</span>
            <span class="column-count">${colTasks.length}</span>
          </div>
          <span class="accordion-arrow${isCollapsed ? ' collapsed' : ''}">&#9662;</span>
        </button>
        <div class="accordion-body${isCollapsed ? ' collapsed' : ''}">
          ${cardsHtml}
        </div>
      </div>`;
  }).join('');

  return layout('Board', `
    ${statsHtml}
    ${tabsHtml}
    <div class="kanban">${columnsHtml}</div>
    <div class="kanban-mobile">${mobileHtml}</div>
    <div class="sheet-overlay" id="sheetOverlay" onclick="closeSheet()"></div>
    <div class="sheet-panel" id="sheetPanel">
      <button class="sheet-close" onclick="closeSheet()">&times;</button>
      <div id="sheetBody"></div>
    </div>`, true);
}

function taskCard(task: queries.Task, now: DateTime): string {
  const config = getConfig();
  const todayStart = now.startOf('day');
  const isDone = task.status === 'DONE';
  const classes = ['task-card'];

  // Urgency ring: overdue or today and OPEN
  let isUrgent = false;
  if (task.deadline && !isDone) {
    const deadlineDate = DateTime.fromISO(task.deadline).setZone(config.TIMEZONE).startOf('day');
    const daysDiff = deadlineDate.diff(todayStart, 'days').days;
    if (daysDiff <= 0) isUrgent = true;
  }
  if (isUrgent) classes.push('urgent');
  if (isDone) classes.push('task-done');

  // Deadline badge
  let deadlineBadgeHtml = '';
  if (task.deadline) {
    const deadlineDate = DateTime.fromISO(task.deadline).setZone(config.TIMEZONE).startOf('day');
    const daysDiff = Math.round(deadlineDate.diff(todayStart, 'days').days);
    const formatted = deadlineDate.toFormat('MMM d');
    let badgeClass = 'future';
    let badgeText = formatted;

    if (isDone) {
      badgeClass = 'done-date';
      badgeText = formatted;
    } else if (daysDiff < 0) {
      badgeClass = 'overdue';
      badgeText = 'overdue!';
    } else if (daysDiff === 0) {
      badgeClass = 'today';
      badgeText = 'today';
    } else if (daysDiff === 1) {
      badgeClass = 'today';
      badgeText = 'tomorrow';
    } else if (daysDiff <= 3) {
      badgeClass = 'soon';
      badgeText = formatted;
    }
    deadlineBadgeHtml = `<span class="deadline-badge ${badgeClass}">${badgeText}</span>`;
  }

  // Assignee dot
  const ASSIGNEE_COLORS: Record<string, string> = {
    M: '#3b82f6', S: '#ec4899', H: '#10b981', A: '#8b5cf6',
    B: '#f97316', C: '#ec4899', D: '#14b8a6',
  };
  let assigneeHtml = '';
  if (task.assignee) {
    const initial = task.assignee.charAt(0).toUpperCase();
    const color = ASSIGNEE_COLORS[initial] || '#6b7280';
    assigneeHtml = `<span class="assignee-dot" style="background:${color}" title="${escHtml(task.assignee)}">${initial}</span>`;
  }

  // Category badge
  const catClass = task.category === 'home' ? 'cat-home' : 'cat-professional';
  const catBadgeHtml = `<span class="cat-badge ${catClass}">${task.category}</span>`;

  // Subtask & attachment counts
  const subtasks = queries.getSubtasks(task.id);
  const attachments = queries.getAttachments(task.id);
  const subtasksDone = subtasks.filter(s => s.completed).length;
  let subtaskHtml = '';
  if (subtasks.length > 0) {
    subtaskHtml = `<span class="meta-icon">&#9745; ${subtasksDone}/${subtasks.length}</span>`;
  }
  let attachHtml = '';
  if (attachments.length > 0) {
    attachHtml = `<span class="meta-icon">&#128206; ${attachments.length}</span>`;
  }

  // Build meta row
  const metaParts = [deadlineBadgeHtml, catBadgeHtml, subtaskHtml, attachHtml].filter(Boolean).join('');

  return `
    <div class="${classes.join(' ')}" draggable="true" data-task-id="${escHtml(task.id)}">
      <span class="drag-handle">&#10303;</span>
      <input type="checkbox" class="task-check" ${isDone ? 'checked' : ''}
        onclick="toggleDone('${escHtml(task.id)}', '${task.status}', event)">
      <div class="task-content" onclick="openTaskSheet('${escHtml(task.id)}')">
        <span class="task-title${isDone ? ' done' : ''}">${escHtml(task.title)}</span>
        <div class="task-meta">${metaParts}</div>
      </div>
      ${assigneeHtml}
    </div>`;
}

export function taskDetailPage(task: queries.Task): string {
  const subtasks = queries.getSubtasks(task.id);
  const attachments = queries.getAttachments(task.id);

  const priorityLabels: Record<number, string> = { 1: 'High', 2: 'Normal', 3: 'Low' };

  const subtasksHtml = subtasks.length > 0 ? `
    <h3 style="margin:16px 0 8px">Subtasks</h3>
    <ul class="subtask-list">
      ${subtasks.map(st => `
        <li class="subtask-item ${st.completed ? 'done' : ''}">
          <input type="checkbox" ${st.completed ? 'checked' : ''} onclick="toggleSubtask('${task.id}', ${st.id})">
          <span>${escHtml(st.title)}</span>
        </li>`).join('')}
    </ul>` : '';

  const photosHtml = attachments.filter(a => a.type === 'IMAGE' && a.image_base64).map(a =>
    `<img src="data:${a.mime_type || 'image/jpeg'};base64,${a.image_base64}" style="max-width:300px;border-radius:8px;margin:4px">`
  ).join('');

  const linksHtml = attachments.filter(a => a.type === 'LINK').map(a =>
    `<a href="${escHtml(a.url || '')}" target="_blank">${escHtml(a.url || '')}</a>`
  ).join('<br>');

  return layout(task.title, `
    <div class="task-detail">
      <a href="/board" style="font-size:0.875rem">&larr; Back to board</a>
      <div class="card" style="margin-top:12px">
        <h2 style="margin-bottom:12px">${escHtml(task.title)}</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <span class="pill pill-${task.category}">${task.category}</span>
          <span class="pill" style="background:#f1f5f9">${task.column_name}</span>
          <span class="pill" style="background:#f1f5f9">Priority: ${priorityLabels[task.priority] || 'Normal'}</span>
          ${task.deadline ? `<span class="pill" style="background:#fef3c7;color:#92400e">Due: ${task.deadline}${task.deadline_time ? ' ' + task.deadline_time : ''}</span>` : ''}
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <button class="btn btn-primary btn-sm" onclick="markDone('${task.id}')">Mark Done</button>
          <select class="move-select" onchange="if(this.value)moveTask('${task.id}',this.value)">
            <option value="">Move to...</option>
            <option value="To Do">To Do</option>
            <option value="In Progress">In Progress</option>
            <option value="Done">Done</option>
          </select>
          <button class="btn btn-danger btn-sm" onclick="deleteTask('${task.id}','${escHtml(task.title).replace(/'/g, "\\'")}')">Delete</button>
        </div>

        <!-- Edit form -->
        <details style="margin-bottom:16px">
          <summary style="cursor:pointer;font-size:0.875rem;color:#2563eb">Edit task</summary>
          <form onsubmit="editTask(event,'${task.id}')" style="margin-top:8px">
            <div class="form-group"><label>Title</label><input name="title" value="${escHtml(task.title)}"></div>
            <div class="form-group"><label>Category</label>
              <select name="category"><option value="home" ${task.category === 'home' ? 'selected' : ''}>Home</option><option value="professional" ${task.category === 'professional' ? 'selected' : ''}>Professional</option></select>
            </div>
            <div class="form-group"><label>Priority</label>
              <select name="priority"><option value="1" ${task.priority === 1 ? 'selected' : ''}>High</option><option value="2" ${task.priority === 2 ? 'selected' : ''}>Normal</option><option value="3" ${task.priority === 3 ? 'selected' : ''}>Low</option></select>
            </div>
            <div class="form-group"><label>Deadline</label><input type="date" name="deadline" value="${task.deadline || ''}"></div>
            <div class="form-group"><label>Time</label><input type="time" name="deadline_time" value="${task.deadline_time || ''}"></div>
            <button type="submit" class="btn btn-primary btn-sm">Save</button>
          </form>
        </details>

        ${subtasksHtml}
        ${photosHtml ? `<h3 style="margin:16px 0 8px">Photos</h3>${photosHtml}` : ''}
        ${linksHtml ? `<h3 style="margin:16px 0 8px">Links</h3>${linksHtml}` : ''}

        <div style="margin-top:16px;font-size:0.75rem;color:#94a3b8">
          Created: ${task.created_at}<br>
          Updated: ${task.updated_at}<br>
          ID: ${task.id}
        </div>
      </div>
    </div>
    <script>
    async function editTask(e, id) {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {};
      for (const [k,v] of fd.entries()) if (v) body[k] = k === 'priority' ? Number(v) : v;
      const res = await fetch('/api/tasks/' + id, {
        method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
      if (res.ok) location.reload();
    }
    </script>`, true);
}

export function createTaskPage(): string {
  return layout('New Task', `
    <div class="create-form">
      <a href="/board" style="font-size:0.875rem">&larr; Back</a>
      <div class="card" style="margin-top:12px">
        <h2 style="margin-bottom:16px">New Task</h2>
        <form method="POST" action="/api/tasks">
          <div class="form-group"><label>Title</label><input name="title" required autofocus></div>
          <div class="form-group"><label>Category</label>
            <div class="radio-group">
              <label><input type="radio" name="category" value="home" checked> Home</label>
              <label><input type="radio" name="category" value="professional"> Professional</label>
            </div>
          </div>
          <div class="form-group"><label>Priority</label>
            <select name="priority"><option value="1">High</option><option value="2" selected>Normal</option><option value="3">Low</option></select>
          </div>
          <div class="form-group"><label>Deadline</label><input type="date" name="deadline"></div>
          <div class="form-group"><label>Time</label><input type="time" name="deadline_time"></div>
          <button type="submit" class="btn btn-primary" style="width:100%">Create Task</button>
        </form>
      </div>
    </div>`, true);
}

export function settingsPage(googleConnected: boolean): string {
  const config = getConfig();
  const gcalSection = config.GOOGLE_CLIENT_ID ? `
    <h3 style="margin:16px 0 8px">Google Calendar</h3>
    ${googleConnected
      ? '<p style="color:#166534">Connected. Tasks with deadlines will sync to Google Calendar.</p>'
      : `<a href="/api/google/authorize" class="btn btn-primary">Connect Google Calendar</a>
         <p style="margin-top:8px;font-size:0.875rem;color:#6b7280">Tasks with deadlines will create calendar events with reminders.</p>`
    }` : '<p style="font-size:0.875rem;color:#6b7280">Google Calendar not configured.</p>';

  return layout('Settings', `
    <div class="task-detail">
      <div class="card">
        <h2 style="margin-bottom:16px">Settings</h2>
        <p><strong>Bot:</strong> ${config.BOT_NAME}</p>
        <p><strong>Timezone:</strong> ${config.TIMEZONE}</p>
        <p><strong>Dashboard port:</strong> ${config.DASHBOARD_PORT}</p>
        ${gcalSection}
      </div>
    </div>`, true);
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
