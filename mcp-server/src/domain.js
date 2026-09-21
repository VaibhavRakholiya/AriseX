/**
 * FlowBoard domain invariants, ported for Node.
 *
 * ── SOURCE OF TRUTH ─────────────────────────────────────────────────────────
 * The browser's copy of these rules lives in ../../js/state.js — the task
 * literal in `Tasks.create`, `taskHasValidProject`, the task-key counter in
 * `load`/`importData`, `slugifyAgent`, and `Entries._recompute`.
 *
 * js/state.js cannot be imported here: it is an IIFE assigned to `window` that
 * touches localStorage, document and setInterval throughout, and making it dual
 * browser/Node would mean a build step the project deliberately does without.
 * So these rules are duplicated on purpose. They CAN drift, and the symptoms
 * are silent (duplicate TASK-n keys, timeSpent disagreeing with timeEntries),
 * so `npm run smoke` diffs the task shape against js/state.js on every run.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const PRIORITIES  = ['low', 'medium', 'high', 'urgent', 'critical'];
export const AGENT_MODELS = ['default', 'opus', 'sonnet', 'haiku'];

/** Mirrors js/state.js `importData` — the /\D/g form, which is the more robust of the two in the app. */
export function nextTaskKey(tasks) {
    const max = (tasks || []).reduce((m, t) => {
        const n = parseInt(String(t.taskKey || '').replace(/\D/g, ''), 10);
        return Number.isNaN(n) ? m : Math.max(m, n);
    }, 0);
    return `TASK-${max + 1}`;
}

/** Date.now() collides when several records are created in the same millisecond. */
export function uniqueId(existing) {
    let id = Date.now();
    const taken = new Set((existing || []).map(r => r.id));
    while (taken.has(id)) id++;
    return id;
}

/** Mirrors js/state.js `taskHasValidProject`. A task with no live project is invalid. */
export function taskHasValidProject(task, projects) {
    if (!task || task.projectId == null || task.projectId === '') return false;
    return (projects || []).some(p => p.id == task.projectId);
}

export function getFirstColumn(project) {
    if (!project || !Array.isArray(project.columns) || !project.columns.length) return null;
    return [...project.columns].sort((a, b) => (a.position || 0) - (b.position || 0))[0];
}

/** Resolve a column by id, then by case-insensitive name, so Claude can say "In Progress". */
export function resolveColumn(project, ref) {
    if (!project || ref == null || ref === '') return null;
    const cols = project.columns || [];
    return cols.find(c => c.id === ref)
        || cols.find(c => String(c.name).toLowerCase() === String(ref).toLowerCase())
        || null;
}

/** Mirrors js/state.js `Tasks.create` — positions are spaced by 1000. */
export function nextPosition(tasks) {
    return ((tasks || []).length + 1) * 1000;
}

/** timeSpent is HOURS and is always derived, never accumulated (js/state.js `Entries._recompute`). */
export function computeTimeSpent(entries) {
    return (entries || []).reduce((s, e) => s + (Number(e.duration) || 0), 0) / 3600;
}

/** Mirrors js/state.js `slugifyAgent`. */
export function slugifyAgent(name, taken) {
    const base = String(name || 'agent').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
    let slug = base;
    let n = 2;
    while (taken && taken.has(slug)) slug = `${base}-${n++}`;
    return slug;
}

/**
 * Mirrors js/state.js `reclaimStaleSlug` (TASK-529). Mutates `agents` in
 * place: if `cleanSlug` is held by a different agent whose own current name
 * no longer slugifies to it (left behind by a rename), relocate that agent
 * to a slug matching its own name, freeing `cleanSlug` for whoever's asking.
 * A slug that still matches its holder's name is a live identity and is
 * left untouched.
 */
export function reclaimStaleSlug(agents, cleanSlug, excludeId) {
    const holder = agents.find(a => a.slug === cleanSlug && a.id != excludeId);
    if (!holder || slugifyAgent(holder.name) === cleanSlug) return;
    const taken = new Set(agents.filter(a => a.id !== holder.id).map(a => a.slug));
    holder.slug = slugifyAgent(holder.name, taken);
}

/**
 * Put back everything RTDB strips. A task read straight from Firebase can be
 * missing every empty array and every null field, so nothing downstream can
 * assume a key exists.
 */
