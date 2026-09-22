/**
 * FlowBoard — Projects Module
 * Handles sidebar project list, project modal (create/edit),
 * column editor, label management, and project navigation.
 */

const Projects = (() => {
    const PROJECT_COLORS = ['#6366f1','#3b82f6','#22c55e','#f59e0b','#ef4444','#ec4899','#8b5cf6','#06b6d4','#f97316','#10b981'];

    let _editingProjectId = null;
    let _sidebarDragProjectId = null;
    /** dragstart's e.target is the draggable row, not the grip — use this to allow drag only from the handle. */
    let _sidebarGripMousedownId = null;
    let _sidebarGripMouseupClear = null;
    let _selectedColor    = '#6366f1';
    let _editingColumns   = [];
    let _colDragIdx           = null;
    /** dragstart's e.target is the whole row, not the grip — gate drag start to the handle, same as the sidebar project list. */
    let _colGripMousedownIdx  = null;
    let _colGripMouseupClear  = null;

    // ── Sidebar ────────────────────────────────────────────
    function renderSidebar() {
        const container = document.getElementById('sidebarProjects');
        if (!container) return;

        bindSidebarProjectReorder(container);

        const projects  = State.Projects.getAll().sort((a, b) => a.position - b.position);
        const { view, projectId } = Router.getCurrent();

        if (!projects.length) {
            container.innerHTML = `
                <div class="sidebar-empty-note">
                    No projects yet
                </div>`;
            return;
        }

        container.innerHTML = projects.map(p => `
            <div class="project-item${(view === 'board' || view === 'chat') && projectId === p.id ? ' active' : ''}"
                 data-project-id="${p.id}"
                 draggable="true"
                 title="${p.name}">
                <span class="project-drag-handle" title="Drag to reorder">
                    <i class="fa-solid fa-grip-vertical"></i>
                </span>
                <span class="project-dot" style="background:${p.color || '#6366f1'};"></span>
                <span class="project-name">${escHtml(p.name)}</span>
                <button class="btn btn-ghost btn-icon btn-sm project-options-btn"
                        data-pid="${p.id}"
                        title="Project options"
                        style="opacity:0;flex-shrink:0;width:22px;height:22px;border-radius:4px;margin-left:auto;">
                    <i class="fa-solid fa-ellipsis"></i>
                </button>
            </div>
        `).join('');

        // Project click → board view
        container.querySelectorAll('.project-item').forEach(el => {
            const pid = Number(el.dataset.projectId);

            el.querySelector('.project-drag-handle')?.addEventListener('mousedown', () => {
                _sidebarGripMousedownId = pid;
                if (_sidebarGripMouseupClear) {
                    window.removeEventListener('mouseup', _sidebarGripMouseupClear);
                }
                _sidebarGripMouseupClear = () => {
                    _sidebarGripMousedownId = null;
                    window.removeEventListener('mouseup', _sidebarGripMouseupClear);
                    _sidebarGripMouseupClear = null;
                };
                window.addEventListener('mouseup', _sidebarGripMouseupClear);
            });

            el.addEventListener('click', (e) => {
                if (e.target.closest('.project-options-btn') || e.target.closest('.project-drag-handle')) return;
                Router.navigate('board', parseInt(el.dataset.projectId, 10));
            });

            el.addEventListener('dragstart', (e) => {
                if (_sidebarGripMousedownId !== pid) {
                    e.preventDefault();
                    return;
                }
                _sidebarGripMousedownId = null;
                if (_sidebarGripMouseupClear) {
                    window.removeEventListener('mouseup', _sidebarGripMouseupClear);
                    _sidebarGripMouseupClear = null;
                }
                _sidebarDragProjectId = pid;
                if (Number.isNaN(_sidebarDragProjectId)) {
                    e.preventDefault();
                    return;
                }
                try {
                    e.dataTransfer.setData('text/plain', String(_sidebarDragProjectId));
                    e.dataTransfer.setData('application/x-flowboard-project', String(_sidebarDragProjectId));
                } catch (err) { /* ignore */ }
                e.dataTransfer.effectAllowed = 'move';
                el.classList.add('project-dragging');
            });

            el.addEventListener('dragend', () => {
                el.classList.remove('project-dragging');
                container.querySelectorAll('.project-item').forEach(x => x.classList.remove('project-drop-target'));
                _sidebarDragProjectId = null;
                _sidebarGripMousedownId = null;
                if (_sidebarGripMouseupClear) {
                    window.removeEventListener('mouseup', _sidebarGripMouseupClear);
                    _sidebarGripMouseupClear = null;
                }
            });

            const optBtn = el.querySelector('.project-options-btn');
            el.addEventListener('mouseenter', () => { if(optBtn) optBtn.style.opacity = '1'; });
            el.addEventListener('mouseleave', () => { if(optBtn) optBtn.style.opacity = '0'; });
        });

        // Options buttons
        container.querySelectorAll('.project-options-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                showProjectContextMenu(e, parseInt(btn.dataset.pid, 10));
            });
        });
    }

    function bindSidebarProjectReorder(container) {
        if (!container || container.dataset.reorderBound === '1') return;
        container.dataset.reorderBound = '1';

        container.addEventListener('dragover', (e) => {
            const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
            const ourDrag = _sidebarDragProjectId ||
                types.includes('application/x-flowboard-project');
            if (!ourDrag || !container.contains(e.target)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const item = e.target.closest('.project-item');
            container.querySelectorAll('.project-item').forEach(x => x.classList.remove('project-drop-target'));
            if (item) item.classList.add('project-drop-target');
        });

        container.addEventListener('drop', (e) => {
            e.preventDefault();
            let dragId = _sidebarDragProjectId;
            if (!dragId || Number.isNaN(dragId)) {
                dragId = Number(e.dataTransfer.getData('text/plain'));
                if (Number.isNaN(dragId)) {
                    dragId = Number(e.dataTransfer.getData('application/x-flowboard-project'));
                }
            }
            container.querySelectorAll('.project-item').forEach(x => {
                x.classList.remove('project-drop-target', 'project-dragging');
            });
            _sidebarDragProjectId = null;
            if (!dragId || Number.isNaN(dragId)) return;
            if (!container.querySelector(`[data-project-id="${dragId}"]`)) return;

            const sorted = State.Projects.getAll().slice().sort((a, b) => (a.position || 0) - (b.position || 0));
            let ids = sorted.map(p => p.id).filter(id => id !== dragId);

            const rowsAll = [...container.querySelectorAll('.project-item')];
            let insertAt = ids.length;
            for (let i = 0; i < rowsAll.length; i++) {
                const pid = Number(rowsAll[i].dataset.projectId);
                if (pid === dragId) continue;
                const r = rowsAll[i].getBoundingClientRect();
                if (e.clientY < r.top + r.height / 2) {
                    insertAt = ids.indexOf(pid);
                    if (insertAt === -1) insertAt = ids.length;
                    break;
                }
            }
            ids.splice(insertAt, 0, dragId);
            State.Projects.setOrder(ids);
        });
    }

    function showProjectContextMenu(event, projectId) {
        const proj = State.Projects.get(projectId);
        if (!proj) return;

        // Close existing menus
        document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));

        const menu = document.createElement('div');
        menu.className = 'dropdown-menu open';
        menu.style.cssText = `position:fixed;top:${event.clientY}px;left:${event.clientX}px;z-index:400;`;
        menu.innerHTML = `
            <div class="dropdown-item" id="ctxBoard"><i class="fa-solid fa-list"></i> View Tasks</div>
            <div class="dropdown-separator"></div>
            <div class="dropdown-item" id="ctxEdit"><i class="fa-solid fa-pen"></i> Edit Project</div>
            <div class="dropdown-item" id="ctxDuplicate"><i class="fa-solid fa-copy"></i> Duplicate Project</div>
            <div class="dropdown-separator"></div>
            <div class="dropdown-item danger" id="ctxDelete"><i class="fa-solid fa-trash"></i> Delete Project</div>
        `;
        document.body.appendChild(menu);

        menu.querySelector('#ctxBoard').addEventListener('click', () => {
            Router.navigate('board', projectId); cleanup();
        });
        menu.querySelector('#ctxEdit').addEventListener('click', () => {
            openModal(projectId); cleanup();
        });
        menu.querySelector('#ctxDuplicate').addEventListener('click', async () => {
            cleanup();
            const copy = await State.Projects.duplicate(projectId);
            if (!copy) {
                UI.toast('Could not duplicate project', 'error');
                return;
            }
            renderSidebar();
            UI.toast(`Duplicated "${proj.name}" → "${copy.name}"`, 'success');
            setTimeout(() => Router.navigate('board', copy.id), 200);
        });
        menu.querySelector('#ctxDelete').addEventListener('click', () => {
            cleanup();
            UI.confirm(`Delete project "${proj.name}"? All tasks will be unassigned.`, () => {
                State.Projects.delete(projectId);
                renderSidebar();
                Router.navigate('mytasks');
                UI.toast(`Project "${proj.name}" deleted`, 'success');
            });
        });

        function cleanup() {
            if (menu.parentNode) menu.parentNode.removeChild(menu);
        }

        setTimeout(() => {
            document.addEventListener('click', function handler(e) {
                if (!menu.contains(e.target)) {
                    cleanup();
                    document.removeEventListener('click', handler);
                }
            });
        }, 0);
    }

    // ── Modal open/close ──────────────────────────────────
    function openModal(projectId) {
        _editingProjectId = projectId || null;
        const modal  = document.getElementById('projectModalScrim');
        const title  = document.getElementById('projectModalTitle');
        const saveBtn= document.getElementById('projectModalSave');

        if (_editingProjectId) {
            const proj = State.Projects.get(_editingProjectId);
            title.textContent = 'Edit Project';
            saveBtn.textContent = 'Save Changes';
            document.getElementById('projectModalId').value = _editingProjectId;
            document.getElementById('projectModalName').value = proj.name;
            document.getElementById('projectModalDesc').value = proj.description || '';
            document.getElementById('projectModalRepo').value = proj.repo || '';
            _selectedColor  = proj.color;
            _editingColumns = proj.columns.map(c => ({ ...c }));
            Agents.populateDefaultAssigneeSelect(document.getElementById('projectModalDefaultAssignee'), proj.defaultAssignee);
        } else {
            title.textContent = 'New Project';
            saveBtn.textContent = 'Create Project';
            document.getElementById('projectModalId').value = '';
            document.getElementById('projectModalName').value = '';
            document.getElementById('projectModalDesc').value = '';
            document.getElementById('projectModalRepo').value = '';
            Agents.populateDefaultAssigneeSelect(document.getElementById('projectModalDefaultAssignee'), '');
            _selectedColor  = '#6366f1';
            _editingColumns = [
                { id: `col-${Date.now()}-1`, name: 'To Do',       color: '#6b7280', position: 0, wipLimit: null },
                { id: `col-${Date.now()}-2`, name: 'In Progress',  color: '#3b82f6', position: 1, wipLimit: null },
                { id: `col-${Date.now()}-3`, name: 'In Review',    color: '#f59e0b', position: 2, wipLimit: null },
                { id: `col-${Date.now()}-4`, name: 'Done',         color: '#22c55e', position: 3, wipLimit: null },
            ];
        }

        renderColorPicker();
        renderColumnEditor();
        modal.classList.add('open');
        setTimeout(() => document.getElementById('projectModalName').focus(), 100);
    }

    function closeModal() {
        document.getElementById('projectModalScrim').classList.remove('open');
    }

    // ── Color picker ──────────────────────────────────────
    function renderColorPicker() {
        const container = document.getElementById('projectModalColors');
        if (!container) return;
        container.innerHTML = PROJECT_COLORS.map(c => `
            <div class="color-swatch${c === _selectedColor ? ' selected' : ''}"
                 data-color="${c}"
                 style="background:${c};"
                 title="${c}"></div>
        `).join('');
        container.querySelectorAll('.color-swatch').forEach(el => {
            el.addEventListener('click', () => {
                _selectedColor = el.dataset.color;
                container.querySelectorAll('.color-swatch').forEach(x => x.classList.remove('selected'));
                el.classList.add('selected');
            });
        });
    }

    // ── Column editor ──────────────────────────────────────
    function renderColumnEditor() {
        const container = document.getElementById('projectModalColumns');
        if (!container) return;

        container.innerHTML = _editingColumns.map((col, i) => `
            <div class="column-editor-item" data-col-idx="${i}" draggable="true">
                <i class="fa-solid fa-grip-vertical column-editor-drag" title="Drag to reorder"></i>
                <input type="color"
                       class="column-color-picker"
                       value="${col.color}"
                       title="Column color"
                       data-col-color="${i}"
                       style="background:${col.color};border-radius:50%;" />
                <input class="column-name-input"
                       type="text"
                       value="${escHtml(col.name)}"
                       placeholder="Column name"
                       data-col-name="${i}"
                       maxlength="30" />
                <input class="form-control"
                       type="number"
                       value="${col.wipLimit || ''}"
                       placeholder="WIP"
                       title="WIP limit (leave empty for unlimited)"
                       data-col-wip="${i}"
                       min="1"
                       style="width:60px;text-align:center;" />
                <button class="btn btn-ghost btn-icon btn-sm" data-col-del="${i}" title="Remove column">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        `).join('');

        // Sync values back to _editingColumns on change
        container.querySelectorAll('[data-col-name]').forEach(el => {
            el.addEventListener('input', () => {
                _editingColumns[parseInt(el.dataset.colName)].name = el.value;
            });
        });
        container.querySelectorAll('[data-col-color]').forEach(el => {
            el.addEventListener('input', () => {
                const idx = parseInt(el.dataset.colColor);
                _editingColumns[idx].color = el.value;
                el.style.background = el.value;
            });
        });
        container.querySelectorAll('[data-col-wip]').forEach(el => {
            el.addEventListener('input', () => {
                const val = parseInt(el.value);
                _editingColumns[parseInt(el.dataset.colWip)].wipLimit = isNaN(val) ? null : val;
            });
        });
        container.querySelectorAll('[data-col-del]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.colDel);
                if (_editingColumns.length <= 1) {
                    UI.toast('A project must have at least one column', 'warning');
                    return;
                }
                _editingColumns.splice(idx, 1);
                _editingColumns.forEach((c, i) => c.position = i);
                renderColumnEditor();
            });
        });

        // Drag-to-reorder, gated to the grip handle like the sidebar project list.
        container.querySelectorAll('.column-editor-item').forEach(el => {
            const idx  = parseInt(el.dataset.colIdx, 10);
            const grip = el.querySelector('.column-editor-drag');

            grip?.addEventListener('mousedown', () => {
                _colGripMousedownIdx = idx;
                if (_colGripMouseupClear) window.removeEventListener('mouseup', _colGripMouseupClear);
                _colGripMouseupClear = () => {
                    _colGripMousedownIdx = null;
                    window.removeEventListener('mouseup', _colGripMouseupClear);
                    _colGripMouseupClear = null;
                };
                window.addEventListener('mouseup', _colGripMouseupClear);
            });

            el.addEventListener('dragstart', (e) => {
                if (_colGripMousedownIdx !== idx) {
                    e.preventDefault();
                    return;
                }
                _colGripMousedownIdx = null;
                if (_colGripMouseupClear) {
                    window.removeEventListener('mouseup', _colGripMouseupClear);
                    _colGripMouseupClear = null;
                }
                _colDragIdx = idx;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(idx));
                el.classList.add('column-editor-dragging');
            });

            el.addEventListener('dragend', () => {
                el.classList.remove('column-editor-dragging');
                container.querySelectorAll('.column-editor-item').forEach(x => x.classList.remove('column-editor-drop-target'));
                _colDragIdx = null;
            });
        });

        bindColumnEditorReorder(container);
    }

    function bindColumnEditorReorder(container) {
        if (container.dataset.reorderBound === '1') return;
        container.dataset.reorderBound = '1';

        container.addEventListener('dragover', (e) => {
            if (_colDragIdx == null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const item = e.target.closest('.column-editor-item');
            container.querySelectorAll('.column-editor-item').forEach(x => x.classList.remove('column-editor-drop-target'));
            if (item) item.classList.add('column-editor-drop-target');
        });

        container.addEventListener('drop', (e) => {
            e.preventDefault();
            const item = e.target.closest('.column-editor-item');
            container.querySelectorAll('.column-editor-item').forEach(x => x.classList.remove('column-editor-drop-target'));
            if (_colDragIdx == null || !item) return;

            const targetIdx = parseInt(item.dataset.colIdx, 10);
            const dragIdx   = _colDragIdx;
            _colDragIdx = null;
            if (targetIdx === dragIdx) return;

            const [moved] = _editingColumns.splice(dragIdx, 1);
            _editingColumns.splice(targetIdx, 0, moved);
            _editingColumns.forEach((c, i) => c.position = i);
            renderColumnEditor();
        });
    }

    // ── Save ──────────────────────────────────────────────
    function save() {
        const name = document.getElementById('projectModalName').value.trim();
        if (!name) {
            UI.toast('Project name is required', 'error');
            document.getElementById('projectModalName').focus();
            return;
        }
        if (!_editingColumns.length) {
            UI.toast('Add at least one column', 'error');
            return;
        }
        // Normalize column positions
        const cols = _editingColumns.map((c, i) => ({ ...c, position: i }));

        const fields = {
            name,
            description:     document.getElementById('projectModalDesc').value.trim(),
            repo:            document.getElementById('projectModalRepo').value.trim(),
            color:           _selectedColor,
            columns:         cols,
            defaultAssignee: document.getElementById('projectModalDefaultAssignee').value || null,
        };

        if (_editingProjectId) {
            State.Projects.update(_editingProjectId, fields);
            UI.toast(`Project updated`, 'success');
        } else {
            const proj = State.Projects.create(fields);
            UI.toast(`Project "${proj.name}" created`, 'success');
            // Navigate to new project board
            setTimeout(() => Router.navigate('board', proj.id), 200);
        }

        renderSidebar();
        closeModal();
    }

    // ── Populate project selects (used by task modals) ────────
    function populateProjectSelect(selectEl, includeNone = true) {
        if (!selectEl) return;
        const projects = State.Projects.getAll().slice().sort((a, b) => (a.position || 0) - (b.position || 0));
        selectEl.innerHTML = (includeNone ? '<option value="">No project</option>' : '') +
            projects.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
    }

    function populateColumnSelect(selectEl, projectId) {
        if (!selectEl) return;
        selectEl.innerHTML = '<option value="">Select column…</option>';
        if (!projectId) return;
        const proj = State.Projects.get(parseInt(projectId, 10));
        if (!proj) return;
        const sorted = [...proj.columns].sort((a, b) => a.position - b.position);
        selectEl.innerHTML = sorted.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    }

    // Delegates to the shared helper in ui.js (loaded last, so resolve at call time).
    function escHtml(str) { return UI.escHtml(str); }

    // ── Init ──────────────────────────────────────────────
    function init() {
        // Add project button (sidebar)
        document.getElementById('addProjectBtn')?.addEventListener('click', () => openModal());

        // Modal close buttons
        document.getElementById('projectModalClose')?.addEventListener('click', closeModal);
        document.getElementById('projectModalCancel')?.addEventListener('click', closeModal);
        document.getElementById('projectModalScrim')?.addEventListener('click', e => {
            if (e.target === document.getElementById('projectModalScrim')) closeModal();
        });

        // Save button
        document.getElementById('projectModalSave')?.addEventListener('click', save);

        // Add column button
        document.getElementById('addColumnBtn')?.addEventListener('click', () => {
            _editingColumns.push({
                id:       `col-${Date.now()}`,
                name:     '',
                color:    '#6b7280',
                position: _editingColumns.length,
                wipLimit: null,
            });
            renderColumnEditor();
        });

        // Manage Board button (edit project)
        document.getElementById('manageBoardBtn')?.addEventListener('click', () => {
            const pid = Router.getCurrentProjectId();
            if (pid) openModal(pid);
        });

        // State changes
        State.on('projects:changed', renderSidebar);

        // Initial render
        renderSidebar();
    }

    return { init, renderSidebar, openModal, closeModal, populateProjectSelect, populateColumnSelect };
})();

window.Projects = Projects;
