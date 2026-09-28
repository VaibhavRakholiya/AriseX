/**
 * FlowBoard — Router
 * Hash-based SPA routing. Routes:
 *   #board/:projectId   (project task list; no bare #board)
 *   #chat/:projectId    (project chat log; no bare #chat)
 *   #reports
 *   #agents
 *   #mytasks
 *   #settings
 */

const Router = (() => {
    const DEFAULT_VIEW = 'dashboard';

    const VIEWS = {
        dashboard: 'view-dashboard',
        board:     'view-board',
        chat:      'view-chat',
        reports:   'view-reports',
        agents:    'view-agents',
        mytasks:   'view-mytasks',
        settings:  'view-settings',
    };

    let _currentRoute = null;
    let _currentProjectId = null;

    function parseHash(hash) {
        const raw = (hash || window.location.hash).replace(/^#/, '').replace(/\/$/, '');
        const parts = raw.split('/').filter(p => p !== '');
        let view = parts[0] || DEFAULT_VIEW;
        let projectId = null;
        if (parts.length > 1) {
            const n = parseInt(parts[1], 10);
            projectId = Number.isNaN(n) ? null : n;
        }
        return { view, projectId };
    }

    /**
     * Project tasks view is only reachable with #board/:projectId (e.g. from the Projects list).
     * Other sections use a single-segment hash so a project id never "sticks" to them.
     */
    function navigate(view, projectId) {
        const v = VIEWS[view] ? view : DEFAULT_VIEW;

        if (v !== 'board' && v !== 'chat') {
            window.location.hash = `#${v}`;
            return;
        }

        const idNum = projectId != null ? Number(projectId) : NaN;
        if (!Number.isFinite(idNum)) {
            window.location.hash = `#${DEFAULT_VIEW}`;
            return;
        }
        window.location.hash = `#${v}/${Math.floor(idNum)}`;
    }

    function activate({ view, projectId }) {

        // Never show board/chat without a concrete project (invalid or bookmarked hash)
        if ((view === 'board' || view === 'chat') && (projectId == null || !Number.isFinite(Number(projectId)))) {
            window.location.hash = `#${DEFAULT_VIEW}`;
            return;
        }

        const viewName = VIEWS[view] ? view : DEFAULT_VIEW;
        _currentRoute    = viewName;
        _currentProjectId = projectId;

        // Swap active view
        Object.values(VIEWS).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('active');
        });

        const target = document.getElementById(VIEWS[viewName]);
        if (target) target.classList.add('active');

        // Highlight sidebar nav
        document.querySelectorAll('.nav-item[data-route]').forEach(el => {
            const on = el.dataset.route === viewName;
            el.classList.toggle('active', on);
            if (on) el.setAttribute('aria-current', 'page');
            else    el.removeAttribute('aria-current');
        });

        // Highlight project items
        document.querySelectorAll('.project-item[data-project-id]').forEach(el => {
            const pid = parseInt(el.dataset.projectId, 10);
            const on = (viewName === 'board' || viewName === 'chat') && pid === projectId;
            el.classList.toggle('active', on);
            if (on) el.setAttribute('aria-current', 'page');
            else    el.removeAttribute('aria-current');
        });

        // Update breadcrumb
        updateBreadcrumb(viewName, projectId);

        // Trigger view-specific render
        renderView(viewName, projectId);
    }

    function renderView(view, projectId) {
        switch (view) {
            case 'dashboard':
                window.Dashboard && Dashboard.render();
                break;
            case 'board':
                window.Board      && Board.render(projectId);
                break;
            case 'chat':
                window.Chat       && Chat.render(projectId);
                break;
            case 'reports':
                window.Reports    && Reports.render();
                break;
            case 'agents':
                window.Agents     && Agents.renderDashboard();
                break;
            case 'mytasks':
                window.Tasks      && Tasks.renderMyTasks();
                break;
            case 'settings':
                renderSettings();
                break;
        }
    }

    function updateBreadcrumb(view, projectId) {
        const bc = document.getElementById('headerBreadcrumb');
        if (!bc) return;

        const labels = {
            dashboard: 'Dashboard',
            board:     'Tasks',
            chat:      'Chat',
            reports:   'Reports',
            agents:    'Agent Activity',
            mytasks:   'My Tasks',
            settings:  'Settings',
        };

        const esc = window.UI ? UI.escHtml : (s => String(s ?? ''));
        const label = esc(labels[view] || view);

        let html = '';
        if (projectId) {
            const proj = State.Projects.get(projectId);
            if (proj) {
                html = `<strong>${esc(proj.name)}</strong>
                        <span class="breadcrumb-sep" aria-hidden="true">/</span>
                        <span>${label}</span>`;
            } else {
                html = `<strong>${label}</strong>`;
            }
        } else {
            html = `<strong>${label}</strong>`;
        }
        bc.innerHTML = html;
    }

    function renderSettings() {
        const username = localStorage.getItem('username') || 'Vaibhav';
        const initial  = username[0].toUpperCase();
        const theme    = document.documentElement.getAttribute('data-theme') || 'dark';

        const av = document.getElementById('settingsAvatar');
        const un = document.getElementById('settingsUsername');
        if (av) av.textContent = initial;
        if (un) un.textContent = username;

        // Highlight active theme
        document.querySelectorAll('[data-theme-pick]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.themePick === theme);
        });

        window.Agents && Agents.renderSettingsList();
    }

    function getCurrent()   { return { view: _currentRoute, projectId: _currentProjectId }; }
    function getCurrentProjectId() { return _currentProjectId; }

    function init() {
        // Navigation click handlers
        document.querySelectorAll('.nav-item[data-route]').forEach(el => {
            el.addEventListener('click', () => navigate(el.dataset.route));
        });

        // Hash change
        window.addEventListener('hashchange', () => {
            const parsed = parseHash();
            activate(parsed);
        });

        // Initial load
        const parsed = parseHash();
        if (!parsed.view || !VIEWS[parsed.view]) {
            navigate(DEFAULT_VIEW);
        } else {
            activate(parsed);
        }
    }

    return { init, navigate, getCurrent, getCurrentProjectId, renderView };
})();

window.Router = Router;
