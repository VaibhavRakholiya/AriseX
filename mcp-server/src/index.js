#!/usr/bin/env node
/**
 * FlowBoard MCP server — stdio transport.
 *
 * Exposes the FlowBoard board (projects, tasks, agent profiles) to
 * Claude Code. Registration only; all behaviour lives in tools.js.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import * as T from './tools.js';
import { config } from './store.js';

const server = new McpServer({ name: 'flowboard', version: '0.1.0' });

/** Wrap a handler so failures come back as readable text, not a dead tool call. */
function register(name, description, shape, handler) {
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
        try {
            const result = await handler(args ?? {});
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: `${name} failed: ${err.message}` }],
            };
        }
    });
}

const taskRef = z.union([z.string(), z.number()])
    .describe('Task id (number) or key such as "TASK-12".');
const agentRef = z.union([z.string(), z.number()])
    .describe('Agent id (number) or slug such as "bug-triager".');

// ── Reads ──────────────────────────────────────────────────

register('list_projects',
    'List FlowBoard projects with their workflow columns, task counts, and configured repo. Start here to get ' +
    'a projectId — check `repo` for which local repository a task\'s work belongs in.',
    {}, T.list_projects);

register('list_agents',
    'List agent profiles, including each one\'s systemPrompt, whether it is idle or working, and its ' +
    'queue depth. Read this before working an agent\'s tasks so you can adopt its instructions.',
    { includeDisabled: z.boolean().optional().describe('Include agents marked unavailable.') },
    T.list_agents);

register('list_tasks',
    'List tasks with optional filters. Use `agent` to get one agent\'s queue — results include ' +
    'queuePosition (0 = active/start now, 1+ = waiting) and agentDone.',
    {
        projectId: z.number().optional(),
        column:    z.string().optional().describe('Column id or name, e.g. "In Progress".'),
        assignee:  z.string().optional().describe('Exact person name.'),
        agent:     agentRef.optional(),
        priority:  z.enum(['low', 'medium', 'high', 'urgent', 'critical']).optional(),
        unassignedAgent: z.boolean().optional().describe('Only tasks with no agent assigned.'),
        query:     z.string().optional().describe('Substring match on title, description and key.'),
        limit:     z.number().optional().describe('Default 50.'),
    }, T.list_tasks);

register('get_task',
    'Full detail for one task: description, subtasks, comments, time entries, and the assigned agent.',
    { task: taskRef }, T.get_task);

// ── Writes ─────────────────────────────────────────────────

register('create_task',
    'Create a task. A valid projectId is required. Passing `agent` assigns it on creation, claiming the ' +
    'agent immediately if it is idle (response: startNow) or queuing it if not (queuePosition).',
    {
        projectId:    z.number(),
        title:        z.string(),
        description:  z.string().optional(),
        priority:     z.enum(['low', 'medium', 'high', 'urgent', 'critical']).optional(),
        column:       z.string().optional().describe('Column id or name. Defaults to the project\'s first column.'),
        assignee:     z.string().optional(),
        agent:        agentRef.optional(),
        dueDate:      z.string().optional().describe('YYYY-MM-DD'),
        startDate:    z.string().optional().describe('YYYY-MM-DD'),
        timeEstimate: z.number().optional().describe('Hours.'),
        labels:       z.array(z.string()).optional(),
    }, T.create_task);

register('update_task', 'Update a task\'s fields. Does not move columns or change assignment.',
    {
        task:         taskRef,
        title:        z.string().optional(),
        description:  z.string().optional(),
        priority:     z.enum(['low', 'medium', 'high', 'urgent', 'critical']).optional(),
        dueDate:      z.string().optional(),
        startDate:    z.string().optional(),
        timeEstimate: z.number().optional(),
        labels:       z.array(z.string()).optional(),
    }, T.update_task);

register('move_task',
    'Move a task to another column, e.g. "In Review". Moving an agent\'s task into a column named ' +
    'exactly "Done" also frees that agent and promotes its next queued task automatically.',
    { task: taskRef, column: z.string().describe('Column id or name.') }, T.move_task);

register('finish_task',
    'Mark an agent done with a task: frees it and immediately hands over the next queued task, if any ' +
    '(agentNextTaskId in the response — call get_task on it and begin right away). Call this after ' +
    'add_comment/move_task, once you are actually finished. Moving into a column named "Done" does ' +
    'this automatically; call it explicitly for any other completion signal.',
    { task: taskRef }, T.finish_task);

register('assign_task',
    'Assign a task to an agent or a person. Pass exactly one of `agent` or `assignee`. ' +
    'If the agent is idle, this claims it and the response says startNow: true — begin work in this ' +
    'session immediately. If the agent is already working something else, the task queues behind it ' +
    '(queuePosition in the response) and will not start on its own; call finish_task on the active one ' +
    'to advance the queue.',
    { task: taskRef, agent: agentRef.optional(), assignee: z.string().optional() }, T.assign_task);

register('add_comment',
    'Add a comment to a task. This is how an agent reports its results back to the board. Author defaults ' +
    'to the task\'s agent. This does not free the agent — call finish_task once you are actually done. ' +
    'Set `needsInput: true` when the comment is a question for the user or asks for permission before ' +
    'continuing — it also posts to the project chat, which triggers an in-app toast and a desktop ' +
    'Notification so the user actually sees it instead of it sitting unread in the task.',
    {
        task: taskRef, text: z.string(), author: z.string().optional(),
        needsInput: z.boolean().optional().describe(
            'True if this comment asks the user a question or requests permission — triggers an in-app + system notification.'),
    }, T.add_comment);

register('create_agent',
    'Create an agent profile. The systemPrompt is the instructions Claude adopts when working this agent\'s tasks.',
    {
        name:         z.string(),
        role:         z.string().optional().describe('One line on what it does.'),
        systemPrompt: z.string().optional(),
        emoji:        z.string().optional(),
        color:        z.string().optional().describe('Hex, e.g. "#f59e0b".'),
        model:        z.enum(['default', 'opus-5.5', 'opus', 'sonnet', 'haiku']).optional(),
        enabled:      z.boolean().optional(),
        slug:         z.string().optional(),
    }, T.create_agent);

register('update_agent',
    'Update an agent profile. Renaming also updates the display name on its tasks.',
    {
        agent:        agentRef,
        name:         z.string().optional(),
        role:         z.string().optional(),
        systemPrompt: z.string().optional(),
        emoji:        z.string().optional(),
        color:        z.string().optional(),
        model:        z.enum(['default', 'opus-5.5', 'opus', 'sonnet', 'haiku']).optional(),
        enabled:      z.boolean().optional(),
    }, T.update_agent);

register('start_session',
    'Mark that a live terminal/Claude Desktop session is up and working this agent — call this once, right ' +
    'after adopting its systemPrompt and before starting real work on its active task. Until this is called, ' +
    'a claimed task (currentTaskId set) still reads as idle on the board and stays out of "In Progress"; this ' +
    'call is what actually moves it there. Call end_session when you stop working this agent.',
    { agent: agentRef }, T.start_session);

register('end_session',
    'Mark that this agent no longer has a live session — call it when you finish working its queue, get ' +
    'interrupted, or hand off, so the board stops showing it as live. Does not touch its assigned task(s); ' +
    'call finish_task or move_task first if the active one is actually done.',
    { agent: agentRef }, T.end_session);

// Deleting tasks or agents is deliberately not exposed: the database has no
// auth and no undo, so destruction stays a human action in the UI.

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the protocol channel — diagnostics must go to stderr.
console.error(`flowboard MCP server ready (${config.base}/${config.namespace})`);
