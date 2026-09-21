/**
 * FlowBoard MCP tool handlers.
 *
 * Every handler is a plain exported async function taking a validated args
 * object, so smoke.js can exercise the exact code the MCP client calls with no
 * JSON-RPC in the loop. index.js only registers them.
 *
 * Writes go through store.mutate(), which is compare-and-set: the mutation
 * callback may run more than once, so it must stay side-effect free.
 */

import * as store from './store.js';
import * as D from './domain.js';

const REFRESH_HINT = 'Reload FlowBoard, or use Settings → Data → Refresh from Cloud, to see this on the board.';

/**
 * Drop a system/agent message into a project's chat log (TASK-519) — the
 * in-app trail of "moved to review", "assigned", "idle" events that the web
 * app surfaces as chat + notifications. Best-effort: a chat write failing
 * must never fail the task mutation it's reporting on.
 */
async function postChatMessage(projectId, { author, authorType = 'system', text, taskKey } = {}) {
    if (projectId == null || !text) return;
    try {
        await store.mutate('chats', (chats) => {
            const msg = {
                id: D.uniqueId(chats),
                projectId,
                author: author || 'System',
                authorType,
                text,
                taskKey: taskKey || null,
                createdAt: new Date().toISOString(),
            };
            return { next: [...chats, msg], result: msg };
        });
    } catch { /* chat is a side channel — never block the caller on it */ }
}

/**
 * Keep one agent's busy/queue state consistent with a task that just finished,
 * moved away, or needs claiming — the one thing that makes assignment mean
 * "start now or wait your turn" instead of just a label on a card.
 *
 * `justFinishedTaskId`: clear this from the agent's active slot if it's there,
 * and promote whatever's next in its queue.
 * `claimTaskId`: take this task if the agent is free after that; otherwise
 * report where it landed in the queue.
 *
 * This is a second, separate compare-and-set write on the 'agents' collection
 * — not part of the same transaction as whatever wrote 'tasks' just before it.
 * If the process dies between the two, the task record can end up pointing at
 * an agent that never claimed it. Nothing here trusts that ever synced
 * correctly: every call recomputes from what's actually in Firebase right now,
 * so the next assign_task / finish_task call self-heals rather than compounds
 * the drift.
 */
async function releaseAndClaim(agentId, { justFinishedTaskId, claimTaskId } = {}) {
    return store.mutate('agents', async (agentsList) => {
        const idx = agentsList.findIndex(a => a.id == agentId);
        if (idx === -1) {
            return { next: undefined, result: { agentStatus: 'unassigned', startNow: false, queuePosition: null, currentTaskId: null, sessionActive: false } };
        }

        const agent = D.hydrateAgent(agentsList[idx]);
        // Freshly read on every attempt (including CAS retries) — cheap, and
        // it's what lets a promoted task reflect a task write that landed
        // between our own retries.
        const [tasks, projects] = await Promise.all([store.read('tasks'), store.read('projects')]);
        // Backlog, In Review and To Be Tested items are assigned but not open
        // work (TASK-571) — never auto-promoted or claimed, only tasks still
        // in a real working column (e.g. "To Do") are.
        const isReady = t => !D.isBlockedColumn(D.hydrateTask(t), projects);

        // A task sitting in "To Be Tested" is done from the agent's side and
        // waiting on a human — it no longer occupies the agent, even if
        // nobody called finish_task on it yet (TASK-572). Self-heals on every
        // call, the same way the rest of this function does: whether that
        // landed here via move_task's own release below, or a column change
        // from somewhere else entirely (e.g. dragged on the board).
        const current = agent.currentTaskId != null ? tasks.find(t => t.id == agent.currentTaskId) : null;
        const currentIsToBeTested = current != null && D.isToBeTestedColumn(D.hydrateTask(current), projects);

        let changed = false;
        if (justFinishedTaskId != null && agent.currentTaskId == justFinishedTaskId) {
            const next = D.pickNextForAgent(tasks, agent.id, agent.currentTaskId, projects, current?.projectId);
            agent.currentTaskId = next ? next.id : null;
            changed = true;
        } else if (currentIsToBeTested) {
            const next = D.pickNextForAgent(tasks, agent.id, agent.currentTaskId, projects, current.projectId);
            agent.currentTaskId = next ? next.id : null;
            changed = true;
        }

        let result;
        if (claimTaskId != null) {
            const claimTask = tasks.find(t => t.id == claimTaskId);
            const claimIsBlocked = claimTask ? !isReady(claimTask) : false;

            if (claimIsBlocked) {
                // Assigned, but sitting in Backlog/In Review/To Be Tested —
                // stays put, doesn't start, even if the agent is otherwise free.
                const hydrated = D.hydrateTask(claimTask);
                const project = projects.find(p => p.id == hydrated.projectId);
                const col = project?.columns?.find(c => c.id === hydrated.columnId);
                result = { agentStatus: 'backlog', startNow: false, queuePosition: null, blockedColumnName: col?.name || null };
            } else if (agent.currentTaskId == null) {
                agent.currentTaskId = claimTaskId;
                changed = true;
                result = { agentStatus: 'active', startNow: true, queuePosition: 0 };
            } else if (agent.currentTaskId == claimTaskId) {
                result = { agentStatus: 'active', startNow: false, queuePosition: 0 };
            } else {
                const queue = D.queueForAgent(tasks, agent.id, agent.currentTaskId, projects);
                const pos = queue.findIndex(t => t.id == claimTaskId);
                result = { agentStatus: 'queued', startNow: false, queuePosition: pos === -1 ? queue.length : pos + 1 };
            }
        } else {
            result = { agentStatus: agent.currentTaskId != null ? 'active' : 'unassigned', startNow: false, queuePosition: null };
        }
        result.currentTaskId = agent.currentTaskId;
        // Whether this agent's terminal/Claude Desktop session is actually
        // live right now — callers use this to decide whether to move a
        // freshly claimed/promoted task to "In Progress" immediately, or
        // leave it for start_session to do once a session picks it up
        // (TASK-574).
        result.sessionActive = agent.sessionActive === true;

        if (!changed) return { next: undefined, result };
        const next = agentsList.slice();
        next[idx] = agent;
        return { next, result };
    });
}

