/**
 * FlowBoard — Agents Module
 * Agent profiles: the Settings list, the create/edit modal, and the
 * assignee picker shared by the task modal.
 *
 * An agent is a profile Claude adopts when it works a task. Profiles are
 * plain FlowBoard data, so the MCP server in mcp-server/ reads and writes
 * exactly the same records through Firebase.
 */

const Agents = (() => {
    const AGENT_COLORS = ['#6366f1','#3b82f6','#22c55e','#f59e0b','#ef4444','#ec4899','#8b5cf6','#06b6d4','#f97316','#10b981'];
    const MODELS = [
        { value: 'default', label: 'Default' },
        { value: 'opus',    label: 'Opus — deepest reasoning' },
        { value: 'sonnet',  label: 'Sonnet — balanced' },
        { value: 'haiku',   label: 'Haiku — fastest' },
    ];

    let _editingAgentId = null;
    let _selectedColor  = '#6366f1';
    let _selectedAvatar = '';

    // Which agents' Agent Activity queues are currently showing more than the
    // default 4-item preview (TASK-513) — session-only UI state, not synced.
    const _expandedQueues = new Set();

    // In-flight drag from the queue list (TASK-513 follow-up: drag-and-drop
    // reordering, and dragging a queued task onto "Current task" to swap it
    // in) — session-only, mirrors _kanbanDragTaskId's pattern in board.js.
    let _queueDragAgentId = null;
    let _queueDragTaskId  = null;

    // How often the Agent Activity tab pulls fresh agent/task state from
    // Firebase while a browser tab is just sitting open (TASK-650). Mirrors
    // chat.js's POLL_MS/_pollTimer pattern — without this, an agent working
    // through another live session (a second terminal, the MCP daemon) only
    // ever shows as "Working" here after a manual "Refresh from Cloud" or a
    // full page reload, because the local/loaded-in-memory State never knew
    // anything changed. The Settings agent list has the same problem, so the
    // poll refreshes both.
    const AGENT_POLL_MS = 30000;
    let _agentPollTimer = null;

    function rerenderDashboardIfActive() {
        if (document.getElementById('view-agents')?.classList.contains('active')) renderDashboard();
    }

    async function poll() {
        const ok = await State.loadFromFirebase();
        if (!ok) return;
        renderSettingsList();
        rerenderDashboardIfActive();
    }

    const escHtml = (s) => UI.escHtml(s);

    // Avatars are cropped to a square and downscaled before being stored as a
    // data URL — keeps them small enough for the shared Firebase record.
    const AVATAR_SIZE = 160;

    function readImageAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    // ── Crop modal ─────────────────────────────────────────
    // Lets the user pick which square of the uploaded image to keep, instead
    // of always taking a fixed center crop. The stage is a fixed-size square;
    // the image is drawn "cover"-fit and the user pans/zooms it underneath.
    const CROP_STAGE = 280;
    const CROP_MAX_ZOOM = 3;

    let _cropImg = null;
    let _cropBaseScale = 1;
    let _cropZoom = 1;
    let _cropOffsetX = 0;
    let _cropOffsetY = 0;
    let _cropDrag = null; // { startX, startY, offsetX, offsetY }

    function cropScale() {
        return _cropBaseScale * _cropZoom;
    }

    function clampCropOffsets() {
        const scale = cropScale();
        const dispW = _cropImg.naturalWidth  * scale;
        const dispH = _cropImg.naturalHeight * scale;
        _cropOffsetX = Math.min(0, Math.max(CROP_STAGE - dispW, _cropOffsetX));
        _cropOffsetY = Math.min(0, Math.max(CROP_STAGE - dispH, _cropOffsetY));
    }

    function renderCropTransform() {
        const img = document.getElementById('avatarCropImage');
        if (!img) return;
        const scale = cropScale();
        img.style.width     = `${_cropImg.naturalWidth}px`;
        img.style.height    = `${_cropImg.naturalHeight}px`;
        img.style.transform = `translate(${_cropOffsetX}px, ${_cropOffsetY}px) scale(${scale})`;
    }

    function openCropModal(dataUrl) {
        const img = new Image();
        img.onload = () => {
            _cropImg = img;
            _cropBaseScale = CROP_STAGE / Math.min(img.naturalWidth, img.naturalHeight);
            _cropZoom = 1;
            _cropOffsetX = (CROP_STAGE - img.naturalWidth  * _cropBaseScale) / 2;
            _cropOffsetY = (CROP_STAGE - img.naturalHeight * _cropBaseScale) / 2;

            const cropImgEl = document.getElementById('avatarCropImage');
            cropImgEl.src = dataUrl;
            const zoomInput = document.getElementById('avatarCropZoom');
            if (zoomInput) zoomInput.value = '1';
            renderCropTransform();

            document.getElementById('avatarCropModalScrim')?.classList.add('open');
        };
        img.onerror = () => UI.toast('Could not read that image', 'error');
        img.src = dataUrl;
    }

    function closeCropModal() {
        document.getElementById('avatarCropModalScrim')?.classList.remove('open');
        _cropImg = null;
        _cropDrag = null;
    }

    function cropPointerPos(e) {
        const point = e.touches ? e.touches[0] : e;
        return { x: point.clientX, y: point.clientY };
    }

    function onCropPointerDown(e) {
        if (!_cropImg) return;
        const pos = cropPointerPos(e);
        _cropDrag = { startX: pos.x, startY: pos.y, offsetX: _cropOffsetX, offsetY: _cropOffsetY };
        document.getElementById('avatarCropStage')?.classList.add('dragging');
        e.preventDefault();
    }

    function onCropPointerMove(e) {
        if (!_cropDrag) return;
        const pos = cropPointerPos(e);
        _cropOffsetX = _cropDrag.offsetX + (pos.x - _cropDrag.startX);
        _cropOffsetY = _cropDrag.offsetY + (pos.y - _cropDrag.startY);
        clampCropOffsets();
        renderCropTransform();
        e.preventDefault();
    }

    function onCropPointerUp() {
        _cropDrag = null;
        document.getElementById('avatarCropStage')?.classList.remove('dragging');
    }

    function onCropZoomInput(e) {
        if (!_cropImg) return;
        const oldScale = cropScale();
        // Anchor on the stage center so zooming doesn't fling the image around.
        const centerImgX = (CROP_STAGE / 2 - _cropOffsetX) / oldScale;
        const centerImgY = (CROP_STAGE / 2 - _cropOffsetY) / oldScale;
        _cropZoom = Math.min(CROP_MAX_ZOOM, Math.max(1, Number(e.target.value) || 1));
        const newScale = cropScale();
        _cropOffsetX = CROP_STAGE / 2 - centerImgX * newScale;
        _cropOffsetY = CROP_STAGE / 2 - centerImgY * newScale;
        clampCropOffsets();
        renderCropTransform();
    }

    async function applyCrop() {
        if (!_cropImg) return;
        const scale = cropScale();
        const sx    = -_cropOffsetX / scale;
        const sy    = -_cropOffsetY / scale;
        const sSide = CROP_STAGE / scale;

        const canvas = document.createElement('canvas');
        canvas.width  = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        canvas.getContext('2d').drawImage(_cropImg, sx, sy, sSide, sSide, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

        _selectedAvatar = canvas.toDataURL('image/jpeg', 0.85);
        renderAvatarPreview();
        closeCropModal();
    }

    // ── Identity helpers (shared with tasks.js / board.js / ui.js) ──
    /**
     * Who is shown on a card. An agent wins over the plain assignee string —
     * the string is kept in sync with the agent name so every legacy read site
     * (My Tasks, CSV export, command palette) still works untouched.
     */
    function assigneeFor(task) {
        if (!task) return null;
        const agent = task.agentId != null ? State.Agents.get(task.agentId) : null;
        if (agent) {
            return {
                name:    agent.name,
                badge:   agent.emoji || agent.name.charAt(0).toUpperCase(),
                color:   agent.color,
                avatar:  agent.avatar || null,
                title:   agent.role ? `${agent.name} — ${agent.role}` : agent.name,
                isAgent: true,
            };
        }
        if (!task.assignee) return null;
        return {
            name:    task.assignee,
            badge:   String(task.assignee).charAt(0).toUpperCase(),
            color:   null,
            avatar:  null,
            title:   task.assignee,
            isAgent: false,
        };
    }

    function hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    /** Avatar markup for a task's owner. sizeMod is '', '--xs' or '--sm'. */
    function assigneeChip(task, sizeMod) {
        const a = assigneeFor(task);
        if (!a) return '';
        const cls = `task-card-assignee${sizeMod ? ' task-card-assignee' + sizeMod : ''}` +
                    (a.isAgent ? ' task-card-assignee--agent' : '');
        const style = a.isAgent && !a.avatar
            ? ` style="background:${hexToRgba(a.color, 0.15)};color:${a.color};border-color:${hexToRgba(a.color, 0.4)};"`
            : '';
        const inner = a.avatar
            ? `<img src="${a.avatar}" alt="" />`
            : escHtml(a.badge);
        return `<div class="${cls}"${style} title="${escHtml(a.title)}">${inner}</div>`;
    }

    // ── Assignee picker (task modal) ───────────────────────
    /**
     * People and agents in one select. Values are namespaced `user:<name>` /
     * `agent:<id>` so a person and an agent sharing a name stay distinct.
     */
    function populateAssigneeSelect(sel, task) {
        if (!sel) return;
        const me = localStorage.getItem('username') || 'Vaibhav';

        // Every human name already in use, so editing a task assigned to a
        // legacy name doesn't silently reassign it.
        const people = new Set([me]);
        State.Tasks.getAll().forEach(t => {
            if (!t.agentId && t.assignee) people.add(t.assignee);
        });

        const agents = State.Agents.enabled();
        // A disabled agent still shows while it holds this task.
        if (task && task.agentId != null && !agents.some(a => a.id == task.agentId)) {
            const current = State.Agents.get(task.agentId);
            if (current) agents.push(current);
        }

        const peopleOpts = [...people].sort().map(n =>
            `<option value="user:${escHtml(n)}">${escHtml(n)}</option>`).join('');
        const agentOpts = agents.map(a =>
            `<option value="agent:${a.id}">${escHtml((a.emoji ? a.emoji + ' ' : '') + a.name)}</option>`).join('');

        sel.innerHTML =
            `<optgroup label="People">${peopleOpts}</optgroup>` +
            (agentOpts ? `<optgroup label="Agents">${agentOpts}</optgroup>` : '');

        sel.value = (task && task.agentId != null)
            ? `agent:${task.agentId}`
            : `user:${(task && task.assignee) || me}`;
        // A stale value (agent since deleted) leaves the select blank — fall back.
        if (!sel.value) sel.value = `user:${me}`;
    }

    /**
     * Same People/Agents option list as populateAssigneeSelect, but for a
     * project's "Default Assignee" setting — which, unlike a task, may
     * legitimately have none. Adds a leading "No default" option.
     */
    function populateDefaultAssigneeSelect(sel, selectedValue) {
        if (!sel) return;
        const me = localStorage.getItem('username') || 'Vaibhav';
        const people = new Set([me]);
        State.Tasks.getAll().forEach(t => {
            if (!t.agentId && t.assignee) people.add(t.assignee);
        });

        const peopleOpts = [...people].sort().map(n =>
            `<option value="user:${escHtml(n)}">${escHtml(n)}</option>`).join('');
        const agentOpts = State.Agents.enabled().map(a =>
            `<option value="agent:${a.id}">${escHtml((a.emoji ? a.emoji + ' ' : '') + a.name)}</option>`).join('');

        sel.innerHTML =
            `<option value="">No default</option>` +
            `<optgroup label="People">${peopleOpts}</optgroup>` +
            (agentOpts ? `<optgroup label="Agents">${agentOpts}</optgroup>` : '');

        // A stale value (agent since deleted, or person no longer in use) leaves the select blank.
        sel.value = selectedValue || '';
    }

    /** Turn the select's value back into task fields. */
    function parseAssigneeValue(raw) {
        raw = String(raw || '');
        if (raw.startsWith('agent:')) {
            const agent = State.Agents.get(Number(raw.slice(6)));
            // assignee mirrors the agent name so string-based views keep working.
            if (agent) return { agentId: agent.id, assignee: agent.name };
            return { agentId: null, assignee: localStorage.getItem('username') || 'Vaibhav' };
        }
        return { agentId: null, assignee: raw.slice(5) };
    }

    // ── Settings list ──────────────────────────────────────
    function renderSettingsList() {
        const box = document.getElementById('settingsAgentsList');
        if (!box) return;

        const agents = State.Agents.getAll();
        if (!agents.length) {
            box.innerHTML = UI.emptyState({
                icon:  'fa-robot',
                title: 'No agents yet',
                body:  'Create an agent, then assign it a task and ask Claude to work its queue.',
            });
            return;
        }

        box.innerHTML = agents.map(a => {
            const count  = State.Agents.taskCount(a.id);
            const badge  = a.avatar
                ? `<img src="${a.avatar}" alt="" />`
                : escHtml(a.emoji || a.name.charAt(0).toUpperCase());
            const status = State.Agents.statusFor(a.id);
            // "Working" requires a live session, not just a claimed task
            // (TASK-574) — an assigned-but-nobody's-there task still reads
            // as Idle here.
            const statusHtml = (status.working && status.live)
                ? `<span class="agent-row-pill agent-row-pill--working" title="${escHtml(status.currentTask?.title || '')}">
                       Working on ${escHtml(status.currentTask?.taskKey || 'a task')}
                   </span>${status.queueLength ? `<span class="agent-row-pill">+${status.queueLength} queued</span>` : ''}`
                : '<span class="agent-row-pill agent-row-pill--idle">Idle</span>';
            return `
            <div class="agent-row" data-agent-id="${a.id}">
                <div class="task-card-assignee task-card-assignee--agent agent-row-avatar"
                     style="background:${hexToRgba(a.color, 0.15)};color:${a.color};border-color:${hexToRgba(a.color, 0.4)};"
                     aria-hidden="true">${badge}</div>
                <div class="agent-row-main">
                    <div class="agent-row-name">
                        ${escHtml(a.name)}
                        ${a.enabled === false ? '<span class="agent-row-pill">Disabled</span>' : ''}
                        ${statusHtml}
                    </div>
                    <div class="agent-row-meta">
                        <code class="agent-row-slug">${escHtml(a.slug)}</code>
                        ${a.role ? ' · ' + escHtml(a.role) : ''}
                    </div>
                </div>
                <div class="agent-row-count text-muted text-sm">${count} task${count === 1 ? '' : 's'}</div>
                <button class="btn btn-ghost btn-sm" data-agent-edit="${a.id}">
                    <i class="fa-solid fa-pen" aria-hidden="true"></i> Edit
                </button>
                <button class="btn btn-ghost btn-sm" data-agent-delete="${a.id}" aria-label="Delete ${escHtml(a.name)}">
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                </button>
            </div>`;
        }).join('');

        box.querySelectorAll('[data-agent-edit]').forEach(btn => {
            btn.addEventListener('click', () => openModal(Number(btn.dataset.agentEdit)));
        });
        box.querySelectorAll('[data-agent-delete]').forEach(btn => {
            btn.addEventListener('click', () => confirmDelete(Number(btn.dataset.agentDelete)));
        });
    }

    // ── Agent Activity dashboard ────────────────────────────
    function renderDashboard() {
        const box = document.getElementById('agentsDashboardContent');
        if (!box) return;

        const agents = State.Agents.getAll();
        if (!agents.length) {
            box.innerHTML = UI.emptyState({
                icon:  'fa-robot',
                title: 'No agents yet',
                body:  'Create an agent in Settings, then assign it a task and ask Claude to work its queue.',
                action: { id: 'agentsDashAddAgent', label: 'Add an agent', icon: 'fa-plus' },
            });
            box.querySelector('#agentsDashAddAgent')?.addEventListener('click', () => openModal());
            return;
        }

        box.innerHTML = agents.map(a => {
            const status  = State.Agents.statusFor(a.id);
            const queue   = State.Agents.queue(a.id);
            const badge   = a.avatar
                ? `<img src="${a.avatar}" alt="" />`
                : escHtml(a.emoji || a.name.charAt(0).toUpperCase());

            const isWorking = status.working && status.live;

            // Project name goes in its own non-shrinking span so it survives
            // the title's ellipsis truncation instead of being cut off with it
            // (TASK-606) — a long title alone would otherwise swallow it.
            const taskLine = t => {
                const proj = t.projectId ? State.Projects.get(t.projectId) : null;
                return `<span class="agent-dash-task-title">${escHtml(t.taskKey || '')} — ${escHtml(t.title)}</span>${proj
                    ? `<span class="agent-dash-task-project">${escHtml(proj.name)}</span>` : ''}`;
            };

            const currentHtml = status.currentTask
                ? `<button type="button" class="agent-dash-task" data-open-task="${status.currentTask.id}">
                       ${taskLine(status.currentTask)}
                   </button>`
                : `<p class="agent-dash-empty">Nothing in progress</p>`;
            // A queued task can be dropped here to swap it in as the current
            // one (TASK-513 follow-up) — see the drop wiring below.
            const currentDropzoneHtml = `<div class="agent-dash-current-dropzone" data-current-dropzone="${a.id}">${currentHtml}</div>`;

            // Reordering (TASK-513) needs each item's real position in the
            // full queue, not just the visible slice, so the up/down buttons
            // and drag-and-drop stay correct whether or not the "+N more"
            // preview is expanded — see data-full-queue below.
            const expanded = _expandedQueues.has(a.id);
            const visible  = expanded ? queue : queue.slice(0, 4);
            const queueHtml = queue.length
                ? `<ul class="agent-dash-queue" data-full-queue="${queue.map(t => t.id).join(',')}">${visible.map((t, i) => {
                       const idx = queue.indexOf(t);
                       return `
                       <li class="agent-dash-queue-item" data-agent-id="${a.id}" data-task-id="${t.id}" draggable="true">
                           <span class="agent-dash-queue-handle" title="Drag to reorder" aria-hidden="true"><i class="fa-solid fa-grip-vertical"></i></span>
                           <div class="agent-dash-queue-move-group">
                               <button type="button" class="agent-dash-queue-move" data-reorder-agent="${a.id}" data-reorder-task="${t.id}" data-reorder-dir="up" title="Move up" aria-label="Move up in queue" ${idx === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                               <button type="button" class="agent-dash-queue-move" data-reorder-agent="${a.id}" data-reorder-task="${t.id}" data-reorder-dir="down" title="Move down" aria-label="Move down in queue" ${idx === queue.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
                           </div>
                           <button type="button" class="agent-dash-task" data-open-task="${t.id}">
                               ${taskLine(t)}
                           </button>
                           <button type="button" class="agent-dash-queue-setcurrent" data-setcurrent-agent="${a.id}" data-setcurrent-task="${t.id}" title="Make current task" aria-label="Make current task">
                               <i class="fa-solid fa-play"></i>
                           </button>
                       </li>`;
                   }).join('')}
                       ${queue.length > 4
                           ? `<li><button type="button" class="agent-dash-queue-toggle" data-toggle-queue="${a.id}">${expanded ? 'Show less' : `+${queue.length - 4} more`}</button></li>`
                           : ''}
                   </ul>`
                : `<p class="agent-dash-empty">Queue is empty</p>`;

            return `
            <div class="agent-dash-card${a.enabled === false ? ' agent-dash-card--disabled' : ''}">
                <div class="agent-dash-head">
                    <div class="task-card-assignee task-card-assignee--agent agent-row-avatar agent-dash-avatar${isWorking ? ' agent-dash-avatar--working' : ''}"
                         style="background:${hexToRgba(a.color, 0.15)};color:${a.color};border-color:${hexToRgba(a.color, 0.4)};"
                         aria-hidden="true">${badge}</div>
                    <div class="agent-dash-head-main">
                        <div class="agent-dash-name">${escHtml(a.name)}</div>
                        <div class="agent-row-meta">${a.role ? escHtml(a.role) : escHtml(a.slug)}</div>
                    </div>
                    ${isWorking
                        ? '<span class="agent-row-pill agent-row-pill--working agent-row-pill--pulse"><span class="agent-row-pill-dot"></span>Working</span>'
                        : '<span class="agent-row-pill agent-row-pill--idle">Idle</span>'}
                </div>
                <div class="agent-dash-section">
                    <p class="agent-dash-section-label">Current task</p>
                    ${currentDropzoneHtml}
                </div>
                <div class="agent-dash-section">
                    <p class="agent-dash-section-label">Queued${queue.length ? ` (${queue.length})` : ''}</p>
                    ${queueHtml}
                </div>
            </div>`;
        }).join('');

        box.querySelectorAll('[data-open-task]').forEach(el => {
            el.addEventListener('click', () => UI.openTaskPanel(parseInt(el.dataset.openTask, 10)));
        });

        box.querySelectorAll('[data-toggle-queue]').forEach(el => {
            el.addEventListener('click', () => {
                const id = Number(el.dataset.toggleQueue);
                if (_expandedQueues.has(id)) _expandedQueues.delete(id); else _expandedQueues.add(id);
                renderDashboard();
            });
        });

        box.querySelectorAll('[data-reorder-task]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const agentId = Number(btn.dataset.reorderAgent);
                const taskId  = Number(btn.dataset.reorderTask);
                const dir     = btn.dataset.reorderDir;
                State.Agents.reorderQueueMove(agentId, taskId, dir);
            });
        });

        // "Make current" — swap a queued task in as the agent's active one
        // without dragging (TASK-513 follow-up).
        box.querySelectorAll('[data-setcurrent-task]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const agentId = Number(btn.dataset.setcurrentAgent);
                const taskId  = Number(btn.dataset.setcurrentTask);
                State.Agents.setCurrentTask(agentId, taskId);
            });
        });

        // Drag-and-drop: reorder the queue by dragging a row, or drop one
        // onto "Current task" to swap it in (TASK-513 follow-up). Mirrors
        // board.js's kanban drag pattern (module-level drag state,
        // dragover/dragleave toggling a hover class, drop doing the write).
        box.querySelectorAll('.agent-dash-queue-item[draggable="true"]').forEach(li => {
            const agentId = Number(li.dataset.agentId);
            const taskId  = Number(li.dataset.taskId);

            li.addEventListener('dragstart', (e) => {
                _queueDragAgentId = agentId;
                _queueDragTaskId  = taskId;
                li.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(taskId));
            });

            li.addEventListener('dragend', () => {
                li.classList.remove('dragging');
                _queueDragAgentId = null;
                _queueDragTaskId  = null;
                box.querySelectorAll('.agent-dash-queue-item').forEach(x =>
                    x.classList.remove('drag-over-top', 'drag-over-bottom'));
                box.querySelectorAll('.agent-dash-current-dropzone').forEach(x =>
                    x.classList.remove('drag-over'));
            });

            li.addEventListener('dragover', (e) => {
                if (_queueDragAgentId !== agentId || _queueDragTaskId == null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect  = li.getBoundingClientRect();
                const isTop = e.clientY < rect.top + rect.height / 2;
                li.classList.toggle('drag-over-top', isTop);
                li.classList.toggle('drag-over-bottom', !isTop);
            });

            li.addEventListener('dragleave', () => {
                li.classList.remove('drag-over-top', 'drag-over-bottom');
            });

            li.addEventListener('drop', (e) => {
                e.preventDefault();
                li.classList.remove('drag-over-top', 'drag-over-bottom');
                if (_queueDragAgentId !== agentId || _queueDragTaskId == null) return;
                const dragId = _queueDragTaskId;
                if (dragId === taskId) return;

                // Reorders against the full queue (data-full-queue), not the
                // DOM's possibly-collapsed slice, so a drop lands correctly
                // even with "+N more" still collapsed.
                const ul  = li.closest('.agent-dash-queue');
                const ids = (ul?.dataset.fullQueue || '').split(',').filter(Boolean).map(Number);
                const rect  = li.getBoundingClientRect();
                const isTop = e.clientY < rect.top + rect.height / 2;

                const from = ids.indexOf(dragId);
                if (from !== -1) ids.splice(from, 1);
                let to = ids.indexOf(taskId);
                if (to === -1) to = ids.length;
                if (!isTop) to += 1;
                ids.splice(to, 0, dragId);

                State.Agents.setQueueOrder(agentId, ids);
            });
        });

        box.querySelectorAll('[data-current-dropzone]').forEach(zone => {
            const agentId = Number(zone.dataset.currentDropzone);

            zone.addEventListener('dragover', (e) => {
                if (_queueDragAgentId !== agentId || _queueDragTaskId == null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                zone.classList.add('drag-over');
            });

            zone.addEventListener('dragleave', (e) => {
                if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
            });

            zone.addEventListener('drop', (e) => {
                e.preventDefault();
                zone.classList.remove('drag-over');
                if (_queueDragAgentId !== agentId || _queueDragTaskId == null) return;
                State.Agents.setCurrentTask(agentId, _queueDragTaskId);
            });
        });
    }

    function confirmDelete(id) {
        const agent = State.Agents.get(id);
        if (!agent) return;
        const count = State.Agents.taskCount(id);
        // Say plainly that nothing is lost — only the link.
        const message = count
            ? `${count} task${count === 1 ? '' : 's'} will keep the name "${agent.name}" but will no longer be linked to this agent. No tasks are deleted.`
            : 'This agent is not assigned to any tasks.';

        UI.confirm(message, () => {
            State.Agents.delete(id);
            renderSettingsList();
            UI.toast('Agent deleted', 'success');
        }, 'Delete Agent', 'btn-danger', { title: `Delete "${agent.name}"?` });
    }

    // ── Modal ──────────────────────────────────────────────
    function openModal(agentId) {
        _editingAgentId = agentId || null;
        const agent = _editingAgentId ? State.Agents.get(_editingAgentId) : null;

        document.getElementById('agentModalTitle').textContent = agent ? 'Edit Agent' : 'New Agent';
        document.getElementById('agentModalSave').textContent  = agent ? 'Save Changes' : 'Create Agent';

        document.getElementById('agentModalName').value    = agent ? agent.name : '';
        document.getElementById('agentModalEmoji').value    = agent ? agent.emoji : '';
        document.getElementById('agentModalRole').value     = agent ? agent.role : '';
        document.getElementById('agentModalPrompt').value   = agent ? agent.systemPrompt : '';
        document.getElementById('agentModalEnabled').checked = agent ? agent.enabled !== false : true;

        const modelSel = document.getElementById('agentModalModel');
        modelSel.innerHTML = MODELS.map(m =>
            `<option value="${m.value}">${escHtml(m.label)}</option>`).join('');
        modelSel.value = agent ? agent.model : 'default';

        _selectedColor  = agent ? agent.color : AGENT_COLORS[0];
        _selectedAvatar = agent ? (agent.avatar || '') : '';
        renderColors();
        renderAvatarPreview();
        updateSlugHint();

        document.getElementById('agentModalScrim').classList.add('open');
        setTimeout(() => document.getElementById('agentModalName').focus(), 100);
    }

    function closeModal() {
        document.getElementById('agentModalScrim').classList.remove('open');
        _editingAgentId = null;
    }

    function renderColors() {
        const box = document.getElementById('agentModalColors');
        if (!box) return;
        box.innerHTML = AGENT_COLORS.map(c => `
            <button type="button" class="color-swatch${c === _selectedColor ? ' selected' : ''}"
                    style="background:${c}" data-color="${c}" aria-label="Color ${c}"></button>`).join('');
        box.querySelectorAll('[data-color]').forEach(btn => {
            btn.addEventListener('click', () => {
                _selectedColor = btn.dataset.color;
                renderColors();
                if (!_selectedAvatar) renderAvatarPreview();
            });
        });
    }

    function renderAvatarPreview() {
        const box = document.getElementById('agentModalAvatarPreview');
        const removeBtn = document.getElementById('agentModalAvatarRemove');
        if (!box) return;
        if (_selectedAvatar) {
            box.innerHTML = `<img src="${_selectedAvatar}" alt="" />`;
        } else {
            const emoji = document.getElementById('agentModalEmoji')?.value.trim();
            const name  = document.getElementById('agentModalName')?.value.trim();
            box.style.color = _selectedColor;
            box.textContent = emoji || (name ? name.charAt(0).toUpperCase() : '?');
        }
        if (removeBtn) removeBtn.hidden = !_selectedAvatar;
    }

    async function handleAvatarFile(file) {
        if (!file || !file.type.startsWith('image/')) {
            UI.toast('Choose an image file', 'error');
            return;
        }
        try {
            const raw = await readImageAsDataUrl(file);
            openCropModal(raw);
        } catch {
            UI.toast('Could not read that image', 'error');
        }
    }

    /** Show the handle Claude will use, live, so it is never a surprise. */
    function updateSlugHint() {
        const hint = document.getElementById('agentModalSlugHint');
        if (!hint) return;
        const name = document.getElementById('agentModalName').value.trim();
        const existing = _editingAgentId ? State.Agents.get(_editingAgentId) : null;
        // A rename updates the slug on save (TASK-529), so the hint previews
        // what it's about to become rather than the slug on file right now.
        const slug = (existing && (!name || name === existing.name)) ? existing.slug : slugPreview(name);
        hint.innerHTML = name || existing
            ? `Claude refers to this agent as <code>${escHtml(slug)}</code>`
            : 'Claude refers to agents by a short handle derived from the name.';
    }

    function slugPreview(name) {
        return String(name || 'agent').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
    }

    function save() {
        const name = document.getElementById('agentModalName').value.trim();
        if (!name) {
            UI.toast('Agent name is required', 'error');
            document.getElementById('agentModalName').focus();
            return;
        }

        const fields = {
            name,
            emoji:        document.getElementById('agentModalEmoji').value.trim(),
            color:        _selectedColor,
            avatar:       _selectedAvatar,
            role:         document.getElementById('agentModalRole').value.trim(),
            systemPrompt: document.getElementById('agentModalPrompt').value.trim(),
            model:        document.getElementById('agentModalModel').value,
            enabled:      document.getElementById('agentModalEnabled').checked,
        };

        if (_editingAgentId) {
            State.Agents.update(_editingAgentId, fields);
            UI.toast('Agent updated', 'success');
        } else {
            const created = State.Agents.create(fields);
            UI.toast(`Agent "${created.name}" created`, 'success');
        }

        closeModal();
        renderSettingsList();
        // Cards may show a renamed agent.
        const { view, projectId } = Router.getCurrent();
        Router.renderView(view, projectId);
    }

    // ── Init ───────────────────────────────────────────────
    function init() {
        document.getElementById('addAgentBtn')?.addEventListener('click', () => openModal());
        document.getElementById('agentModalClose')?.addEventListener('click', closeModal);
        document.getElementById('agentModalCancel')?.addEventListener('click', closeModal);
        document.getElementById('agentModalSave')?.addEventListener('click', save);
        document.getElementById('agentModalName')?.addEventListener('input', updateSlugHint);
        document.getElementById('agentModalName')?.addEventListener('input', () => {
            if (!_selectedAvatar) renderAvatarPreview();
        });
        document.getElementById('agentModalEmoji')?.addEventListener('input', () => {
            if (!_selectedAvatar) renderAvatarPreview();
        });
        document.getElementById('agentModalAvatarPick')?.addEventListener('click', () => {
            document.getElementById('agentModalAvatarInput')?.click();
        });
        document.getElementById('agentModalAvatarInput')?.addEventListener('change', e => {
            const file = e.target.files && e.target.files[0];
            if (file) handleAvatarFile(file);
            e.target.value = '';
        });
        document.getElementById('agentModalAvatarRemove')?.addEventListener('click', () => {
            _selectedAvatar = '';
            renderAvatarPreview();
        });
        document.getElementById('agentModalScrim')?.addEventListener('click', e => {
            if (e.target === document.getElementById('agentModalScrim')) closeModal();
        });

        const cropStage = document.getElementById('avatarCropStage');
        cropStage?.addEventListener('mousedown', onCropPointerDown);
        cropStage?.addEventListener('touchstart', onCropPointerDown, { passive: false });
        window.addEventListener('mousemove', onCropPointerMove);
        window.addEventListener('touchmove', onCropPointerMove, { passive: false });
        window.addEventListener('mouseup', onCropPointerUp);
        window.addEventListener('touchend', onCropPointerUp);
        document.getElementById('avatarCropZoom')?.addEventListener('input', onCropZoomInput);
        document.getElementById('avatarCropApply')?.addEventListener('click', applyCrop);
        document.getElementById('avatarCropCancel')?.addEventListener('click', closeCropModal);
        document.getElementById('avatarCropClose')?.addEventListener('click', closeCropModal);
        document.getElementById('avatarCropModalScrim')?.addEventListener('click', e => {
            if (e.target === document.getElementById('avatarCropModalScrim')) closeCropModal();
        });

        State.on('agents:changed', () => { renderSettingsList(); rerenderDashboardIfActive(); });
        State.on('tasks:changed', rerenderDashboardIfActive);

        _agentPollTimer = setInterval(poll, AGENT_POLL_MS);
    }

    return {
        init, openModal, closeModal, renderSettingsList, renderDashboard,
        assigneeFor, assigneeChip, populateAssigneeSelect, populateDefaultAssigneeSelect, parseAssigneeValue,
        COLORS: AGENT_COLORS,
    };
})();

window.Agents = Agents;
