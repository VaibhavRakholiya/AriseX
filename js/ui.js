/**
 * FlowBoard — UI Module
 * Task detail slide-in panel, toast notifications, confirm dialog,
 * command palette (Cmd+K), sidebar toggle (Cmd/Ctrl+B), theme toggle, logout, settings wiring.
 */

const UI = (() => {
    const MAX_TASK_PANELS = 2;
    let _openTaskIds      = [];
    let _fullscreenTaskId = null;
    let _confirmCb        = null;
    const _timerIntervals = new Map();
    let _dragSubtaskId     = null;
    let _dragSubtaskTaskId = null;
    let _subtaskDragAllowed = false;

    // ══════════════════════════════════════════════════════
    // FOCUS MANAGEMENT
    // ══════════════════════════════════════════════════════
    const FOCUSABLE = [
        'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])', 'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]'
    ].join(',');

    function focusableWithin(container) {
        return Array.from(container.querySelectorAll(FOCUSABLE))
            .filter(el => el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    /**
     * Confine Tab focus to `container` until the returned release() is called.
     * Restores focus to whatever was focused beforehand.
     */
    function trapFocus(container, onEscape) {
        if (!container) return () => {};
        const previous = document.activeElement;

        const first = focusableWithin(container)[0];
        // Prefer a text input if the dialog leads with one.
        const preferred = container.querySelector('input:not([type="hidden"]), textarea') || first;
        preferred?.focus();

        function onKeydown(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onEscape?.();
                return;
            }
            if (e.key !== 'Tab') return;

            const items = focusableWithin(container);
            if (!items.length) { e.preventDefault(); return; }
            const firstEl = items[0];
            const lastEl  = items[items.length - 1];

            if (e.shiftKey && document.activeElement === firstEl) {
                e.preventDefault(); lastEl.focus();
            } else if (!e.shiftKey && document.activeElement === lastEl) {
                e.preventDefault(); firstEl.focus();
            } else if (!container.contains(document.activeElement)) {
                e.preventDefault(); firstEl.focus();
            }
        }

        container.addEventListener('keydown', onKeydown, true);

        return function release() {
            container.removeEventListener('keydown', onKeydown, true);
            if (previous && document.contains(previous)) previous.focus();
        };
    }

    // Active traps, keyed by the element they guard, so open/close stays symmetric.
    const _traps = new Map();

    function beginTrap(key, container, onEscape) {
        endTrap(key);
        if (container) _traps.set(key, trapFocus(container, onEscape));
    }

    function endTrap(key) {
        const release = _traps.get(key);
        if (release) { release(); _traps.delete(key); }
    }

    // ══════════════════════════════════════════════════════
    // TOAST NOTIFICATIONS
    // ══════════════════════════════════════════════════════
    function toast(message, type = 'info', title) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const icons = {
            success: 'fa-circle-check',
            error:   'fa-circle-xmark',
            warning: 'fa-triangle-exclamation',
            info:    'fa-circle-info',
        };

        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.innerHTML = `
            <div class="toast-icon"><i class="fa-solid ${icons[type] || icons.info}"></i></div>
            <div class="toast-content">
                ${title ? `<div class="toast-title">${escHtml(title)}</div>` : ''}
                <div class="toast-message">${escHtml(message)}</div>
            </div>
            <div class="toast-close"><i class="fa-solid fa-xmark"></i></div>
        `;

        container.appendChild(el);
        el.querySelector('.toast-close').addEventListener('click', () => dismissToast(el));
        setTimeout(() => dismissToast(el), 4000);
    }

    function dismissToast(el) {
        if (!el.parentNode) return;
        el.classList.add('removing');
        setTimeout(() => el.parentNode && el.parentNode.removeChild(el), 260);
    }

    // ══════════════════════════════════════════════════════
    // CONFETTI (TASK-600 — celebrates a task landing in Done)
    // ══════════════════════════════════════════════════════
    const CONFETTI_DURATION_MS = 2200;

    /**
     * A short canvas-based burst, no library. Skipped entirely under
     * prefers-reduced-motion, same as every other animation in the app
     * (see the global @media rule in styles.css).
     */
    function celebrateConfetti() {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

        const canvas = document.createElement('canvas');
        canvas.className = 'confetti-canvas';
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');

        const style = getComputedStyle(document.documentElement);
        const colors = ['--primary', '--accent-2', '--chart-3', '--chart-4', '--status-done']
            .map(v => style.getPropertyValue(v).trim())
            .filter(Boolean);

        const COUNT = 140;
        const particles = Array.from({ length: COUNT }, () => ({
            x: Math.random() * canvas.width,
            y: -20 - Math.random() * canvas.height * 0.3,
            size: 6 + Math.random() * 6,
            color: colors[Math.floor(Math.random() * colors.length)] || '#22c55e',
            vx: (Math.random() - 0.5) * 3,
            vy: 3 + Math.random() * 4,
            rotation: Math.random() * Math.PI * 2,
            vr: (Math.random() - 0.5) * 0.3,
        }));

        const start = performance.now();
        let frameId;

        function frame(now) {
            const elapsed = now - start;
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            particles.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.06; // gravity
                p.rotation += p.vr;

                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rotation);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
                ctx.restore();
            });

            if (elapsed < CONFETTI_DURATION_MS) {
                frameId = requestAnimationFrame(frame);
            } else {
                cancelAnimationFrame(frameId);
                canvas.remove();
            }
        }
        frameId = requestAnimationFrame(frame);

        // Keep the burst covering the viewport through a resize (e.g. rotating
        // a tablet mid-animation) instead of leaving stale-sized particles.
        const onResize = () => {
            canvas.width  = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        window.addEventListener('resize', onResize);
        setTimeout(() => window.removeEventListener('resize', onResize), CONFETTI_DURATION_MS);
    }

    // ══════════════════════════════════════════════════════
    // CONFIRM DIALOG
    // ══════════════════════════════════════════════════════
    /**
     * Confirm dialog. Callback form is kept for existing callers; it also
     * returns a Promise<boolean> so new code can `await UI.confirm(...)`.
     */
    function confirm(message, callback, okLabel = 'Delete', okClass = 'btn-danger', opts = {}) {
        const scrim = document.getElementById('confirmModalScrim');
        document.getElementById('confirmMessage').textContent = message;
        document.getElementById('confirmTitle').textContent = opts.title || 'Confirm';

        const okBtn = document.getElementById('confirmOk');
        if (okBtn) {
            okBtn.textContent = okLabel;
            okBtn.className   = `btn ${okClass}`;
        }
        scrim.classList.add('open');

        return new Promise(resolve => {
            _confirmCb = (ok) => {
                if (ok && callback) callback();
                resolve(ok);
            };
            // Focus the cancel button by default — destructive dialogs should
            // never confirm on a stray Enter. (The trap itself is installed by
            // the scrim observer in installDialogObserver.)
            setTimeout(() => document.getElementById('confirmCancel')?.focus(), 0);
        });
    }

    function closeConfirm(ok = false) {
        const cb = _confirmCb;
        _confirmCb = null;
        document.getElementById('confirmModalScrim').classList.remove('open');
        if (cb) cb(ok);
    }

    // ══════════════════════════════════════════════════════
    // DIALOG OBSERVER
    // ══════════════════════════════════════════════════════
    /**
     * Every dialog in the app is a scrim that gets an `open` class. Rather than
     * ask each module to manage focus, watch the class and install/release the
     * trap centrally — so any future dialog is accessible for free.
     */
    function installDialogObserver() {
        const scrims = document.querySelectorAll('.modal-scrim, #command-palette-scrim');

        scrims.forEach(scrim => {
            const key = scrim.id || `scrim-${Math.random()}`;

            new MutationObserver(() => {
                const isOpen = scrim.classList.contains('open');
                const dialog = scrim.querySelector('.modal, .command-palette');
                if (isOpen) {
                    beginTrap(key, dialog, () => {
                        // Defer to the dialog's own close button so each module
                        // keeps ownership of its teardown.
                        const closeBtn = scrim.querySelector('.modal-close');
                        if (closeBtn) closeBtn.click();
                        else scrim.classList.remove('open');
                    });
                } else {
                    endTrap(key);
                }
            }).observe(scrim, { attributes: true, attributeFilter: ['class'] });
        });
    }

    // ══════════════════════════════════════════════════════
    // TASK DETAIL PANELS (up to 2)
    // ══════════════════════════════════════════════════════
    function maxTaskPanels() {
        return window.innerWidth <= 680 ? 1 : MAX_TASK_PANELS;
    }

    function isTaskPanelOpen(taskId) {
        return _openTaskIds.includes(taskId);
    }

    function getOpenTaskId() {
        return _openTaskIds[0] ?? null;
    }

    function getPanelElement(taskId) {
        return document.getElementById(`task-detail-panel-${taskId}`);
    }

    function ensurePanelShell(taskId) {
        if (getPanelElement(taskId)) return;
        const container = document.getElementById('task-detail-panels');
        if (!container) return;

        const panel = document.createElement('div');
        panel.className = 'task-detail-panel';
        panel.id = `task-detail-panel-${taskId}`;
        panel.dataset.taskId = String(taskId);
        panel.innerHTML = `
            <div class="panel-header">
                <button class="panel-close" type="button" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <button class="panel-expand-btn" type="button" title="Open in full window">
                    <i class="fa-solid fa-expand"></i>
                </button>
                <div class="panel-task-id" id="panelTaskId-${taskId}"></div>
                <div class="panel-actions">
                    <button class="btn btn-ghost btn-icon btn-sm" id="panelTimerBtn-${taskId}" title="Start/Stop timer">
                        <i class="fa-solid fa-play"></i>
                    </button>
                    <button class="btn btn-ghost btn-icon btn-sm" id="panelOptionsBtn-${taskId}" title="Options">
                        <i class="fa-solid fa-ellipsis-vertical"></i>
                    </button>
                </div>
            </div>
            <div class="panel-body" id="panelBody-${taskId}"></div>
        `;

        panel.querySelector('.panel-close')?.addEventListener('click', () => closeTaskPanel(taskId));
        panel.querySelector('.panel-expand-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleTaskPanelFullscreen(taskId);
        });
        panel.querySelector(`#panelTimerBtn-${taskId}`)?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            State.Timer.toggle(taskId);
            openTaskPanel(taskId);
        });
        panel.addEventListener('mousedown', () => focusTaskPanel(taskId));

        container.appendChild(panel);
    }

    function removePanelShell(taskId) {
        getPanelElement(taskId)?.remove();
    }

    function focusTaskPanel(taskId) {
        document.querySelectorAll('.task-detail-panel').forEach(el => {
            el.classList.toggle('focused', parseInt(el.dataset.taskId, 10) === taskId);
        });
    }

    function exitTaskPanelFullscreen() {
        _fullscreenTaskId = null;
        syncFullscreenState();
    }

    function toggleTaskPanelFullscreen(taskId) {
        if (_fullscreenTaskId === taskId) {
            exitTaskPanelFullscreen();
            return;
        }
        if (!isTaskPanelOpen(taskId)) openTaskPanel(taskId);
        _fullscreenTaskId = taskId;
        focusTaskPanel(taskId);
        syncFullscreenState();
    }

    function syncFullscreenState() {
        const container = document.getElementById('task-detail-panels');
        if (!container) return;

        if (_fullscreenTaskId != null && !_openTaskIds.includes(_fullscreenTaskId)) {
            _fullscreenTaskId = null;
        }

        const isFullscreen = _fullscreenTaskId != null;
        container.classList.toggle('fullscreen', isFullscreen);
        document.body.classList.toggle('task-panel-fullscreen', isFullscreen);

        document.querySelectorAll('.task-detail-panel').forEach(el => {
            const id = parseInt(el.dataset.taskId, 10);
            const isActive = isFullscreen && id === _fullscreenTaskId;
            el.classList.toggle('fullscreen-active', isActive);
            el.classList.toggle('fullscreen-hidden', isFullscreen && !isActive);
        });

        document.querySelectorAll('.panel-expand-btn').forEach(btn => {
            const panel = btn.closest('.task-detail-panel');
            const id = parseInt(panel?.dataset.taskId, 10);
            const expanded = _fullscreenTaskId === id;
            btn.title = expanded ? 'Exit full window' : 'Open in full window';
            btn.innerHTML = `<i class="fa-solid ${expanded ? 'fa-compress' : 'fa-expand'}"></i>`;
            btn.setAttribute('aria-pressed', expanded ? 'true' : 'false');
        });
    }

    function syncPanelsContainer() {
        const container = document.getElementById('task-detail-panels');
        if (!container) return;

        _openTaskIds.forEach(taskId => {
            const el = getPanelElement(taskId);
            if (el) container.appendChild(el);
        });

        container.classList.toggle('open', _openTaskIds.length > 0);
        container.classList.toggle('dual-open', _openTaskIds.length > 1 && _fullscreenTaskId == null);
        if (_openTaskIds.length) focusTaskPanel(_openTaskIds[0]);
        syncFullscreenState();
    }

    function stopPanelTimer(taskId) {
        const interval = _timerIntervals.get(taskId);
        if (interval) {
            clearInterval(interval);
            _timerIntervals.delete(taskId);
        }
    }

    function openTaskPanel(taskId) {
        const task = State.Tasks.get(taskId);
        if (!task) return;

        noteRecentTask(taskId);

        const limit = maxTaskPanels();
        const existingIdx = _openTaskIds.indexOf(taskId);
        const wasAlreadyOpen = existingIdx !== -1;
        if (existingIdx !== -1) {
            _openTaskIds.splice(existingIdx, 1);
        }
        _openTaskIds.unshift(taskId);

        if (!wasAlreadyOpen) {
            _fullscreenTaskId = taskId;
        }

        while (_openTaskIds.length > limit) {
            const removedId = _openTaskIds.pop();
            stopPanelTimer(removedId);
            removePanelShell(removedId);
        }

        ensurePanelShell(taskId);
        const panelEl = getPanelElement(taskId);
        if (!panelEl) return;

        renderPanel(task, panelEl);
        syncPanelsContainer();
    }

    function closeTaskPanel(taskId) {
        if (_openTaskIds.length === 0) return;

        const id = taskId != null ? taskId : _openTaskIds[0];
        const idx = _openTaskIds.indexOf(id);
        if (idx === -1) return;

        _openTaskIds.splice(idx, 1);
        if (_fullscreenTaskId === id) exitTaskPanelFullscreen();
        stopPanelTimer(id);
        removePanelShell(id);
        syncPanelsContainer();
    }

    function renderPanel(task, panelEl) {
        SpeechToText.stopAll();

        const tid = task.id;
        const q = (suffix) => panelEl.querySelector(`#${suffix}-${tid}`);
        const proj    = task.projectId ? State.Projects.get(task.projectId) : null;
        const col     = State.getColumnById(task.projectId, task.columnId);
        const columns = proj ? [...proj.columns].sort((a, b) => a.position - b.position) : [];
        const allLabels= [...State.Labels.getAll(), ...(proj?.labels || [])];
        const running = task.isTimerRunning;
        const elapsed = running ? State.Timer.getElapsed(task.id) : 0;

        // Panel ID
        const taskIdEl = q('panelTaskId');
        if (taskIdEl) taskIdEl.textContent = task.taskKey || `TASK-${task.id}`;

        // Timer button
        const timerBtn = q('panelTimerBtn');
        if (timerBtn) {
            timerBtn.innerHTML = `<i class="fa-solid ${running ? 'fa-stop' : 'fa-play'}"></i>`;
            timerBtn.title = running ? 'Stop timer' : 'Start timer';
            timerBtn.style.color = running ? '#22c55e' : '';
        }

        // Options button
        const optBtn = q('panelOptionsBtn');
        if (optBtn) {
            optBtn.onclick = (e) => {
                e.stopPropagation();
                showPanelOptionsMenu(e, task);
            };
        }

        const body = q('panelBody');
        if (!body) return;

        body.innerHTML = `
            <!-- Title -->
            <div class="panel-title-row">
                <div class="panel-title"
                     id="panelTitleEl-${tid}"
                     contenteditable="true"
                     spellcheck="false"
                     data-task-id="${task.id}">${escHtml(task.title)}</div>
                <button type="button" class="desc-tool-btn desc-tool-speech panel-title-speech" id="panelTitleSpeech-${tid}" title="Speech to text" aria-label="Speech to text" aria-pressed="false">
                    <i class="fa-solid fa-microphone"></i>
                </button>
            </div>

            <!-- Description -->
            <div class="panel-section panel-section-description-top">
                <div class="description-toolbar" id="panelDescToolbar-${tid}">
                    <button type="button" class="desc-tool-btn" data-cmd="bold" title="Bold"><i class="fa-solid fa-bold"></i></button>
                    <button type="button" class="desc-tool-btn" data-cmd="italic" title="Italic"><i class="fa-solid fa-italic"></i></button>
                    <button type="button" class="desc-tool-btn" data-cmd="underline" title="Underline"><i class="fa-solid fa-underline"></i></button>
                    <button type="button" class="desc-tool-btn" data-cmd="strikeThrough" title="Strikethrough"><i class="fa-solid fa-strikethrough"></i></button>
                    <span class="desc-tool-sep"></span>
                    <button type="button" class="desc-tool-btn" data-cmd="insertUnorderedList" title="Bullet list"><i class="fa-solid fa-list-ul"></i></button>
                    <button type="button" class="desc-tool-btn" data-cmd="insertOrderedList" title="Numbered list"><i class="fa-solid fa-list-ol"></i></button>
                    <button type="button" class="desc-tool-btn" id="panelDescImage-${tid}" title="Insert image">
                        <i class="fa-solid fa-image"></i>
                    </button>
                    <input type="file" id="panelDescImageInput-${tid}" accept="image/*" class="sr-only" />
                    <span class="desc-tool-sep"></span>
                    <button type="button" class="desc-tool-btn" id="panelDescCopy-${tid}" title="Copy description">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                    <span class="desc-tool-sep"></span>
                    <button type="button" class="desc-tool-btn desc-tool-speech" id="panelDescSpeech-${tid}" title="Speech to text" aria-label="Speech to text" aria-pressed="false">
                        <i class="fa-solid fa-microphone"></i>
                    </button>
                </div>
                <div class="panel-description"
                     id="panelDesc-${tid}"
                     contenteditable="true"
                     spellcheck="true"
                     data-placeholder="Add a description…"></div>
            </div>

            <!-- Subtasks -->
            <div class="panel-section panel-section-subtasks">
                <div class="panel-section-title">
                    Subtasks
                    ${buildSubtaskProgress(task)}
                </div>
                <div class="subtask-list" id="panelSubtasks-${tid}">
                    ${buildSubtaskTree(task.subtasks || [])}
                </div>
                <div class="add-subtask-row" id="addSubtaskRow-${tid}">
                    <i class="fa-solid fa-plus"></i> Add subtask
                </div>
            </div>


            <!-- Meta grid -->
            <div class="panel-meta-grid">
                <div class="panel-meta-item">
                    <div class="panel-meta-label">Status</div>
                    <div class="panel-meta-value">
                        <select class="form-control panel-meta-select" id="panelStatusSel-${tid}">
                            ${columns.map(c => `<option value="${c.id}"${c.id === task.columnId ? ' selected' : ''}
                                style="color:${c.color};">${escHtml(c.name)}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="panel-meta-item">
                    <div class="panel-meta-label">Due Date</div>
                    <div class="panel-meta-value">
                        <input type="date" class="form-control" id="panelDueDate-${tid}"
                               value="${task.dueDate || ''}"
                               class="panel-meta-input" />
                    </div>
                </div>
                <div class="panel-meta-item">
                    <label class="panel-meta-label" for="panelAssignee-${tid}">Assignee</label>
                    <div class="panel-meta-value">
                        <select class="form-control panel-meta-select" id="panelAssignee-${tid}"></select>
                    </div>
                </div>
                <div class="panel-meta-item">
                    <label class="panel-meta-label" for="panelPriority-${tid}">Priority</label>
                    <div class="panel-meta-value">
                        <select class="form-control panel-meta-select" id="panelPriority-${tid}">
                            ${Tasks.priorityOptions(task.priority)}
                        </select>
                    </div>
                </div>
                <div class="panel-meta-item">
                    <div class="panel-meta-label">Start Date</div>
                    <div class="panel-meta-value">
                        <input type="date" class="form-control" id="panelStartDate-${tid}"
                               value="${task.startDate || ''}" />
                    </div>
                </div>
                <div class="panel-meta-item">
                    <div class="panel-meta-label">Estimate (hrs)</div>
                    <div class="panel-meta-value">
                        <input type="number" class="form-control" id="panelEstimate-${tid}"
                               min="0" step="0.5" value="${task.timeEstimate ?? ''}" placeholder="—" />
                    </div>
                </div>
            </div>

            <!-- Labels -->
            <div class="panel-section">
                <div class="panel-section-title">Labels</div>
                <div class="labels-wrap" id="panelLabels-${tid}">
                    ${allLabels.map(l => {
                        const sel = (task.labels||[]).includes(l.id);
                        return `<div class="label-select-item${sel ? ' selected' : ''}"
                                     data-label-id="${l.id}"
                                     style="background:${l.bg||'rgba(99,102,241,0.1)'};color:${l.color};">
                            ${escHtml(l.name)}
                        </div>`;
                    }).join('')}
                </div>
            </div>

            <!-- Time Tracking -->
            <div class="panel-section">
                <div class="panel-section-title">Time Tracking</div>
                <div class="time-actions">
                    <button type="button" class="btn btn-primary btn-sm${running ? ' is-hidden' : ''}" id="panelBodyStartTimer-${tid}">
                        <i class="fa-solid fa-play" aria-hidden="true"></i> Start timer
                    </button>
                    <button type="button" class="btn btn-success btn-sm${running ? '' : ' is-hidden'}" id="panelBodyStopTimer-${tid}">
                        <i class="fa-solid fa-stop" aria-hidden="true"></i> Stop timer
                    </button>
                    <button type="button" class="btn btn-ghost btn-sm" id="panelLogTime-${tid}">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i> Log time
                    </button>
                </div>
                <div class="time-tracking-row">
                    <div>
                        <div class="time-display" id="panelTimeDisplay-${tid}">
                            ${Tasks.formatHours(task.timeSpent)}
                        </div>
                        <div class="time-sub">${running ? 'Running…' : 'Total spent'}</div>
                    </div>
                    ${task.timeEstimate ? `
                    <div class="time-progress-wrap">
                        <div class="time-progress-labels">
                            <span>${Tasks.formatHours(task.timeSpent)} of ${Tasks.formatHours(task.timeEstimate)}</span>
                            <span>${task.timeSpent > task.timeEstimate ? 'over estimate' : 'estimated'}</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill${task.timeSpent >= task.timeEstimate ? ' danger' : ''}"
                                 style="width:${Math.min(100, ((task.timeSpent||0)/task.timeEstimate)*100).toFixed(1)}%;">
                            </div>
                        </div>
                    </div>` : ''}
                </div>
                ${running ? `
                <div class="panel-live-timer" id="panelLiveTimer-${tid}">
                    ${Tasks.formatElapsed(elapsed)}
                </div>
                <div class="timer-note-field">
                    <label class="form-label" for="panelTimerNote-${tid}">Note for this session</label>
                    <textarea class="form-control timer-note-input" id="panelTimerNote-${tid}"
                              placeholder="What are you working on right now?" rows="2"
                              maxlength="2000">${escHtml(task.timerNote || '')}</textarea>
                    <span class="timer-note-status" id="panelTimerNoteStatus-${tid}" aria-live="polite"></span>
                </div>` : ''}

                <div class="time-entry-list" id="panelTimeEntries-${tid}">
                    ${buildTimeEntries(task)}
                </div>
            </div>

            <!-- Comments -->
            <div class="panel-section">
                <div class="panel-section-title">Comments</div>
                <div class="comment-list" id="panelComments-${tid}">
                    ${buildComments(task)}
                </div>
                <div class="add-comment-row">
                    <textarea class="form-control" id="panelCommentInput-${tid}" rows="2"
                              placeholder="Add a comment…" maxlength="4000"></textarea>
                    <button type="button" class="btn btn-primary btn-sm" id="panelCommentSubmit-${tid}">
                        <i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Comment
                    </button>
                </div>
            </div>

            <!-- Activity -->
            <div class="panel-section">
                <div class="panel-section-title">Activity</div>
                <div class="activity-feed">${buildActivityFeed(task)}</div>
            </div>

        `;

        // ── Inline event handlers ──────────────────────────

        // Title blur → save
        const titleEl = q('panelTitleEl');
        if (titleEl) {
            titleEl.addEventListener('blur', () => {
                const newTitle = titleEl.textContent.trim();
                if (newTitle && newTitle !== task.title) {
                    State.Tasks.update(task.id, { title: newTitle });
                }
            });
            titleEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });

            const titleSpeechBtn = q('panelTitleSpeech');
            if (titleSpeechBtn) SpeechToText.attach(titleSpeechBtn, titleEl);
        }

        // Status change
        q('panelStatusSel')?.addEventListener('change', (e) => {
            State.Tasks.update(task.id, { columnId: e.target.value });
            const { view, projectId } = Router.getCurrent();
            Router.renderView(view, projectId);
        });

        // Due date
        q('panelDueDate')?.addEventListener('change', (e) => {
            State.Tasks.update(task.id, { dueDate: e.target.value || null });
        });

        // Description — load, format toolbar, save
        const descEl = q('panelDesc');
        if (descEl) {
            Tasks.setDescriptionElement(descEl, task.description || '');

            q('panelDescToolbar')?.querySelectorAll('.desc-tool-btn[data-cmd]').forEach(btn => {
                btn.addEventListener('mousedown', e => {
                    e.preventDefault();
                    descEl.focus();
                    document.execCommand(btn.dataset.cmd, false, null);
                });
            });

            const speechBtn = q('panelDescSpeech');
            if (speechBtn) SpeechToText.attach(speechBtn, descEl);

            // Insert image — capture the caret before the file dialog steals
            // focus, then restore it once a file comes back.
            let pendingImageRange = null;
            q('panelDescImage')?.addEventListener('mousedown', e => {
                e.preventDefault();
                descEl.focus();
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0 && descEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                    pendingImageRange = sel.getRangeAt(0).cloneRange();
                } else {
                    pendingImageRange = document.createRange();
                    pendingImageRange.selectNodeContents(descEl);
                    pendingImageRange.collapse(false);
                }
            });
            q('panelDescImage')?.addEventListener('click', () => {
                q('panelDescImageInput')?.click();
            });
            q('panelDescImageInput')?.addEventListener('change', async e => {
                const file = e.target.files && e.target.files[0];
                e.target.value = '';
                if (!file) return;
                if (!file.type.startsWith('image/')) {
                    toast('Please choose an image file', 'warning');
                    return;
                }
                try {
                    const dataUrl = await Tasks.resizeImageForDescription(file);
                    descEl.focus();
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    if (pendingImageRange) sel.addRange(pendingImageRange);
                    document.execCommand('insertHTML', false, `<img src="${dataUrl}" alt="">`);
                    State.Tasks.update(task.id, { description: Tasks.getDescriptionFromElement(descEl) });
                } catch (err) {
                    toast('Could not read that image', 'error');
                }
            });

            descEl.addEventListener('paste', e => {
                e.preventDefault();
                const text = (e.clipboardData || window.clipboardData).getData('text/plain');
                document.execCommand('insertText', false, text);
            });

            Tasks.bindDescriptionTabKey(descEl);

            descEl.addEventListener('blur', () => {
                const next = Tasks.getDescriptionFromElement(descEl);
                if (next !== (task.description || '')) {
                    State.Tasks.update(task.id, { description: next });
                }
            });

            q('panelDescCopy')?.addEventListener('click', () => {
                copyDescriptionToClipboard(descEl);
            });
        }

        // Labels toggle
        panelEl.querySelectorAll(`#panelLabels-${tid} .label-select-item`).forEach(el => {
            el.addEventListener('click', () => {
                el.classList.toggle('selected');
                const selected = Array.from(panelEl.querySelectorAll(`#panelLabels-${tid} .label-select-item.selected`))
                    .map(x => x.dataset.labelId);
                State.Tasks.update(task.id, { labels: selected });
            });
        });

        // Subtasks (delegated — supports nested subtasks)
        const subtasksRoot = panelEl.querySelector(`#panelSubtasks-${tid}`);
        subtasksRoot?.addEventListener('click', (e) => {
            const addChildBtn = e.target.closest('.subtask-add-child');
            if (addChildBtn) {
                e.stopPropagation();
                const parentId = parseInt(addChildBtn.dataset.parentSub, 10);
                const row = addChildBtn.closest('.subtask-item') || addChildBtn;
                inlinePrompt(row, { placeholder: 'Subtask…' }).then(text => {
                    if (!text) return;
                    State.Tasks.addSubtask(task.id, text, parentId);
                    openTaskPanel(task.id);
                });
                return;
            }
            const checkbox = e.target.closest('.subtask-checkbox');
            if (checkbox) {
                State.Tasks.toggleSubtask(task.id, parseInt(checkbox.dataset.subId, 10));
                openTaskPanel(task.id);
                return;
            }
            const delBtn = e.target.closest('.subtask-delete');
            if (delBtn) {
                e.stopPropagation();
                State.Tasks.deleteSubtask(task.id, parseInt(delBtn.dataset.subDel, 10));
                openTaskPanel(task.id);
            }
        });

        subtasksRoot?.querySelectorAll('.subtask-text').forEach(el => {
            el.contentEditable = true;
            el.addEventListener('blur', () => {
                const newText = el.textContent.trim();
                const subId   = parseInt(el.dataset.subId, 10);
                if (newText) State.Tasks.updateSubtaskText(task.id, subId, newText);
            });
        });

        q('addSubtaskRow')?.addEventListener('click', (e) => {
            inlinePrompt(e.currentTarget, { placeholder: 'Subtask…' }).then(text => {
                if (!text) return;
                State.Tasks.addSubtask(task.id, text);
                openTaskPanel(task.id);
            });
        });

        attachSubtaskDragEvents(task.id, panelEl);

        function onPanelTimerToggle(e) {
            e.preventDefault();
            e.stopPropagation();
            State.Timer.toggle(task.id);
            openTaskPanel(task.id);
        }

        q('panelBodyStartTimer')?.addEventListener('click', onPanelTimerToggle);
        q('panelBodyStopTimer')?.addEventListener('click', onPanelTimerToggle);

        // Note on the running timer — debounced so every keystroke doesn't
        // hit localStorage, but nothing is lost if the tab closes mid-sentence.
        const noteEl = q('panelTimerNote');
        if (noteEl) {
            const statusEl = q('panelTimerNoteStatus');
            let noteDebounce = null;
            noteEl.addEventListener('input', () => {
                clearTimeout(noteDebounce);
                if (statusEl) statusEl.textContent = '';
                noteDebounce = setTimeout(() => {
                    State.Timer.setNote(task.id, noteEl.value);
                    if (statusEl) {
                        statusEl.textContent = 'Saved';
                        setTimeout(() => { if (statusEl.textContent === 'Saved') statusEl.textContent = ''; }, 1500);
                    }
                }, 500);
            });
            // Flush on blur so navigating away right after typing doesn't drop it.
            noteEl.addEventListener('blur', () => {
                clearTimeout(noteDebounce);
                State.Timer.setNote(task.id, noteEl.value);
            });
        }

        // Priority
        q('panelPriority')?.addEventListener('change', (e) => {
            State.Tasks.update(task.id, { priority: e.target.value });
            const { view, projectId } = Router.getCurrent();
            Router.renderView(view, projectId);
        });

        // Assignee
        const assigneeSel = q('panelAssignee');
        if (assigneeSel) {
            Agents.populateAssigneeSelect(assigneeSel, task);
            assigneeSel.addEventListener('change', (e) => {
                State.Tasks.update(task.id, Agents.parseAssigneeValue(e.target.value));
                const { view, projectId } = Router.getCurrent();
                Router.renderView(view, projectId);
            });
        }

        // Start date
        q('panelStartDate')?.addEventListener('change', (e) => {
            State.Tasks.update(task.id, { startDate: e.target.value || null });
        });

        // Time estimate (hours)
        q('panelEstimate')?.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            State.Tasks.update(task.id, { timeEstimate: Number.isFinite(val) ? val : null });
        });

        // Log time manually
        q('panelLogTime')?.addEventListener('click', async () => {
            const result = await promptTimeEntry({ title: 'Log time' });
            if (!result) return;
            State.Entries.logManual(task.id, result);
            toast(`Logged ${State.formatDuration(result.seconds)}`, 'success');
            openTaskPanel(task.id);
        });

        // Comments
        q('panelCommentSubmit')?.addEventListener('click', () => {
            const input = q('panelCommentInput');
            const text = input?.value.trim();
            if (!text) return;
            State.Tasks.addComment(task.id, text);
            openTaskPanel(task.id);
        });
        q('panelCommentInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                q('panelCommentSubmit')?.click();
            }
        });

        // Edit / delete individual entries
        q('panelTimeEntries')?.addEventListener('click', async (e) => {
            const editBtn = e.target.closest('[data-entry-edit]');
            const delBtn  = e.target.closest('[data-entry-del]');

            if (editBtn) {
                const id = Number(editBtn.dataset.entryEdit);
                const entry = State.Entries.getAll(task.id).find(x => x.id === id);
                if (!entry) return;
                const result = await promptTimeEntry({
                    title: 'Edit time entry',
                    duration: State.formatDuration(entry.duration),
                    date: (entry.startedAt || entry.date).slice(0, 10),
                    note: entry.note || '',
                });
                if (!result) return;
                State.Entries.update(task.id, id, { seconds: result.seconds, note: result.note });
                toast('Time entry updated', 'success');
                openTaskPanel(task.id);
                return;
            }

            if (delBtn) {
                const id = Number(delBtn.dataset.entryDel);
                const entry = State.Entries.getAll(task.id).find(x => x.id === id);
                if (!entry) return;
                confirm(`Delete this ${State.formatDuration(entry.duration)} entry?`, () => {
                    State.Entries.remove(task.id, id);
                    toast('Time entry deleted', 'success');
                    openTaskPanel(task.id);
                });
            }
        });

        // Live timer
        if (running) startPanelTimer(task.id);
    }

    async function copyDescriptionToClipboard(descEl) {
        const text = (descEl.innerText || '').trim();
        if (!text) {
            toast('No description to copy', 'warning');
            return;
        }
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            toast('Description copied to clipboard', 'success');
        } catch {
            toast('Could not copy description', 'error');
        }
    }

    function attachSubtaskDragEvents(taskId, panelEl) {
        const root = panelEl.querySelector(`#panelSubtasks-${taskId}`);
        if (!root) return;

        const lists = [root, ...root.querySelectorAll('.subtask-children')];
        lists.forEach((list) => {
        list.querySelectorAll(':scope > .subtask-group > .subtask-item').forEach(item => {
            const subId = parseInt(item.dataset.subId, 10);
            item.draggable = true;

            const handle = item.querySelector('.subtask-drag-handle');
            handle?.addEventListener('mousedown', () => { _subtaskDragAllowed = true; });
            handle?.addEventListener('mouseup', () => { _subtaskDragAllowed = false; });
            handle?.addEventListener('mouseleave', () => { _subtaskDragAllowed = false; });

            item.addEventListener('dragstart', (e) => {
                if (!_subtaskDragAllowed) {
                    e.preventDefault();
                    return;
                }
                _dragSubtaskId = subId;
                _dragSubtaskTaskId = taskId;
                item.classList.add('subtask-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(subId));
            });

            item.addEventListener('dragend', () => {
                _subtaskDragAllowed = false;
                _dragSubtaskId = null;
                _dragSubtaskTaskId = null;
                item.classList.remove('subtask-dragging');
                list.querySelectorAll('.subtask-item').forEach(el => {
                    el.classList.remove('subtask-drag-over-top', 'subtask-drag-over-bottom');
                });
            });

            item.addEventListener('dragover', (e) => {
                if (_dragSubtaskTaskId !== taskId || _dragSubtaskId === subId) return;
                e.preventDefault();
                const rect = item.getBoundingClientRect();
                const isTop = e.clientY < rect.top + rect.height / 2;
                item.classList.toggle('subtask-drag-over-top', isTop);
                item.classList.toggle('subtask-drag-over-bottom', !isTop);
            });

            item.addEventListener('dragleave', () => {
                item.classList.remove('subtask-drag-over-top', 'subtask-drag-over-bottom');
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('subtask-drag-over-top', 'subtask-drag-over-bottom');
                const dragId = _dragSubtaskId || parseInt(e.dataTransfer.getData('text/plain'), 10);
                const targetId = parseInt(item.dataset.subId, 10);
                if (!dragId || dragId === targetId || _dragSubtaskTaskId !== taskId) return;

                const rect = item.getBoundingClientRect();
                const insertBefore = e.clientY < rect.top + rect.height / 2;
                State.Tasks.reorderSubtask(taskId, dragId, targetId, insertBefore);
                openTaskPanel(taskId);
            });
        });
        });
    }

    function buildSubtaskProgress(task) {
        const stats = State.Tasks.subtaskStats(task);
        if (!stats.total) return '';
        const pct = Math.round((stats.done / stats.total) * 100);
        return `<span class="text-muted text-sm" style="font-weight:400;margin-left:6px;">${stats.done}/${stats.total}</span>
                <div class="progress-bar" style="width:60px;display:inline-block;vertical-align:middle;margin-left:6px;">
                    <div class="progress-fill${pct === 100 ? ' success' : ''}" style="width:${pct}%;"></div>
                </div>`;
    }

    function buildSubtaskTree(subs, depth = 0) {
        return (subs || []).map((sub) => buildSubtaskGroup(sub, depth)).join('');
    }

    function buildSubtaskGroup(sub, depth) {
        const kids = sub.subtasks || [];
        const childList = kids.length
            ? `<div class="subtask-list subtask-children">${buildSubtaskTree(kids, depth + 1)}</div>`
            : '';
        return `<div class="subtask-group">
            <div class="subtask-item" data-sub-id="${sub.id}" style="--subtask-depth:${depth}">
                <i class="fa-solid fa-grip-vertical subtask-drag-handle" title="Drag to reorder"></i>
                <div class="subtask-checkbox${sub.completed ? ' checked' : ''}" data-sub-id="${sub.id}"></div>
                <span class="subtask-text${sub.completed ? ' completed' : ''}" data-sub-id="${sub.id}">${linkify(sub.text)}</span>
                <i class="fa-solid fa-plus subtask-add-child" data-parent-sub="${sub.id}" title="Add subtask"></i>
                <i class="fa-solid fa-xmark subtask-delete" data-sub-del="${sub.id}" title="Remove subtask"></i>
            </div>
            ${childList}
        </div>`;
    }

    function startPanelTimer(taskId) {
        stopPanelTimer(taskId);
        const interval = setInterval(() => {
            const liveEl = document.getElementById(`panelLiveTimer-${taskId}`);
            if (!liveEl) { stopPanelTimer(taskId); return; }
            liveEl.textContent = Tasks.formatElapsed(State.Timer.getElapsed(taskId));
        }, 1000);
        _timerIntervals.set(taskId, interval);
    }

    function showPanelOptionsMenu(event, task) {
        document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
        const menu = document.createElement('div');
        menu.className = 'dropdown-menu open';
        menu.style.cssText = `position:fixed;top:${event.clientY+4}px;right:calc(100vw - ${event.clientX}px);z-index:600;`;
        const fsLabel = _fullscreenTaskId === task.id ? 'Exit full window' : 'Open in full window';
        const fsIcon  = _fullscreenTaskId === task.id ? 'fa-compress' : 'fa-expand';
        menu.innerHTML = `
            <div class="dropdown-item" id="pmFullscreen"><i class="fa-solid ${fsIcon}"></i> ${fsLabel}</div>
            <div class="dropdown-item" id="pmDuplicate"><i class="fa-solid fa-copy"></i> Duplicate Task</div>
            <div class="dropdown-separator"></div>
            <div class="dropdown-item danger" id="pmDelete"><i class="fa-solid fa-trash"></i> Delete Task</div>
        `;
        document.body.appendChild(menu);

        menu.querySelector('#pmFullscreen').addEventListener('click', () => {
            cleanup();
            toggleTaskPanelFullscreen(task.id);
        });
        menu.querySelector('#pmDuplicate').addEventListener('click', async () => {
            cleanup();
            const copy = await State.Tasks.duplicate(task.id);
            if (!copy) {
                toast('Could not duplicate task', 'error');
                return;
            }
            const { view, projectId } = Router.getCurrent();
            Router.renderView(view, projectId);
            openTaskPanel(copy.id);
            toast(`Duplicated "${task.title}"`, 'success');
        });
        menu.querySelector('#pmDelete').addEventListener('click', () => {
            cleanup();
            confirm(`Delete task "${task.title}"?`, () => {
                State.Tasks.delete(task.id);
                closeTaskPanel(task.id);
                const { view, projectId } = Router.getCurrent();
                Router.renderView(view, projectId);
                toast(`Task deleted`, 'success');
            });
        });

        function cleanup() { if (menu.parentNode) menu.parentNode.removeChild(menu); }
        setTimeout(() => {
            document.addEventListener('click', function h(e) {
                if (!menu.contains(e.target)) { cleanup(); document.removeEventListener('click', h); }
            });
        }, 0);
    }

    // ══════════════════════════════════════════════════════
    // COMMAND PALETTE
    // ══════════════════════════════════════════════════════
    let _cmdSelectedIdx = 0;
    let _cmdActions = [];

    function openCommandPalette() {
        const scrim = document.getElementById('command-palette-scrim');
        if (!scrim) return;
        scrim.classList.add('open');
        const input = document.getElementById('cmdPaletteInput');
        if (input) {
            input.value = '';
            input.focus();
            renderCmdResults('');
        }
    }

    function closeCommandPalette() {
        document.getElementById('command-palette-scrim')?.classList.remove('open');
        _cmdSelectedIdx = 0;
        _cmdActions = [];
    }

    function updateCmdSelection(scroll = true) {
        const container = document.getElementById('cmdPaletteResults');
        if (!container) return;
        container.querySelectorAll('.command-item').forEach(el => {
            el.classList.toggle('selected', parseInt(el.dataset.cmdItemIdx, 10) === _cmdSelectedIdx);
        });
        if (scroll) {
            container.querySelector('.command-item.selected')?.scrollIntoView({ block: 'nearest' });
        }
    }

    function activateCmdSelection() {
        _cmdActions[_cmdSelectedIdx]?.();
    }

    // ── Task search ────────────────────────────────────────
    const RECENT_KEY = 'flowboard_recent_tasks';

    function noteRecentTask(taskId) {
        try {
            const prev = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
            const next = [taskId, ...prev.filter(id => id !== taskId)].slice(0, 8);
            localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        } catch { /* storage full or blocked — recents are a nicety */ }
    }

    function recentTasks(limit) {
        try {
            const ids = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
            return ids.map(id => State.Tasks.get(id)).filter(Boolean).slice(0, limit);
        } catch { return []; }
    }

    /**
     * Subsequence match — "fob" matches "Fix onboarding". Returns a score where
     * lower is better, or null when there's no match at all.
     */
    function fuzzyScore(haystack, needle) {
        const h = haystack.toLowerCase();
        const exact = h.indexOf(needle);
        if (exact !== -1) return exact;               // substring beats fuzzy

        let hi = 0, gaps = 0, lastHit = -1;
        for (const ch of needle) {
            const found = h.indexOf(ch, hi);
            if (found === -1) return null;
            if (lastHit !== -1) gaps += found - lastHit - 1;
            lastHit = found;
            hi = found + 1;
        }
        return 1000 + gaps;                            // always ranks below substring hits
    }

    function searchTasks(q, limit) {
        const labelName = id => State.Labels.getAll().find(l => l.id === id)?.name || '';

        return State.Tasks.getAll()
            .map(t => {
                // Weighted so a title hit always outranks a description hit.
                const fields = [
                    [t.title, 0],
                    [t.taskKey || '', 5],
                    [t.assignee || '', 40],
                    [(t.labels || []).map(labelName).join(' '), 60],
                    [String(t.description || '').replace(/<[^>]*>/g, ' '), 80],
                ];

                let best = null;
                for (const [text, weight] of fields) {
                    if (!text) continue;
                    const s = fuzzyScore(text, q);
                    if (s != null) best = best == null ? s + weight : Math.min(best, s + weight);
                }
                return best == null ? null : { task: t, score: best };
            })
            .filter(Boolean)
            .sort((a, b) => a.score - b.score)
            .slice(0, limit)
            .map(x => x.task);
    }

    function renderCmdResults(query) {
        const container = document.getElementById('cmdPaletteResults');
        if (!container) return;

        const q = query.toLowerCase().trim();
        let html = '';
        _cmdActions = [];
        let itemIdx = 0;

        // ── Navigation commands ────────────────────────────
        const navCmds = [
            { icon: 'fa-gauge-high',     label: 'Dashboard',        action: () => { closeCommandPalette(); Router.navigate('dashboard'); } },
            { icon: 'fa-check-circle',   label: 'My Tasks',         action: () => { closeCommandPalette(); Router.navigate('mytasks'); } },
            { icon: 'fa-chart-gantt',    label: 'Timeline',         action: () => { closeCommandPalette(); Router.navigate('timeline'); } },
            { icon: 'fa-chart-bar',      label: 'Reports',          action: () => { closeCommandPalette(); Router.navigate('reports'); } },
            { icon: 'fa-plus',           label: 'New Task',         action: () => { closeCommandPalette(); Tasks.openModal(); }, kbd: ['N'] },
            { icon: 'fa-diagram-project',label: 'New Project',      action: () => { closeCommandPalette(); Projects.openModal(); } },
        ];

        const filteredCmds = q ? navCmds.filter(c => c.label.toLowerCase().includes(q)) : navCmds;

        if (filteredCmds.length) {
            html += `<div class="command-group-title">Actions</div>`;
            html += filteredCmds.map(cmd => {
                const idx = itemIdx++;
                _cmdActions.push(cmd.action);
                return `
                <div class="command-item" data-cmd-item-idx="${idx}">
                    <i class="fa-solid ${cmd.icon}"></i>
                    <span class="command-item-label">${cmd.label}</span>
                    ${cmd.kbd ? `<div class="command-item-kbd">${cmd.kbd.map(k=>`<kbd>${k}</kbd>`).join('')}</div>` : ''}
                </div>`;
            }).join('');
        }

        // ── Projects ───────────────────────────────────────
        const projects = State.Projects.getAll().filter(p => !q || p.name.toLowerCase().includes(q));
        if (projects.length) {
            html += `<div class="command-group-title">Projects</div>`;
            html += projects.map(p => {
                const idx = itemIdx++;
                _cmdActions.push(() => {
                    closeCommandPalette();
                    Router.navigate('board', p.id);
                });
                return `
                <div class="command-item" data-cmd-item-idx="${idx}">
                    <i class="fa-solid fa-folder" aria-hidden="true"></i>
                    <span class="command-item-label">${escHtml(p.name)}</span>
                    <span class="command-item-sub">Tasks</span>
                </div>`;
            }).join('');
        }

        // ── Tasks ──────────────────────────────────────────
        // With no query, show what was opened recently; otherwise rank matches
        // across title, key, description, assignee and labels.
        const tasks = q ? searchTasks(q, 12) : recentTasks(5);
        if (tasks.length) {
            html += `<div class="command-group-title">${q ? 'Tasks' : 'Recent'}</div>`;
            html += tasks.map(t => {
                const idx = itemIdx++;
                _cmdActions.push(() => {
                    closeCommandPalette();
                    openTaskPanel(t.id);
                });
                const proj = t.projectId ? State.Projects.get(t.projectId) : null;
                return `
                <div class="command-item" data-cmd-item-idx="${idx}">
                    <i class="fa-solid fa-list-check" aria-hidden="true"></i>
                    <span class="command-item-key">${escHtml(t.taskKey || '')}</span>
                    <span class="command-item-label">${escHtml(t.title)}</span>
                    <span class="command-item-sub">${proj ? escHtml(proj.name) : ''}</span>
                </div>`;
            }).join('');
        }

        if (!html) {
            html = `<div class="command-palette-empty">No results for "${escHtml(query)}"</div>`;
        }

        _cmdSelectedIdx = 0;
        container.innerHTML = html;

        container.querySelectorAll('[data-cmd-item-idx]').forEach(el => {
            const idx = parseInt(el.dataset.cmdItemIdx, 10);
            el.addEventListener('click', () => _cmdActions[idx]?.());
            el.addEventListener('mouseenter', () => {
                _cmdSelectedIdx = idx;
                updateCmdSelection(false);
            });
        });

        updateCmdSelection(false);
    }

    // ══════════════════════════════════════════════════════
    // THEME TOGGLE
    // ══════════════════════════════════════════════════════
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('flowboard-theme', theme);
        const icon = document.getElementById('headerThemeIcon');
        if (icon) icon.className = `fa-solid ${theme === 'dark' ? 'fa-sun' : 'fa-moon'}`;

        // Sync settings chips
        document.querySelectorAll('[data-theme-pick]').forEach(btn => {
            const on = btn.dataset.themePick === theme;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-pressed', String(on));
        });

        document.querySelector('meta[name="theme-color"]')
            ?.setAttribute('content', theme === 'dark' ? '#0b0a12' : '#faf9ff');
    }

    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        applyTheme(current === 'dark' ? 'light' : 'dark');
    }

    function isTypingShortcutTarget(el) {
        if (!el || !el.tagName) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        return !!el.isContentEditable;
    }

    /** Toggle left nav: mobile drawer vs desktop collapsed rail (same as header button). */
    function toggleAppSidebar() {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        let expanded;
        if (window.innerWidth <= 680) {
            expanded = sidebar.classList.toggle('mobile-open');
            document.getElementById('mobileSidebarOverlay')?.classList.toggle('visible');
        } else {
            expanded = !sidebar.classList.toggle('collapsed');
        }
        document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(expanded));
    }

    // ══════════════════════════════════════════════════════
    // SYNC STATUS
    // ══════════════════════════════════════════════════════
    /**
     * Cloud sync is last-write-wins with no conflict handling, so the least we
     * can do is make its state visible rather than silent.
     */
    function installSyncStatus() {
        const el    = document.getElementById('syncStatus');
        const label = document.getElementById('syncLabel');
        if (!el || !label) return;

        let settleTimer = null;
        function set(state, text) {
            clearTimeout(settleTimer);
            el.dataset.state = state;
            label.textContent = text;
            el.title = text;
            if (state === 'ok') {
                settleTimer = setTimeout(() => {
                    el.dataset.state = 'idle';
                    label.textContent = 'Saved';
                }, 2000);
            }
        }

        State.on('sync:pending', () => set('pending', 'Unsaved changes'));
        State.on('sync:start',   () => set('syncing', 'Syncing…'));
        State.on('sync:ok',      () => set('ok', 'Synced'));
        State.on('sync:offline', () => set('offline', 'Offline — saved locally'));
        State.on('sync:error',   () => set('error', 'Sync failed — saved locally'));

        window.addEventListener('offline', () => set('offline', 'Offline — saved locally'));
        window.addEventListener('online',  () => set('idle', 'Saved'));
    }

    // ══════════════════════════════════════════════════════
    // TIME ENTRIES
    // ══════════════════════════════════════════════════════
    function fmtEntryDate(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return sameDay ? `Today, ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
    }

    function buildTimeEntries(task) {
        const entries = State.Entries.getAll(task.id);
        if (!entries.length) {
            return `<p class="time-entry-empty">No time logged yet.</p>`;
        }
        return entries.map(e => `
            <div class="time-entry" data-entry-id="${e.id}">
                <div class="time-entry-main">
                    <span class="time-entry-duration">${State.formatDuration(e.duration)}</span>
                    <span class="time-entry-date">${escHtml(fmtEntryDate(e.startedAt || e.date))}</span>
                    ${e.source === 'manual' ? '<span class="time-entry-tag">manual</span>' : ''}
                    ${e.source === 'recovered' ? '<span class="time-entry-tag">recovered</span>' : ''}
                </div>
                ${e.note ? `<div class="time-entry-note">${linkify(e.note)}</div>` : ''}
                <div class="time-entry-actions">
                    <button type="button" class="btn btn-ghost btn-icon btn-sm" data-entry-edit="${e.id}"
                            aria-label="Edit this time entry" title="Edit">
                        <i class="fa-solid fa-pen" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="btn btn-ghost btn-icon btn-sm" data-entry-del="${e.id}"
                            aria-label="Delete this time entry" title="Delete">
                        <i class="fa-solid fa-trash" aria-hidden="true"></i>
                    </button>
                </div>
            </div>`).join('');
    }

    /** Parse "1h 30m", "90m", "1.5h", "1:30" into seconds. */
    function parseDuration(input) {
        const s = String(input || '').trim().toLowerCase();
        if (!s) return null;

        const clock = s.match(/^(\d+):([0-5]?\d)$/);
        if (clock) return (+clock[1]) * 3600 + (+clock[2]) * 60;

        let total = 0, matched = false;
        const h = s.match(/([\d.]+)\s*h/);
        const m = s.match(/([\d.]+)\s*m/);
        if (h) { total += parseFloat(h[1]) * 3600; matched = true; }
        if (m) { total += parseFloat(m[1]) * 60;   matched = true; }
        if (matched) return Math.round(total);

        const bare = parseFloat(s);
        if (Number.isNaN(bare)) return null;
        return Math.round(bare * 3600);   // a bare number means hours
    }

    /** Dialog for adding or editing one entry. Resolves null on cancel. */
    function promptTimeEntry({ title, duration = '', date = '', note = '' }) {
        return new Promise(resolve => {
            const scrim = document.createElement('div');
            scrim.className = 'modal-scrim open';
            scrim.innerHTML = `
                <div class="modal modal--sm" role="dialog" aria-modal="true" aria-labelledby="logTimeTitle">
                    <div class="modal-header">
                        <h2 class="modal-title" id="logTimeTitle">${escHtml(title)}</h2>
                        <button class="modal-close" data-close aria-label="Close dialog">
                            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                        </button>
                    </div>
                    <form class="modal-body" id="logTimeForm">
                        <div class="form-group">
                            <label class="form-label" for="logTimeDuration">Duration</label>
                            <input class="form-control" id="logTimeDuration" value="${escHtml(duration)}"
                                   placeholder="1h 30m" autocomplete="off" required />
                            <span class="form-hint">Accepts <code>1h 30m</code>, <code>90m</code>, <code>1.5</code> or <code>1:30</code>.</span>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="logTimeDate">Date</label>
                            <input class="form-control" type="date" id="logTimeDate"
                                   value="${escHtml(date || new Date().toISOString().slice(0, 10))}" />
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="logTimeNote">Note <span class="text-muted">(optional)</span></label>
                            <input class="form-control" id="logTimeNote" value="${escHtml(note)}" placeholder="What did you work on?" />
                        </div>
                        <p class="form-error is-hidden" id="logTimeError"></p>
                    </form>
                    <div class="modal-footer">
                        <button class="btn btn-ghost" type="button" data-close>Cancel</button>
                        <button class="btn btn-primary" type="submit" form="logTimeForm">Save</button>
                    </div>
                </div>`;
            document.body.appendChild(scrim);

            const release = trapFocus(scrim.querySelector('.modal'), () => finish(null));
            function finish(result) {
                release();
                scrim.remove();
                resolve(result);
            }

            scrim.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => finish(null)));
            scrim.addEventListener('click', e => { if (e.target === scrim) finish(null); });

            scrim.querySelector('#logTimeForm').addEventListener('submit', e => {
                e.preventDefault();
                const seconds = parseDuration(scrim.querySelector('#logTimeDuration').value);
                const err = scrim.querySelector('#logTimeError');
                if (!seconds || seconds <= 0) {
                    err.textContent = 'Enter a duration like 1h 30m, 90m, or 1.5.';
                    err.classList.remove('is-hidden');
                    return;
                }
                finish({
                    seconds,
                    date: scrim.querySelector('#logTimeDate').value,
                    note: scrim.querySelector('#logTimeNote').value.trim(),
                });
            });
        });
    }

    // ══════════════════════════════════════════════════════
    // ACTIVITY FEED
    // ══════════════════════════════════════════════════════
    const ACTIVITY_LABELS = {
        task_created: 'created this task',
        task_moved:   'moved this task',
        task_deleted: 'deleted a task',
        task_updated: 'updated this task',
        project_created: 'created the project',
    };

    function buildActivityFeed(task) {
        const all = State.Activity.getAll() || [];
        const mine = all
            .filter(a => !task || a.taskTitle === task.title)
            .slice(-12)
            .reverse();

        if (!mine.length) return `<p class="activity-empty">No activity recorded yet.</p>`;

        return mine.map(a => `
            <div class="activity-item">
                <span class="activity-avatar" aria-hidden="true">${escHtml((a.user || 'U')[0].toUpperCase())}</span>
                <div class="activity-body">
                    <span class="activity-text">
                        <strong>${escHtml(a.user || 'Someone')}</strong>
                        ${escHtml(ACTIVITY_LABELS[a.action] || a.action || 'made a change')}
                        ${a.extra ? `<span class="activity-extra">${escHtml(a.extra)}</span>` : ''}
                    </span>
                    <time class="activity-time">${escHtml(timeAgo(a.at))}</time>
                </div>
            </div>`).join('');
    }

    // ══════════════════════════════════════════════════════
    // COMMENTS
    // ══════════════════════════════════════════════════════
    function buildComments(task) {
        const comments = task.comments || [];
        if (!comments.length) return `<p class="comment-empty">No comments yet.</p>`;

        return comments.map(c => `
            <div class="comment-item">
                <span class="comment-avatar" aria-hidden="true">${escHtml((c.author || 'U')[0].toUpperCase())}</span>
                <div class="comment-body">
                    <div class="comment-meta">
                        <strong class="comment-author">${escHtml(c.author || 'Someone')}</strong>
                        <time class="comment-time">${escHtml(timeAgo(c.createdAt))}</time>
                    </div>
                    <div class="comment-text">${linkify(c.text)}</div>
                </div>
            </div>`).join('');
    }

    // ══════════════════════════════════════════════════════
    // KEYBOARD SHORTCUTS
    // ══════════════════════════════════════════════════════
    /**
     * Rows are [keys, description, handler]. `keys` is what the help sheet
     * shows; matching is done by the handler's own guard below.
     */
    const SHORTCUTS = [
        { group: 'General', keys: ['⌘', 'K'], desc: 'Search / command palette' },
        { group: 'General', keys: ['N'],      desc: 'New task' },
        { group: 'General', keys: ['⌘', 'B'], desc: 'Toggle sidebar' },
        { group: 'General', keys: ['?'],      desc: 'This help sheet' },
        { group: 'General', keys: ['Esc'],    desc: 'Close panel or dialog' },
        { group: 'Navigation', keys: ['G', 'D'], desc: 'Go to Dashboard' },
        { group: 'Navigation', keys: ['G', 'M'], desc: 'Go to My Tasks' },
        { group: 'Navigation', keys: ['G', 'T'], desc: 'Go to Timeline' },
        { group: 'Navigation', keys: ['G', 'R'], desc: 'Go to Reports' },
        { group: 'Navigation', keys: ['G', 'S'], desc: 'Go to Settings' },
        { group: 'Task list', keys: ['J'], desc: 'Focus next task' },
        { group: 'Task list', keys: ['K'], desc: 'Focus previous task' },
        { group: 'Task list', keys: ['Enter'], desc: 'Open focused task' },
        { group: 'Task list', keys: ['T'], desc: 'Start / stop timer on focused task' },
        { group: 'Dialogs', keys: ['⌘', 'Enter'], desc: 'Save and close' },
    ];

    const GOTO_ROUTES = { d: 'dashboard', m: 'mytasks', t: 'timeline', r: 'reports', s: 'settings' };
    let _gotoArmed = false;
    let _gotoTimer = null;

    function anyOverlayOpen() {
        return !!document.querySelector('.modal-scrim.open, #command-palette-scrim.open, #shortcutsScrim.open');
    }

    /** Rows in the current view that J/K can walk. */
    function focusableRows() {
        const view = document.querySelector('.view.active');
        if (!view) return [];
        return Array.from(view.querySelectorAll('[data-task-id]'))
            .filter(el => el.offsetParent !== null);
    }

    function moveRowFocus(delta) {
        const rows = focusableRows();
        if (!rows.length) return;
        const current = rows.indexOf(document.activeElement.closest('[data-task-id]'));
        const next = current === -1
            ? (delta > 0 ? 0 : rows.length - 1)
            : Math.min(rows.length - 1, Math.max(0, current + delta));
        rows[next].focus();
        rows[next].scrollIntoView({ block: 'nearest' });
    }

    function focusedTaskId() {
        const el = document.activeElement?.closest('[data-task-id]');
        if (!el) return null;
        const id = parseInt(el.dataset.taskId, 10);
        return Number.isNaN(id) ? null : id;
    }

    function installShortcuts() {
        document.addEventListener('keydown', (e) => {
            // ── Modifier shortcuts work even while typing ──
            const mod = e.metaKey || e.ctrlKey;

            if (mod && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                openCommandPalette();
                return;
            }

            if (e.key === 'Escape') {
                if (document.getElementById('command-palette-scrim')?.classList.contains('open')) {
                    closeCommandPalette();
                } else if (document.getElementById('shortcutsScrim')?.classList.contains('open')) {
                    closeShortcutsSheet();
                } else if (_fullscreenTaskId != null) {
                    closeTaskPanel(_fullscreenTaskId);
                } else if (document.getElementById('task-detail-panels')?.classList.contains('open')) {
                    closeTaskPanel();
                }
                return;
            }

            // ── Everything below is inert while typing ──
            if (isTypingShortcutTarget(e.target)) return;

            if (mod && e.key.toLowerCase() === 'b') {
                e.preventDefault();
                toggleAppSidebar();
                return;
            }

            if (mod) return;            // leave other browser shortcuts alone
            if (anyOverlayOpen()) return;

            const key = e.key.toLowerCase();

            // G-then-key navigation
            if (_gotoArmed) {
                disarmGoto();
                const route = GOTO_ROUTES[key];
                if (route) { e.preventDefault(); Router.navigate(route); }
                return;
            }
            if (key === 'g') {
                _gotoArmed = true;
                clearTimeout(_gotoTimer);
                _gotoTimer = setTimeout(disarmGoto, 1500);
                return;
            }

            switch (key) {
                case 'n':
                    e.preventDefault();
                    Tasks.openModal();
                    break;
                case '?':
                case '/':
                    if (e.key === '?' || e.shiftKey) { e.preventDefault(); openShortcutsSheet(); }
                    break;
                case 'j':
                    e.preventDefault(); moveRowFocus(1);
                    break;
                case 'k':
                    e.preventDefault(); moveRowFocus(-1);
                    break;
                case 'enter': {
                    const id = focusedTaskId();
                    if (id != null) { e.preventDefault(); openTaskPanel(id); }
                    break;
                }
                case 't': {
                    const id = focusedTaskId();
                    if (id == null) break;
                    e.preventDefault();
                    const task = State.Tasks.get(id);
                    if (!task) break;
                    task.isTimerRunning ? State.Timer.stop(id) : State.Timer.start(id);
                    break;
                }
            }
        });
    }

    function disarmGoto() {
        _gotoArmed = false;
        clearTimeout(_gotoTimer);
    }

    // ── Shortcuts help sheet (built on demand) ─────────────
    function openShortcutsSheet() {
        let scrim = document.getElementById('shortcutsScrim');
        if (!scrim) {
            scrim = document.createElement('div');
            scrim.className = 'modal-scrim';
            scrim.id = 'shortcutsScrim';

            const groups = [...new Set(SHORTCUTS.map(s => s.group))];
            scrim.innerHTML = `
                <div class="modal shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcutsTitle">
                    <div class="modal-header">
                        <h2 class="modal-title" id="shortcutsTitle">Keyboard shortcuts</h2>
                        <button class="modal-close" id="shortcutsClose" aria-label="Close dialog">
                            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                        </button>
                    </div>
                    <div class="modal-body">
                        ${groups.map(g => `
                            <div class="shortcuts-group">
                                <h3 class="shortcuts-group-title">${escHtml(g)}</h3>
                                ${SHORTCUTS.filter(s => s.group === g).map(s => `
                                    <div class="shortcuts-row">
                                        <span class="shortcuts-desc">${escHtml(s.desc)}</span>
                                        <span class="shortcuts-keys">
                                            ${s.keys.map(k => `<kbd>${escHtml(k)}</kbd>`).join('')}
                                        </span>
                                    </div>`).join('')}
                            </div>`).join('')}
                    </div>
                </div>`;
            document.body.appendChild(scrim);

            scrim.querySelector('#shortcutsClose').addEventListener('click', closeShortcutsSheet);
            scrim.addEventListener('click', e => { if (e.target === scrim) closeShortcutsSheet(); });
        }
        scrim.classList.add('open');
        beginTrap('shortcuts', scrim.querySelector('.modal'), closeShortcutsSheet);
    }

    function closeShortcutsSheet() {
        endTrap('shortcuts');
        document.getElementById('shortcutsScrim')?.classList.remove('open');
    }

    // ══════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════
    function init() {
        installShortcuts();
        installDialogObserver();

        // ── Timer safety ───────────────────────────────────
        // A timer that survived a tab close must never log its full wall-clock
        // span silently — 14 hours of "work" is how time data gets ruined.
        State.on('timer:stale', ({ taskId, elapsedMs }) => {
            const task = State.Tasks.get(taskId);
            if (!task) return;
            const hours = (elapsedMs / 3600000).toFixed(1);

            confirm(
                `The timer for "${task.title}" has been running for ${hours} hours — probably since the app was last closed. ` +
                `Discard it, or log a corrected amount?`,
                async () => {
                    const result = await promptTimeEntry({
                        title: 'Log corrected time',
                        note: State.Timer.getNote(taskId),
                    });
                    if (!result) { State.Timer.discard(taskId); toast('Timer discarded', 'info'); return; }
                    State.Timer.setNote(taskId, result.note);
                    State.Timer.stop(taskId, result.seconds);
                    toast(`Logged ${State.formatDuration(result.seconds)}`, 'success');
                    const { view, projectId } = Router.getCurrent();
                    Router.renderView(view, projectId);
                },
                'Log corrected time',
                'btn-primary',
                { title: 'Timer left running' }
            ).then(ok => {
                if (!ok) {
                    State.Timer.discard(taskId);
                    toast('Timer discarded — no time logged', 'info');
                }
            });
        });

        State.on('timer:idle', ({ taskId, idleMs }) => {
            const task = State.Tasks.get(taskId);
            if (!task) return;
            toast(
                `No activity for ${Math.round(idleMs / 60000)} minutes — the timer for "${task.title}" is still running.`,
                'warning',
                'Still working?'
            );
        });

        State.on('tasks:rescued', ({ count, projectName }) => {
            toast(
                `${count} task${count === 1 ? '' : 's'} had no valid project and ${count === 1 ? 'was' : 'were'} moved to "${projectName}".`,
                'warning',
                'Tasks recovered'
            );
        });

        // Keep panels in sync when timer is started from board / list / elsewhere
        State.on('timer:started', (taskId) => {
            if (isTaskPanelOpen(taskId)) openTaskPanel(taskId);
        });

        // Timer stopped → refresh panel
        State.on('timer:stopped', (taskId) => {
            stopPanelTimer(taskId);
            if (isTaskPanelOpen(taskId)) openTaskPanel(taskId);
        });

        // Tasks changed → refresh panel if open
        State.on('tasks:changed', ({ type, task, oldTask }) => {
            if (task && isTaskPanelOpen(task.id) && type === 'update') {
                // Lightweight refresh: update title/status without re-rendering
            }

            // A task landing in Done (however it got moved — kanban drag, the
            // list-view status dropdown, or the task panel) gets a one-off
            // celebration. Only on the transition into Done, not every edit
            // to a task that was already sitting there (TASK-600).
            if (type === 'update' && task && oldTask
                && task.columnId !== oldTask.columnId
                && window.Tasks?.isDoneColumn(task) && !window.Tasks.isDoneColumn(oldTask)) {
                celebrateConfetti();
            }
        });

        // ── Command Palette ────────────────────────────────
        document.getElementById('cmdPaletteTrigger')?.addEventListener('click', openCommandPalette);
        document.getElementById('command-palette-scrim')?.addEventListener('click', (e) => {
            if (e.target === document.getElementById('command-palette-scrim')) closeCommandPalette();
        });
        document.getElementById('cmdPaletteInput')?.addEventListener('input', (e) => {
            renderCmdResults(e.target.value);
        });
        document.getElementById('cmdPaletteInput')?.addEventListener('keydown', (e) => {
            if (!_cmdActions.length) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                _cmdSelectedIdx = (_cmdSelectedIdx + 1) % _cmdActions.length;
                updateCmdSelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                _cmdSelectedIdx = (_cmdSelectedIdx - 1 + _cmdActions.length) % _cmdActions.length;
                updateCmdSelection();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                activateCmdSelection();
            }
        });

        // ── Confirm dialog ─────────────────────────────────
        document.getElementById('confirmOk')?.addEventListener('click', () => closeConfirm(true));
        document.getElementById('confirmCancel')?.addEventListener('click', () => closeConfirm(false));
        document.getElementById('confirmModalClose')?.addEventListener('click', () => closeConfirm(false));
        document.getElementById('confirmModalScrim')?.addEventListener('click', e => {
            if (e.target === document.getElementById('confirmModalScrim')) closeConfirm(false);
        });

        // ── Dashboard header buttons ───────────────────────
        document.getElementById('dashAddTaskBtn')?.addEventListener('click', () => Tasks.openModal());
        document.getElementById('dashShortcutsBtn')?.addEventListener('click', openShortcutsSheet);

        // ── Theme toggle ───────────────────────────────────
        document.getElementById('themeToggleBtn')?.addEventListener('click', toggleTheme);

        // Initial theme icon
        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        const icon  = document.getElementById('headerThemeIcon');
        if (icon) icon.className = `fa-solid ${theme === 'dark' ? 'fa-sun' : 'fa-moon'}`;

        // Settings theme pickers
        document.querySelectorAll('[data-theme-pick]').forEach(btn => {
            btn.addEventListener('click', () => applyTheme(btn.dataset.themePick));
        });

        // ── Logout ─────────────────────────────────────────
        function doLogout() {
            // Best-effort — the app must still land back on the login page
            // even if this fails (offline, SDK not loaded), so it's not
            // awaited (TASK-584).
            if (window.firebase?.auth) firebase.auth().signOut().catch(() => {});
            localStorage.removeItem('isLoggedIn');
            localStorage.removeItem('loginTime');
            window.location.href = 'login.html';
        }
        document.getElementById('logoutBtn')?.addEventListener('click', doLogout);
        document.getElementById('settingsLogoutBtn')?.addEventListener('click', doLogout);

        // Sidebar user menu
        document.getElementById('sidebarUser')?.addEventListener('click', (e) => {
            if (e.target.closest('#logoutBtn')) return;
            Router.navigate('settings');
        });

        // ── Sync status indicator ──────────────────────────
        installSyncStatus();

        // ── Export / Import / Clear Data ───────────────────
        document.getElementById('refreshCloudBtn')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            const loaded = await State.loadFromFirebase();
            btn.disabled = false;
            if (!loaded) { toast('Could not reach the cloud', 'error'); return; }
            Projects.renderSidebar();
            const { view, projectId } = Router.getCurrent();
            Router.renderView(view, projectId);
            toast('Refreshed from cloud', 'success');
        });

        document.getElementById('exportDataBtn')?.addEventListener('click', () => {
            State.exportData();
            toast('Data exported', 'success');
        });

        const importInput = document.getElementById('importDataInput');
        document.getElementById('importDataBtn')?.addEventListener('click', () => importInput?.click());

        importInput?.addEventListener('change', async () => {
            const file = importInput.files?.[0];
            importInput.value = '';           // allow re-picking the same file
            if (!file) return;

            const text = await file.text();
            const check = State.inspectImport(text);
            if (!check.ok) {
                toast(check.error, 'error', 'Import failed');
                return;
            }

            const { projects, tasks } = check.summary;
            confirm(
                `This file has ${projects} project${projects === 1 ? '' : 's'} and ${tasks} task${tasks === 1 ? '' : 's'}. ` +
                `Importing replaces everything currently in this workspace.`,
                () => {
                    State.importData(check.data);
                    Projects.renderSidebar();
                    Router.navigate('mytasks');
                    toast(`Imported ${tasks} tasks across ${projects} projects`, 'success');
                },
                'Replace and import',
                'btn-primary',
                { title: 'Import data' }
            );
        });

        document.getElementById('clearDataBtn')?.addEventListener('click', () => {
            confirm('Clear ALL data? This cannot be undone.', () => {
                State.clearAll();
                Projects.renderSidebar();
                Router.navigate('mytasks');
                toast('All data cleared', 'warning');
            });
        });

        // ── Sidebar toggle ─────────────────────────────────
        const sidebar = document.getElementById('sidebar');
        document.getElementById('sidebarToggle')?.addEventListener('click', toggleAppSidebar);

        document.getElementById('mobileSidebarOverlay')?.addEventListener('click', () => {
            sidebar.classList.remove('mobile-open');
            document.getElementById('mobileSidebarOverlay')?.classList.remove('visible');
        });

        // ── User display ───────────────────────────────────
        const username  = localStorage.getItem('username') || 'Vaibhav';
        const initial   = username[0].toUpperCase();
        const avatarEl  = document.getElementById('sidebarUserAvatar');
        const nameEl    = document.getElementById('sidebarUserName');
        if (avatarEl) avatarEl.textContent = initial;
        if (nameEl)   nameEl.textContent   = username;
    }

    // ── Helpers ────────────────────────────────────────────
    function escHtml(str) {
        return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Escapes then wraps http(s) URLs in clickable anchors.
    const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
    function linkify(str) {
        return escHtml(str).replace(URL_RE, url =>
            `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    }

    function timeAgo(date) {
        const d = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(d.getTime())) return '';
        const diff = (Date.now() - d.getTime()) / 1000;
        if (diff < 60)    return 'just now';
        if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
        if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    /**
     * Shared empty state. `action` is { label, icon, onClick } — the caller
     * binds it by id after inserting the markup, or passes `actionId` and wires
     * it up itself.
     */
    function emptyState({ icon = 'fa-inbox', title, body = '', action = null, grow = false } = {}) {
        return `
            <div class="empty-state${grow ? ' empty-state--grow' : ''}">
                <div class="empty-state-icon"><i class="fa-solid ${escHtml(icon)}" aria-hidden="true"></i></div>
                <p class="empty-state-title">${escHtml(title)}</p>
                ${body ? `<p class="empty-state-desc">${escHtml(body)}</p>` : ''}
                ${action ? `<button class="btn btn-primary btn-sm mt-2" id="${escHtml(action.id)}">
                    ${action.icon ? `<i class="fa-solid ${escHtml(action.icon)}" aria-hidden="true"></i>` : ''}
                    ${escHtml(action.label)}
                </button>` : ''}
            </div>`;
    }

    /** Loading placeholder. `kind` is 'rows' | 'cards'. */
    function skeleton(kind = 'rows', count = 5) {
        const one = kind === 'cards'
            ? '<div class="skeleton skeleton-card"></div>'
            : '<div class="skeleton skeleton-row"></div>';
        return `<div class="skeleton-wrap" aria-hidden="true">${one.repeat(count)}</div>`;
    }

    /**
     * Floating menu anchored to an element. `items` is a list of
     * { icon, label, onClick, danger } — or the string 'separator'.
     */
    function menu(anchorEl, items) {
        document.querySelectorAll('.dropdown-menu.floating').forEach(m => m.remove());

        const el = document.createElement('div');
        el.className = 'dropdown-menu floating open';
        el.setAttribute('role', 'menu');
        el.innerHTML = items.map((it, i) => it === 'separator'
            ? '<div class="dropdown-separator" role="separator"></div>'
            : `<button type="button" role="menuitem" class="dropdown-item${it.danger ? ' danger' : ''}" data-menu-idx="${i}">
                   ${it.icon ? `<i class="fa-solid ${escHtml(it.icon)}" aria-hidden="true"></i>` : ''}
                   <span>${escHtml(it.label)}</span>
               </button>`).join('');

        document.body.appendChild(el);

        const r = anchorEl.getBoundingClientRect();
        el.style.position = 'fixed';
        el.style.top  = `${Math.min(r.bottom + 4, window.innerHeight - el.offsetHeight - 8)}px`;
        el.style.left = `${Math.min(r.left, window.innerWidth - el.offsetWidth - 8)}px`;

        function close() {
            el.remove();
            document.removeEventListener('click', onDocClick, true);
            document.removeEventListener('keydown', onKey, true);
        }
        function onDocClick(e) { if (!el.contains(e.target)) close(); }
        function onKey(e) { if (e.key === 'Escape') { close(); anchorEl.focus(); } }

        el.querySelectorAll('[data-menu-idx]').forEach(btn => {
            btn.addEventListener('click', () => {
                const it = items[parseInt(btn.dataset.menuIdx, 10)];
                close();
                it.onClick?.();
            });
        });

        setTimeout(() => {
            document.addEventListener('click', onDocClick, true);
            document.addEventListener('keydown', onKey, true);
            el.querySelector('[data-menu-idx]')?.focus();
        }, 0);

        return close;
    }

    /**
     * Inline single-field prompt rendered next to `anchorEl` — replaces
     * window.prompt(), which blocks the page and cannot be styled.
     * Resolves with the trimmed string, or null if cancelled.
     */
    function inlinePrompt(anchorEl, { placeholder = '', value = '', submitLabel = 'Add' } = {}) {
        return new Promise(resolve => {
            document.querySelectorAll('.inline-prompt').forEach(el => el.remove());

            const form = document.createElement('form');
            form.className = 'inline-prompt';
            form.innerHTML = `
                <input type="text" class="form-control" placeholder="${escHtml(placeholder)}"
                       value="${escHtml(value)}" aria-label="${escHtml(placeholder || submitLabel)}" />
                <button type="submit" class="btn btn-primary btn-sm">${escHtml(submitLabel)}</button>
                <button type="button" class="btn btn-ghost btn-sm" data-cancel>Cancel</button>`;

            anchorEl.insertAdjacentElement('afterend', form);
            const input = form.querySelector('input');
            input.focus();

            let settled = false;
            function finish(result) {
                if (settled) return;
                settled = true;
                form.remove();
                resolve(result);
            }

            form.addEventListener('submit', e => {
                e.preventDefault();
                const v = input.value.trim();
                finish(v || null);
            });
            form.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
            input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } });
            input.addEventListener('blur', () => setTimeout(() => {
                if (!form.contains(document.activeElement)) finish(null);
            }, 120));
        });
    }

    return {
        init, toast, confirm, celebrateConfetti,
        openTaskPanel, closeTaskPanel, getOpenTaskId, isTaskPanelOpen,
        toggleTaskPanelFullscreen, exitTaskPanelFullscreen,
        openCommandPalette, closeCommandPalette,
        openShortcutsSheet, closeShortcutsSheet,
        applyTheme, toggleTheme,
        // Shared component layer
        escHtml, linkify, timeAgo, emptyState, skeleton, menu, inlinePrompt, trapFocus,
    };
})();

window.UI = UI;

// ── App bootstrap ──────────────────────────────────────────
const App = (() => {
    function init() {
        // Init state first
        State.init();

        // Init all modules
        UI.init();
        Projects.init();
        Agents.init();
        Tasks.init();
        Board.init();
        Chat.init();
        Reports.init();
        Timeline.init();
        Dashboard.init();
        Router.init();

        // Try to sync from Firebase in background
        State.loadFromFirebase().then(loaded => {
            if (loaded) {
                Projects.renderSidebar();
                const { view, projectId } = Router.getCurrent();
                Router.renderView(view, projectId);
            }
        });
    }

    return { init };
})();

window.App = App;
