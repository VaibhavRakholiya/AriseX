// Firebase REST API Integration for TimeTracker - Database URL Only
// This approach uses direct HTTP requests to Firebase Realtime Database REST API
// No Firebase SDK required - only the database URL

class FirebaseRESTIntegration {
    constructor() {
        this.databaseURL = "https://tictac-405e5-default-rtdb.firebaseio.com";
        this.isOnline = navigator.onLine;
        this.isConnected = false;

        // The most recent remote snapshot this tab has actually seen for each
        // collection, keyed by dataType — see saveData()'s merge logic below.
        this._lastKnown = {};

        // Initialize network listeners
        this.initNetworkListeners();

        // Test connection
        this.testConnection();
    }

    // Firebase ID token for the signed-in user, required once database rules
    // reject unauthenticated requests (TASK-589). `currentUser` can still be
    // null immediately after page load even for a persisted session, since
    // Firebase restores auth state asynchronously — in that case we wait for
    // the SDK's first onAuthStateChanged emission instead of guessing.
    async getIdToken() {
        const user = firebase.auth().currentUser || await new Promise((resolve) => {
            const unsubscribe = firebase.auth().onAuthStateChanged((u) => {
                unsubscribe();
                resolve(u);
            });
        });
        return user ? await user.getIdToken() : null;
    }

    // Appends the signed-in user's ID token so RTDB REST calls pass rules
    // that require `auth != null`. Falls back to the bare URL when signed
    // out, letting the request fail with Firebase's own permission error
    // rather than masking it here.
    async withAuth(url) {
        const token = await this.getIdToken();
        return token ? `${url}?auth=${encodeURIComponent(token)}` : url;
    }