/**
 * Best-effort: once a task is confirmed active (currentTaskId) *and* a live
 * session has picked it up, move it into the project's "In Progress" column
 * so the board shows what's actually being worked — mirrors js/state.js
 * moveToInProgressColumn. Callers only reach this when the agent's
 * sessionActive flag is true (see start_session and the `sessionActive`
 * result from releaseAndClaim) — a claimed-but-not-yet-live task stays in
 * its assigned column until a real session starts on it (TASK-574). Silent
 * no-op if the project has no column with that exact name. This is a third,
 * independent CAS write in the same non-atomic chain documented for
 * releaseAndClaim — if it fails or is skipped, the task is still correctly
 * assigned and active, just visually still in its old column.
 */
async function moveToInProgressIfActive(taskId) {
    if (taskId == null) return { moved: false };
    const projects = await store.read('projects');

    return store.mutate('tasks', (tasksList) => {
        const idx = tasksList.findIndex(t => t.id == taskId);
        if (idx === -1) return { next: undefined, result: { moved: false } };

        const found = D.hydrateTask(tasksList[idx]);
        const project = projects.find(p => p.id == found.projectId);
        const col = project ? D.resolveColumn(project, 'In Progress') : null;
        if (!col || found.columnId === col.id) return { next: undefined, result: { moved: false } };

        const next = tasksList.slice();
        next[idx] = { ...found, columnId: col.id };
        return { next, result: { moved: true, columnId: col.id, columnName: col.name } };
    });
}

// ── Read tools ─────────────────────────────────────────────

export async function list_projects() {
    const [projects, tasks] = await Promise.all([store.read('projects'), store.read('tasks')]);
    return projects.map(p => ({
        id:          p.id,
        name:        p.name,
        description: p.description || '',
        repo:        p.repo || '',
        color:       p.color,
        columns:     (p.columns || []).slice()
                        .sort((a, b) => (a.position || 0) - (b.position || 0))
                        .map(c => ({ id: c.id, name: c.name, position: c.position })),
        taskCount:   tasks.filter(t => t.projectId == p.id).length,
    }));
}

export async function list_agents({ includeDisabled = false } = {}) {
    const [rawAgents, rawTasks, projects] = await Promise.all([store.read('agents'), store.read('tasks'), store.read('projects')]);
    const tasks = rawTasks.map(D.hydrateTask);
    return rawAgents.map(D.hydrateAgent)
        .filter(a => includeDisabled || a.enabled)
        .map(a => {
            const s = D.agentStatus(a, tasks, projects);
            return {
                id: a.id, slug: a.slug, name: a.name, emoji: a.emoji, color: a.color,
                role: a.role, model: a.model, enabled: a.enabled,
                // Included so Claude can adopt the profile without a second call.
                systemPrompt: a.systemPrompt,
                // 'idle' means assign_task will start work immediately; 'working'
                // means a new assignment queues behind currentTaskKey. Requires a
                // *live* session (start_session), not just a claimed task — an
                // agent with work assigned but nobody actually running it yet
                // reads as idle here, even though a new assignment would still
                // queue behind currentTaskKey once a session does pick it up
                // (TASK-574).
                status: (s.working && s.live) ? 'working' : 'idle',
                live: s.live,
                currentTaskKey: s.currentTask?.taskKey || null,
                queueLength: s.queueLength,
                assignedTaskCount: tasks.filter(t => t.agentId == a.id).length,
            };
        });
}

