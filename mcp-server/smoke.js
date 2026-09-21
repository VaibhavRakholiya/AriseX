#!/usr/bin/env node
/**
 * Smoke test for the FlowBoard MCP tools.
 *
 * Calls the same handler functions the MCP client calls, with no JSON-RPC in
 * the loop, against a scratch Firebase namespace so live data is never touched.
 *
 *   npm run smoke
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Must be set before ./src/store.js is imported — it reads env at module load.
process.env.FLOWBOARD_NAMESPACE = process.env.FLOWBOARD_NAMESPACE || 'timetracker_smoke';

const T     = await import('./src/tools.js');
const D     = await import('./src/domain.js');
const store = await import('./src/store.js');

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;

async function check(label, fn) {
    try { await fn(); console.log(`  ok    ${label}`); pass++; }
    catch (err) { console.log(`  FAIL  ${label}\n          ${err.message}`); fail++; }
}

function section(t) { console.log(`\n${t}`); }

// ── Guard: never run against the live namespace ────────────
if (store.config.namespace === 'timetracker') {
    console.error('Refusing to run: FLOWBOARD_NAMESPACE is the live namespace.');
    process.exit(1);
}
console.log(`FlowBoard MCP smoke test\n  ${store.config.base}/${store.config.namespace}`);

// ── Unit checks that need no network ───────────────────────
section('domain invariants');

await check('coerceArray handles arrays, numeric-keyed objects, null', () => {
    assert.deepEqual(store.coerceArray(null), []);
    assert.deepEqual(store.coerceArray([1, null, 2]), [1, 2]);
    // RTDB returns this shape when an array is not contiguous from zero.
    assert.deepEqual(store.coerceArray({ '1': 'b', '0': 'a', '10': 'c' }), ['a', 'b', 'c']);
});

await check('nextTaskKey continues from the highest existing key', () => {
    assert.equal(D.nextTaskKey([]), 'TASK-1');
    assert.equal(D.nextTaskKey([{ taskKey: 'TASK-3' }, { taskKey: 'TASK-11' }]), 'TASK-12');
    assert.equal(D.nextTaskKey([{ taskKey: null }]), 'TASK-1');
});

await check('uniqueId never collides inside one millisecond', () => {
    const seen = new Set();
    const recs = [];
    for (let i = 0; i < 50; i++) { const id = D.uniqueId(recs); recs.push({ id }); seen.add(id); }
    assert.equal(seen.size, 50);
});

await check('hydrateTask restores every key RTDB strips', () => {
    // A task as it actually comes back from Firebase: no empty arrays, no nulls.
    const t = D.hydrateTask({ id: 1, taskKey: 'TASK-1', title: 'x', projectId: 9 });
    assert.deepEqual(t.labels, []);
    assert.deepEqual(t.comments, []);
    assert.deepEqual(t.timeEntries, []);
    assert.deepEqual(t.subtasks, []);
    assert.equal(t.dueDate, null);
    assert.equal(t.agentId, null);
    assert.equal(t.isTimerRunning, false);
    assert.equal(t.timeSpent, 0);
});

await check('timeSpent is hours derived from entry seconds', () => {
    assert.equal(D.computeTimeSpent([{ duration: 1800 }, { duration: 1800 }]), 1);
});

await check('slugifyAgent is stable and collision-free', () => {
    assert.equal(D.slugifyAgent('Bug Triager!'), 'bug-triager');
    assert.equal(D.slugifyAgent('Bug Triager', new Set(['bug-triager'])), 'bug-triager-2');
});

// ── Drift guard: the duplicated task shape must match js/state.js ──
section('schema drift vs js/state.js');

await check('task fields match Tasks.create in js/state.js', () => {
    // Structural diff of the two task literals. hydrateTask() is not the right
    // comparison — id/taskKey/projectId come from the caller, not from defaults.
    const fieldsOf = (src, marker) => {
        const start = src.indexOf(marker);
        assert.ok(start !== -1, `could not find ${marker}`);
        const body = src.slice(start, src.indexOf('};', start));
        return new Set([...body.matchAll(/^\s+(\w+):/gm)].map(m => m[1]));
    };

    const appFields = fieldsOf(
        readFileSync(join(HERE, '..', 'js', 'state.js'), 'utf8'), 'const task = {');
    const mcpFields = fieldsOf(
        readFileSync(join(HERE, 'src', 'tools.js'), 'utf8'), 'const task = {');

    assert.ok(appFields.size > 15, `parsed only ${appFields.size} fields from js/state.js`);

    const missing = [...appFields].filter(f => !mcpFields.has(f));
    const extra   = [...mcpFields].filter(f => !appFields.has(f));
    assert.deepEqual(missing, [], `in js/state.js Tasks.create but not in create_task: ${missing}`);
    assert.deepEqual(extra,   [], `in create_task but not in js/state.js Tasks.create: ${extra}`);
});

// ── Network round trip ─────────────────────────────────────
section('tool round trip');

// Seed a project — there is deliberately no create_project tool. Columns
// mirror the real workspace's "Big Fonts" project (To Do / In Progress /
// In Review / Done) so the auto-move-on-claim and auto-finish-on-Done
// behaviors both have a real column to land in.
const projectId = Date.now();
await store.mutate('projects', () => ({
    next: [{
        id: projectId, name: 'Smoke Project', description: '', emoji: '', color: '#6366f1',
        position: 1000, labels: [],
        columns: [
            { id: 'col-todo',   name: 'To Do',         color: '#6b7280', position: 0, wipLimit: null },
            { id: 'col-ip',     name: 'In Progress',   color: '#3b82f6', position: 1, wipLimit: null },
            { id: 'col-review', name: 'In Review',     color: '#f59e0b', position: 2, wipLimit: null },
            { id: 'col-tbt',    name: 'To Be Tested',  color: '#a855f7', position: 3, wipLimit: null },
            { id: 'col-done',   name: 'Done',          color: '#22c55e', position: 4, wipLimit: null },
        ],
        createdAt: new Date().toISOString(),
    }],
    result: null,
}));

// A second project mirroring most of the real workspace: no "In Progress"
// column at all — claiming a task here must be a silent no-op, not a throw.
const bareProjectId = Date.now() + 1;
await store.mutate('projects', (projects) => ({
    next: [...projects, {
        id: bareProjectId, name: 'Bare Project', description: '', emoji: '', color: '#94a3b8',
        position: 2000, labels: [],
        columns: [
            { id: 'bare-todo', name: 'To Do', color: '#6b7280', position: 0, wipLimit: null },
            { id: 'bare-done', name: 'Done',  color: '#22c55e', position: 1, wipLimit: null },
        ],
        createdAt: new Date().toISOString(),
    }],
    result: null,
}));

// A third project mirroring the real workspace's "Blower" / "Origami Weapons"
// projects: a literal Backlog column ahead of To Do.
const backlogProjectId = Date.now() + 2;
await store.mutate('projects', (projects) => ({
    next: [...projects, {
        id: backlogProjectId, name: 'Backlog Project', description: '', emoji: '', color: '#a855f7',
        position: 3000, labels: [],
        columns: [
            { id: 'bl-backlog', name: 'Backlog',     color: '#94a3b8', position: 0, wipLimit: null },
            { id: 'bl-todo',    name: 'To Do',       color: '#6b7280', position: 1, wipLimit: null },
            { id: 'bl-ip',      name: 'In Progress', color: '#3b82f6', position: 2, wipLimit: null },
            { id: 'bl-done',    name: 'Done',        color: '#22c55e', position: 3, wipLimit: null },
        ],
        createdAt: new Date().toISOString(),
    }],
    result: null,
}));

let agent, task;

await check('list_projects returns the seeded project with columns', async () => {
    const projects = await T.list_projects();
    const p = projects.find(x => x.id === projectId);
    assert.ok(p, 'seeded project not found');
    assert.equal(p.columns.length, 5);
    assert.equal(p.columns[0].name, 'To Do');
});

await check('create_agent produces a slug', async () => {
    const r = await T.create_agent({
        name: 'Bug Triager', emoji: '🐞', role: 'Triages bugs',
        systemPrompt: 'Reproduce first, then diagnose.', color: '#f59e0b',
    });
    agent = r.agent;
    assert.equal(agent.slug, 'bug-triager');
    assert.equal(agent.enabled, true);
    // Everything below this point expects the old claim-moves-immediately
    // behavior — mark this agent live up front so the rest of the section
    // isn't testing TASK-574's deferred-move behavior by accident. That gets
    // its own dedicated section further down.
    await T.start_session({ agent: agent.slug });
});

await check('list_agents exposes systemPrompt for profile adoption', async () => {
    const agents = await T.list_agents({});
    const a = agents.find(x => x.id === agent.id);
    assert.equal(a.systemPrompt, 'Reproduce first, then diagnose.');
});

await check('create_task defaults to the first column', async () => {
    const r = await T.create_task({ projectId, title: 'Crash on save', priority: 'high' });
    task = r.task;
    assert.equal(task.columnId, 'col-todo');
    assert.match(task.taskKey, /^TASK-\d+$/);
    assert.equal(task.agentId, null);
});

await check('create_task refuses an invalid project', async () => {
    await assert.rejects(() => T.create_task({ projectId: 1, title: 'orphan' }), /No project with id/);
});

await check('create_task refuses an unknown column, naming the valid ones', async () => {
    await assert.rejects(
        () => T.create_task({ projectId, title: 'x', column: 'Nowhere' }),
        /Available: To Do, In Progress, In Review, To Be Tested, Done/);
});

await check('assign_task by slug sets agentId and mirrors the name', async () => {
    const r = await T.assign_task({ task: task.taskKey, agent: 'bug-triager' });
    assert.equal(r.agentId, agent.id);
    assert.equal(r.assignee, 'Bug Triager');   // denormalized for the board's string views
    assert.equal(r.agentSlug, 'bug-triager');
});

await check('list_tasks filters by agent', async () => {
    const mine = await T.list_tasks({ agent: 'bug-triager' });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].taskKey, task.taskKey);
    assert.equal(mine[0].agentSlug, 'bug-triager');
});

await check('list_tasks resolves a column by name', async () => {
    // The prior check assigned `task` to a free agent, which — per the
    // claim-moves-to-In-Progress behavior — already relocated it there.
    const inProgress = await T.list_tasks({ projectId, column: 'In Progress' });
    assert.ok(inProgress.some(t => t.taskKey === task.taskKey));
    assert.equal(
        (await T.list_tasks({ projectId, column: 'To Do' })).some(t => t.taskKey === task.taskKey),
        false, 'it should no longer be listed under To Do after being claimed');
});

await check('add_comment attributes to the owning agent by default', async () => {
    const r = await T.add_comment({ task: task.taskKey, text: 'Repro confirmed on Safari.' });
    assert.equal(r.comment.author, 'bug-triager');
});

await check('move_task accepts a column name', async () => {
    const r = await T.move_task({ task: task.taskKey, column: 'In Review' });
    assert.equal(r.columnId, 'col-review');
});

await check('update_task rejects an invalid priority', async () => {
    await assert.rejects(() => T.update_task({ task: task.taskKey, priority: 'nope' }), /priority must be/);
});

await check('get_task resolves names, agent and counts', async () => {
    const full = await T.get_task({ task: task.taskKey });
    assert.equal(full.projectName, 'Smoke Project');
    assert.equal(full.columnName, 'In Review');
    assert.equal(full.agent.slug, 'bug-triager');
    assert.equal(full.comments.length, 1);
});

await check('renaming an agent rewrites assignee on its tasks', async () => {
    const r = await T.update_agent({ agent: 'bug-triager', name: 'Triage Bot' });
    assert.equal(r.tasksRenamed, 1);
    const full = await T.get_task({ task: task.taskKey });
    assert.equal(full.assignee, 'Triage Bot');
    assert.equal(full.agent.slug, 'bug-triager', 'slug must survive a rename — Claude may already use it');
});

await check('add_comment with needsInput also posts a question to project chat', async () => {
    await T.add_comment({ task: task.taskKey, text: 'OK to delete the legacy migration table?', needsInput: true });
    const chats = await store.read('chats');
    const posted = chats.filter(c => c.projectId === projectId && c.authorType === 'question');
    assert.equal(posted.length, 1);
    assert.ok(posted[0].text.includes('OK to delete the legacy migration table?'));
    assert.equal(posted[0].taskKey, task.taskKey);
});

await check('unknown agent fails with a usable message', async () => {
    await assert.rejects(() => T.assign_task({ task: task.taskKey, agent: 'ghost' }), /No agent matches/);
});

await check('tasks round-trip through Firebase as a dense array', async () => {
    const raw = await store.read('tasks');
    assert.ok(Array.isArray(raw));
    assert.ok(raw.every(t => t != null));
});

// ── Queue: start-if-free, queue-if-busy, promote-on-finish ──
section('agent queue behavior');

let busyAgent, taskA, taskB, taskC;

await check('a task assigned to a free agent starts now and moves to In Progress', async () => {
    busyAgent = (await T.create_agent({ name: 'Queue Tester' })).agent;
    await T.start_session({ agent: busyAgent.slug });
    const r = await T.create_task({ projectId, title: 'Queue A', agent: busyAgent.slug });
    taskA = r.task;
    assert.equal(r.startNow, true);
    assert.equal(r.agentStatus, 'active');
    assert.equal(taskA.columnId, 'col-ip', 'a freshly claimed task should land in In Progress');
    const agents = await T.list_agents({});
    const a = agents.find(x => x.id === busyAgent.id);
    assert.equal(a.status, 'working');
    assert.equal(a.currentTaskKey, taskA.taskKey);
    assert.equal(a.queueLength, 0);
});

await check('a second task queues behind the busy agent, staying in To Do', async () => {
    const r = await T.create_task({ projectId, title: 'Queue B', agent: busyAgent.slug });
    taskB = r.task;
    assert.equal(r.startNow, false);
    assert.equal(r.agentStatus, 'queued');
    assert.equal(r.queuePosition, 1);
    assert.equal(taskB.columnId, 'col-todo', 'a queued task must not jump the board');
    const agents = await T.list_agents({});
    assert.equal(agents.find(x => x.id === busyAgent.id).queueLength, 1);
});

await check('a third task extends the queue in order', async () => {
    const r = await T.assign_task({ task: (await T.create_task({ projectId, title: 'Queue C' })).task.taskKey, agent: busyAgent.slug });
    taskC = { taskKey: r.taskKey };
    assert.equal(r.queuePosition, 2);
});

await check('list_tasks reports queuePosition per task for this agent', async () => {
    const mine = await T.list_tasks({ agent: busyAgent.slug });
    const byKey = Object.fromEntries(mine.map(t => [t.taskKey, t.queuePosition]));
    assert.equal(byKey[taskA.taskKey], 0);
    assert.equal(byKey[taskB.taskKey], 1);
    assert.equal(byKey[taskC.taskKey], 2);
});

await check('finish_task frees the agent and promotes the oldest queued task (FIFO)', async () => {
    const r = await T.finish_task({ task: taskA.taskKey });
    assert.equal(r.freed, true);
    const next = await T.get_task({ task: r.agentNextTaskId });
    assert.equal(next.taskKey, taskB.taskKey, 'should promote B before C — B was queued first');
    assert.equal(next.isActiveForAgent, true);
    assert.equal(next.columnId, 'col-ip', 'the newly-promoted task should move to In Progress');
    assert.equal(next.columnName, 'In Progress');
});

await check('a finished task does not reappear in its own queue listing', async () => {
    const mine = await T.list_tasks({ agent: busyAgent.slug });
    const a = mine.find(t => t.taskKey === taskA.taskKey);
    assert.equal(a.agentDone, true);
    assert.equal(a.queuePosition, null);
});

await check('moving the active task to a column named Done auto-finishes and promotes', async () => {
    const r = await T.move_task({ task: taskB.taskKey, column: 'Done' });
    assert.equal(r.agentFreed, true);
    assert.ok(r.agentNextTaskId, 'should have promoted taskC');
    const c = await T.get_task({ task: r.agentNextTaskId });
    assert.equal(c.taskKey, taskC.taskKey);
    assert.equal(c.isActiveForAgent, true);
    assert.equal(c.columnId, 'col-ip', 'promotion via the Done-move path should also move to In Progress');
});

await check('a project with no In Progress column: claiming does not throw and leaves the column alone', async () => {
    const bareAgent = (await T.create_agent({ name: 'Bare Tester' })).agent;
    await T.start_session({ agent: bareAgent.slug });
    const r = await T.create_task({ projectId: bareProjectId, title: 'Bare Task', agent: bareAgent.slug });
    assert.equal(r.startNow, true);
    assert.equal(r.task.columnId, 'bare-todo', 'no In Progress column exists — task should stay where it was created');
});

await check('finishing the last task leaves the agent idle', async () => {
    const r = await T.finish_task({ task: taskC.taskKey });
    assert.equal(r.agentNextTaskId, null);
    const agents = await T.list_agents({});
    const a = agents.find(x => x.id === busyAgent.id);
    assert.equal(a.status, 'idle');
    assert.equal(a.queueLength, 0);
});

await check('moving a finished task back to To Do reopens it and re-claims it if the agent is idle', async () => {
    // taskB was auto-finished (Done) two checks ago and busyAgent is idle
    // again as of the check above.
    const before = await T.get_task({ task: taskB.taskKey });
    assert.ok(before.agentDoneAt, 'sanity: taskB should still read finished going in');

    const r = await T.move_task({ task: taskB.taskKey, column: 'To Do' });
    assert.equal(r.agentReopened, true);

    const after = await T.get_task({ task: taskB.taskKey });
    assert.equal(after.agentDoneAt, null, 'agentDoneAt should be cleared on reopen');
    assert.equal(after.isActiveForAgent, true, 'an idle agent should claim the reopened task immediately');
    assert.equal(after.columnId, 'col-ip', 'a live session should move the reclaimed task to In Progress');

    // clean up: finish it so busyAgent is idle again for the next check
    await T.finish_task({ task: taskB.taskKey });
});

await check('reassigning an agent\'s active task away promotes its queue', async () => {
    const t1 = (await T.create_task({ projectId, title: 'Reassign 1', agent: busyAgent.slug })).task;
    const t2 = (await T.create_task({ projectId, title: 'Reassign 2', agent: busyAgent.slug })).task;
    const r = await T.assign_task({ task: t1.taskKey, assignee: 'someone' }); // pull it off the agent
    assert.equal(r.agentId, null);
    const agents = await T.list_agents({});
    const a = agents.find(x => x.id === busyAgent.id);
    assert.equal(a.currentTaskKey, t2.taskKey, 'promoting away from the active task should surface the queued one');
    // clean up: finish what's left so the agent doesn't leak into other checks
    await T.finish_task({ task: t2.taskKey });
});

// ── Backlog: assigned-but-not-ready tasks never auto-start ──
section('backlog exclusion');

await check('a task created in Backlog is not claimed — agent stays idle', async () => {
    const backlogAgent = (await T.create_agent({ name: 'Backlog Tester' })).agent;
    await T.start_session({ agent: backlogAgent.slug });
    const r = await T.create_task({
        projectId: backlogProjectId, title: 'Sits in backlog', column: 'Backlog', agent: backlogAgent.slug,
    });
    assert.equal(r.startNow, false);
    assert.equal(r.agentStatus, 'backlog');
    assert.equal(r.task.columnId, 'bl-backlog', 'it must stay put, not get moved to In Progress');

    const agents = await T.list_agents({});
    assert.equal(agents.find(a => a.id === backlogAgent.id).status, 'idle',
        'a backlog-only task must not count as the agent working something');
});

await check('a workable task is claimed ahead of an already-assigned backlog task', async () => {
    const backlogAgent = (await T.list_agents({})).find(a => a.slug === 'backlog-tester');
    // Explicit column: this project's default (first-by-position) column is
    // itself "Backlog" — matching "Blower"/"Origami Weapons" — so a task
    // needs to be placed somewhere workable on purpose, same as real usage.
    const r = await T.create_task({
        projectId: backlogProjectId, title: 'Ready to go', column: 'To Do', agent: backlogAgent.slug,
    });
    assert.equal(r.startNow, true);
    assert.equal(r.task.columnId, 'bl-ip', 'a fresh claim still moves to In Progress as usual');
});

await check('finishing the active task does not promote a backlog task', async () => {
    const backlogAgent = (await T.list_agents({})).find(a => a.slug === 'backlog-tester');
    const r = await T.finish_task({ task: backlogAgent.currentTaskKey });
    assert.equal(r.agentNextTaskId, null, 'the only thing left queued is stuck in Backlog — agent should go idle');
    const agents = await T.list_agents({});
    assert.equal(agents.find(a => a.id === backlogAgent.id).status, 'idle');
});

await check('moving a task out of Backlog lets it be claimed on reassignment', async () => {
    const backlogAgent = (await T.list_agents({})).find(a => a.slug === 'backlog-tester');
    const mine = await T.list_tasks({ agent: backlogAgent.slug });
    const stuck = mine.find(t => t.title === 'Sits in backlog');
    await T.move_task({ task: stuck.taskKey, column: 'To Do' });
    const r = await T.assign_task({ task: stuck.taskKey, agent: backlogAgent.slug });
    assert.equal(r.startNow, true, 'now that it is out of Backlog, it should claim normally');
});

section('review-column exclusion (TASK-571)');

await check('a task in In Review is not claimed — agent stays idle', async () => {
    const reviewAgent = (await T.create_agent({ name: 'Review Tester' })).agent;
    const r = await T.create_task({
        projectId, title: 'Awaiting review', column: 'In Review', agent: reviewAgent.slug,
    });
    assert.equal(r.startNow, false);
    assert.equal(r.agentStatus, 'backlog', 'blocked columns reuse the same status agents already know to wait on');
    assert.equal(r.task.columnId, 'col-review', 'it must stay put, not get moved to In Progress');
});

await check('a To Do task is claimed ahead of an already-assigned In Review task', async () => {
    const reviewAgent = (await T.list_agents({})).find(a => a.slug === 'review-tester');
    const r = await T.create_task({
        projectId, title: 'Ready to go', column: 'To Do', agent: reviewAgent.slug,
    });
    assert.equal(r.startNow, true);
});

section('To Be Tested does not occupy the agent (TASK-572)');

await check('moving the active task to To Be Tested frees the agent without finishing it', async () => {
    const tbtAgent = (await T.create_agent({ name: 'TBT Tester' })).agent;
    const t1 = (await T.create_task({ projectId, title: 'TBT 1', agent: tbtAgent.slug })).task;

    const r = await T.move_task({ task: t1.taskKey, column: 'To Be Tested' });
    assert.equal(r.agentFreed, true, 'To Be Tested should free the agent the same way Done does');
    assert.equal(r.agentNextTaskId, null, 'nothing queued yet — the agent should go idle');

    const agents = await T.list_agents({});
    assert.equal(agents.find(a => a.id === tbtAgent.id).status, 'idle',
        'a task waiting in To Be Tested must not count as the agent working something');

    const full = await T.get_task({ task: t1.taskKey });
    assert.equal(full.agentDoneAt, null, 'unlike Done, this is not a finish — the task stays open pending review');
    assert.equal(full.agentId, tbtAgent.id, 'it stays assigned to the agent that did the work');
});

await check('a queued task is promoted once the active one lands in To Be Tested', async () => {
    const tbtAgent = (await T.list_agents({})).find(a => a.slug === 'tbt-tester');
    const t2 = (await T.create_task({ projectId, title: 'TBT 2', agent: tbtAgent.slug })).task;
    assert.equal((await T.get_task({ task: t2.taskKey })).isActiveForAgent, true,
        'the agent was idle after the previous test, so this should claim immediately');

    const r = await T.move_task({ task: t2.taskKey, column: 'To Be Tested' });
    assert.equal(r.agentFreed, true);

    const t3 = (await T.create_task({ projectId, title: 'TBT 3', agent: tbtAgent.slug })).task;
    assert.equal((await T.get_task({ task: t3.taskKey })).isActiveForAgent, true,
        'the agent should already be idle again — no need to wait for finish_task on the To Be Tested task');

    await T.finish_task({ task: t3.taskKey }); // leave the agent clean for anything appended later
});

section('same-project task preferred over cross-project FIFO (TASK-573)');

await check('finishing a task hands the agent its own project\'s queued work before an older cross-project one', async () => {
    const hopAgent = (await T.create_agent({ name: 'Hop Tester' })).agent;

    // P1 becomes current (Smoke Project). Q1 (Bare Project) is assigned next,
    // so it's older in the queue than P2 (Smoke Project again). Pure FIFO
    // would hand the agent Q1 — it should get P2 instead, since that's the
    // project it was just working in.
    const p1 = (await T.create_task({ projectId, title: 'Hop P1', agent: hopAgent.slug })).task;
    assert.equal((await T.get_task({ task: p1.taskKey })).isActiveForAgent, true);
    const q1 = (await T.create_task({ projectId: bareProjectId, title: 'Hop Q1', column: 'To Do', agent: hopAgent.slug })).task;
    const p2 = (await T.create_task({ projectId, title: 'Hop P2', agent: hopAgent.slug })).task;

    const r = await T.finish_task({ task: p1.taskKey });
    assert.equal(r.agentNextTaskId, p2.id, 'same-project task should win even though it was queued after the cross-project one');

    const nextTask = await T.get_task({ task: r.agentNextTaskId });
    assert.equal(nextTask.taskKey, p2.taskKey);
    assert.equal(nextTask.isActiveForAgent, true);

    const mine = await T.list_tasks({ agent: hopAgent.slug });
    const stillQueued = mine.find(t => t.taskKey === q1.taskKey);
    assert.equal(stillQueued.queuePosition, 1, 'the cross-project task stays queued, just no longer first');

    // clean up
    await T.finish_task({ task: p2.taskKey });
    const after = await T.get_task({ task: q1.taskKey });
    assert.equal(after.isActiveForAgent, true, 'with nothing left in its own project, the agent falls back to the cross-project task');
    await T.finish_task({ task: q1.taskKey });
});

section('working requires a live session, not just a claimed task (TASK-574)');

await check('a claimed task stays put and the agent reads idle until start_session', async () => {
    const liveAgent = (await T.create_agent({ name: 'Live Tester' })).agent;
    const r = await T.create_task({ projectId, title: 'Live 1', agent: liveAgent.slug, column: 'To Do' });
    assert.equal(r.startNow, true, 'still claimed — currentTaskId is set');
    assert.equal(r.task.columnId, 'col-todo', 'no live session yet, so it must not jump to In Progress');

    const agents = await T.list_agents({});
    const found = agents.find(a => a.id === liveAgent.id);
    assert.equal(found.status, 'idle', 'a claimed-but-not-live task must not read as working');
    assert.equal(found.live, false);
    assert.equal(found.currentTaskKey, r.task.taskKey, 'still shows as the current task despite reading idle');
});

await check('start_session marks the agent live and moves its active task to In Progress', async () => {
    const liveAgent = (await T.list_agents({})).find(a => a.slug === 'live-tester');
    const r = await T.start_session({ agent: liveAgent.slug });
    assert.equal(r.movedToColumn, 'In Progress');

    const agents = await T.list_agents({});
    const found = agents.find(a => a.id === liveAgent.id);
    assert.equal(found.status, 'working');
    assert.equal(found.live, true);

    const task = await T.get_task({ task: r.currentTaskId });
    assert.equal(task.columnName, 'In Progress');
});

await check('finishing a task while live promotes and moves the next one immediately', async () => {
    const liveAgent = (await T.list_agents({})).find(a => a.slug === 'live-tester');
    const t2 = (await T.create_task({ projectId, title: 'Live 2', agent: liveAgent.slug })).task;
    assert.equal((await T.get_task({ task: t2.taskKey })).columnName, 'To Do', 'queued behind the active task, not claimed yet');

    const r = await T.finish_task({ task: liveAgent.currentTaskKey });
    assert.equal(r.agentNextTaskId, t2.id);
    const next = await T.get_task({ task: t2.taskKey });
    assert.equal(next.columnName, 'In Progress', 'the same live session should keep moving newly-promoted work forward');
});

await check('end_session drops the agent back to idle without touching its task', async () => {
    const liveAgent = (await T.list_agents({})).find(a => a.slug === 'live-tester');
    const activeTaskKey = liveAgent.currentTaskKey;

    const r = await T.end_session({ agent: liveAgent.slug });
    assert.equal(r.agentSlug, 'live-tester');

    const agents = await T.list_agents({});
    const found = agents.find(a => a.id === liveAgent.id);
    assert.equal(found.status, 'idle');
    assert.equal(found.live, false);
    assert.equal(found.currentTaskKey, activeTaskKey, 'still assigned to the same task — just nobody live to work it');

    const task = await T.get_task({ task: activeTaskKey });
    assert.equal(task.columnName, 'In Progress', 'ending the session does not move the card back');

    await T.finish_task({ task: activeTaskKey }); // leave the agent clean
});

await check('a task claimed while idle only moves once a new session starts', async () => {
    const liveAgent = (await T.list_agents({})).find(a => a.slug === 'live-tester');
    assert.equal(liveAgent.status, 'idle');
    const t3 = (await T.create_task({ projectId, title: 'Live 3', agent: liveAgent.slug })).task;
    assert.equal((await T.get_task({ task: t3.taskKey })).isActiveForAgent, true, 'claimed — the agent has nothing else current');
    assert.equal((await T.get_task({ task: t3.taskKey })).columnName, 'To Do', 'but not moved — no live session claimed it');

    await T.start_session({ agent: liveAgent.slug });
    assert.equal((await T.get_task({ task: t3.taskKey })).columnName, 'In Progress');
    await T.finish_task({ task: t3.taskKey });
    await T.end_session({ agent: liveAgent.slug });
});

// ── Concurrent sessions for the same agent across repos (TASK-650 follow-up) ──
// The real-world shape: the same agent identity has separate /start-agent
// terminals open per repo at once, each independently calling start_session
// once and end_session once when *its own* repo's queue empties — never
// aware of sibling sessions elsewhere. A plain sessionActive boolean meant
// whichever one finished first wiped out "live" for the others too.
section('concurrent sessions for one agent (TASK-650 follow-up)');

await check('two sessions starting keeps the agent live until both end', async () => {
    const multiAgent = (await T.create_agent({ name: 'Multi Session Tester' })).agent;

    await T.start_session({ agent: multiAgent.slug }); // "repo A" terminal
    await T.start_session({ agent: multiAgent.slug }); // "repo B" terminal, same agent identity
    assert.equal((await T.list_agents({})).find(a => a.id === multiAgent.id).live, true);

    // Repo A's terminal finishes its own queue and ends its session — repo
    // B's terminal is still working and never called end_session itself.
    await T.end_session({ agent: multiAgent.slug });
    assert.equal(
        (await T.list_agents({})).find(a => a.id === multiAgent.id).live, true,
        'one sibling session ending must not drop the agent to idle while another is still active — this is the bug TASK-650 follow-up fixes');

    // Repo B's terminal now finishes too — only now should it read idle.
    await T.end_session({ agent: multiAgent.slug });
    assert.equal((await T.list_agents({})).find(a => a.id === multiAgent.id).live, false);
});

await check('end_session never drops sessionCount below zero', async () => {
    const soloAgent = (await T.create_agent({ name: 'Solo Session Tester' })).agent;
    await T.end_session({ agent: soloAgent.slug }); // never started — must not go negative
    await T.start_session({ agent: soloAgent.slug });
    assert.equal((await T.list_agents({})).find(a => a.id === soloAgent.id).live, true);
});

// ── Cleanup ────────────────────────────────────────────────
section('cleanup');
await check('scratch namespace removed', async () => {
    const res = await fetch(`${store.config.base}/${store.config.namespace}.json`, { method: 'DELETE' });
    assert.ok(res.ok, `DELETE returned ${res.status}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