    // Test Firebase connection
    async testConnection() {
        try {
            console.log(`🔍 Testing connection to: ${this.databaseURL}/.json`);
            const response = await fetch(await this.withAuth(`${this.databaseURL}/.json`), {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            console.log(`📡 Response status: ${response.status}`);
            
            if (response.ok) {
                this.isConnected = true;
                console.log('🟢 Connected to Firebase via REST API');
                this.showToast('Connected to cloud sync', 'success');
            } else {
                this.isConnected = false;
                console.log('🔴 Failed to connect to Firebase');
                this.showToast('Firebase connection failed', 'error');
            }
        } catch (error) {
            this.isConnected = false;
            console.log('🔴 Firebase connection error:', error);
            this.showToast('Working offline', 'warning');
        }
    }

    // RTDB may hand back an array, a numeric-keyed object, or null. Mirrors
    // mcp-server/src/store.js coerceArray.
    _coerceArray(v) {
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

    // Database Methods using REST API
    //
    // A blind `PUT` of this tab's whole in-memory collection used to be how
    // every save worked. That is how the board lost tasks: this tab's local
    // array reflects only what it has loaded/edited itself, so a task an MCP
    // agent (or another tab) created after this tab's last load simply isn't
    // in it — and a blind overwrite deletes it from Firebase along with
    // pushing this tab's own changes. For an array collection (tasks,
    // agents, projects — every current caller), this now does a
    // compare-and-set merge instead: records this tab doesn't know about get
    // preserved rather than wiped, while an id this tab previously saw and
    // has since dropped locally is still treated as an intentional deletion
    // (see `_lastKnown`, the baseline that tells those two cases apart).
    async saveData(dataType, data) {
        if (!Array.isArray(data)) return this._saveDataLegacy(dataType, data);

        const url = `${this.databaseURL}/timetracker/${dataType}.json`;
        const maxRetries = 4;
        const local = data.filter(r => r != null);

        try {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                const getRes = await fetch(await this.withAuth(url), {
                    headers: { 'X-Firebase-ETag': 'true' },
                });
                if (!getRes.ok) throw new Error(`HTTP ${getRes.status}: ${getRes.statusText}`);
                const etag = getRes.headers.get('etag');
                const remote = this._coerceArray(await getRes.json());

                const baselineIds = new Set((this._lastKnown[dataType] || []).map(r => r.id));
                const localIds = new Set(local.map(r => r.id));
                // In Firebase, not in this save, and not something this tab
                // ever saw before — i.e. created elsewhere since this tab's
                // last load. Keep it. An id this tab HAS seen before and no
                // longer has locally is a real local deletion, not this case.
                const preserved = remote.filter(r => !localIds.has(r.id) && !baselineIds.has(r.id));
                const merged = [...local, ...preserved];

                const putRes = await fetch(await this.withAuth(url), {
                    method:  'PUT',
                    headers: { 'Content-Type': 'application/json', 'if-match': etag },
                    body:    JSON.stringify(merged),
                });

                if (putRes.ok) {
                    this._lastKnown[dataType] = merged;
                    localStorage.setItem(`${dataType}_backup`, JSON.stringify(merged));
                    console.log(`✅ Data saved to Firebase via REST: ${dataType}`);
                    return true;
                }

                if (putRes.status === 412) {
                    // Someone else wrote in between — back off and redo the
                    // merge against their fresh version.
                    const wait = 100 * (attempt + 1) + Math.floor(Math.random() * 120);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }

                const errorText = await putRes.text().catch(() => '');
                throw new Error(`HTTP ${putRes.status}: ${putRes.statusText} ${errorText}`.trim());
            }
            throw new Error(`${dataType} is being written too rapidly by something else. Nothing was written.`);
        } catch (error) {
            console.error(`❌ Error saving ${dataType} to Firebase:`, error);
            // Fallback to localStorage
            localStorage.setItem(`${dataType}_backup`, JSON.stringify(local));
            this.showToast(`Saved locally (offline): ${dataType}`, 'warning');
            return false;
        }
    }

    // Original blind-overwrite path, kept for any non-array payload (no
    // current caller passes one — every collection this app syncs is a
    // record array with an `id`, which is what the merge above needs).
    async _saveDataLegacy(dataType, data) {
        try {
            const url = `${this.databaseURL}/timetracker/${dataType}.json`;
            console.log(`💾 Saving ${dataType} to: ${url}`);
            console.log(`📦 Data to save:`, data);

            const response = await fetch(await this.withAuth(url), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            console.log(`📡 Save response status: ${response.status}`);

            if (response.ok) {
                // Also save to localStorage as backup
                localStorage.setItem(`${dataType}_backup`, JSON.stringify(data));
                console.log(`✅ Data saved to Firebase via REST: ${dataType}`);
                return true;
            } else {
                const errorText = await response.text();
                console.error(`❌ Save failed: ${response.status} - ${errorText}`);
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            console.error(`❌ Error saving ${dataType} to Firebase:`, error);

            // Fallback to localStorage
            localStorage.setItem(`${dataType}_backup`, JSON.stringify(data));
            this.showToast(`Saved locally (offline): ${dataType}`, 'warning');
            return false;
        }
    }

    async loadData(dataType) {
        try {
            const url = `${this.databaseURL}/timetracker/${dataType}.json`;
            console.log(`📥 Loading ${dataType} from: ${url}`);

            const response = await fetch(await this.withAuth(url), {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            console.log(`📡 Load response status: ${response.status}`);

            if (response.ok) {
                const data = await response.json();
                console.log(`📦 Loaded data for ${dataType}:`, data);
                
                if (data !== null) {
                    // Update localStorage backup
                    localStorage.setItem(`${dataType}_backup`, JSON.stringify(data));
                    console.log(`✅ Data loaded from Firebase via REST: ${dataType}`);
                    // This is now the baseline saveData() diffs against to tell
                    // "created elsewhere, preserve it" apart from "I deleted
                    // this locally, drop it" — see saveData()'s comment.
                    if (Array.isArray(data)) this._lastKnown[dataType] = data;
                    return data;
                } else {
                    // Return default data if no data exists
                    console.log(`ℹ️  No data found in Firebase for: ${dataType}, using defaults`);
                    this._lastKnown[dataType] = [];
                    return this.getDefaultData(dataType);
                }
            } else {
                const errorText = await response.text();
                console.error(`❌ Load failed: ${response.status} - ${errorText}`);
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            console.error(`❌ Error loading ${dataType} from Firebase:`, error);
            // Fallback to localStorage
            const backup = localStorage.getItem(`${dataType}_backup`);
            if (backup) {
                console.log(`📱 Using local backup for: ${dataType}`);
                const parsed = JSON.parse(backup);
                if (Array.isArray(parsed)) this._lastKnown[dataType] = parsed;
                return parsed;
            } else {
                console.log(`🆕 Using default data for: ${dataType}`);
                return this.getDefaultData(dataType);
            }
        }
    }

    // Atomically reserve `count` sequential task-key numbers via Firebase's
    // ETag compare-and-set (mirrors mcp-server/src/store.js
    // allocateTaskKeyNumbers). The browser used to mint "TASK-N" locally by
    // scanning its own possibly-stale localStorage copy of the task list,
    // which is how the board ended up with two live TASK-513s: an MCP agent
    // and a browser tab each computed "next" from data the other one had
    // already moved past. Routing both writers through the same shared
    // counter node closes that gap.
    async allocateTaskKeyNumbers(count = 1) {
        const metaUrl = `${this.databaseURL}/timetracker/flowboard_meta.json`;
        const maxRetries = 4;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const res = await fetch(await this.withAuth(metaUrl), {
                headers: { 'X-Firebase-ETag': 'true' },
            });
            if (!res.ok) throw new Error(`Firebase GET flowboard_meta failed: ${res.status} ${res.statusText}`);
            const etag = res.headers.get('etag');
            const meta = (await res.json()) || {};

            let current = Number(meta.taskCounter);
            if (!Number.isFinite(current)) {
                const tasks = await this.loadData('flowboard_tasks');
                current = (Array.isArray(tasks) ? tasks : []).reduce((max, t) => {
                    const n = parseInt(String(t?.taskKey || '').replace(/\D/g, ''), 10);
                    return Number.isNaN(n) ? max : Math.max(max, n);
                }, 0);
            }
            const next = current + count;

            const put = await fetch(await this.withAuth(metaUrl), {
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

        throw new Error('flowboard_meta task counter is being written too rapidly by something else. Nothing was written.');
    }

    // Real-time listeners using Server-Sent Events (if supported) or polling
    setupRealtimeListener(dataType, callback) {
        console.log(`⏸️ Realtime listener disabled for: ${dataType} (auto-refresh disabled)`);
        // Realtime listeners are disabled to prevent continuous refreshing
        // Data will only be loaded when explicitly requested
    }

    // Cleanup polling intervals
    cleanupListeners() {
        const dataTypes = ['projects', 'tasks', 'backlogItems', 'timeEntries', 'timesheetReviews'];
        dataTypes.forEach(dataType => {
            if (this[`${dataType}Interval`]) {
                clearInterval(this[`${dataType}Interval`]);
                delete this[`${dataType}Interval`];
            }
        });
    }

    // Helper Methods
    getDefaultData(dataType) {
        const defaults = {
            projects: [],
            tasks: [],
            backlogItems: [],
            timeEntries: [],
            timesheetReviews: []
        };
        return defaults[dataType] || [];
    }

    initNetworkListeners() {
        window.addEventListener('online', () => {
            this.isOnline = true;
            console.log('🌐 Network connection restored');
            this.showToast('Connection restored', 'success');
            this.testConnection();
        });

        window.addEventListener('offline', () => {
            this.isOnline = false;
            console.log('📴 Network connection lost');
            this.showToast('Working offline', 'warning');
        });
    }

    setupRealtimeListeners() {
        console.log('⏸️ Realtime listeners disabled - data loads only once on page load');
        // Realtime listeners are disabled to prevent continuous refreshing
        // Data will only be loaded when explicitly requested
    }

    updateUI(dataType) {
        // Disabled automatic UI updates - data loads only once on page load
        console.log(`⏸️ Skipping automatic UI update for ${dataType} (auto-refresh disabled)`);
    }

    async syncPendingChanges() {
        // Sync any local changes that were made while offline
        if (this.isConnected) {
            try {
                console.log('🔄 Syncing pending changes...');
                const dataTypes = ['projects', 'tasks', 'backlogItems', 'timeEntries', 'timesheetReviews'];
                
                for (const dataType of dataTypes) {
                    const localData = JSON.parse(localStorage.getItem(`${dataType}_backup`) || '[]');
                    if (localData && localData.length > 0) {
                        await this.saveData(dataType, localData);
                    }
                }
                
                console.log('✅ Sync completed');
            } catch (error) {
                console.error('❌ Error syncing data:', error);
            }
        }
    }

    showToast(message, type = 'info') {
        // Use existing toast functionality if available
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
        } else {
            console.log(`Toast: ${message}`);
        }
    }

    // Get connection status
    getConnectionStatus() {
        return {
            isConnected: this.isConnected,
            isOnline: this.isOnline
        };
    }

    // Get database URL
    getDatabaseURL() {
        return this.databaseURL;
    }

    // Manual test function for debugging
    async testFirebaseConnection() {
        console.log('🔍 Starting comprehensive Firebase test...');
        console.log(`📡 Database URL: ${this.databaseURL}`);
        
        // Test 1: Basic connection
        try {
            const response = await fetch(await this.withAuth(`${this.databaseURL}/.json`));
            console.log(`📡 Basic connection test: ${response.status}`);
            if (response.ok) {
                const data = await response.json();
                console.log('📦 Current database content:', data);
            }
        } catch (error) {
            console.error('❌ Basic connection test failed:', error);
        }

        // Test 2: Save test data
        try {
            const testData = { 
                message: 'Hello Firebase!', 
                timestamp: new Date().toISOString(),
                testId: Math.random().toString(36).substr(2, 9)
            };
            
            const response = await fetch(await this.withAuth(`${this.databaseURL}/timetracker/test.json`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testData)
            });

            console.log(`📡 Save test response: ${response.status}`);
            if (response.ok) {
                console.log('✅ Test data saved successfully!');

                // Test 3: Read it back
                const readResponse = await fetch(await this.withAuth(`${this.databaseURL}/timetracker/test.json`));
                if (readResponse.ok) {
                    const readData = await readResponse.json();
                    console.log('📦 Test data read back:', readData);
                }
            } else {
                const errorText = await response.text();
                console.error('❌ Save test failed:', response.status, errorText);
            }
        } catch (error) {
            console.error('❌ Save test error:', error);
        }
    }
}

// Initialize Firebase REST Integration
let firebaseRESTIntegration;

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    firebaseRESTIntegration = new FirebaseRESTIntegration();
    
    // Disable polling listeners - data loads only once on page load
    // firebaseRESTIntegration.setupRealtimeListeners();
    
    // Make it available globally immediately
    window.firebaseRESTIntegration = firebaseRESTIntegration;
    
    console.log('🚀 Firebase REST Integration initialized (Database URL only)');
    console.log(`📡 Using database URL: ${firebaseRESTIntegration.getDatabaseURL()}`);
    
    // Test a simple save operation
    setTimeout(async () => {
        console.log('🧪 Testing Firebase connection with a simple save...');
        try {
            const testData = { test: 'connection', timestamp: new Date().toISOString() };
            const result = await firebaseRESTIntegration.saveData('test', testData);
            if (result) {
                console.log('✅ Test save successful! Firebase is working.');
            } else {
                console.log('❌ Test save failed! Check Firebase configuration.');
            }
        } catch (error) {
            console.error('❌ Test save error:', error);
        }
    }, 2000);
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (firebaseRESTIntegration) {
        firebaseRESTIntegration.cleanupListeners();
    }
});

// Export for use in main app (set in DOMContentLoaded event)

// Global test function for debugging
window.testFirebase = () => {
    if (firebaseRESTIntegration) {
        firebaseRESTIntegration.testFirebaseConnection();
    } else {
        console.error('❌ Firebase integration not initialized yet');
    }
};
