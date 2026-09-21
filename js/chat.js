/**
 * FlowBoard — Chat Module (TASK-519)
 * Per-project chat log. Agents post system messages here (via the MCP
 * server's move_task/assign_task/finish_task tools) when a task changes
 * status, moves to review, or an agent goes idle; humans can post plain
 * messages from the composer. New messages surface as an in-app toast and,
 * where permitted, a desktop Notification.
 */

const Chat = (() => {
    const POLL_MS = 30000;

    let _currentProjectId = null;
    let _pollTimer = null;

    function escHtml(str) { return UI.escHtml(str); }

    function render(projectId) {
        _currentProjectId = projectId;

        const container = document.getElementById('chatContainer');
        const titleEl    = document.getElementById('chatViewTitle');
        if (!container) return;

        const proj = projectId ? State.Projects.get(projectId) : null;
        if (titleEl) titleEl.textContent = proj ? proj.name : 'Chat';

        if (!projectId || !proj) {
            container.innerHTML = UI.emptyState({
                icon: 'fa-comments',
                title: 'No project selected',
                body: 'Choose a project from the sidebar to view its chat.',
                grow: true,
            });
            return;
        }

        const messages = State.Chats.byProject(projectId);
        container.innerHTML = `
            <div class="chat-log" id="chatLog">
                ${messages.length
                    ? messages.map(renderMessage).join('')
                    : `<div class="chat-empty">No messages yet. Say hi, or wait for an agent update.</div>`}
            </div>
            <form class="chat-composer" id="chatComposer">
                <input type="text" class="form-control" id="chatComposerInput"
                       placeholder="Message this project…" maxlength="2000" autocomplete="off" />
                <button type="submit" class="btn btn-primary btn-sm" aria-label="Send">
                    <i class="fa-solid fa-paper-plane"></i>
                </button>
            </form>`;

        const log = document.getElementById('chatLog');
        if (log) log.scrollTop = log.scrollHeight;

        document.getElementById('chatComposer')?.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('chatComposerInput');
            if (!input || !input.value.trim()) return;
            State.Chats.send(projectId, input.value);
            input.value = '';
        });
    }

    function renderMessage(m) {
        const cls  = `chat-message chat-message--${escHtml(m.authorType || 'system')}`;
        const time = new Date(m.createdAt).toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        return `<div class="${cls}">
            <div class="chat-message-head">
                <span class="chat-message-author">${m.authorType === 'question' ? '<i class="fa-solid fa-circle-question"></i> ' : ''}${escHtml(m.author || 'System')}</span>
                <span class="chat-message-time">${escHtml(time)}</span>
            </div>
            <div class="chat-message-text">${UI.linkify(m.text)}</div>
        </div>`;
    }

    /**
     * Show a system notification, routed through the already-registered
     * Service Worker when one is available (TASK-648). Mobile browsers —
     * Android Chrome in particular — throw ("Illegal constructor:
     * Notifications on Android require Push messaging via a Service
     * Worker") or simply no-op on the page-context `new Notification(...)`
     * constructor, which is why these never appeared on mobile even with
     * permission granted; `ServiceWorkerRegistration.showNotification`
     * accepts the same options and works on both mobile and desktop. Falls
     * back to the page-context constructor only when no Service Worker is
     * registered at all (e.g. sw.js failed to register).
     */
    function notifySystem(title, options) {
        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
            navigator.serviceWorker.ready
                .then(reg => reg.showNotification(title, options))
                .catch(() => { try { new Notification(title, options); } catch { /* unsupported here too */ } });
            return;
        }
        try { new Notification(title, options); } catch { /* not supported */ }
    }

    /** Toast + desktop Notification for messages this tab hasn't seen before. */
    function notifyNew(prevMessages, nextMessages) {
        const seenIds = new Set(prevMessages.map(m => m.id));
        const me = localStorage.getItem('username') || 'Vaibhav';
        const fresh = nextMessages.filter(m =>
            !seenIds.has(m.id) && !(m.authorType === 'user' && m.author === me));
        if (!fresh.length) return;

        fresh.forEach(m => {
            const proj = State.Projects.get(m.projectId);
            const isQuestion = m.authorType === 'question';
            UI.toast(m.text, isQuestion ? 'warning' : 'info', proj ? `${proj.name} · ${m.author}` : m.author);
        });

        if (!('Notification' in window)) return;
        if (Notification.permission === 'default') Notification.requestPermission();
        if (Notification.permission !== 'granted') return;
        fresh.forEach(m => {
            const proj = State.Projects.get(m.projectId);
            const isQuestion = m.authorType === 'question';
            const title = proj ? `${proj.name} — ${m.author}` : m.author;
            notifySystem(isQuestion ? `❓ ${title}` : title, {
                body: m.text,
                tag:  `flowboard-chat-${m.id}`,
                requireInteraction: isQuestion,
                icon: 'icons/icon.png',
            });
        });
    }

    async function poll() {
        const prev = State.Chats.getAll().slice();
        const ok = await State.Chats.refresh();
        if (!ok) return;
        notifyNew(prev, State.Chats.getAll());
        if (Router.getCurrent().view === 'chat') render(_currentProjectId);
    }

    function init() {
        _pollTimer = setInterval(poll, POLL_MS);

        document.getElementById('boardChatBtn')?.addEventListener('click', () => {
            const { projectId } = Router.getCurrent();
            if (projectId != null) Router.navigate('chat', projectId);
        });
        document.getElementById('chatBackToBoardBtn')?.addEventListener('click', () => {
            const { projectId } = Router.getCurrent();
            if (projectId != null) Router.navigate('board', projectId);
        });

        State.on('chats:changed', () => {
            const { view, projectId } = Router.getCurrent();
            if (view === 'chat') render(projectId);
        });
    }

    return { init, render };
})();

window.Chat = Chat;