export async function list_tasks(args = {}) {
    const { projectId, column, assignee, agent, priority,
            unassignedAgent, query, limit = 50 } = args;

    const [rawTasks, projects, agents] = await Promise.all([
        store.read('tasks'), store.read('projects'), store.read('agents'),
    ]);
    const tasks = rawTasks.map(D.hydrateTask);

    let agentId = null, agentRecord = null;
    if (agent != null && agent !== '') {
        agentRecord = D.resolveAgent(agents.map(D.hydrateAgent), agent);
        if (!agentRecord) throw new Error(`No agent matches "${agent}". Use list_agents to see available agents.`);
        agentId = agentRecord.id;
    }

    const out = tasks.filter(t => {
        if (projectId != null && t.projectId != projectId) return false;
        if (priority  != null && t.priority  !== priority) return false;
        if (assignee  != null && t.assignee  !== assignee) return false;
        if (agentId   != null && t.agentId   != agentId)   return false;
        if (unassignedAgent && t.agentId != null) return false;
        if (column != null && column !== '') {
            const proj = projects.find(p => p.id == t.projectId);
            const col  = D.resolveColumn(proj, column);
            if (!col || t.columnId !== col.id) return false;
        }
        if (query) {
            const q = String(query).toLowerCase();
            const hay = `${t.title} ${t.description} ${t.taskKey}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    return out.slice(0, limit).map(t => {
        const summary = summarize(t, projects, agents);
        // 0 = the agent's active task right now; 1+ = position in its queue;
        // null = unrelated to this agent, or already finished (see agentDone).
        if (agentId != null) {
            if (summary.agentDone) {
                summary.queuePosition = null;
            } else if (t.id == agentRecord.currentTaskId) {
                summary.queuePosition = 0;
            } else {
                const q = D.queueForAgent(tasks, agentId, agentRecord.currentTaskId, projects);
                const i = q.findIndex(x => x.id === t.id);
                summary.queuePosition = i === -1 ? null : i + 1;
            }
        }
        return summary;
    });
}

export async function get_task({ task }) {
    const [rawTasks, projects, agents] = await Promise.all([
        store.read('tasks'), store.read('projects'), store.read('agents'),
    ]);
    const found = D.resolveTask(rawTasks, task);
    if (!found) throw new Error(`No task matches "${task}". Pass a numeric id or a key like TASK-12.`);

    const t = D.hydrateTask(found);
    const proj = projects.find(p => p.id == t.projectId);
    const agent = t.agentId != null ? D.resolveAgent(agents.map(D.hydrateAgent), t.agentId) : null;
    const labelIds = new Set(t.labels);

    return {
        ...t,
        projectName: proj?.name || null,
        columnName:  D.resolveColumn(proj, t.columnId)?.name || null,
        labelNames:  (proj?.labels || []).filter(l => labelIds.has(l.id)).map(l => l.name),
        agent:       agent ? { id: agent.id, slug: agent.slug, name: agent.name, role: agent.role } : null,
        // True when this is the agent's current active task (start now); false
        // when it's queued behind something else, or the agent already
        // finished it (see agentDoneAt above).
        isActiveForAgent: agent != null && agent.currentTaskId == t.id,
        subtaskStats: countSubtasks(t.subtasks),
    };
}

// ── Write tools ────────────────────────────────────────────

export async function create_task(args) {
    const { projectId, title } = args;
    if (!title || !String(title).trim()) throw new Error('title is required.');

    const [projects, agents] = await Promise.all([store.read('projects'), store.read('agents')]);
    const project = projects.find(p => p.id == projectId);
    // Mirrors js/state.js Tasks.create — a task with no live project is refused.
    if (!project) throw new Error(`No project with id ${projectId}. Use list_projects first.`);

    const column = args.column ? D.resolveColumn(project, args.column) : D.getFirstColumn(project);
    if (args.column && !column) {
        throw new Error(`No column "${args.column}" in project "${project.name}". ` +
            `Available: ${(project.columns || []).map(c => c.name).join(', ')}.`);
    }

    const owner = resolveOwner(agents, args);

    const created = await store.mutate('tasks', (tasks) => {
        const task = {
            id:             D.uniqueId(tasks),
            taskKey:        D.nextTaskKey(tasks),
            projectId:      project.id,
            columnId:       column?.id ?? null,
            title:          String(title).trim(),
            description:    args.description || '',
            priority:       D.PRIORITIES.includes(args.priority) ? args.priority : 'medium',
            labels:         Array.isArray(args.labels) ? args.labels : [],
            assignee:       owner.assignee,
            agentId:        owner.agentId,
            assignedAt:     owner.agentId != null ? new Date().toISOString() : null,
            agentDoneAt:    null,
            startDate:      args.startDate || null,
            dueDate:        args.dueDate || null,
            timeEstimate:   args.timeEstimate ?? null,
            position:       D.nextPosition(tasks),
            timeSpent:      0,
            timeEntries:    [],
            subtasks:       [],
            comments:       [],
            isTimerRunning: false,
            timerStart:     null,
            timerNote:      '',
            createdAt:      new Date().toISOString(),
        };
        return { next: [...tasks, task], result: task };
    });

    // A task created already pointed at an agent joins its queue the same way
    // assign_task does — claimed immediately if the agent is free.
    let queue = { agentStatus: 'unassigned', startNow: false, queuePosition: null, currentTaskId: null, sessionActive: false };
    if (owner.agentId != null) queue = await releaseAndClaim(owner.agentId, { claimTaskId: created.id });
    // Claimed (startNow) just means it's now this agent's currentTaskId — the
    // card only actually moves to "In Progress" once a live session is up to
    // work it (TASK-574); until then it stays wherever it was created.
    const moved = (queue.startNow && queue.sessionActive) ? await moveToInProgressIfActive(created.id) : { moved: false };
    // The response should reflect where the card actually ended up, not the
    // column it was created in a moment before being claimed and moved.
    if (moved.moved) created.columnId = moved.columnId;

    return {
        task: created, agentSlug: owner.agentSlug,
        agentStatus: queue.agentStatus, startNow: queue.startNow, queuePosition: queue.queuePosition,
        hint: queue.startNow
            ? (queue.sessionActive
                ? `${owner.agentSlug} is free and live — begin this task now.` +
                  (moved.moved ? ` The card moved to "${moved.columnName}".` : '')
                : `${owner.agentSlug} is free and claimed this task, but has no live session right now — it will move to "In Progress" once one starts (see start_session).`)
            : queue.agentStatus === 'backlog'
                ? `This task is in the Backlog column, so ${owner.agentSlug} will not start it automatically. Move it to a workable column (e.g. "To Do") first.`
                : queue.agentStatus === 'queued'
                    ? `${owner.agentSlug} is already working something else. This is #${queue.queuePosition} in its queue.`
                    : REFRESH_HINT,
    };
}

const UPDATABLE = ['title', 'description', 'priority', 'dueDate', 'startDate',
                   'timeEstimate', 'labels'];

export async function update_task(args) {
    const { task: ref } = args;
    const projects = await store.read('projects');

    return store.mutate('tasks', (tasks) => {
        const idx = tasks.findIndex(t => t === D.resolveTask(tasks, ref));
        if (idx === -1) throw new Error(`No task matches "${ref}".`);

        const merged = { ...D.hydrateTask(tasks[idx]) };
        let changed = false;
        for (const k of UPDATABLE) {
            if (args[k] !== undefined) { merged[k] = args[k]; changed = true; }
        }
        if (args.priority !== undefined && !D.PRIORITIES.includes(args.priority)) {
            throw new Error(`priority must be one of: ${D.PRIORITIES.join(', ')}.`);
        }
        if (!changed) return { next: undefined, result: { task: merged, hint: 'No fields to update.' } };

        // Mirrors js/state.js Tasks.update — never let an edit orphan the task.
        if (!D.taskHasValidProject(merged, projects)) {
            throw new Error('That change would leave the task without a valid project; nothing was written.');
        }

        const next = tasks.slice();
        next[idx] = merged;
        return { next, result: { task: merged, hint: REFRESH_HINT } };
    });
}

export async function move_task({ task: ref, column }) {
    const projects = await store.read('projects');

    const moveResult = await store.mutate('tasks', (tasks) => {
        const found = D.resolveTask(tasks, ref);
        if (!found) throw new Error(`No task matches "${ref}".`);
        const idx = tasks.indexOf(found);

        const project = projects.find(p => p.id == found.projectId);
        const col = D.resolveColumn(project, column);
        if (!col) {
            throw new Error(`No column "${column}" in project "${project?.name || found.projectId}". ` +
                `Available: ${(project?.columns || []).map(c => c.name).join(', ')}.`);
        }

        // Moving an agent's own task into a column literally named "Done" is
        // treated as finishing it — a convenience on top of the explicit
        // finish_task tool, not a substitute for it (a "Shipped" or "QA"
        // column still needs an explicit finish_task call).
        const isDoneColumn = String(col.name).trim().toLowerCase() === 'done';
        const isToBeTestedColumn = String(col.name).trim().toLowerCase() === 'to be tested';
        const isToDoColumnMove = String(col.name).trim().toLowerCase() === 'to do';
        const autoFinish = isDoneColumn && found.agentId != null && found.agentDoneAt == null;
        // Landing in "To Be Tested" frees the agent too, just without marking
        // the task done — it's waiting on a human, not back in the queue for
        // rework (TASK-572).
        const freesAgent = autoFinish || (isToBeTestedColumn && found.agentId != null);
        // The reverse of autoFinish: moving a task an agent already finished
        // back into "To Do" reopens it — clears agentDoneAt, since otherwise
        // queueForAgent's `agentDoneAt == null` filter leaves it permanently
        // invisible to the agent's queue and the Agent Activity tab even
        // though it's sitting right there in To Do (found by the user moving
        // a reviewed task back for rework and never seeing it re-queue).
        const reopensTask = isToDoColumnMove && found.agentId != null && found.agentDoneAt != null;

        const updated = {
            ...D.hydrateTask(found),
            columnId: col.id,
            agentDoneAt: autoFinish ? new Date().toISOString() : (reopensTask ? null : (found.agentDoneAt ?? null)),
        };
        const next = tasks.slice();
        next[idx] = updated;
        return { next, result: { task: updated, columnName: col.name, autoFinish, freesAgent, reopensTask } };
    });

    const isReviewColumn = String(moveResult.columnName).trim().toLowerCase().includes('review');
    const movedByAgent = moveResult.task.agentId != null
        ? (await store.read('agents')).find(a => a.id == moveResult.task.agentId)
        : null;
    await postChatMessage(moveResult.task.projectId, {
        author:     movedByAgent?.name || 'System',
        authorType: movedByAgent ? 'agent' : 'system',
        taskKey:    moveResult.task.taskKey,
        text: isReviewColumn
            ? `🔍 "${moveResult.task.title}" (${moveResult.task.taskKey}) is ready for review.`
            : `"${moveResult.task.title}" (${moveResult.task.taskKey}) moved to ${moveResult.columnName}.`,
    });

    let queue = null;
    let moved = { moved: false };
    if (moveResult.freesAgent) {
        queue = await releaseAndClaim(moveResult.task.agentId, { justFinishedTaskId: moveResult.task.id });
        // Only move the promoted task to In Progress if the agent's session
        // is actually live to work it now (TASK-574) — otherwise it waits
        // for start_session, same as a fresh claim would.
        if (queue.currentTaskId != null && queue.sessionActive) moved = await moveToInProgressIfActive(queue.currentTaskId);
        if (queue.currentTaskId == null && movedByAgent) {
            await postChatMessage(moveResult.task.projectId, {
                author: movedByAgent.name, authorType: 'agent',
                text: `${movedByAgent.name} is now idle.`,
            });
        }
    } else if (moveResult.reopensTask) {
        // The reopened task itself is the claim candidate — same "claimed if
        // free" rule assign_task uses, so a reopened task an idle agent can
        // pick up doesn't just sit there until someone reassigns it by hand.
        queue = await releaseAndClaim(moveResult.task.agentId, { claimTaskId: moveResult.task.id });
        if (queue.currentTaskId === moveResult.task.id && queue.sessionActive) {
            moved = await moveToInProgressIfActive(moveResult.task.id);
        }
    }

    return {
        taskKey: moveResult.task.taskKey, columnId: moveResult.task.columnId, columnName: moveResult.columnName,
        agentFreed: moveResult.freesAgent,
        agentReopened: moveResult.reopensTask,
        agentNextTaskId: moveResult.freesAgent ? (queue?.currentTaskId ?? null) : null,
        hint: moveResult.freesAgent
            ? `Moving to "${moveResult.columnName}" freed the agent.` +
              (queue?.currentTaskId
                  ? ` It is now on task id ${queue.currentTaskId}` + (moved.moved ? ` (moved to "${moved.columnName}")` : '') + ` — call get_task to see it.`
                  : ' Its queue is empty.') +
              ` ${REFRESH_HINT}`
            : moveResult.reopensTask
                ? `Reopened — cleared agentDoneAt so it re-enters the agent's queue.` +
                  (queue?.currentTaskId === moveResult.task.id
                      ? ` The agent was idle and claimed it now` + (moved.moved ? ` (moved to "${moved.columnName}")` : '') + `.`
                      : '') +
                  ` ${REFRESH_HINT}`
                : REFRESH_HINT,
    };
}

export async function assign_task({ task: ref, agent, assignee }) {
    if ((agent == null || agent === '') && (assignee == null || assignee === '')) {
        throw new Error('Pass either `agent` (id or slug) or `assignee` (a person\'s name).');
    }
    const agentsList = await store.read('agents');
    const owner = resolveOwner(agentsList, { agent, assignee });

    // Step 1: update the task record.
    const { task, oldAgentId } = await store.mutate('tasks', (tasks) => {
        const found = D.resolveTask(tasks, ref);
        if (!found) throw new Error(`No task matches "${ref}".`);
        const idx = tasks.indexOf(found);
        const previousAgentId = found.agentId ?? null;

        const updated = {
            ...D.hydrateTask(found),
            agentId:     owner.agentId,
            assignee:    owner.assignee,
            assignedAt:  owner.agentId != null ? new Date().toISOString() : null,
            // Reassigning always re-enters the pool — a task can't be both
            // "done for the old agent" and freshly handed to a new one.
            agentDoneAt: null,
        };
        const next = tasks.slice();
        next[idx] = updated;
        return { next, result: { task: updated, oldAgentId: previousAgentId } };
    });

    await postChatMessage(task.projectId, {
        author: owner.assignee, authorType: owner.agentId != null ? 'agent' : 'system',
        taskKey: task.taskKey,
        text: `"${task.title}" (${task.taskKey}) assigned to ${owner.assignee}.`,
    });

    // Step 2: keep the agent busy/queue state honest. Two separate CAS writes
    // (see releaseAndClaim) — not one transaction with step 1.
    if (oldAgentId != null && oldAgentId != owner.agentId) {
        const freed = await releaseAndClaim(oldAgentId, { justFinishedTaskId: task.id });
        // Pulling this task off its old agent may have promoted a different
        // one there — that one only starts moving now if that agent's
        // session is actually live (TASK-574).
        if (freed.currentTaskId != null && freed.sessionActive) await moveToInProgressIfActive(freed.currentTaskId);
    }

    let queue = { agentStatus: 'unassigned', startNow: false, queuePosition: null, currentTaskId: null, sessionActive: false };
    if (owner.agentId != null) queue = await releaseAndClaim(owner.agentId, { claimTaskId: task.id });
    const moved = (queue.startNow && queue.sessionActive) ? await moveToInProgressIfActive(task.id) : { moved: false };

    return {
        taskKey: task.taskKey, assignee: task.assignee,
        agentId: task.agentId, agentSlug: owner.agentSlug,
        agentStatus: queue.agentStatus, startNow: queue.startNow, queuePosition: queue.queuePosition,
        movedToColumn: moved.moved ? moved.columnName : null,
        hint: queue.startNow
            ? (queue.sessionActive
                ? `${owner.agentSlug} is free and live — begin this task now.` +
                  (moved.moved ? ` The card moved to "${moved.columnName}".` : '')
                : `${owner.agentSlug} is free and claimed this task, but has no live session right now — it will move to "In Progress" once one starts (see start_session).`)
            : queue.agentStatus === 'backlog'
                ? `This task is in the "${queue.blockedColumnName || 'Backlog'}" column, so ${owner.agentSlug} will not start it automatically even though it's free. Move it to a workable column (e.g. "To Do") first, then it can be claimed.`
                : queue.agentStatus === 'queued'
                    ? `${owner.agentSlug} is already working something else. This is #${queue.queuePosition} in its queue — it will not start on its own; call finish_task on the active one to advance the queue.`
                    : REFRESH_HINT,
    };
}

/**
 * Signal that an agent is done with a task. Frees it and, if anything is
 * queued behind it, immediately hands over the next one — this is the "when
 * an agent finishes, the next queued task starts" half of the workflow.
 *
 * This does not touch comments or the column — call add_comment / move_task
 * first if you want those recorded, then call this to advance the queue.
 * (Moving a task into a column literally named "Done" does this step
 * automatically; call this explicitly for any other completion signal.)
 */
export async function finish_task({ task: ref }) {
    const task = await store.mutate('tasks', (tasks) => {
        const found = D.resolveTask(tasks, ref);
        if (!found) throw new Error(`No task matches "${ref}".`);
        const idx = tasks.indexOf(found);
        if (found.agentId == null) {
            return { next: undefined, result: D.hydrateTask(found) };
        }
        const updated = { ...D.hydrateTask(found), agentDoneAt: new Date().toISOString() };
        const next = tasks.slice();
        next[idx] = updated;
        return { next, result: updated };
    });

    if (task.agentId == null) {
        return { taskKey: task.taskKey, freed: false, hint: 'This task has no agent assigned — nothing to free.' };
    }

    const queue = await releaseAndClaim(task.agentId, { justFinishedTaskId: task.id });
    // The same session that just finished is presumably still live, so the
    // next promoted task (if any) moves to In Progress right away; if the
    // agent's session isn't actually marked live, it waits for start_session
    // like any other promotion (TASK-574).
    const moved = (queue.currentTaskId != null && queue.sessionActive)
        ? await moveToInProgressIfActive(queue.currentTaskId)
        : { moved: false };

    const finishingAgent = (await store.read('agents')).find(a => a.id == task.agentId);
    await postChatMessage(task.projectId, {
        author: finishingAgent?.name || 'Agent', authorType: 'agent',
        taskKey: task.taskKey,
        text: queue.currentTaskId != null
            ? `${finishingAgent?.name || 'Agent'} finished "${task.title}" (${task.taskKey}) and moved on to the next task.`
            : `${finishingAgent?.name || 'Agent'} finished "${task.title}" (${task.taskKey}) and is now idle.`,
    });

    return {
        taskKey: task.taskKey,
        freed: true,
        agentNextTaskId: queue.currentTaskId,
        hint: queue.currentTaskId
            ? `The agent is now on task id ${queue.currentTaskId}` +
              (moved.moved ? ` (moved to "${moved.columnName}")` : '') +
              ` — call get_task to see it, then begin work now.`
            : `The agent's queue is empty; it is idle. ${REFRESH_HINT}`,
    };
}

export async function add_comment({ task: ref, text, author, needsInput }) {
    if (!text || !String(text).trim()) throw new Error('text is required.');
    const agents = await store.read('agents');

    const outcome = await store.mutate('tasks', (tasks) => {
        const found = D.resolveTask(tasks, ref);
        if (!found) throw new Error(`No task matches "${ref}".`);
        const idx = tasks.indexOf(found);
        const t = D.hydrateTask(found);

        // Default the author to the agent that owns the task, so the board
        // shows who actually did the work.
        const owning = t.agentId != null ? D.resolveAgent(agents.map(D.hydrateAgent), t.agentId) : null;
        const comment = {
            id:        D.uniqueId(t.comments),
            text:      String(text).trim(),
            author:    author || owning?.slug || 'claude',
            createdAt: new Date().toISOString(),
        };

        const updated = { ...t, comments: [...t.comments, comment] };
        const next = tasks.slice();
        next[idx] = updated;
        return { next, result: { task: t, comment } };
    });

    // TASK-570: a comment flagged needsInput is an agent asking a question or
    // requesting permission — drop it into the project chat too, so it rides
    // the existing chat pipeline's toast + desktop Notification (chat.js) as
    // both an in-app and a system-wide alert, instead of sitting silent in a
    // task's comment list until someone happens to open it.
    if (needsInput) {
        await postChatMessage(outcome.task.projectId, {
            author: outcome.comment.author, authorType: 'question',
            taskKey: outcome.task.taskKey,
            text: `Needs your input on "${outcome.task.title}" (${outcome.task.taskKey}): ${outcome.comment.text}`,
        });
    }

    return { taskKey: outcome.task.taskKey, comment: outcome.comment, hint: REFRESH_HINT };
}

export async function create_agent(args) {
    const { name } = args;
    if (!name || !String(name).trim()) throw new Error('name is required.');

    return store.mutate('agents', (agents) => {
        D.reclaimStaleSlug(agents, D.slugifyAgent(args.slug || name), null);
        const taken = new Set(agents.map(a => a.slug).filter(Boolean));
        const agent = D.hydrateAgent({
            id:           D.uniqueId(agents),
            slug:         D.slugifyAgent(args.slug || name, taken),
            name:         String(name).trim().slice(0, 40),
            emoji:        args.emoji || '',
            color:        args.color || '#6366f1',
            role:         args.role || '',
            systemPrompt: args.systemPrompt || '',
            model:        args.model || 'default',
            enabled:      args.enabled !== false,
            createdAt:    new Date().toISOString(),
        });
        return { next: [...agents, agent], result: { agent, hint: REFRESH_HINT } };
    });
}

const AGENT_UPDATABLE = ['name', 'emoji', 'color', 'role', 'systemPrompt', 'model', 'enabled'];

export async function update_agent(args) {
    const { agent: ref } = args;

    const updated = await store.mutate('agents', (agents) => {
        const found = D.resolveAgent(agents.map(D.hydrateAgent), ref);
        if (!found) throw new Error(`No agent matches "${ref}". Use list_agents to see available agents.`);
        const idx = agents.findIndex(a => a.id == found.id);

        const merged = { ...found };
        let changed = false;
        for (const k of AGENT_UPDATABLE) {
            if (args[k] !== undefined) { merged[k] = args[k]; changed = true; }
        }
        if (!changed) return { next: undefined, result: { agent: found, renamed: false } };

        // TASK-529: a rename follows through to the slug too, so Claude's
        // handle for this agent tracks its current name rather than freezing
        // at whatever it was called when created.
        if (args.name !== undefined && args.name !== found.name) {
            const cleanSlug = D.slugifyAgent(args.name);
            D.reclaimStaleSlug(agents, cleanSlug, found.id);
            const taken = new Set(agents.filter(a => a.id != found.id).map(a => a.slug));
            merged.slug = D.slugifyAgent(args.name, taken);
        }

        const next = agents.slice();
        next[idx] = D.hydrateAgent(merged);
        return {
            next,
            result: { agent: next[idx], renamed: args.name !== undefined && args.name !== found.name },
        };
    });

    // `assignee` is a denormalized copy of the agent name, so a rename has to
    // rewrite it on that agent's tasks — same invariant as State.Agents.update.
    let tasksTouched = 0;
    if (updated.renamed) {
        tasksTouched = await store.mutate('tasks', (tasks) => {
            const hits = tasks.filter(t => t.agentId == updated.agent.id);
            if (!hits.length) return { next: undefined, result: 0 };
            const next = tasks.map(t =>
                t.agentId == updated.agent.id ? { ...t, assignee: updated.agent.name } : t);
            return { next, result: hits.length };
        });
    }

    return { agent: updated.agent, tasksRenamed: tasksTouched, hint: REFRESH_HINT };
}

/**
 * Mark that a live terminal/Claude Desktop session is actually up and
 * working this agent — call this once, right after adopting its
 * systemPrompt and before starting real work on its active task (TASK-574).
 * A task can be claimed (currentTaskId set) long before any session picks
 * it up; the board should read that as "idle" until this is called, which
 * is also what actually moves the card to "In Progress" for the first time.
 * Call end_session when you stop working this agent, whether it finished
 * its queue, got interrupted, or is handing off — otherwise the board keeps
 * showing it as live after nobody's there.
 */
export async function start_session({ agent: ref }) {
    const agentsList = await store.read('agents');
    const record = D.resolveAgent(agentsList.map(D.hydrateAgent), ref);
    if (!record) throw new Error(`No agent matches "${ref}". Use list_agents to see available agents.`);

    await store.mutate('agents', (agents) => {
        const idx = agents.findIndex(a => a.id == record.id);
        if (idx === -1) return { next: undefined, result: null };
        const next = agents.slice();
        const hydrated = D.hydrateAgent(agents[idx]);
        next[idx] = { ...hydrated, sessionCount: hydrated.sessionCount + 1, sessionActive: true };
        return { next, result: null };
    });

    // A live session picking up its already-claimed task is what actually
    // starts the work — move the card to In Progress now, not at claim time.
    const moved = record.currentTaskId != null
        ? await moveToInProgressIfActive(record.currentTaskId)
        : { moved: false };

    return {
        agentSlug: record.slug,
        currentTaskId: record.currentTaskId,
        movedToColumn: moved.moved ? moved.columnName : null,
        hint: record.currentTaskId != null
            ? `${record.slug} is now live.` + (moved.moved ? ` Its active task moved to "${moved.columnName}".` : ' Its active task is already in a working column.') + ` ${REFRESH_HINT}`
            : `${record.slug} is now live, but has no active task right now.`,
    };
}

export async function end_session({ agent: ref }) {
    const agentsList = await store.read('agents');
    const record = D.resolveAgent(agentsList.map(D.hydrateAgent), ref);
    if (!record) throw new Error(`No agent matches "${ref}". Use list_agents to see available agents.`);

    await store.mutate('agents', (agents) => {
        const idx = agents.findIndex(a => a.id == record.id);
        if (idx === -1) return { next: undefined, result: null };
        const next = agents.slice();
        const hydrated = D.hydrateAgent(agents[idx]);
        const sessionCount = Math.max(0, hydrated.sessionCount - 1);
        next[idx] = { ...hydrated, sessionCount, sessionActive: sessionCount > 0 };
        return { next, result: null };
    });

    return { agentSlug: record.slug, hint: `${record.slug} is now marked idle (no live session).` };
}

// ── Helpers ────────────────────────────────────────────────

function resolveOwner(rawAgents, args) {
    if (args.agent != null && args.agent !== '') {
        const a = D.resolveAgent(rawAgents.map(D.hydrateAgent), args.agent);
        if (!a) throw new Error(`No agent matches "${args.agent}". Use list_agents to see available agents.`);
        // assignee mirrors the agent name so the board's string-based views
        // (My Tasks, CSV export, command palette) keep working.
        return { agentId: a.id, assignee: a.name, agentSlug: a.slug };
    }
    return { agentId: null, assignee: args.assignee || 'Vaibhav', agentSlug: null };
}

function summarize(t, projects, agents) {
    const proj = projects.find(p => p.id == t.projectId);
    const agent = t.agentId != null ? agents.find(a => a.id == t.agentId) : null;
    return {
        id: t.id, taskKey: t.taskKey, title: t.title,
        projectId: t.projectId, projectName: proj?.name || null,
        columnId: t.columnId, columnName: D.resolveColumn(proj, t.columnId)?.name || null,
        priority: t.priority, assignee: t.assignee,
        agentId: t.agentId, agentSlug: agent?.slug || null,
        // Whether the currently-assigned agent already finished this one —
        // set by finish_task, not by moving columns (except into "Done").
        agentDone: t.agentDoneAt != null,
        dueDate: t.dueDate, timeSpent: Number(t.timeSpent.toFixed(3)),
        subtasks: countSubtasks(t.subtasks),
    };
}

function countSubtasks(subs) {
    let done = 0, total = 0;
    (subs || []).forEach(s => {
        total++;
        if (s.completed) done++;
        const n = countSubtasks(s.subtasks);
        done += n.done; total += n.total;
    });
    return { done, total };
}
