export const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }

.container { max-width: 1200px; margin: 0 auto; padding: 16px; }
.header { background: #1e293b; color: white; padding: 12px 0; margin-bottom: 16px; }
.header .container { display: flex; justify-content: space-between; align-items: center; }
.header h1 { font-size: 1.25rem; }
.header nav { display: flex; gap: 16px; align-items: center; }
.header nav a { color: #94a3b8; font-size: 0.875rem; }
.header nav a:hover, .header nav a.active { color: white; }
.btn { display: inline-block; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.875rem; text-decoration: none; }
.btn-primary { background: #2563eb; color: white; }
.btn-primary:hover { background: #1d4ed8; }
.btn-danger { background: #dc2626; color: white; }
.btn-danger:hover { background: #b91c1c; }
.btn-sm { padding: 4px 10px; font-size: 0.75rem; }

/* Login */
.login-container { max-width: 400px; margin: 100px auto; }
.card { background: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 16px; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 0.875rem; }
.form-group input, .form-group select, .form-group textarea {
  width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem;
}

/* Kanban */
.tabs { display: flex; gap: 8px; margin-bottom: 16px; }
.tab { padding: 6px 14px; border-radius: 20px; background: #e2e8f0; color: #475569; font-size: 0.875rem; cursor: pointer; border: none; }
.tab.active { background: #2563eb; color: white; }
.kanban { display: flex; gap: 16px; overflow-x: auto; padding-bottom: 16px; }
.column { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; }
.column-header { margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; padding: 0 4px; }
.column-header-left { display: flex; align-items: center; gap: 8px; }
.column-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
.column-name { font-size: 0.875rem; font-weight: 600; color: #334155; }
.column-count { background: #f1f5f9; color: #64748b; border-radius: 10px; padding: 1px 8px; font-size: 0.6875rem; font-weight: 600; min-width: 20px; text-align: center; }
.column-add { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; color: #94a3b8; font-size: 1.125rem; text-decoration: none; }
.column-add:hover { background: #f1f5f9; color: #64748b; text-decoration: none; }
.column-items { flex: 1; display: flex; flex-direction: column; gap: 8px; border-radius: 8px; border: 1px dashed transparent; padding: 4px; min-height: 80px; transition: border-color 0.15s, background-color 0.15s; }
.column-items.drag-over { border-color: rgba(37,99,235,0.4); background: rgba(37,99,235,0.05); }
.empty-state { height: 80px; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px dashed #d1d5db; font-size: 0.75rem; color: #94a3b8; }

/* Task card */
.task-card { display: flex; align-items: flex-start; gap: 8px; border-radius: 8px; border: 1px solid #e2e8f0; background: white; padding: 12px; cursor: default; transition: background 0.15s, box-shadow 0.15s; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
.task-card:hover { background: #f8fafc; }
.task-card.dragging { opacity: 0.5; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
.task-card.urgent { box-shadow: 0 0 0 2px #ef4444, 0 1px 2px rgba(0,0,0,0.05); }
.task-card.task-done { opacity: 0.6; }
.drag-handle { opacity: 0; cursor: grab; color: #94a3b8; font-size: 0.875rem; line-height: 1; margin-top: 2px; transition: opacity 0.15s; user-select: none; }
.task-card:hover .drag-handle { opacity: 1; }
.task-check { margin-top: 3px; flex-shrink: 0; cursor: pointer; width: 16px; height: 16px; }
.task-content { flex: 1; min-width: 0; cursor: pointer; }
.task-title { font-size: 0.875rem; font-weight: 500; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-title.done { text-decoration: line-through; color: #94a3b8; }
.task-meta { margin-top: 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.assignee-dot { width: 24px; height: 24px; border-radius: 50%; color: white; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.deadline-badge { font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; }
.deadline-badge.overdue { background: rgba(239,68,68,0.1); color: #ef4444; font-weight: 500; }
.deadline-badge.today { background: rgba(239,68,68,0.1); color: #ef4444; }
.deadline-badge.soon { background: rgba(245,158,11,0.1); color: #d97706; }
.deadline-badge.future { background: #f1f5f9; color: #64748b; }
.deadline-badge.done-date { background: rgba(34,197,94,0.1); color: #16a34a; text-decoration: line-through; }
.cat-badge { font-size: 0.6875rem; padding: 1px 6px; border-radius: 10px; font-weight: 600; }
.cat-home { background: #dcfce7; color: #166534; }
.cat-professional { background: #dbeafe; color: #1e40af; }
.meta-icon { font-size: 0.75rem; color: #94a3b8; display: inline-flex; align-items: center; gap: 2px; }

/* Mobile accordion */
.kanban-mobile { display: none; }
@media (max-width: 767px) {
  .kanban { display: none; }
  .kanban-mobile { display: flex; flex-direction: column; gap: 8px; }
}
.accordion-column { border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
.accordion-header { display: flex; width: 100%; align-items: center; justify-content: space-between; padding: 12px; background: white; border: none; cursor: pointer; font-family: inherit; transition: background 0.15s; }
.accordion-header:hover { background: #f8fafc; }
.accordion-arrow { color: #94a3b8; font-size: 0.75rem; transition: transform 0.2s; }
.accordion-arrow.collapsed { transform: rotate(-90deg); }
.accordion-body { border-top: 1px solid #e2e8f0; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.accordion-body.collapsed { display: none; }

/* Sheet */
.sheet-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 50; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
.sheet-overlay.open { opacity: 1; pointer-events: auto; }
.sheet-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 100%; max-width: 560px; background: white; z-index: 51; transform: translateX(100%); transition: transform 0.25s ease; overflow-y: auto; box-shadow: -4px 0 12px rgba(0,0,0,0.1); padding: 24px; }
.sheet-panel.open { transform: translateX(0); }
.sheet-close { position: absolute; top: 12px; right: 12px; width: 32px; height: 32px; border: none; background: none; cursor: pointer; font-size: 1.25rem; color: #94a3b8; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
.sheet-close:hover { background: #f1f5f9; color: #334155; }
.sheet-title { font-size: 1.25rem; font-weight: 600; margin-bottom: 16px; padding-right: 40px; cursor: pointer; }
.sheet-title:hover { color: #2563eb; }
.sheet-title-input { font-size: 1.25rem; font-weight: 600; width: 100%; border: 1px solid #2563eb; border-radius: 6px; padding: 4px 8px; outline: none; margin-bottom: 16px; }
.sheet-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
.sheet-field label { display: block; font-size: 0.6875rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.sheet-field select, .sheet-field input { width: 100%; padding: 6px 8px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.875rem; background: white; }
.sheet-actions { display: flex; gap: 8px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #e2e8f0; }
.sheet-section { margin-bottom: 16px; }
.sheet-section-label { font-size: 0.6875rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
.sheet-timestamps { font-size: 0.75rem; color: #94a3b8; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
.add-subtask-row { display: flex; gap: 8px; margin-top: 8px; }
.add-subtask-row input { flex: 1; padding: 6px 8px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.875rem; }

/* Pills (used on detail page) */
.pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.7rem; font-weight: 600; }
.pill-home { background: #dcfce7; color: #166534; }
.pill-professional { background: #dbeafe; color: #1e40af; }

/* Task detail */
.task-detail { max-width: 600px; margin: 0 auto; }
.subtask-list { list-style: none; padding: 0; }
.subtask-item { padding: 6px 0; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #f1f5f9; }
.subtask-item input[type=checkbox] { cursor: pointer; }
.subtask-item.done { text-decoration: line-through; color: #94a3b8; }

/* Move dropdown */
.move-select { padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.75rem; background: white; }

/* Stats bar */
.stats-bar { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.stat { background: white; border-radius: 8px; padding: 12px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); text-align: center; flex: 1; min-width: 100px; }
.stat .num { font-size: 1.5rem; font-weight: 700; }
.stat .label { font-size: 0.75rem; color: #94a3b8; }

/* Create form */
.create-form { max-width: 500px; margin: 0 auto; }
.radio-group { display: flex; gap: 12px; }
.radio-group label { display: flex; align-items: center; gap: 4px; font-weight: normal; cursor: pointer; }
`;

export const JS = `
// Move task to column
async function moveTask(taskId, column) {
  if (column === 'Done') {
    await fetch('/api/tasks/' + taskId + '/done', { method: 'POST' });
  } else {
    await fetch('/api/tasks/' + taskId, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ status: 'OPEN', column_name: column })
    });
  }
  location.reload();
}

// Mark done
async function markDone(taskId) {
  const res = await fetch('/api/tasks/' + taskId + '/done', { method: 'POST' });
  if (res.ok) location.reload();
}

// Delete task
async function deleteTask(taskId, title) {
  if (!confirm('Delete "' + title + '"?')) return;
  const res = await fetch('/api/tasks/' + taskId, { method: 'DELETE' });
  if (res.ok) location.href = '/board';
}

// Toggle subtask
async function toggleSubtask(taskId, subtaskId) {
  const res = await fetch('/api/tasks/' + taskId + '/subtasks/' + subtaskId + '/toggle', { method: 'POST' });
  if (res.ok) location.reload();
}

// Toggle done via checkbox
async function toggleDone(taskId, currentStatus, event) {
  event.stopPropagation();
  if (currentStatus === 'OPEN') {
    await fetch('/api/tasks/' + taskId + '/done', { method: 'POST' });
  } else {
    await fetch('/api/tasks/' + taskId, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ status: 'OPEN', column_name: 'To Do' })
    });
  }
  location.reload();
}

// Mobile accordion toggle
function toggleAccordion(btn) {
  var body = btn.nextElementSibling;
  var arrow = btn.querySelector('.accordion-arrow');
  body.classList.toggle('collapsed');
  arrow.classList.toggle('collapsed');
}

// Drag and drop
let draggedCard = null;
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.task-card');
  if (card) { draggedCard = card; card.classList.add('dragging'); }
});
document.addEventListener('dragend', (e) => {
  const card = e.target.closest('.task-card');
  if (card) { card.classList.remove('dragging'); }
});
document.querySelectorAll('.column-items').forEach(zone => {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (draggedCard) {
      const taskId = draggedCard.dataset.taskId;
      const column = zone.closest('.column').dataset.column;
      moveTask(taskId, column);
    }
  });
});

// --- Sheet ---
var sheetDirty = false;

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function openTaskSheet(taskId) {
  var res = await fetch('/api/tasks/' + taskId);
  if (!res.ok) return;
  var data = await res.json();
  sheetDirty = false;
  renderSheet(data);
  document.getElementById('sheetOverlay').classList.add('open');
  document.getElementById('sheetPanel').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  document.getElementById('sheetOverlay').classList.remove('open');
  document.getElementById('sheetPanel').classList.remove('open');
  document.body.style.overflow = '';
  if (sheetDirty) location.reload();
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeSheet();
});

async function sheetMoveColumn(taskId, column) {
  if (column === 'Done') {
    await fetch('/api/tasks/' + taskId + '/done', { method: 'POST' });
  } else {
    await fetch('/api/tasks/' + taskId, {
      method: 'PATCH',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ status: 'OPEN', column_name: column })
    });
  }
  sheetDirty = true;
  openTaskSheet(taskId);
}

function renderSheet(data) {
  var t = data.task;
  var subs = data.subtasks || [];
  var atts = data.attachments || [];
  var isDone = t.status === 'DONE';

  var subtasksHtml = subs.map(function(s) {
    return '<li class="subtask-item ' + (s.completed ? 'done' : '') + '">'
      + '<input type="checkbox" ' + (s.completed ? 'checked' : '')
      + ' onclick="sheetToggleSubtask(\\'' + esc(t.id) + '\\',' + s.id + ')">'
      + '<span>' + esc(s.title) + '</span></li>';
  }).join('');

  var imagesHtml = atts.filter(function(a){return a.type==='IMAGE'}).map(function() {
    return '<a href="/task/' + esc(t.id) + '" target="_blank" style="font-size:0.75rem;color:#2563eb">View photos on detail page</a>';
  }).join('');

  var linksHtml = atts.filter(function(a){return a.type==='LINK'}).map(function(a) {
    return '<div><a href="' + esc(a.url) + '" target="_blank" style="font-size:0.875rem">' + esc(a.url) + '</a></div>';
  }).join('');

  var html = ''
    + '<div class="sheet-title" onclick="sheetEditTitle(\\'' + esc(t.id) + '\\',this)">' + esc(t.title) + '</div>'
    + '<div class="sheet-grid">'
    + '  <div class="sheet-field"><label>Column</label>'
    + '    <select onchange="sheetMoveColumn(\\'' + esc(t.id) + '\\', this.value)">'
    + '      <option' + (t.column_name==='To Do'?' selected':'') + '>To Do</option>'
    + '      <option' + (t.column_name==='In Progress'?' selected':'') + '>In Progress</option>'
    + '      <option' + (t.column_name==='Done'?' selected':'') + '>Done</option>'
    + '    </select></div>'
    + '  <div class="sheet-field"><label>Category</label>'
    + '    <select onchange="sheetPatch(\\'' + esc(t.id) + '\\',{category:this.value})">'
    + '      <option value="home"' + (t.category==='home'?' selected':'') + '>Home</option>'
    + '      <option value="professional"' + (t.category==='professional'?' selected':'') + '>Professional</option>'
    + '    </select></div>'
    + '  <div class="sheet-field"><label>Priority</label>'
    + '    <select onchange="sheetPatch(\\'' + esc(t.id) + '\\',{priority:Number(this.value)})">'
    + '      <option value="1"' + (t.priority===1?' selected':'') + '>High</option>'
    + '      <option value="2"' + (t.priority===2?' selected':'') + '>Normal</option>'
    + '      <option value="3"' + (t.priority===3?' selected':'') + '>Low</option>'
    + '    </select></div>'
    + '  <div class="sheet-field"><label>Deadline</label>'
    + '    <input type="date" value="' + (t.deadline||'') + '" onchange="sheetPatch(\\'' + esc(t.id) + '\\',{deadline:this.value})">'
    + '  </div>'
    + '</div>'
    + '<div class="sheet-actions">'
    + '  <button class="btn btn-primary btn-sm" onclick="sheetToggleDone(\\'' + esc(t.id) + '\\',\\'' + t.status + '\\')">' + (isDone ? 'Reopen' : 'Mark Done') + '</button>'
    + '  <button class="btn btn-danger btn-sm" onclick="sheetDelete(\\'' + esc(t.id) + '\\',\\'' + esc(t.title).replace(/'/g,"\\\\'") + '\\')">' + 'Delete</button>'
    + '  <a href="/task/' + esc(t.id) + '" class="btn btn-sm" style="background:#f1f5f9;color:#334155">Full page</a>'
    + '</div>';

  var doneCount = subs.filter(function(s){return s.completed}).length;
  html += '<div class="sheet-section">'
    + '<div class="sheet-section-label">Subtasks' + (subs.length ? '  ' + doneCount + '/' + subs.length : '') + '</div>'
    + '<ul class="subtask-list">' + subtasksHtml + '</ul>'
    + '<div class="add-subtask-row">'
    + '  <input type="text" id="newSubtaskInput" placeholder="Add subtask..." onkeydown="if(event.key===\\'Enter\\')sheetAddSubtask(\\'' + esc(t.id) + '\\')">'
    + '  <button class="btn btn-sm btn-primary" onclick="sheetAddSubtask(\\'' + esc(t.id) + '\\')">Add</button>'
    + '</div></div>';

  if (atts.length > 0) {
    html += '<div class="sheet-section">'
      + '<div class="sheet-section-label">Attachments</div>'
      + (imagesHtml ? imagesHtml : '')
      + linksHtml
      + '</div>';
  }

  html += '<div class="sheet-timestamps">'
    + 'Created: ' + esc(t.created_at) + '<br>'
    + 'Updated: ' + esc(t.updated_at) + '<br>'
    + 'ID: ' + esc(t.id)
    + '</div>';

  document.getElementById('sheetBody').innerHTML = html;
}

async function sheetPatch(taskId, fields) {
  await fetch('/api/tasks/' + taskId, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(fields)
  });
  sheetDirty = true;
}

async function sheetToggleDone(taskId, currentStatus) {
  if (currentStatus === 'OPEN') {
    await fetch('/api/tasks/' + taskId + '/done', { method: 'POST' });
  } else {
    await fetch('/api/tasks/' + taskId, {
      method: 'PATCH',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ status: 'OPEN', column_name: 'To Do' })
    });
  }
  sheetDirty = true;
  openTaskSheet(taskId);
}

async function sheetDelete(taskId, title) {
  if (!confirm('Delete "' + title + '"?')) return;
  await fetch('/api/tasks/' + taskId, { method: 'DELETE' });
  sheetDirty = true;
  closeSheet();
}

async function sheetToggleSubtask(taskId, subtaskId) {
  await fetch('/api/tasks/' + taskId + '/subtasks/' + subtaskId + '/toggle', { method: 'POST' });
  sheetDirty = true;
  openTaskSheet(taskId);
}

async function sheetAddSubtask(taskId) {
  var input = document.getElementById('newSubtaskInput');
  var title = input.value.trim();
  if (!title) return;
  await fetch('/api/tasks/' + taskId + '/subtasks', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ title: title })
  });
  sheetDirty = true;
  openTaskSheet(taskId);
}

function sheetEditTitle(taskId, el) {
  var current = el.textContent;
  var input = document.createElement('input');
  input.className = 'sheet-title-input';
  input.value = current;
  el.replaceWith(input);
  input.focus();
  input.select();
  function save() {
    var newTitle = input.value.trim();
    if (newTitle && newTitle !== current) {
      sheetPatch(taskId, { title: newTitle });
    }
    openTaskSheet(taskId);
  }
  input.addEventListener('blur', save);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { openTaskSheet(taskId); }
  });
}
`;