export function hydrateTask(raw) {
    const t = { ...raw };
    t.labels      = asArray(t.labels);
    t.comments    = asArray(t.comments);
    t.timeEntries = asArray(t.timeEntries);
    t.subtasks    = hydrateSubtasks(t.subtasks);

    for (const k of ['columnId', 'dueDate', 'startDate', 'timeEstimate', 'agentId',
                     'timerStart', 'assignedAt', 'agentDoneAt']) {
        if (t[k] === undefined || t[k] === '') t[k] = null;
    }
    t.title          = t.title || 'Untitled Task';
    t.description    = t.description || '';
    t.priority       = t.priority || 'medium';
    t.assignee       = t.assignee || '';
    t.timerNote      = t.timerNote || '';
    t.isTimerRunning = t.isTimerRunning === true;
    t.position       = t.position != null ? t.position : 0;
    t.createdAt      = t.createdAt || new Date().toISOString();
    t.timeSpent      = computeTimeSpent(t.timeEntries);
    return t;
}

function hydrateSubtasks(list) {
    return asArray(list).map(s => ({
        ...s,
        completed: !!s.completed,
        text:      s.text || '',
        subtasks:  hydrateSubtasks(s.subtasks),
    }));
}

function asArray(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v.filter(x => x != null);
    if (typeof v === 'object') {
        return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map(k => v[k]).filter(x => x != null);
    }
    return [];
}

export function hydrateAgent(raw) {
    const a = { ...raw };
    a.name         = a.name || 'Agent';
    a.slug         = a.slug || slugifyAgent(a.name);
    a.emoji        = a.emoji || '';
    a.color        = /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#6366f1';
    a.role         = a.role || '';
    a.systemPrompt = a.systemPrompt || '';
    a.model        = AGENT_MODELS.includes(a.model) ? a.model : 'default';
    a.enabled       = a.enabled !== false;
    a.createdAt     = a.createdAt || new Date().toISOString();
    a.currentTaskId = a.currentTaskId === undefined || a.currentTaskId === '' ? null : a.currentTaskId;
    // Whether a live terminal/Claude Desktop session has marked itself
    // present via start_session — distinct from having a currentTaskId,
    // which just means a task is claimed/queued (TASK-574).
    a.sessionActive = a.sessionActive === true;
    return a;
}

/**
 * A task sitting in a column literally named "Done" is finished, whether or
 * not agentDoneAt ever got stamped for it (TASK-605). Mirrors js/state.js
 * isDoneColumnExact. Still used by tools.js move_task's autoFinish check;
 * queueForAgent below now uses the stronger isToDoColumn allowlist instead.
 */
export function isDoneColumn(task, projects) {
    if (!task) return false;
    const project = (projects || []).find(p => p.id == task.projectId);
    if (!project) return false;
    const col = (project.columns || []).find(c => c.id === task.columnId);
    return !!col && String(col.name).trim().toLowerCase() === 'done';
}

/**
 * Exact-match "To Do" — the only column a task can sit in and still show up
 * in queueForAgent's listing (TASK-607). Mirrors js/state.js isToDoColumn.
 */
export function isToDoColumn(task, projects) {
    if (!task) return false;
    const project = (projects || []).find(p => p.id == task.projectId);
    if (!project) return false;
    const col = (project.columns || []).find(c => c.id === task.columnId);
    return !!col && String(col.name).trim().toLowerCase() === 'to do';
}

/**
 * Pending work for an agent, oldest assignment first, excluding whatever it's
 * actively on (excludeTaskId), anything already marked done (agentDoneAt),
 * and — as of TASK-607 — anything not currently sitting in a column
 * literally named "To Do". Backlog, In Review, To Be Tested and Done all
 * drop out of the queue the moment a task lands there, whether that move
 * came from the board or an agent's own move_task, since this is the single
 * listing both sides read from (tools.js list_tasks queuePosition, and
 * js/state.js's Agent Activity dashboard). `projects` is required to apply
 * the column check — omitting it means nothing passes. Mirrors js/state.js
 * queueForAgent.
 */
/**
 * Oldest-assignment-first, unless the user manually reordered the queue from
 * the web UI's Agent Activity tab (TASK-513) — a task carrying a
 * `queueOrder` sorts by that instead, ahead of anything untouched. Mirrors
 * js/state.js queueSortCompare.
 */
function queueSortCompare(a, b) {
    const ao = a.queueOrder, bo = b.queueOrder;
    if (ao != null && bo != null) return ao - bo;
    if (ao != null) return -1;
    if (bo != null) return 1;
    return new Date(a.assignedAt || a.createdAt) - new Date(b.assignedAt || b.createdAt);
}

export function queueForAgent(tasks, agentId, excludeTaskId, projects) {
    return (tasks || [])
        .filter(t => t.agentId == agentId && t.agentDoneAt == null && t.id != excludeTaskId
            && isToDoColumn(hydrateTask(t), projects))
        .sort(queueSortCompare);
}

