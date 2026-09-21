/**
 * FlowBoard — State Management
 * Central in-memory store with localStorage persistence and Firebase sync.
 */

const State = (() => {
    const STORAGE_KEY = 'flowboard_data';
    const ACTIVITY_KEY = 'flowboard_activity';
    const MAX_ACTIVITY = 50;

    const defaultColumns = [
        { id: 'col-backlog',    name: 'Backlog',     color: '#94a3b8', position: 0, wipLimit: null },
        { id: 'col-todo',       name: 'To Do',       color: '#6b7280', position: 1, wipLimit: null },
        { id: 'col-inprogress', name: 'In Progress',  color: '#3b82f6', position: 2, wipLimit: null },
        { id: 'col-inreview',   name: 'In Review',    color: '#f59e0b', position: 3, wipLimit: null },
        { id: 'col-done',       name: 'Done',         color: '#22c55e', position: 4, wipLimit: null },
    ];

    const defaultLabels = [
        { id: 'lbl-bug',      name: 'Bug',      color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
        { id: 'lbl-feature',  name: 'Feature',  color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
        { id: 'lbl-design',   name: 'Design',   color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
        { id: 'lbl-docs',     name: 'Docs',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
        { id: 'lbl-backend',  name: 'Release',  color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
        { id: 'lbl-frontend', name: 'Frontend', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
    ];

    function getDefaults() {
        return {
            projects: [],
            tasks:    [],
            agents:   [],
            chats:    [],
            labels:   defaultLabels,
            activity: [],
        };
    }

    /** Fix imported / legacy tasks so timer stop and UI stay consistent. Mutates in place. */
    function normalizeImportedTask(task) {
        if (!task || typeof task !== 'object') return;
        if (!Array.isArray(task.timeEntries)) task.timeEntries = [];
        const r = task.isTimerRunning;
        task.isTimerRunning = r === true || r === 1 ||
            (typeof r === 'string' && ['true', '1', 'yes'].includes(r.trim().toLowerCase()));
        if (task.timerStart != null && task.timerStart !== '') {
            const n = Number(task.timerStart);
            task.timerStart = Number.isFinite(n) ? n : null;
        } else {
            task.timerStart = null;
        }
        if (task.isTimerRunning && task.timerStart == null) {
            task.isTimerRunning = false;
        }
        if (typeof task.timerNote !== 'string') task.timerNote = '';
        if (!task.isTimerRunning) task.timerNote = '';
        if (!Array.isArray(task.subtasks)) task.subtasks = [];
        normalizeSubtasksList(task.subtasks);
        // Firebase strips null values, so an unassigned task comes back with no
        // agentId key at all. Put it back so every task has the same shape.
        if (task.agentId === undefined || task.agentId === '') task.agentId = null;
        // assignedAt drives queue order; agentDoneAt marks a task as no longer
        // pending for the agent that worked it, without losing the historical
        // agentId. Both are null-stripped by Firebase the same way agentId is.
        if (task.assignedAt === undefined || task.assignedAt === '') task.assignedAt = null;
        if (task.agentDoneAt === undefined || task.agentDoneAt === '') task.agentDoneAt = null;
    }

    function normalizeSubtasksList(list) {
        if (!Array.isArray(list)) return;
        list.forEach((s) => {
            if (!s || typeof s !== 'object') return;
            if (!Array.isArray(s.subtasks)) s.subtasks = [];
            normalizeSubtasksList(s.subtasks);
        });
    }

    function findSubtaskEntry(list, subtaskId) {
        if (!Array.isArray(list)) return null;
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            if (s.id == subtaskId) return { list, index: i, sub: s };
            const nested = findSubtaskEntry(s.subtasks, subtaskId);
            if (nested) return nested;
        }
        return null;
    }

    function cloneSubtasksTree(subs, nextId) {
        return (subs || []).map((s) => ({
            id:        nextId(),
            text:      s.text || '',
            completed: !!s.completed,
            subtasks:  cloneSubtasksTree(s.subtasks, nextId),
        }));
    }

    function countSubtasksTree(subs) {
        let done = 0;
        let total = 0;
        (subs || []).forEach((s) => {
            total++;
            if (s.completed) done++;
            const nested = countSubtasksTree(s.subtasks);
            done += nested.done;
            total += nested.total;
        });
        return { done, total };
    }

    function normalizeAllTasks() {
        (_data.tasks || []).forEach(normalizeImportedTask);
    }

    // ── Agents ────────────────────────────────────────────
    const AGENT_MODELS = ['default', 'opus', 'sonnet', 'haiku'];

    /**
     * The slug is the stable handle Claude uses to refer to an agent, so it has
     * to stay unique and URL-ish even when the display name is renamed.
     */
    function slugifyAgent(name, taken) {
        const base = String(name || 'agent').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
        let slug = base;
        let n = 2;
        while (taken && taken.has(slug)) slug = `${base}-${n++}`;
        return slug;
    }

    /**
     * If `cleanSlug` is currently held by a different agent whose slug no
     * longer matches ITS OWN name (i.e. inherited from a name it has since
     * been renamed away from), relocate that agent to a slug that matches its
     * current name — freeing `cleanSlug` for whoever actually deserves it now
     * (TASK-529: renaming an agent away from "Monday" left the next agent
     * actually named Monday stuck with "monday-2"). A slug that still matches
     * its holder's current name is a live collision, not a stale one, so it's
     * left alone and the asker gets a numeric-suffixed slug instead.
     */
    function reclaimStaleSlug(cleanSlug, excludeId) {
        const holder = _data.agents.find(a => a.slug === cleanSlug && a.id !== excludeId);
        if (!holder || slugifyAgent(holder.name) === cleanSlug) return;
        const taken = new Set(_data.agents.filter(a => a.id !== holder.id).map(a => a.slug));
        holder.slug = slugifyAgent(holder.name, taken);
    }

    /** Coerce an imported / Firebase agent into a complete record. Mutates in place. */
    function normalizeImportedAgent(agent, taken) {
        if (!agent || typeof agent !== 'object') return;
        if (agent.id == null) agent.id = Date.now() + Math.floor(Math.random() * 1000);
        agent.name = String(agent.name || 'Agent').slice(0, 40);
        const e = agent.enabled;
        agent.enabled = e === undefined || e === true || e === 1 ||
            (typeof e === 'string' && ['true', '1', 'yes'].includes(e.trim().toLowerCase()));
        agent.emoji        = typeof agent.emoji === 'string' ? agent.emoji.slice(0, 4) : '';
        agent.color        = /^#[0-9a-f]{6}$/i.test(agent.color || '') ? agent.color : '#6366f1';
        agent.avatar       = typeof agent.avatar === 'string' && agent.avatar.startsWith('data:image/')
            ? agent.avatar : '';
        agent.role         = String(agent.role || '').slice(0, 200);
        agent.systemPrompt = String(agent.systemPrompt || '').slice(0, 8000);
        agent.model        = AGENT_MODELS.includes(agent.model) ? agent.model : 'default';
        agent.createdAt    = agent.createdAt || new Date().toISOString();
        // The task this agent is actively working, or null when it's free.
        // Everything else assigned to it and not yet finished sits in its queue.
        agent.currentTaskId = agent.currentTaskId === undefined || agent.currentTaskId === ''
            ? null : agent.currentTaskId;
        // Whether a live terminal/Claude Desktop session has marked itself
        // present via start_session — distinct from currentTaskId, which
        // just means a task is claimed/queued (TASK-574). Mirrors
        // mcp-server/src/domain.js hydrateAgent.
        agent.sessionActive = agent.sessionActive === true;
        if (!agent.slug || (taken && taken.has(agent.slug))) agent.slug = slugifyAgent(agent.name, taken);
        if (taken) taken.add(agent.slug);
    }

    /**
     * Date.now() alone collides when several agents are created inside the same
     * millisecond — which a human never does but the MCP server easily can, and
     * two agents sharing an id means deleting one deletes both.
     */
    function nextAgentId() {
        let id = Date.now();
        while (_data.agents.some(a => a.id === id)) id++;
        return id;
    }

    /**
     * Same collision as nextAgentId, for tasks. This one bit the agent queue
     * feature directly: two tasks minted in the same millisecond and assigned
     * to the same agent would compare equal, so the second was silently
     * excluded from the queue count instead of actually queuing.
     */
    function nextTaskId() {
        let id = Date.now();
        while (_data.tasks.some(t => t.id === id)) id++;
        return id;
    }

    function normalizeAllAgents() {
        const taken = new Set();
        (_data.agents || []).forEach(a => normalizeImportedAgent(a, taken));
        resyncStaleAgentSlugs();
    }

    /**
     * TASK-529: self-heal a slug that no longer matches its own agent's
     * current name — typically left behind by a rename before this file's
     * create()/update() started keeping slugs in sync — so a *different*,
     * later agent actually named after the freed slug isn't stuck with a
     * numeric suffix (e.g. an agent renamed away from "Monday" was still
     * sitting on the "monday" slug, so the next agent actually named Monday
     * got "monday-2"). Only touches a slug that is provably stale; one that
     * still matches its holder's current name is a live identity and is
     * never reassigned out from under it.
     */
    function resyncStaleAgentSlugs() {
        _data.agents.forEach(a => {
            const clean = slugifyAgent(a.name);
            if (a.slug === clean) return;
            reclaimStaleSlug(clean, a.id);
            if (!_data.agents.some(o => o.id !== a.id && o.slug === clean)) {
                a.slug = clean;
            }
        });
    }

    /** True when task.projectId references an existing project. */
    function taskHasValidProject(task) {
        if (!task || task.projectId == null || task.projectId === '') return false;
        return _data.projects.some(p => p.id == task.projectId);
    }

    /**
     * Tasks whose project no longer exists used to be deleted outright. Losing
     * work to a cleanup pass is never acceptable, so park them in a recovery
     * project instead and tell the user.
     */
    const ORPHAN_PROJECT_NAME = 'Unassigned';

    function ensureOrphanProject() {
        let proj = _data.projects.find(p => p.name === ORPHAN_PROJECT_NAME);
        if (proj) return proj;

        proj = {
            id: Date.now(),
            name: ORPHAN_PROJECT_NAME,
            description: 'Tasks recovered from a project that no longer exists.',
            emoji: '',
            color: '#94a3b8',
            position: (Math.max(0, ..._data.projects.map(p => p.position || 0)) + 1000),
            columns: defaultColumns.map(c => ({ ...c })),
            labels: [],
            createdAt: new Date().toISOString(),
        };
        _data.projects.push(proj);
        return proj;
    }

    /** Rehome tasks with no valid project; returns the count rescued. */
    function removeOrphanedTasks() {
        const orphans = (_data.tasks || []).filter(t => !taskHasValidProject(t));
        if (!orphans.length) return 0;

        const proj = ensureOrphanProject();
        const firstCol = [...proj.columns].sort((a, b) => a.position - b.position)[0];

        orphans.forEach(t => {
            if (t.isTimerRunning) {
                t.isTimerRunning = false;
                t.timerStart = null;
            }
            t.projectId = proj.id;
            t.columnId  = firstCol?.id ?? null;
        });

        // This runs during load(), before the UI subscribes — defer so the
        // notification actually reaches someone.
        setTimeout(() => emit('tasks:rescued', { count: orphans.length, projectName: proj.name }), 0);
        return orphans.length;
    }

    let _data = getDefaults();
    let _listeners = {};
    let _syncDebounce = null;
    let _taskCounter = 0;

    // ── Event Emitter ────────────────────────────────────
    function on(event, fn) {
        if (!_listeners[event]) _listeners[event] = [];
        _listeners[event].push(fn);
    }

    function off(event, fn) {
        if (!_listeners[event]) return;
        _listeners[event] = _listeners[event].filter(f => f !== fn);
    }

    function emit(event, data) {
        (_listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) { console.error(e); } });
        (_listeners['*'] || []).forEach(fn => { try { fn(event, data); } catch(e) { console.error(e); } });
    }

    // ── Persistence ──────────────────────────────────────
    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(_data));
        } catch (e) {
            console.warn('State: localStorage save failed', e);
        }
        scheduleSyncToFirebase();
    }

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                _data = Object.assign(getDefaults(), parsed);
                if (!_data.labels || !_data.labels.length) _data.labels = defaultLabels;
                if (!Array.isArray(_data.agents)) _data.agents = [];
                if (!Array.isArray(_data.chats)) _data.chats = [];
                if (!_data.activity) _data.activity = [];
                normalizeAllTasks();
                normalizeAllAgents();
                if (removeOrphanedTasks()) save();
            }
        } catch (e) {
            console.warn('State: load failed, using defaults', e);
            _data = getDefaults();
        }

        // Determine task counter from existing task IDs
        _taskCounter = _data.tasks.reduce((max, t) => {
            const num = parseInt(String(t.taskKey || '0').replace('TASK-', ''), 10) || 0;
            return Math.max(max, num);
        }, 0);
    }

    function scheduleSyncToFirebase() {
        if (_syncDebounce) clearTimeout(_syncDebounce);
        emit('sync:pending');
        _syncDebounce = setTimeout(syncToFirebase, 2000);
    }

    async function syncToFirebase() {
        if (!window.firebaseRESTIntegration) { emit('sync:offline'); return; }
        emit('sync:start');
        try {
            await window.firebaseRESTIntegration.saveData('flowboard_projects', _data.projects);
            await window.firebaseRESTIntegration.saveData('flowboard_tasks',    _data.tasks);
            await window.firebaseRESTIntegration.saveData('flowboard_agents',   _data.agents);
            emit('sync:ok');
        } catch (e) {
            console.warn('State: Firebase sync failed', e);
            // Sync failures used to be invisible; surface them so a user can
            // export before losing anything.
            emit('sync:error', e);
        }
    }

    async function loadFromFirebase() {
        if (!window.firebaseRESTIntegration) return false;
        try {
            const [projects, tasks, agents, chats] = await Promise.all([
                window.firebaseRESTIntegration.loadData('flowboard_projects'),
                window.firebaseRESTIntegration.loadData('flowboard_tasks'),
                window.firebaseRESTIntegration.loadData('flowboard_agents'),
                window.firebaseRESTIntegration.loadData('flowboard_chats'),
            ]);
            if (projects && Array.isArray(projects)) _data.projects = projects;
            if (tasks    && Array.isArray(tasks))    _data.tasks    = tasks;
            if (agents   && Array.isArray(agents))   _data.agents   = agents;
            if (chats    && Array.isArray(chats))    _data.chats    = chats;
            normalizeAllTasks();
            normalizeAllAgents();
            removeOrphanedTasks();
            save();
            emit('chats:changed');
            return true;
        } catch (e) {
            console.warn('State: Firebase load failed', e);
            return false;
        }
    }

    /**
     * Chats are pulled here on their own (not folded into the periodic
     * syncToFirebase push) because that push is a wholesale last-write-wins
     * overwrite of the whole collection — fine for single-editor data like
     * tasks, but chats are appended concurrently by the MCP server (agents)
     * while a browser tab is open, so a full overwrite could erase messages
     * this tab never saw. Reads are safe either way; only writes need care —
     * see Chats.send below, which appends via a fresh read instead.
     */
    async function refreshChatsFromFirebase() {
        if (!window.firebaseRESTIntegration) return false;
        try {
            const chats = await window.firebaseRESTIntegration.loadData('flowboard_chats');
            if (Array.isArray(chats)) {
                _data.chats = chats;
                emit('chats:changed');
                return true;
            }
        } catch (e) {
            console.warn('State: chat refresh failed', e);
        }
        return false;
    }

    // ── Activity log ─────────────────────────────────────
    function addActivity(action, taskTitle, extra) {
        const item = {
            id:        Date.now(),
            action,
            taskTitle: taskTitle || '',
            extra:     extra || '',
            user:      localStorage.getItem('username') || 'Vaibhav',
            at:        new Date().toISOString(),
        };
        _data.activity.unshift(item);
        if (_data.activity.length > MAX_ACTIVITY) _data.activity.length = MAX_ACTIVITY;
        save();
        emit('activity:changed');
    }

    // ── Task key generator ────────────────────────────────
    function nextTaskKey() {
        _taskCounter++;
        return `TASK-${_taskCounter}`;
    }

    // ── Project accessors ─────────────────────────────────
    const Projects = {
        getAll() { return _data.projects; },
        get(id)  { return _data.projects.find(p => p.id === id); },

        create(fields) {
            const proj = {
                id:              Date.now(),
                name:            fields.name   || 'Untitled Project',
                description:     fields.description || '',
                repo:            fields.repo   || '',
                emoji:           '',
                color:           fields.color  || '#6366f1',
                position:        (_data.projects.length + 1) * 1000,
                columns:         fields.columns || defaultColumns.map(c => ({ ...c })),
                labels:          fields.labels  || [],
                defaultAssignee: fields.defaultAssignee || null,
                createdAt:       new Date().toISOString(),
            };
            _data.projects.push(proj);
            save();
            addActivity('project_created', proj.name);
            emit('projects:changed', proj);
            return proj;
        },

        update(id, fields) {
            const idx = _data.projects.findIndex(p => p.id === id);
            if (idx === -1) return null;
            Object.assign(_data.projects[idx], fields);
            save();
            emit('projects:changed', _data.projects[idx]);
            return _data.projects[idx];
        },

        delete(id) {
            const proj = this.get(id);
            if (!proj) return;
            _data.projects = _data.projects.filter(p => p.id !== id);
            _data.tasks = _data.tasks.filter(t => {
                if (t.projectId != id) return true;
                if (t.isTimerRunning) {
                    t.isTimerRunning = false;
                    t.timerStart = null;
                }
                return false;
            });
            save();
            addActivity('project_deleted', proj.name);
            emit('projects:changed');
            emit('tasks:changed', { type: 'delete', projectId: id });
        },

        /**
         * Reassign `position` on projects to match sidebar order (first id = top).
         * Unknown ids are ignored; any project missing from the list is appended in current order.
         */
        setOrder(orderedIds) {
            if (!Array.isArray(orderedIds) || !orderedIds.length) return;
            const sorted = _data.projects.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
            const allIds = sorted.map(p => p.id);
            const seen = new Set();
            const result = [];
            orderedIds.forEach((id) => {
                if (allIds.includes(id) && !seen.has(id)) {
                    result.push(id);
                    seen.add(id);
                }
            });
            allIds.forEach((id) => {
                if (!seen.has(id)) result.push(id);
            });
            result.forEach((id, i) => {
                const p = _data.projects.find(x => x.id === id);
                if (p) p.position = (i + 1) * 1000;
            });
            save();
            emit('projects:changed');
        },

        /**
         * Clone a project (columns, labels, description, color) and all of its tasks.
         * Column / project-label IDs are remapped.
         */
        duplicate(sourceId) {
            const src = this.get(sourceId);
            if (!src) return null;

            let nid = Date.now();
            const nextId = () => ++nid;

            const sortedCols = [...(src.columns || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
            const colMap = {};
            const newColumns = sortedCols.map((c, i) => {
                const newColId = `col-${nextId()}`;
                colMap[c.id] = newColId;
                return { ...c, id: newColId, position: i };
            });
            if (!newColumns.length) return null;

            const labelMap = {};
            const newLabels = (src.labels || []).map((l) => {
                const newLid = `lbl-${nextId()}`;
                labelMap[l.id] = newLid;
                return { ...l, id: newLid };
            });

            const prefix = 'Copy of ';
            const maxName = 60;
            const room = Math.max(0, maxName - prefix.length);
            const trimmed = String(src.name || 'Untitled').slice(0, room);
            const newName = (prefix + trimmed).slice(0, maxName);

            const newProj = {
                id:              nextId(),
                name:            newName,
                description:     src.description || '',
                emoji:           src.emoji || '',
                color:           src.color || '#6366f1',
                position:        (_data.projects.length + 1) * 1000,
                columns:         newColumns,
                labels:          newLabels,
                defaultAssignee: src.defaultAssignee || null,
                createdAt:       new Date().toISOString(),
            };
            _data.projects.push(newProj);

            const firstColId = newColumns[0].id;
            const sourceTasks = _data.tasks.filter(t => t.projectId === sourceId);

            sourceTasks.forEach((t) => {
                const mappedCol = t.columnId && colMap[t.columnId] ? colMap[t.columnId] : firstColId;
                const newLabelIds = (t.labels || []).map((lid) =>
                    (labelMap[lid] !== undefined ? labelMap[lid] : lid)
                );
                const newTask = {
                    id:            nextId(),
                    taskKey:       nextTaskKey(),
                    projectId:     newProj.id,
                    columnId:      mappedCol,
                    title:         t.title,
                    description:   t.description || '',
                    priority:      t.priority || 'medium',
                    labels:        newLabelIds,
                    assignee:      t.assignee || (localStorage.getItem('username') || 'Vaibhav'),
                    agentId:       t.agentId ?? null,
                    startDate:     t.startDate || null,
                    dueDate:       t.dueDate || null,
                    timeEstimate:  t.timeEstimate != null ? t.timeEstimate : null,
                    position:      t.position != null ? t.position : (_data.tasks.length + 1) * 1000,
                    timeSpent:     t.timeSpent || 0,
                    timeEntries:   (t.timeEntries || []).map((e) => ({ ...e })),
                    subtasks:      cloneSubtasksTree(t.subtasks, nextId),
                    comments:      (t.comments || []).map((c) => ({ ...c, id: nextId() })),
                    isTimerRunning: false,
                    timerStart:    null,
                    timerNote:     '',
                    createdAt:     new Date().toISOString(),
                };
                _data.tasks.push(newTask);
            });

            save();
            addActivity('project_duplicated', newProj.name, src.name);
            emit('projects:changed', newProj);
            emit('tasks:changed', { type: 'duplicate', projectId: newProj.id });
            return newProj;
        },
    };

    // ── Task accessors ────────────────────────────────────
    const Tasks = {
        getAll()             { return _data.tasks; },
        /** Loose id match so string ids from DOM / Firebase still resolve. */
        get(id)              { return _data.tasks.find(t => t.id == id); },
        byProject(projectId) { return _data.tasks.filter(t => t.projectId === projectId); },

        create(fields) {
            if (!taskHasValidProject({ projectId: fields.projectId })) {
                console.warn('State: cannot create task without a valid project');
                return null;
            }

            // An agentId always wins the assignee string — mirrors resolveOwner
            // in the MCP server and keeps every string-based read site (My
            // Tasks, CSV export, command palette, card avatars) showing the
            // agent, not a stale default.
            const owningAgent = fields.agentId != null ? Agents.get(fields.agentId) : null;

            const task = {
                id:            nextTaskId(),
                taskKey:       nextTaskKey(),
                projectId:     fields.projectId,
                columnId:      fields.columnId    || null,
                title:         fields.title       || 'Untitled Task',
                description:   fields.description || '',
                priority:      fields.priority    || 'medium',
                labels:        fields.labels      || [],
                assignee:      owningAgent ? owningAgent.name
                                   : (fields.assignee || (localStorage.getItem('username') || 'Vaibhav')),
                agentId:       fields.agentId    != null ? fields.agentId : null,
                assignedAt:    null,
                agentDoneAt:   null,
                startDate:     fields.startDate   || null,
                dueDate:       fields.dueDate     || null,
                timeEstimate:  fields.timeEstimate|| null,
                position:      fields.position    != null ? fields.position : (_data.tasks.length + 1) * 1000,
                timeSpent:     0,
                timeEntries:   [],
                subtasks:      fields.subtasks    || [],
                comments:      fields.comments    || [],
                isTimerRunning:false,
                timerStart:    null,
                timerNote:     '',
                createdAt:     new Date().toISOString(),
            };
            _data.tasks.push(task);
            // A task created already pointed at an agent joins that agent's
            // queue the same way assignTask does — claimed if free, queued if not.
            if (task.agentId != null) {
                const agent = Agents.get(task.agentId);
                if (agent) {
                    task.assignedAt = new Date().toISOString();
                    if (agent.currentTaskId == null && !isBlockedColumn(task)) {
                        agent.currentTaskId = task.id;
                        // Claimed, but only moves to In Progress once a live
                        // session is actually up to work it (TASK-574).
                        if (agent.sessionActive) moveToInProgressColumn(task);
                    }
                }
            }
            save();
            addActivity('task_created', task.title);
            emit('tasks:changed', { type: 'create', task });
            return task;
        },

        update(id, fields) {
            const idx = _data.tasks.findIndex(t => t.id == id);
            if (idx === -1) return null;
            const oldTask = { ..._data.tasks[idx] };
            const merged = { ..._data.tasks[idx], ...fields };
            // An edit that would orphan the task must not delete it — reject the
            // change and let the caller surface the problem.
            if (!taskHasValidProject(merged)) return null;

            const oldAgentId = oldTask.agentId ?? null;
            const agentChanging = 'agentId' in fields && (fields.agentId ?? null) != oldAgentId;
            // Reassignment is handled through Agents.assignTask/releaseTask so
            // currentTaskId and the queue stay correct — a bare field copy
            // would leave the old agent stuck "busy" on a task it no longer has.
            if (agentChanging && oldAgentId != null) Agents.releaseTask(oldAgentId, id);

            Object.assign(_data.tasks[idx], fields);

            if (agentChanging) {
                const newAgentId = fields.agentId ?? null;
                if (newAgentId != null) {
                    _data.tasks[idx].assignedAt  = new Date().toISOString();
                    _data.tasks[idx].agentDoneAt = null;
                    const agent = Agents.get(newAgentId);
                    // An agentId always wins the assignee string, unless the
                    // caller explicitly passed its own — same rule as create().
                    if (agent && !('assignee' in fields)) _data.tasks[idx].assignee = agent.name;
                    if (agent && agent.currentTaskId == null && !isBlockedColumn(_data.tasks[idx])) {
                        agent.currentTaskId = id;
                        if (agent.sessionActive) moveToInProgressColumn(_data.tasks[idx]);
                    }
                } else {
                    _data.tasks[idx].assignedAt = null;
                }
            }

            // Dragging an agent's active task into "To Be Tested" frees the
            // agent, same as move_task on the MCP side — it's waiting on a
            // human now, not tying up the agent (TASK-572). Not a finish:
            // agentDoneAt stays untouched, the task just stops being "current".
            if (fields.columnId && fields.columnId !== oldTask.columnId
                && _data.tasks[idx].agentId != null
                && isToBeTestedColumn(_data.tasks[idx])) {
                const agent = Agents.get(_data.tasks[idx].agentId);
                if (agent && agent.currentTaskId == id) promoteNextForAgent(agent.id, _data.tasks[idx].projectId);
            }

            // Dragging an agent's active task into a column literally named
            // "Done" finishes it — mirrors mcp-server/src/tools.js move_task's
            // autoFinish, which only the MCP path had until now. Without this,
            // a task moved to Done through the web UI (kanban drag, the
            // list-view status dropdown, or the task panel) kept agentDoneAt
            // null forever and left the agent's currentTaskId stuck pointing
            // at a task that was already finished (TASK-602).
            if (fields.columnId && fields.columnId !== oldTask.columnId
                && _data.tasks[idx].agentId != null
                && _data.tasks[idx].agentDoneAt == null
                && isDoneColumnExact(_data.tasks[idx])) {
                const agent = Agents.get(_data.tasks[idx].agentId);
                _data.tasks[idx].agentDoneAt = new Date().toISOString();
                if (agent && agent.currentTaskId == id) promoteNextForAgent(agent.id, _data.tasks[idx].projectId);
            }

            save();
            if (fields.columnId && fields.columnId !== oldTask.columnId) {
                addActivity('task_moved', _data.tasks[idx].title, `→ column`);
            }
            emit('tasks:changed', { type: 'update', task: _data.tasks[idx], oldTask });
            return _data.tasks[idx];
        },

        delete(id) {
            const task = this.get(id);
            if (!task) return;
            // Stop timer if running
            if (task.isTimerRunning) Timer.stop(id);
            // Deleting an agent's active task must not leave it stuck "busy"
            // forever — free it and promote whatever's next in its queue.
            if (task.agentId != null) Agents.releaseTask(task.agentId, task.id);
            _data.tasks = _data.tasks.filter(t => !(t.id == id));
            save();
            addActivity('task_deleted', task.title);
            emit('tasks:changed', { type: 'delete', task });
        },

        addSubtask(taskId, text, parentSubtaskId = null) {
            const task = this.get(taskId);
            if (!task) return;
            const sub = { id: Date.now(), text, completed: false, subtasks: [] };
            if (parentSubtaskId) {
                const parent = findSubtaskEntry(task.subtasks, parentSubtaskId);
                if (!parent) return;
                if (!Array.isArray(parent.sub.subtasks)) parent.sub.subtasks = [];
                parent.sub.subtasks.push(sub);
            } else {
                task.subtasks.push(sub);
            }
            save();
            emit('tasks:changed', { type: 'update', task });
            return sub;
        },

        toggleSubtask(taskId, subtaskId) {
            const task = this.get(taskId);
            if (!task) return;
            const entry = findSubtaskEntry(task.subtasks, subtaskId);
            if (entry) {
                entry.sub.completed = !entry.sub.completed;
                save();
                emit('tasks:changed', { type: 'update', task });
            }
        },

        updateSubtaskText(taskId, subtaskId, text) {
            const task = this.get(taskId);
            if (!task) return;
            const entry = findSubtaskEntry(task.subtasks, subtaskId);
            if (entry && text) {
                entry.sub.text = text;
                save();
                emit('tasks:changed', { type: 'update', task });
            }
        },

        deleteSubtask(taskId, subtaskId) {
            const task = this.get(taskId);
            if (!task) return;
            const entry = findSubtaskEntry(task.subtasks, subtaskId);
            if (!entry) return;
            entry.list.splice(entry.index, 1);
            save();
            emit('tasks:changed', { type: 'update', task });
        },

        reorderSubtask(taskId, dragSubId, targetSubId, insertBefore) {
            const task = this.get(taskId);
            if (!task) return;
            const dragEntry = findSubtaskEntry(task.subtasks, dragSubId);
            const targetEntry = findSubtaskEntry(task.subtasks, targetSubId);
            if (!dragEntry || !targetEntry || dragEntry.list !== targetEntry.list) return;

            const subs = dragEntry.list;
            const fromIdx = dragEntry.index;
            let toIdx = targetEntry.index;
            if (fromIdx === toIdx) return;

            const [moved] = subs.splice(fromIdx, 1);
            if (fromIdx < toIdx) toIdx--;
            if (!insertBefore) toIdx++;
            subs.splice(toIdx, 0, moved);
            save();
            emit('tasks:changed', { type: 'update', task });
        },

        subtaskStats(task) {
            return countSubtasksTree(task?.subtasks || []);
        },

        /**
         * Clone a task in the same project/column (new id, key, subtasks, comments).
         * Timer and logged time are not copied.
         */
        duplicate(id) {
            const src = this.get(id);
            if (!src) return null;

            let nid = Date.now();
            const nextId = () => ++nid;

            const prefix = 'Copy of ';
            const maxTitle = 120;
            const room = Math.max(0, maxTitle - prefix.length);
            const trimmed = String(src.title || 'Untitled').slice(0, room);
            const newTitle = (prefix + trimmed).slice(0, maxTitle);

            const newTask = {
                id:            nextId(),
                taskKey:       nextTaskKey(),
                projectId:     src.projectId ?? null,
                columnId:      src.columnId ?? null,
                title:         newTitle,
                description:   src.description || '',
                priority:      src.priority || 'medium',
                labels:        [...(src.labels || [])],
                assignee:      src.assignee || (localStorage.getItem('username') || 'Vaibhav'),
                agentId:       src.agentId ?? null,
                startDate:     src.startDate || null,
                dueDate:       src.dueDate || null,
                timeEstimate:  src.timeEstimate != null ? src.timeEstimate : null,
                position:      (src.position != null ? src.position : 0) + 0.5,
                timeSpent:     0,
                timeEntries:   [],
                subtasks:      cloneSubtasksTree(src.subtasks, nextId),
                comments:      (src.comments || []).map((c) => ({ ...c, id: nextId() })),
                isTimerRunning: false,
                timerStart:    null,
                timerNote:     '',
                createdAt:     new Date().toISOString(),
            };
            _data.tasks.push(newTask);
            // Same rule as a fresh Tasks.create: a duplicate assigned to an
            // agent is new work for it, claimed if free, queued if not.
            if (newTask.agentId != null) {
                const agent = Agents.get(newTask.agentId);
                if (agent) {
                    newTask.assignedAt = new Date().toISOString();
                    if (agent.currentTaskId == null && !isBlockedColumn(newTask)) {
                        agent.currentTaskId = newTask.id;
                        if (agent.sessionActive) moveToInProgressColumn(newTask);
                    }
                }
            }
            save();
            addActivity('task_duplicated', newTask.title, src.title);
            emit('tasks:changed', { type: 'duplicate', task: newTask, sourceTask: src });
            return newTask;
        },

        addComment(taskId, text) {
            const task = this.get(taskId);
            if (!task) return;
            const comment = {
                id:        Date.now(),
                text,
                author:    localStorage.getItem('username') || 'Vaibhav',
                createdAt: new Date().toISOString(),
            };
            (task.comments || (task.comments = [])).push(comment);
            save();
            addActivity('comment_added', task.title);
            emit('tasks:changed', { type: 'update', task });
            return comment;
        },
    };



    // ── Agent busy / queue tracking ─────────────────────────
    /**
     * Tasks assigned to an agent, still pending, in the order they should be
     * worked — oldest assignment first. Excludes the agent's own current task
     * (that one is active, not queued), anything the agent already finished
     * (agentDoneAt), and — as of TASK-607 — anything not currently sitting in
     * a column literally named "To Do": Backlog, In Review, To Be Tested and
     * Done all drop out of the queue the moment a task lands there, whether
     * that move came from the board (kanban drag, status dropdown, task
     * panel) or an agent's own move_task, since this is the single listing
     * both sides read from. Superseded the narrower Done-only check from
     * TASK-605 — "To Do" is a positive allowlist that already covers it.
     */
    /**
     * Oldest-assignment-first, unless the user has manually reordered the
     * queue from the Agent Activity tab (TASK-513) — a task carrying a
     * `queueOrder` sorts by that instead, ahead of anything untouched, which
     * keeps a manual reorder sticky instead of being nudged back into place
     * every time an older task gets assigned. Mirrors
     * mcp-server/src/domain.js queueSortCompare.
     */
    function queueSortCompare(a, b) {
        const ao = a.queueOrder, bo = b.queueOrder;
        if (ao != null && bo != null) return ao - bo;
        if (ao != null) return -1;
        if (bo != null) return 1;
        return new Date(a.assignedAt || a.createdAt) - new Date(b.assignedAt || b.createdAt);
    }

    function queueForAgent(agentId, excludeTaskId) {
        return _data.tasks
            .filter(t => t.agentId == agentId && t.agentDoneAt == null && t.id != excludeTaskId && isToDoColumn(t))
            .sort(queueSortCompare);
    }

    /**
     * Best-effort: when a task becomes an agent's active work, move the card
     * into the project's "In Progress" column so the board shows what's
     * actually being worked without anyone touching it by hand. Silent no-op
     * if the project has no column with that exact name — several projects in
     * this workspace only have To Do / Done, and that's fine.
     */
    function moveToInProgressColumn(task) {
        if (!task) return;
        const proj = _data.projects.find(p => p.id == task.projectId);
        if (!proj) return;
        const col = (proj.columns || []).find(c => String(c.name).trim().toLowerCase() === 'in progress');
        if (col && task.columnId !== col.id) task.columnId = col.id;
    }

    /**
     * A task sitting in a column literally named "Backlog" is assigned but
     * not ready — several real projects here use it as the stage before
     * "To Do". It stays assigned to the agent and keeps its place once moved
     * to "To Do", but as of TASK-607 it no longer shows in the queue listing
     * itself (see queueForAgent) until then.
     */
    function isBacklogColumn(task) {
        if (!task) return false;
        const proj = _data.projects.find(p => p.id == task.projectId);
        if (!proj) return false;
        const col = (proj.columns || []).find(c => c.id === task.columnId);
        return !!col && String(col.name).trim().toLowerCase() === 'backlog';
    }

    /**
     * A task sitting in "In Review" or "To Be Tested" is mid-review, not open
     * work — an agent should only ever pick up something still in "To Do" (or
     * whatever pre-review column a project uses). Mirrors mcp-server/src/domain.js
     * isReviewColumn (TASK-571).
     */
    function isReviewColumn(task) {
        if (!task) return false;
        const proj = _data.projects.find(p => p.id == task.projectId);
        if (!proj) return false;
        const col = (proj.columns || []).find(c => c.id === task.columnId);
        if (!col) return false;
        const name = String(col.name).trim().toLowerCase();
        return name === 'in review' || name === 'to be tested';
    }

    /** Not open work for an agent to pick up on its own: Backlog, In Review, To Be Tested. */
    function isBlockedColumn(task) {
        return isBacklogColumn(task) || isReviewColumn(task);
    }

    /**
     * A task sitting in a column literally named "To Be Tested" is done from
     * the agent's side and waiting on a human — it stays assigned, but no
     * longer ties up the agent (TASK-572). Mirrors mcp-server/src/domain.js
     * isToBeTestedColumn.
     */
    function isToBeTestedColumn(task) {
        if (!task) return false;
        const proj = _data.projects.find(p => p.id == task.projectId);
        if (!proj) return false;
        const col = (proj.columns || []).find(c => c.id === task.columnId);
        return !!col && String(col.name).trim().toLowerCase() === 'to be tested';
    }

    /**
     * Exact-match "Done", not the looser Tasks.isDoneColumn (which matches
     * any name containing "done"). Mirrors mcp-server/src/tools.js move_task's
     * isDoneColumn check, since this drives the same auto-finish behavior
     * that function already has — see Tasks.update below (TASK-602).
     */
    function isDoneColumnExact(task) {
        if (!task) return false;
        const proj = _data.projects.find(p => p.id == task.projectId);
        if (!proj) return false;
        const col = (proj.columns || []).find(c => c.id === task.columnId);
        return !!col && String(col.name).trim().toLowerCase() === 'done';
    }

    /**
     * Exact-match "To Do" — the only column a task can sit in and still show
     * up in queueForAgent's listing (TASK-607). Mirrors mcp-server/src/domain.js
     * isToDoColumn.
     */
    function isToDoColumn(task) {
        if (!task) return false;
        const proj = _data.projects.find(p => p.id == task.projectId);
        if (!proj) return false;
        const col = (proj.columns || []).find(c => c.id === task.columnId);
        return !!col && String(col.name).trim().toLowerCase() === 'to do';
    }

    /**
     * The agent just went idle — hand it the next queued, workable task, if
     * any. `preferProjectId`, when given, is the project the agent was just
     * working in: an agent mid-stream on one project shouldn't hop to a
     * different project's older-queued task just because that one was
     * assigned first, and shouldn't sit idle because everything ready in its
     * own project happens to be behind an older, still-blocked task from
     * elsewhere (TASK-573). Falls back to the oldest ready task across all
     * projects when its own project has nothing left. Mirrors
     * mcp-server/src/domain.js pickNextForAgent.
     */
    function promoteNextForAgent(agentId, preferProjectId) {
        const agent = _data.agents.find(a => a.id == agentId);
        if (!agent) return null;
        const ready = queueForAgent(agentId, agent.currentTaskId).filter(t => !isBlockedColumn(t));
        const next = (preferProjectId != null && ready.find(t => t.projectId == preferProjectId)) || ready[0] || null;
        agent.currentTaskId = next ? next.id : null;
        // Only moves to In Progress if the agent's session is actually live
        // right now — otherwise it waits for Agents.startSession, same as a
        // fresh claim would (TASK-574).
        if (next && agent.sessionActive) moveToInProgressColumn(next);
        return next;
    }

    // ── Agent accessors ───────────────────────────────────
    /**
     * Agents are profiles Claude adopts when working a task, stored alongside
     * projects and tasks so the MCP server and the UI see the same records.
     *
     * `assignee` stays a plain display string and is kept in sync with the
     * agent's name. Every existing read site (My Tasks, card avatars, the CSV
     * export, the command palette) treats it as a string and keeps working;
     * `agentId` is what actually identifies the agent.
     */
    const Agents = {
        getAll()   { return _data.agents; },
        /** Loose id match so string ids from DOM / Firebase still resolve. */
        get(id)    { return _data.agents.find(a => a.id == id); },
        bySlug(sl) { return _data.agents.find(a => a.slug === String(sl || '').toLowerCase()); },
        /** Accept either an id or a slug — the MCP tools take both. */
        resolve(ref) { return this.get(ref) || this.bySlug(ref) || null; },
        enabled()  { return _data.agents.filter(a => a.enabled !== false); },
        taskCount(id) { return _data.tasks.filter(t => t.agentId == id).length; },

        create(fields) {
            reclaimStaleSlug(slugifyAgent(fields.slug || fields.name), null);
            const taken = new Set(_data.agents.map(a => a.slug));
            const agent = {
                id:           nextAgentId(),
                slug:         slugifyAgent(fields.slug || fields.name, taken),
                name:         String(fields.name || 'Agent').slice(0, 40),
                emoji:        fields.emoji || '',
                color:        fields.color || '#6366f1',
                avatar:       fields.avatar || '',
                role:         fields.role || '',
                systemPrompt: fields.systemPrompt || '',
                model:        AGENT_MODELS.includes(fields.model) ? fields.model : 'default',
                enabled:      fields.enabled !== false,
                currentTaskId: null,
                createdAt:    new Date().toISOString(),
            };
            _data.agents.push(agent);
            save();
            addActivity('agent_created', agent.name);
            emit('agents:changed', agent);
            return agent;
        },

        update(id, fields) {
            const idx = _data.agents.findIndex(a => a.id == id);
            if (idx === -1) return null;
            const oldName = _data.agents[idx].name;

            if (fields.slug) {
                const taken = new Set(_data.agents.filter(a => a.id != id).map(a => a.slug));
                fields.slug = slugifyAgent(fields.slug, taken);
            } else if (fields.name && fields.name !== oldName) {
                // TASK-529: a rename now follows through to the slug too, so
                // Claude's handle for this agent tracks its current name
                // instead of freezing at whatever it was called when created.
                reclaimStaleSlug(slugifyAgent(fields.name), id);
                const taken = new Set(_data.agents.filter(a => a.id != id).map(a => a.slug));
                fields.slug = slugifyAgent(fields.name, taken);
            }
            Object.assign(_data.agents[idx], fields);

            // assignee is a denormalized copy of the name — a rename has to
            // rewrite it, or cards and the CSV export go stale.
            if (fields.name && fields.name !== oldName) {
                let touched = false;
                _data.tasks.forEach(t => {
                    if (t.agentId == id) { t.assignee = fields.name; touched = true; }
                });
                if (touched) emit('tasks:changed', { type: 'update' });
            }

            save();
            emit('agents:changed', _data.agents[idx]);
            return _data.agents[idx];
        },

        delete(id) {
            const agent = this.get(id);
            if (!agent) return;
            // Never delete the task with the agent. Drop the reference but keep
            // `assignee` so the board still reads correctly afterwards.
            _data.tasks.forEach(t => { if (t.agentId == id) t.agentId = null; });
            _data.agents = _data.agents.filter(a => a.id != id);
            save();
            addActivity('agent_deleted', agent.name);
            emit('agents:changed');
            emit('tasks:changed', { type: 'update' });
        },

        /**
         * Assign a task to an agent, claiming it immediately if the agent is
         * free, or leaving it queued behind whatever the agent is already
         * working. Returns whether the agent should start on it right now.
         */
        assignTask(agentId, taskId) {
            const agent = this.get(agentId);
            const task  = _data.tasks.find(t => t.id == taskId);
            if (!agent || !task) return null;

            const oldAgentId = task.agentId ?? null;
            if (oldAgentId != null && oldAgentId != agentId) this.releaseTask(oldAgentId, taskId);

            // A task left sitting in "To Be Tested" no longer occupies its
            // agent, even if nobody explicitly freed it yet (TASK-572) —
            // self-heal here the same way releaseTask does.
            const current = agent.currentTaskId != null ? _data.tasks.find(t => t.id == agent.currentTaskId) : null;
            if (current && isToBeTestedColumn(current)) promoteNextForAgent(agentId, current.projectId);

            task.agentId     = agent.id;
            task.assignee    = agent.name;
            task.assignedAt  = new Date().toISOString();
            task.agentDoneAt = null;

            const startNow = agent.currentTaskId == null && !isBlockedColumn(task);
            if (startNow) {
                agent.currentTaskId = task.id;
                // Claimed, but only moves to In Progress once a live session
                // is actually up to work it (TASK-574).
                if (agent.sessionActive) moveToInProgressColumn(task);
            }

            save();
            emit('agents:changed', agent);
            emit('tasks:changed', { type: 'update', task });
            return { agent, task, startNow };
        },

        /**
         * The agent is done with this task. Frees it if it was the active one
         * and immediately promotes the next queued task, if there is one.
         */
        releaseTask(agentId, taskId) {
            const agent = this.get(agentId);
            if (!agent) return null;
            const task = _data.tasks.find(t => t.id == taskId);
            if (task) task.agentDoneAt = new Date().toISOString();

            let next = null;
            if (agent.currentTaskId == taskId) next = promoteNextForAgent(agentId, task?.projectId);

            save();
            emit('agents:changed', agent);
            return { freed: agent.currentTaskId !== taskId, next };
        },

        /**
         * Mark this agent's terminal/Claude Desktop session as live — mirrors
         * mcp-server/src/tools.js start_session. Also moves its already-
         * claimed active task to In Progress for the first time, if it
         * hasn't been already (TASK-574).
         */
        startSession(agentId) {
            const agent = this.get(agentId);
            if (!agent) return null;
            agent.sessionActive = true;
            const task = agent.currentTaskId != null ? _data.tasks.find(t => t.id == agent.currentTaskId) : null;
            if (task) moveToInProgressColumn(task);
            save();
            emit('agents:changed', agent);
            return { agent, task: task || null };
        },

        /** Mirrors mcp-server/src/tools.js end_session. Leaves tasks untouched. */
        endSession(agentId) {
            const agent = this.get(agentId);
            if (!agent) return null;
            agent.sessionActive = false;
            save();
            emit('agents:changed', agent);
            return { agent };
        },

        /**
         * Idle / working, and how deep its queue is — what the Settings row
         * shows. `working` stays assignment-based (mirrors
         * mcp-server/src/domain.js agentStatus); `live` is whether a
         * terminal/Claude Desktop session has actually marked itself present
         * (TASK-574) — render the Working/Idle pill from `working && live`,
         * not `working` alone.
         */
        statusFor(id) {
            const agent = this.get(id);
            if (!agent) return null;
            const current = agent.currentTaskId != null ? _data.tasks.find(t => t.id == agent.currentTaskId) : null;
            return {
                working:     current != null && !isToBeTestedColumn(current),
                live:        agent.sessionActive === true,
                currentTask: current || null,
                queueLength: queueForAgent(id, agent.currentTaskId).length,
            };
        },

        /** Tasks pending behind this agent's current one, oldest first. */
        queue(id) {
            const agent = this.get(id);
            return agent ? queueForAgent(id, agent.currentTaskId) : [];
        },

        /**
         * Move one queued task up or down relative to its neighbors, from the
         * Agent Activity tab (TASK-513). Stamps the *entire* current queue
         * with fresh, evenly-spaced `queueOrder` values so the new order
         * sticks instead of only the moved task getting one — a partial stamp
         * would otherwise leave it racing against every still-unordered task's
         * assignedAt, which is exactly what queueSortCompare treats as "no
         * preference yet".
         */
        reorderQueueMove(agentId, taskId, direction) {
            const agent = this.get(agentId);
            if (!agent) return false;
            const list = queueForAgent(agentId, agent.currentTaskId);
            const idx = list.findIndex(t => t.id == taskId);
            if (idx === -1) return false;
            const swapWith = direction === 'up' ? idx - 1 : idx + 1;
            if (swapWith < 0 || swapWith >= list.length) return false;

            [list[idx], list[swapWith]] = [list[swapWith], list[idx]];
            list.forEach((t, i) => { t.queueOrder = (i + 1) * 1000; });

            save();
            emit('tasks:changed', { type: 'reorder' });
            return true;
        },
    };

    // ── Chats (per-project log, TASK-519) ──────────────────
    const Chats = {
        getAll()       { return _data.chats; },
        byProject(pid) { return _data.chats.filter(c => c.projectId == pid).sort((a, b) => a.id - b.id); },
        refresh:  refreshChatsFromFirebase,

        /**
         * Post a human message. Appends via a fresh read-then-write straight to
         * Firebase rather than routing through the debounced whole-state
         * syncToFirebase — see refreshChatsFromFirebase's comment on why chats
         * don't ride that wholesale push.
         */
        async send(projectId, text) {
            const trimmed = String(text || '').trim();
            if (!projectId || !trimmed) return null;

            const msg = {
                id:         Date.now(),
                projectId,
                author:     localStorage.getItem('username') || 'Vaibhav',
                authorType: 'user',
                text:       trimmed,
                taskKey:    null,
                createdAt:  new Date().toISOString(),
            };

            _data.chats.push(msg);
            emit('chats:changed');

            if (window.firebaseRESTIntegration) {
                try {
                    const current = await window.firebaseRESTIntegration.loadData('flowboard_chats');
                    const list = Array.isArray(current) ? current : [];
                    list.push(msg);
                    await window.firebaseRESTIntegration.saveData('flowboard_chats', list);
                } catch (e) {
                    console.warn('State: chat send failed', e);
                }
            }
            return msg;
        },
    };

    // ── Timer ─────────────────────────────────────────────
    /**
     * A timer left running past this is almost certainly a forgotten tab, not
     * real work. Past it we refuse to log silently and ask the user instead.
     */
    const STALE_TIMER_MS = 8 * 60 * 60 * 1000;   // 8 hours
    const IDLE_PROMPT_MS = 15 * 60 * 1000;       // 15 minutes with no input

    const Timer = {
        _interval: null,
        _activetaskId: null,
        _lastActivity: Date.now(),
        _idleNotified: false,

        start(taskId) {
            // Stop any running timer first
            const running = _data.tasks.find(t => t.isTimerRunning);
            if (running) this.stop(running.id);

            Tasks.update(taskId, { isTimerRunning: true, timerStart: Date.now(), timerNote: '' });
            this._activetaskId = taskId;
            this._lastActivity = Date.now();
            this._idleNotified = false;
            this._tick();
            emit('timer:started', taskId);
        },

        /**
         * Update the note attached to a running timer. Persisted immediately
         * (debounced by the caller) so it survives a reload or a tab close —
         * the whole point is capturing context while it's still fresh.
         */
        setNote(taskId, note) {
            const task = Tasks.get(taskId);
            if (!task || !task.isTimerRunning) return;
            task.timerNote = String(note ?? '').slice(0, 2000);
            save();
            emit('timer:note', { taskId, note: task.timerNote });
        },

        getNote(taskId) {
            return Tasks.get(taskId)?.timerNote || '';
        },

        /**
         * Stop and log. `overrideSeconds` lets a recovery prompt log a
         * corrected duration instead of the raw wall-clock elapsed.
         */
        stop(taskId, overrideSeconds = null) {
            const task = Tasks.get(taskId);
            if (!task || !task.isTimerRunning) return;

            const start = task.timerStart != null ? Number(task.timerStart) : null;
            const hasStart = start != null && Number.isFinite(start);
            const elapsedMs = hasStart ? Math.max(0, Date.now() - start) : 0;
            const seconds = overrideSeconds != null
                ? Math.max(0, Math.round(overrideSeconds))
                : Math.max(0, Math.round(elapsedMs / 1000));
            const note = task.timerNote || '';

            task.isTimerRunning = false;
            task.timerStart = null;
            task.timerNote = '';

            if (seconds > 0) {
                Entries.add(task, seconds, {
                    startedAt: hasStart ? new Date(start).toISOString() : null,
                    source: overrideSeconds != null ? 'recovered' : 'timer',
                    note,
                });
            }

            save();
            if (this._interval) { clearInterval(this._interval); this._interval = null; }
            this._activetaskId = null;
            emit('timer:stopped', taskId);
            emit('tasks:changed', { type: 'update', task });
        },

        /** Abandon a running timer without logging anything. */
        discard(taskId) {
            const task = Tasks.get(taskId);
            if (!task) return;
            task.isTimerRunning = false;
            task.timerStart = null;
            task.timerNote = '';
            save();
            if (this._interval) { clearInterval(this._interval); this._interval = null; }
            this._activetaskId = null;
            emit('timer:stopped', taskId);
            emit('tasks:changed', { type: 'update', task });
        },

        noteActivity() {
            this._lastActivity = Date.now();
            this._idleNotified = false;
        },

        toggle(taskId) {
            const task = Tasks.get(taskId);
            if (!task) return;
            task.isTimerRunning ? this.stop(taskId) : this.start(taskId);
        },

        _tick() {
            if (this._interval) clearInterval(this._interval);
            this._interval = setInterval(() => {
                const task = Tasks.get(this._activetaskId);
                if (!task || !task.isTimerRunning) {
                    clearInterval(this._interval);
                    return;
                }
                emit('timer:tick', { taskId: this._activetaskId, elapsed: Date.now() - task.timerStart });

                if (!this._idleNotified && Date.now() - this._lastActivity > IDLE_PROMPT_MS) {
                    this._idleNotified = true;
                    emit('timer:idle', {
                        taskId: this._activetaskId,
                        idleMs: Date.now() - this._lastActivity,
                    });
                }
            }, 1000);
        },

        getElapsed(taskId) {
            const task = Tasks.get(taskId);
            if (!task || !task.isTimerRunning) return 0;
            return Date.now() - task.timerStart;
        },

        getRunning() {
            return _data.tasks.find(t => t.isTimerRunning) || null;
        },

        STALE_TIMER_MS,
    };

    // ── Time entries ──────────────────────────────────────
    /**
     * `duration` is seconds; `task.timeSpent` is hours. Every mutation goes
     * through here so the two never drift apart.
     */
    const Entries = {
        add(task, seconds, { startedAt = null, note = '', source = 'manual' } = {}) {
            if (!Array.isArray(task.timeEntries)) task.timeEntries = [];
            const endedAt = new Date();
            const entry = {
                id: Date.now() + Math.floor(Math.random() * 1000),
                date: endedAt.toISOString(),
                startedAt: startedAt || new Date(endedAt.getTime() - seconds * 1000).toISOString(),
                duration: Math.max(0, Math.round(seconds)),
                note,
                source,
            };
            task.timeEntries.push(entry);
            this._recompute(task);
            return entry;
        },

        /** Manual log against a task id, with an explicit date. */
        logManual(taskId, { seconds, date, note = '' }) {
            const task = Tasks.get(taskId);
            if (!task || !(seconds > 0)) return null;
            if (!Array.isArray(task.timeEntries)) task.timeEntries = [];

            const endedAt = date ? new Date(`${date}T12:00:00`) : new Date();
            const entry = {
                id: Date.now() + Math.floor(Math.random() * 1000),
                date: endedAt.toISOString(),
                startedAt: new Date(endedAt.getTime() - seconds * 1000).toISOString(),
                duration: Math.max(0, Math.round(seconds)),
                note,
                source: 'manual',
            };
            task.timeEntries.push(entry);
            this._recompute(task);
            save();
            addActivity('logged time on', task.title, formatDuration(seconds));
            emit('tasks:changed', { type: 'update', task });
            return entry;
        },

        update(taskId, entryId, { seconds, note }) {
            const task = Tasks.get(taskId);
            const entry = task?.timeEntries?.find(e => e.id === entryId);
            if (!entry) return null;
            if (seconds != null) entry.duration = Math.max(0, Math.round(seconds));
            if (note != null)    entry.note = note;
            this._recompute(task);
            save();
            emit('tasks:changed', { type: 'update', task });
            return entry;
        },

        remove(taskId, entryId) {
            const task = Tasks.get(taskId);
            if (!task?.timeEntries) return false;
            const before = task.timeEntries.length;
            task.timeEntries = task.timeEntries.filter(e => e.id !== entryId);
            if (task.timeEntries.length === before) return false;
            this._recompute(task);
            save();
            addActivity('removed a time entry on', task.title);
            emit('tasks:changed', { type: 'update', task });
            return true;
        },

        getAll(taskId) {
            const task = Tasks.get(taskId);
            return (task?.timeEntries || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
        },

        /** timeSpent (hours) is always derived from the entries, never added to. */
        _recompute(task) {
            const totalSeconds = (task.timeEntries || []).reduce((s, e) => s + (Number(e.duration) || 0), 0);
            task.timeSpent = totalSeconds / 3600;
        },
    };

    function formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.round((seconds % 3600) / 60);
        return h ? `${h}h ${m}m` : `${m}m`;
    }

    // ── Labels ────────────────────────────────────────────
    const Labels = {
        getAll() { return _data.labels; },
        get(id)  { return _data.labels.find(l => l.id === id); },
    };

    // ── Activity ──────────────────────────────────────────
    const Activity = {
        getAll()  { return _data.activity; },
        add: addActivity,
    };

    // ── Helpers ───────────────────────────────────────────
    function getColumnById(projectId, columnId) {
        const proj = Projects.get(projectId);
        if (!proj) return null;
        return proj.columns.find(c => c.id === columnId) || null;
    }

    function getFirstColumn(projectId) {
        const proj = Projects.get(projectId);
        if (!proj || !proj.columns.length) return null;
        return [...proj.columns].sort((a, b) => a.position - b.position)[0];
    }

    // ── Data export / clear ───────────────────────────────
    function exportData() {
        const blob = new Blob([JSON.stringify(_data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `flowboard-export-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Validate an exported payload without applying it, so the UI can show the
     * user exactly what an import would bring in before anything is replaced.
     */
    function inspectImport(json) {
        let parsed;
        try { parsed = typeof json === 'string' ? JSON.parse(json) : json; }
        catch { return { ok: false, error: 'That file is not valid JSON.' }; }

        if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'That file is not an AriseX export.' };
        if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.tasks)) {
            return { ok: false, error: 'That file is missing a projects or tasks list.' };
        }

        return {
            ok: true,
            data: parsed,
            summary: {
                projects: parsed.projects.length,
                tasks:    parsed.tasks.length,
                agents:   Array.isArray(parsed.agents)  ? parsed.agents.length  : 0,
            },
        };
    }

    /** Replace all data with a validated import payload. */
    function importData(json) {
        const check = inspectImport(json);
        if (!check.ok) return check;

        _data = Object.assign(getDefaults(), check.data);
        if (!_data.labels?.length) _data.labels = defaultLabels;
        if (!Array.isArray(_data.agents))   _data.agents   = [];
        if (!Array.isArray(_data.activity)) _data.activity = [];

        normalizeAllTasks();
        normalizeAllAgents();
        removeOrphanedTasks();
        migrateTimeEntries();

        _taskCounter = _data.tasks.reduce((max, t) => {
            const n = parseInt(String(t.taskKey || '').replace(/\D/g, ''), 10);
            return Number.isNaN(n) ? max : Math.max(max, n);
        }, 0);

        save();
        emit('state:reset');
        return check;
    }

    function clearAll() {
        _data = getDefaults();
        _taskCounter = 0;
        save();
        emit('state:reset');
    }

    // ── Init ──────────────────────────────────────────────
    /**
     * Older entries stored only a stop timestamp and no id. Backfill both so
     * entries can be edited and so a day view has a real start time to use.
     */
    function migrateTimeEntries() {
        let changed = false;
        _data.tasks.forEach(task => {
            if (!Array.isArray(task.timeEntries) || !task.timeEntries.length) return;
            task.timeEntries.forEach((e, i) => {
                if (e.id == null) { e.id = Date.parse(e.date) + i; changed = true; }
                if (!e.startedAt && e.date && e.duration != null) {
                    e.startedAt = new Date(Date.parse(e.date) - e.duration * 1000).toISOString();
                    changed = true;
                }
                if (e.source == null) { e.source = 'timer'; changed = true; }
            });
            // Reconcile any historical drift between entries and the total.
            const derived = task.timeEntries.reduce((s, e) => s + (Number(e.duration) || 0), 0) / 3600;
            if (Math.abs((task.timeSpent || 0) - derived) > 0.01) {
                task.timeSpent = derived;
                changed = true;
            }
        });
        if (changed) save();
    }

    function init() {
        load();
        migrateTimeEntries();

        // A timer still flagged running means the tab was closed mid-session.
        // Never log that span silently — hand it to the UI to resolve.
        const running = _data.tasks.find(t => t.isTimerRunning);
        if (running) {
            const elapsed = running.timerStart ? Date.now() - Number(running.timerStart) : 0;
            if (elapsed > STALE_TIMER_MS) {
                // State.init() runs before the UI subscribes, so defer the emit
                // to the next tick — otherwise nobody is listening yet.
                setTimeout(() => emit('timer:stale', { taskId: running.id, elapsedMs: elapsed }), 0);
            } else {
                Timer._activetaskId = running.id;
                Timer.noteActivity();
                Timer._tick();
            }
        }

        // Feed the idle detector.
        ['mousemove', 'keydown', 'click', 'scroll'].forEach(evt => {
            window.addEventListener(evt, () => Timer.noteActivity(), { passive: true });
        });
    }

    return {
        on, off, emit,
        Projects, Tasks, Agents, Chats, Labels, Activity, Timer, Entries,
        getColumnById, getFirstColumn, formatDuration,
        load, save, init, exportData, importData, inspectImport, clearAll, loadFromFirebase,
        get data() { return _data; },
    };
})();

window.State = State;
