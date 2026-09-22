/**
 * Firebase Realtime Database REST client for the FlowBoard MCP server.
 *
 * The browser app writes the same keys through firebase-rest-integration.js.
 * Two facts about RTDB drive everything here, both verified against the live DB:
 *
 *   1. RTDB does not store arrays. It stores objects keyed "0", "1", … and only
 *      returns a JSON array when those keys are contiguous from zero. It also
 *      deletes empty and null values outright — which is why a stored task can
 *      come back with no `labels`, `comments` or `dueDate` key at all, and why
 *      an empty collection does not exist as a node in the live DB at all.
 *
 *   2. RTDB REST supports compare-and-set: GET with `X-Firebase-ETag: true`
 *      returns an ETag, and PUT with `if-match` returns 412 if the node changed
 *      in between. `mutate()` below uses this so a concurrent write is retried
 *      against fresh data rather than silently overwriting someone's work.
 */

const BASE = (process.env.FLOWBOARD_FIREBASE_URL
    || 'https://tictac-405e5-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const NS = process.env.FLOWBOARD_NAMESPACE || 'timetracker';

export const KEYS = {
    projects: 'flowboard_projects',
    tasks:    'flowboard_tasks',
    agents:   'flowboard_agents',
    chats:    'flowboard_chats',
};

const META_URL = `${BASE}/${NS}/flowboard_meta.json`;

const MAX_RETRIES = 4;

function url(key) {
    if (!KEYS[key]) throw new Error(`Unknown store key: ${key}`);
    return `${BASE}/${NS}/${KEYS[key]}.json`;
}

/** RTDB may hand back an array, a numeric-keyed object, or nothing at all. */
export function coerceArray(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v.filter(x => x != null);
    if (typeof v === 'object') {
        return Object.keys(v)
            .sort((a, b) => Number(a) - Number(b))
            .map(k => v[k])
            .filter(x => x != null);
    }
    return [];
}

/** Read a collection. Never throws on an empty node — that is the normal state. */
export async function read(key) {
    const res = await fetch(url(key));
    if (!res.ok) throw new Error(`Firebase GET ${KEYS[key]} failed: ${res.status} ${res.statusText}`);
    return coerceArray(await res.json());
}

async function readWithEtag(key) {
    const res = await fetch(url(key), { headers: { 'X-Firebase-ETag': 'true' } });
    if (!res.ok) throw new Error(`Firebase GET ${KEYS[key]} failed: ${res.status} ${res.statusText}`);
    return { etag: res.headers.get('etag'), list: coerceArray(await res.json()) };
}

/**
 * Read-modify-write one collection under compare-and-set.
 *
 * `fn(list)` must be a pure in-memory mutation returning `{ next, result }`.
 * It may be called more than once, so it must not have side effects of its own.
 * On a 412 the collection is re-read and `fn` re-applied against fresh data,
 * so a write never clobbers a change it did not see.
 */
export async function mutate(key, fn) {
    let lastEtag = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const { etag, list } = await readWithEtag(key);
        lastEtag = etag;

        const { next, result } = await fn(list);
        if (next === undefined) return result;   // fn decided nothing needs writing

        const res = await fetch(url(key), {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json', 'if-match': etag },
            // Always write a dense array: the browser guards on Array.isArray,
            // and a hole would come back as an object and fail that check.
            body: JSON.stringify(next.filter(x => x != null)),
        });

        if (res.ok) return result;

        if (res.status === 412) {
            // Someone else wrote between our read and our write. Back off and
            // re-apply against their version.
            const wait = 100 * (attempt + 1) + Math.floor(Math.random() * 120);
            await new Promise(r => setTimeout(r, wait));
            continue;
        }

        const body = await res.text().catch(() => '');
        throw new Error(`Firebase PUT ${KEYS[key]} failed: ${res.status} ${res.statusText} ${body}`.trim());
    }

    throw new Error(
        `${KEYS[key]} is being written too rapidly by something else (${MAX_RETRIES + 1} conflicts, ` +
        `last etag ${lastEtag}). Nothing was written. If FlowBoard is open in a browser tab and you are ` +
        `editing in it, close or idle that tab and retry.`
    );
}

/**
 * Atomically reserve `count` sequential task-key numbers.
 *
 * Both the browser (js/state.js) and every MCP server process used to mint
 * "TASK-N" keys by scanning their own in-memory copy of the tasks list for
 * the current max and adding one — cheap, but two writers with stale copies
 * (a browser tab open on old localStorage, two agents in different repos)
 * can compute the same "next" number and hand out duplicate keys. This is
 * exactly what happened in practice (two live TASK-513s, two TASK-505s).
 *
 * `flowboard_meta.taskCounter` is the single shared source of truth: every
 * allocation goes through the same ETag compare-and-set as `mutate()`, so a
 * losing writer retries against the winner's fresh value instead of both
 * landing on the same number. First-ever call seeds the counter from the
 * highest key already present in `flowboard_tasks`, so it picks up where
 * the old per-process scanning left off rather than restarting at 1.
 */
export async function allocateTaskKeyNumbers(count = 1) {
    let lastEtag = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(META_URL, { headers: { 'X-Firebase-ETag': 'true' } });
        if (!res.ok) throw new Error(`Firebase GET flowboard_meta failed: ${res.status} ${res.statusText}`);
        const etag = res.headers.get('etag');
        lastEtag = etag;
        const meta = (await res.json()) || {};

        let current = Number(meta.taskCounter);
        if (!Number.isFinite(current)) {
            // Never allocated before — seed from the existing tasks so numbering
            // continues rather than colliding with keys already on the board.
            const tasks = await read('tasks');
            current = tasks.reduce((max, t) => {
                const n = parseInt(String(t.taskKey || '').replace(/\D/g, ''), 10);
                return Number.isNaN(n) ? max : Math.max(max, n);
            }, 0);
        }
        const next = current + count;

        const put = await fetch(META_URL, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json', 'if-match': etag },
            body:    JSON.stringify({ ...meta, taskCounter: next }),
        });

        if (put.ok) {
            const start = current + 1;
            return Array.from({ length: count }, (_, i) => start + i);
        }

        if (put.status === 412) {
            const wait = 100 * (attempt + 1) + Math.floor(Math.random() * 120);
            await new Promise(r => setTimeout(r, wait));
            continue;
        }

        const body = await put.text().catch(() => '');
        throw new Error(`Firebase PUT flowboard_meta failed: ${put.status} ${put.statusText} ${body}`.trim());
    }

    throw new Error(
        `flowboard_meta task counter is being written too rapidly by something else (${MAX_RETRIES + 1} ` +
        `conflicts, last etag ${lastEtag}). Nothing was written.`
    );
}

export const config = { base: BASE, namespace: NS };