/**
 * A task sitting in a column literally named "Backlog" is assigned but not
 * ready — several real projects here (e.g. "Blower", "Origami Weapons") use
 * it as the stage before "To Do". Mirrors js/state.js isBacklogColumn.
 */
export function isBacklogColumn(task, projects) {
    if (!task) return false;
    const project = (projects || []).find(p => p.id == task.projectId);
    if (!project) return false;
    const col = (project.columns || []).find(c => c.id === task.columnId);
    return !!col && String(col.name).trim().toLowerCase() === 'backlog';
}

/**
 * A task sitting in "In Review" or "To Be Tested" is mid-review, not open
 * work — an agent should only ever pick up something still in "To Do" (or
 * whatever pre-review column a project uses). Mirrors js/state.js
 * isReviewColumn (TASK-571).
 */
export function isReviewColumn(task, projects) {
    if (!task) return false;
    const project = (projects || []).find(p => p.id == task.projectId);
    if (!project) return false;
    const col = (project.columns || []).find(c => c.id === task.columnId);
    if (!col) return false;
    const name = String(col.name).trim().toLowerCase();
    return name === 'in review' || name === 'to be tested';
}

/** Not open work for an agent to pick up on its own: Backlog, In Review, To Be Tested. */
export function isBlockedColumn(task, projects) {
    return isBacklogColumn(task, projects) || isReviewColumn(task, projects);
}

/**
 * A task sitting in a column literally named "To Be Tested" is done from the
 * agent's side and waiting on a human — it stays assigned (still the agent's
 * currentTaskId, still in its history) but no longer ties up the agent
 * (TASK-572). Mirrors js/state.js isToBeTestedColumn.
 */
export function isToBeTestedColumn(task, projects) {
    if (!task) return false;
    const project = (projects || []).find(p => p.id == task.projectId);
    if (!project) return false;
    const col = (project.columns || []).find(c => c.id === task.columnId);
    return !!col && String(col.name).trim().toLowerCase() === 'to be tested';
}

/**
 * Which of an agent's pending tasks should become active next. Prefers the
 * oldest ready task in `preferProjectId` (the project the agent was just
 * working in) over strict global FIFO order — an agent mid-stream on one
 * project shouldn't hop to a different project's older-queued task just
 * because that one was assigned first, and shouldn't sit idle because
 * everything ready in its own project happens to be behind an older,
 * still-blocked task from elsewhere (TASK-573). Falls back to the oldest
 * ready task across all projects when its own project has nothing left.
 * Mirrors js/state.js pickNextForAgent.
 */
export function pickNextForAgent(tasks, agentId, excludeTaskId, projects, preferProjectId) {
    const ready = queueForAgent(tasks, agentId, excludeTaskId, projects).filter(t => !isBlockedColumn(hydrateTask(t), projects));
    if (preferProjectId != null) {
        const sameProject = ready.find(t => t.projectId == preferProjectId);
        if (sameProject) return sameProject;
    }
    return ready[0] || null;
}

/**
 * `projects` is optional for callers that only need queue bookkeeping and
 * never see a "To Be Tested" column, but passing it is what lets a task
 * sitting there stop counting as occupying the agent (TASK-572).
 *
 * `working` stays purely assignment-based (a current task in a workable
 * column) — daemon.js and the queue-promotion logic need that signal
 * regardless of whether any session has actually started on it yet, or
 * nothing would ever get dispatched in the first place. `live` is the new,
 * separate signal for whether a terminal/Claude Desktop session has marked
 * itself present via start_session (TASK-574) — callers that render a
 * user-facing "Working"/"Idle" label should show working only when both are
 * true; `working && !live` means "assigned, waiting on a session to pick it
 * up," not "in progress."
 */
export function agentStatus(agent, tasks, projects) {
    const current = agent.currentTaskId != null ? (tasks || []).find(t => t.id == agent.currentTaskId) || null : null;
    const working = current != null && !isToBeTestedColumn(current, projects);
    const live = agent.sessionActive === true;
    return {
        live,
        working,
        currentTask: current,
        queueLength: queueForAgent(tasks, agent.id, agent.currentTaskId, projects).length,
    };
}

/** Accept an id or a slug — Claude naturally says the slug. */
export function resolveAgent(agents, ref) {
    if (ref == null || ref === '') return null;
    return (agents || []).find(a => a.id == ref)
        || (agents || []).find(a => a.slug === String(ref).toLowerCase())
        || null;
}

/** Accept a numeric id or a "TASK-42" key. */
export function resolveTask(tasks, ref) {
    if (ref == null || ref === '') return null;
    const byKey = String(ref).toUpperCase();
    return (tasks || []).find(t => t.id == ref)
        || (tasks || []).find(t => String(t.taskKey || '').toUpperCase() === byKey)
        || null;
}
