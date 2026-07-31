// ==========================================================
//   NTI SECURE — Admin Dashboard Logic v2.0
//   Firebase Storage · Activity Log · Charts · Backup/Restore
// ==========================================================
// ?v=3 forces the browser to bypass the HTTP cache and refetch. Critical:
// if your browser is serving a stale admin.js that calls initSettingsForm(),
// that's the cause of the ReferenceError you're seeing in the console.
import { app, db, auth, storage } from './firebase-config.js?v=3';
import {
    signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import {
    doc, getDoc, setDoc, collection, addDoc, getDocs, deleteDoc, updateDoc,
    query, orderBy, writeBatch, onSnapshot, increment, where, limit
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import {
    ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-storage.js";

// --- UTILS ---
// --- ADVANCED UTILS (Network Resilience) ---
// Don't waste time retrying errors that will never succeed:
//   - permission-denied  → user not in admin_roles / rules block the write
//   - unauthenticated    → session expired, retry won't help
//   - not-found          → doc/collection doesn't exist
//   - invalid-argument   → bad payload, not a network issue
// Only retry on transient network / unavailable errors.
const _FATAL_FIRESTORE_CODES = new Set([
    'permission-denied',
    'unauthenticated',
    'not-found',
    'invalid-argument',
    'failed-precondition',
    'already-exists',
    'cancelled',
    'out-of-range',
    'unimplemented',
    'data-loss'
]);

const _isFatal = (err) => {
    const code = err?.code || '';
    if (_FATAL_FIRESTORE_CODES.has(code)) return true;
    // Storage SDK uses different error codes — also non-retryable:
    if (/^storage\/unauthorized$|^storage\/unauthenticated$/.test(code)) return true;
    // Offline errors should also fail fast (Firestore will surface real cause on next call)
    if (/offline|client is offline|webchannel/i.test(err?.message || '')) {
        // For "client is offline" we DO want to retry — but only once, and only on real offline.
        // Permission errors are reported as "offline" sometimes in some versions, so be defensive:
        return code === 'permission-denied';
    }
    return false;
};

const withRetry = async (fn, retries = 3, delay = 1500) => {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); }
        catch (err) {
            if (_isFatal(err)) {
                console.warn('[withRetry] fatal error, no retry:', err?.code || '', err?.message);
                throw err;
            }
            if (i === retries - 1) throw err;
            console.warn('[withRetry] retry', i + 1, '/', retries, 'after', delay, 'ms', err?.code || err?.message);
            await new Promise(r => setTimeout(r, delay));
            delay *= 1.5;
        }
    }
};
// --------------------------------------------------
const _safeURL = (s, fb) => (s && /^https?:\/\//i.test(s)) ? s : (fb || '#');
const _safeURLOrNull = (s) => (s && /^https?:\/\//i.test(s)) ? s : null;
const _escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// --- STATE ---
const state = {
    team: [],
    posts: [],
    settings: null,
    activity: [],
    currentTab: 'overview',
    search: '',          // team search
    postsSearch: '',     // posts search
    selectedTeam: new Set(),
    selectedPosts: new Set(),
    focusTrapRelease: null,
    unsubTeam: null,
    unsubPosts: null,
    unsubActivity: null
};

// --- TOAST ---
// Enhanced toast: now supports an optional action button (used for Undo).
// Backward-compatible: existing calls (msg, type, duration) still work.
// New usage: toast('Deleted', 'success', 6000, { label: 'تراجع', onClick: fn })
function toast(msg, type = 'info', duration = 3500, action = null) {
    const wrap = document.getElementById('toastContainer');
    if (!wrap) return () => {};
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    const icons = { success: 'check-circle', error: 'warning-circle', warning: 'warning', info: 'info' };
    let html = `<i class="ph-fill ph-${icons[type]}" aria-hidden="true"></i><span class="toast-msg">${_escapeHTML(msg)}</span>`;
    if (action && action.label) {
        // Use a real <button> for accessibility; uppercase label for emphasis.
        html += `<button type="button" class="toast-action">${_escapeHTML(action.label)}</button>`;
        // Visual countdown bar so the user knows how much time is left.
        html += `<div class="toast-undo-bar" style="animation-duration:${duration}ms"></div>`;
    }
    el.innerHTML = html;
    wrap.appendChild(el);

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 300);
    };

    if (action && action.label) {
        const btn = el.querySelector('.toast-action');
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            try { if (action.onClick) action.onClick(); } catch (e) { console.error('toast action error:', e); }
            dismiss();
        });
    }

    setTimeout(dismiss, duration);
    return dismiss; // Caller can dismiss early if needed.
}

// --- ACTIVITY LOG (Firestore) ---
// Returns a Promise that resolves to true on success, false on failure.
// NEVER throws — activity logging is a side effect; failures must not break
// the main user action. We only show a toast on the FIRST failure (per page
// load) so we don't spam the user.
let _activityLogWarned = false;
async function logActivity(type, title, details = '') {
    try {
        await addDoc(collection(db, 'activity'), {
            type, title, details,
            userEmail: auth.currentUser?.email || 'unknown',
            userUid: auth.currentUser?.uid || 'unknown',
            timestamp: new Date().toISOString(),
            createdAt: Date.now()
        });
        return true;
    } catch (e) {
        console.warn('[logActivity] failed:', e?.code, e?.message);
        // Surface a one-time hint so the admin knows what to fix.
        // Common cause: their UID is missing from the admin_roles collection.
        if (!_activityLogWarned && e?.code === 'permission-denied') {
            _activityLogWarned = true;
            const uid = auth.currentUser?.uid;
            toast(
                'سجل النشاط لا يعمل: صلاحيات مرفوضة. ' +
                'أضف الـ UID التالي في مجموعة admin_roles: ' + (uid || '?'),
                'error', 10000
            );
            console.info('[logActivity] To fix: create a doc in admin_roles with id =', uid);
        }
        return false;
    }
}

// --- AUTH ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('login-container').style.display = 'none';
        document.getElementById('dashboard-container').style.display = 'flex';
        document.getElementById('adminEmail').textContent = user.email || '—';
        initDashboard();
    } else {
        document.getElementById('login-container').style.display = 'flex';
        document.getElementById('dashboard-container').style.display = 'none';
        // Unsubscribe real-time listeners
        if (state.unsubTeam) state.unsubTeam();
        if (state.unsubPosts) state.unsubPosts();
        if (state.unsubActivity) state.unsubActivity();
    }
});

const loginForm = document.getElementById('login-form');
if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('admin-email').value.trim();
        const pw = document.getElementById('admin-password').value;
        const btn = loginForm.querySelector('button[type="submit"]');
        const errorEl = document.getElementById('login-error');

        if (errorEl) errorEl.textContent = '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i><span>جاري التحقق...</span>'; }

        signInWithEmailAndPassword(auth, email, pw)
            .then(() => toast('تم تسجيل الدخول بنجاح', 'success'))
            .catch((err) => {
                if (errorEl) errorEl.textContent = '> ACCESS_DENIED: ' + (err.message || 'Auth failed');
                toast('فشل تسجيل الدخول', 'error');
            })
            .finally(() => {
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ph ph-sign-in"></i><span>تسجيل الدخول</span>'; }
            });
    });
}

const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) logoutBtn.addEventListener('click', () => signOut(auth));

// Click the admin email in the topbar to copy the UID + show where to register it.
// This is the #1 fix for "permission-denied" errors — admins need their UID
// in the admin_roles collection (one doc per admin, doc id = uid).
const adminEmailEl = document.getElementById('adminEmail');
if (adminEmailEl) {
    adminEmailEl.title = 'اضغط لعرض ونسخ الـ UID (لازم يكون في admin_roles)';
    adminEmailEl.style.cursor = 'help';
    adminEmailEl.addEventListener('click', async () => {
        const u = auth.currentUser;
        if (!u) return;
        const text = `Email: ${u.email}\nUID: ${u.uid}\n\nأضف doc في admin_roles بالـ UID ده كـ document ID.`;
        try {
            await navigator.clipboard.writeText(u.uid);
            toast('تم نسخ الـ UID: ' + u.uid, 'success', 5000);
            console.info(text);
        } catch (_) {
            prompt('انسخ الـ UID ده (document ID في admin_roles):', u.uid);
        }
    });
}

const togglePw = document.getElementById('togglePw');
if (togglePw) {
    togglePw.addEventListener('click', () => {
        const inp = document.getElementById('admin-password');
        if (!inp) return;
        const isPw = inp.type === 'password';
        inp.type = isPw ? 'text' : 'password';
        togglePw.innerHTML = `<i class="ph ph-eye${isPw ? '-slash' : ''}"></i>`;
    });
}

// --- DASHBOARD INIT ---
// Note: All form/editor/backup listeners are attached at module load time
// (settings form, member editor, post editor, backup/restore). The dashboard
// only needs to kick off the tabs, sidebar, real-time listeners, and the
// initial settings load + login activity.
//
// Every step is wrapped in try/catch so a single failure can't take down
// the whole UI. This is critical: if one boot step throws, the user would
// otherwise lose the tabs, sidebar toggle, and the quick-action buttons.
function initDashboard() {
    const _safe = (name, fn) => {
        try { fn(); }
        catch (err) {
            console.error('[initDashboard] ' + name + ' failed:', err);
            toast('تعذّر تهيئة "' + name + '" — ' + (err?.message || err), 'error', 5000);
        }
    };

    // Tab + sidebar wiring is what powers the "quick action" buttons
    // (data-jump) — must come first so a later failure doesn't block them.
    _safe('tabs', initTabs);
    _safe('sidebar', initSidebar);
    _safe('realtime-listeners', initRealtimeListeners);

    // Activity log is a side effect — logActivity already swallows errors,
    // but if the user isn't an admin (no UID in admin_roles) the write will
    // fail with permission-denied. We surface a friendly hint, then move on.
    logActivity('settings', 'Admin logged in').then(ok => {
        if (!ok) {
            console.warn('[initDashboard] activity log skipped (likely no admin role for current UID)');
        }
    });
}

// --- REAL-TIME LISTENERS ---
function initRealtimeListeners() {
    // Team real-time
    state.unsubTeam = onSnapshot(
        query(collection(db, 'team'), orderBy('order', 'asc')),
        (snap) => {
            state.team = [];
            snap.forEach(d => state.team.push({ id: d.id, ...d.data() }));
            renderMetrics();
            renderTeamList();
            updatePostAuthorSelect();
        },
        (err) => {
            console.error('[team listener] error:', err);
            if (err?.code === 'permission-denied') {
                toast('لا توجد صلاحيات لقراءة الفريق — تأكد من admin_roles', 'error', 6000);
            } else {
                toast('خطأ في تحميل الفريق: ' + (err?.message || err), 'error');
            }
        }
    );

    // Posts real-time
    state.unsubPosts = onSnapshot(
        query(collection(db, 'posts'), orderBy('order', 'asc')),
        (snap) => {
            state.posts = [];
            snap.forEach(d => state.posts.push({ id: d.id, ...d.data() }));
            renderPostsList();
            renderMetrics();
        },
        (err) => {
            console.error('[posts listener] error:', err);
            if (err?.code === 'permission-denied') {
                toast('لا توجد صلاحيات لقراءة المنشورات — تأكد من admin_roles', 'error', 6000);
            } else {
                toast('خطأ في تحميل المنشورات: ' + (err?.message || err), 'error');
            }
        }
    );

    // Activity log real-time (last 50)
    state.unsubActivity = onSnapshot(
        query(collection(db, 'activity'), orderBy('createdAt', 'desc'), limit(50)),
        (snap) => {
            state.activity = [];
            snap.forEach(d => state.activity.push({ id: d.id, ...d.data() }));
            renderActivityLog();
        },
        (err) => {
            console.error('[activity listener] error:', err);
            // Don't spam toasts for activity log — it's secondary.
            if (err?.code === 'permission-denied') {
                console.warn('Activity log listener: missing admin role for activity collection');
            }
        }
    );

    // Settings one-time
    loadSettings();
}

async function loadSettings() {
    try {
        const snap = await withRetry(() => getDoc(doc(db, 'settings', 'site')));
        if (snap.exists()) {
            state.settings = snap.data();
            document.getElementById('site-title').value = state.settings.title || '';
            document.getElementById('site-desc').value = state.settings.heroDescription || '';
            document.getElementById('site-master-url').value = state.settings.masterPresentationUrl || '';
            document.getElementById('site-preview-url').value = state.settings.reportPreviewUrl || '';
            document.getElementById('site-download-url').value = state.settings.reportUrl || '';
            renderMetrics();
        }
    } catch (err) {
        console.warn('[loadSettings] failed:', err?.code, err?.message);
        // Don't crash the dashboard on settings load failure — they can still
        // use the rest of the panel and the form will be empty until retry.
        if (err?.code === 'permission-denied') {
            toast('لا توجد صلاحيات لقراءة الإعدادات — تأكد من admin_roles', 'error', 6000);
        } else if (/offline/i.test(err?.message || '')) {
            toast('فشل تحميل الإعدادات — لا اتصال بـ Firestore', 'warning', 4000);
        }
    }
}

// --- TABS ---
function initTabs() {
    document.querySelectorAll('[data-tab]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            const tab = el.dataset.tab;
            if (!tab) return;
            state.currentTab = tab;

            document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tab));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

            const labels = {
                overview: ['نظرة عامة', 'إحصائيات الموقع'],
                team: ['الفريق', 'إدارة أعضاء الفريق'],
                posts: ['المنشورات', 'إدارة المشاريع والمنشورات'],
                settings: ['إعدادات', 'إعدادات الموقع'],
                activity: ['سجل النشاط', 'آخر العمليات في النظام']
            };
            const tEl = document.getElementById('topbarTitle');
            const sEl = document.getElementById('topbarSub');
            if (tEl) tEl.textContent = labels[tab]?.[0] || tab;
            if (sEl) sEl.textContent = labels[tab]?.[1] || '';
        });
    });

    document.querySelectorAll('[data-jump]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelector('.nav-item[data-tab="' + btn.dataset.jump + '"]')?.click();
        });
    });

    const refresh = document.getElementById('refreshBtn');
    if (refresh) {
        refresh.addEventListener('click', () => {
            toast('جاري التحديث...', 'info');
            // Real-time already handles this, but force refresh metrics
            renderMetrics();
        });
    }
}

function initSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const st = document.getElementById('sidebarToggle');
    if (!sidebar || !st) return;
    st.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        st.setAttribute('aria-expanded', String(sidebar.classList.contains('open')));
    });
}

// --- METRICS & CHARTS ---
function renderMetrics() {
    document.getElementById('metricTeam').textContent = state.team.length;

    let linksCount = 0;
    if (state.settings) {
        if (_safeURLOrNull(state.settings.masterPresentationUrl)) linksCount++;
        if (_safeURLOrNull(state.settings.reportPreviewUrl)) linksCount++;
        if (_safeURLOrNull(state.settings.reportUrl)) linksCount++;
    }
    document.getElementById('metricLinks').textContent = linksCount + '/3';
    document.getElementById('metricUpdated').textContent = state.settings?.updatedAt 
        ? new Date(state.settings.updatedAt).toLocaleDateString('en-GB') 
        : '—';

    // Role distribution chart
    const roleCount = {};
    state.team.forEach(m => { roleCount[m.role || 'Unassigned'] = (roleCount[m.role || 'Unassigned'] || 0) + 1; });
    const sorted = Object.entries(roleCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = sorted.length ? Math.max(...sorted.map(s => s[1])) : 1;

    const chart = document.getElementById('distChart');
    if (!chart) return;
    chart.innerHTML = '';

    if (!sorted.length) {
        chart.innerHTML = '<div class="empty-state"><i class="ph ph-chart-bar"></i><span>لا توجد بيانات</span></div>';
        return;
    }

    sorted.forEach(([role, count]) => {
        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML = `
            <div class="bar-label">${_escapeHTML(role)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
            <div class="bar-val">${count}</div>
        `;
        chart.appendChild(row);
    });

    requestAnimationFrame(() => {
        chart.querySelectorAll('.bar-fill').forEach((fill, i) => {
            setTimeout(() => { fill.style.width = ((sorted[i][1] / max) * 100) + '%'; }, 100);
        });
    });
}

// --- ACTIVITY LOG RENDER ---
function renderActivityLog() {
    const wrap = document.getElementById('activityList');
    if (!wrap) return;

    if (!state.activity.length) {
        wrap.innerHTML = '<div class="empty-state"><i class="ph ph-clock"></i><span>لا توجد أنشطة مسجلة</span></div>';
        return;
    }

    wrap.innerHTML = '';
    state.activity.forEach(act => {
        const item = document.createElement('div');
        item.className = 'activity-item';
        const time = act.timestamp ? new Date(act.timestamp).toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
        item.innerHTML = `
            <div class="activity-icon ${act.type || 'settings'}"><i class="ph ph-${act.type === 'add' ? 'plus' : act.type === 'delete' ? 'trash' : act.type === 'edit' ? 'pencil-simple' : 'gear'}"></i></div>
            <div class="activity-content">
                <div class="activity-title">${_escapeHTML(act.title)}</div>
                <div class="activity-time">${_escapeHTML(act.userEmail || '')} · ${time}</div>
            </div>
        `;
        wrap.appendChild(item);
    });
}

// --- TEAM LIST ---
function renderTeamList() {
    const wrap = document.getElementById('adminTeamList');
    if (!wrap) return;
    const q = state.search.trim().toLowerCase();
    const filtered = state.team.filter(m => {
        if (!q) return true;
        return (m.name + ' ' + (m.role || '') + ' ' + (m.skills || []).join(' ')).toLowerCase().includes(q);
    });

    wrap.innerHTML = '';

    if (!filtered.length) {
        wrap.innerHTML = `<div class="empty-state"><i class="ph ${state.team.length ? 'ph-magnifying-glass' : 'ph-users'}"></i><span>${state.team.length ? 'لا توجد نتائج' : 'لا يوجد أعضاء - أضف الأول'}</span></div>`;
        return;
    }

    // Bulk actions bar
    const bulkBar = document.createElement('div');
    bulkBar.className = 'bulk-bar' + (state.selectedTeam.size ? ' active' : '');
    bulkBar.id = 'teamBulkBar';
    bulkBar.innerHTML = `
        <span>${state.selectedTeam.size} محدد</span>
        <button class="btn btn-ghost" id="teamBulkDelete" style="color:var(--danger)"><i class="ph ph-trash"></i> حذف المحدد</button>
        <button class="btn btn-ghost" id="teamBulkClear"><i class="ph ph-x"></i> إلغاء</button>
    `;
    wrap.appendChild(bulkBar);

    filtered.forEach(m => {
        const row = document.createElement('div');
        row.className = 'team-row' + (state.selectedTeam.has(m.id) ? ' selected' : '');
        row.dataset.id = m.id;
        row.innerHTML = `
            <div class="checkbox-wrap"><input type="checkbox" ${state.selectedTeam.has(m.id) ? 'checked' : ''} data-select="${m.id}"></div>
            <div class="drag-handle"><i class="ph ph-dots-six-vertical"></i></div>
            <div class="team-avatar"><img src="${_safeURL(m.photoUrl, '')}" alt="" onerror="this.style.display='none';this.parentNode.textContent='${(m.name||'?').charAt(0)}'"></div>
            <div class="team-info">
                <div class="name">${_escapeHTML(m.name || '—')}</div>
                <div class="role">${_escapeHTML(m.role || '—')}</div>
            </div>
            <div class="team-actions">
                <button class="icon-btn" data-action="view" title="عرض"><i class="ph ph-eye"></i></button>
                <button class="icon-btn" data-action="edit" title="تعديل"><i class="ph ph-pencil-simple"></i></button>
                <button class="icon-btn delete" data-action="delete" title="حذف"><i class="ph ph-trash"></i></button>
            </div>
        `;
        wrap.appendChild(row);
    });

    // Event listeners
    wrap.querySelectorAll('.team-row').forEach(row => {
        const id = row.dataset.id;
        row.querySelector('[data-action="edit"]')?.addEventListener('click', () => openEditor(id));
        row.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteMember(id));
        row.querySelector('[data-action="view"]')?.addEventListener('click', () => {
            const m = state.team.find(x => x.id === id);
            if (m?.presentationUrl) window.open(_safeURL(m.presentationUrl), '_blank');
        });
        row.querySelector('input[type="checkbox"]')?.addEventListener('change', (e) => {
            if (e.target.checked) state.selectedTeam.add(id);
            else state.selectedTeam.delete(id);
            renderTeamList();
        });
    });

    document.getElementById('teamBulkDelete')?.addEventListener('click', bulkDeleteTeam);
    document.getElementById('teamBulkClear')?.addEventListener('click', () => {
        state.selectedTeam.clear();
        renderTeamList();
    });

    // Sortable (if available)
    if (window.Sortable) {
        try {
            window.Sortable.create(wrap, {
                handle: '.drag-handle',
                animation: 200,
                ghostClass: 'sortable-ghost',
                onEnd: persistTeamOrder,
                filter: '.bulk-bar, .checkbox-wrap, .team-actions'
            });
        } catch (_) {}
    }
}

async function persistTeamOrder() {
    const wrap = document.getElementById('adminTeamList');
    if (!wrap) return;
    const ids = Array.from(wrap.querySelectorAll('.team-row')).map(r => r.dataset.id).filter(Boolean);
    try {
        const batch = writeBatch(db);
        ids.forEach((id, i) => batch.update(doc(db, 'team', id), { order: i + 1 }));
        await batch.commit();
        toast('تم تحديث الترتيب', 'success');
        logActivity('edit', 'Reordered team members');
    } catch (err) {
        toast('فشل الترتيب: ' + err.message, 'error');
    }
}

async function bulkDeleteTeam() {
    if (!state.selectedTeam.size) return;
    const count = state.selectedTeam.size;
    if (!confirm(`هل أنت متأكد من حذف ${count} عضو؟`)) return;

    // Capture snapshots before delete for Undo.
    const snapshots = state.team.filter(m => state.selectedTeam.has(m.id)).map(m => ({ ...m }));

    try {
        const batch = writeBatch(db);
        state.selectedTeam.forEach(id => {
            batch.delete(doc(db, 'team', id));
        });
        await batch.commit();
        toast(`تم حذف ${count} عضو`, 'success', 6000, {
            label: 'تراجع',
            onClick: async () => {
                try {
                    const batch2 = writeBatch(db);
                    snapshots.forEach(m => {
                        const { id: _drop, ...data } = m;
                        batch2.set(doc(db, 'team', m.id), data);
                    });
                    await withRetry(() => batch2.commit());
                    toast(`تم استعادة ${snapshots.length} عضو`, 'success');
                    logActivity('add', `Restored ${snapshots.length} team members`);
                } catch (err) {
                    toast('فشل الاستعادة: ' + (err?.message || err), 'error', 6000);
                }
            }
        });
        logActivity('delete', `Bulk deleted ${count} team members`);
        state.selectedTeam.clear();
    } catch (err) {
        toast('فشل الحذف الجماعي: ' + (err?.message || err), 'error');
    }
}

const adminSearch = document.getElementById('adminSearch');
if (adminSearch) {
    adminSearch.addEventListener('input', _debounce((e) => {
        state.search = e.target.value;
        renderTeamList();
    }, 150));
}

// --- MEMBER EDITOR ---
const memberForm = document.getElementById('memberForm');
const editor = document.getElementById('memberEditor');
const editorTitle = document.getElementById('editorTitle');

function openEditor(id) {
    if (!memberForm || !editor) return;
    memberForm.reset();
    document.getElementById('member-id').value = '';
    const preview = document.getElementById('uploadPreview');
    if (preview) preview.innerHTML = '<i class="ph ph-image" style="font-size:1.5rem;color:var(--text-dim)"></i>';
    document.getElementById('member-order').value = state.team.length + 1;

    if (id) {
        const m = state.team.find(x => x.id === id);
        if (!m) return;
        editorTitle.textContent = 'تعديل العضو';
        document.getElementById('member-id').value = m.id;
        document.getElementById('member-name').value = m.name || '';
        document.getElementById('member-role').value = m.role || '';
        document.getElementById('member-photo-url').value = m.photoUrl || '';
        document.getElementById('member-pres').value = m.presentationUrl || '';
        document.getElementById('member-order').value = m.order != null ? m.order : 99;
        document.getElementById('member-bio').value = m.bio || '';
        document.getElementById('member-skills').value = (m.skills || []).join(', ');
        document.getElementById('member-contributions').value = m.contributions || '';
        if (m.photoUrl && preview) {
            preview.innerHTML = `<img src="${_safeURL(m.photoUrl)}" alt="" style="width:100%;height:100%;object-fit:cover">`;
        }
    } else {
        editorTitle.textContent = 'إضافة عضو جديد';
    }
    editor.style.display = 'flex';
    editor.setAttribute('aria-hidden', 'false');
}

function closeEditor() {
    if (!editor) return;
    editor.style.display = 'none';
    editor.setAttribute('aria-hidden', 'true');
    document.getElementById('member-photo-file').value = '';
}

if (editor) {
    document.querySelectorAll('[data-close-editor]').forEach(b => b.addEventListener('click', closeEditor));
    editor.addEventListener('click', (e) => { if (e.target === editor) closeEditor(); });
}

document.getElementById('addMemberBtn')?.addEventListener('click', () => openEditor());

// Photo upload preview (local only until save)
document.getElementById('member-photo-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('الملف ليس صورة', 'error'); e.target.value = ''; return; }
    if (file.size > 5 * 1024 * 1024) { toast('الملف كبير جداً (5MB max)', 'error'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
        const preview = document.getElementById('uploadPreview');
        if (preview) preview.innerHTML = `<img src="${ev.target.result}" alt="" style="width:100%;height:100%;object-fit:cover">`;
    };
    reader.readAsDataURL(file);
});

document.getElementById('member-photo-url')?.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    const preview = document.getElementById('uploadPreview');
    if (!preview) return;
    if (_safeURLOrNull(url)) {
        preview.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentNode.innerHTML='<i class=\'ph ph-image\' style=\'font-size:1.5rem;color:var(--text-dim)\'></i>'">`;
    }
});

document.getElementById('clearPhoto')?.addEventListener('click', () => {
    document.getElementById('member-photo-file').value = '';
    document.getElementById('member-photo-url').value = '';
    const preview = document.getElementById('uploadPreview');
    if (preview) preview.innerHTML = '<i class="ph ph-image" style="font-size:1.5rem;color:var(--text-dim)"></i>';
});

// Upload to Firebase Storage
async function uploadToStorage(file, path) {
    const storageRef = ref(storage, path);
    const snapshot = await uploadBytes(storageRef, file);
    return await getDownloadURL(snapshot.ref);
}

if (memberForm) {
    memberForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('member-id').value;
        const btn = memberForm.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i><span>جاري الحفظ...</span>'; }

        try {
            let photoUrl = document.getElementById('member-photo-url').value.trim();
            const presentationUrl = _safeURLOrNull(document.getElementById('member-pres').value.trim());

            if (document.getElementById('member-pres').value.trim() && !presentationUrl) {
                toast('رابط العرض يجب أن يبدأ بـ http(s)', 'error'); return;
            }
            if (photoUrl && !_safeURLOrNull(photoUrl)) {
                toast('رابط الصورة يجب أن يبدأ بـ http(s)', 'error'); return;
            }

            // Upload file if selected
            const fileInput = document.getElementById('member-photo-file');
            if (fileInput?.files?.[0]) {
                toast('جاري رفع الصورة...', 'info', 2000);
                const ext = fileInput.files[0].name.split('.').pop();
                const path = `team/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
                photoUrl = await uploadToStorage(fileInput.files[0], path);
            }

            const name = document.getElementById('member-name').value.trim();
            const role = document.getElementById('member-role').value.trim();
            if (name.length < 2 || role.length < 2) { toast('الاسم والدور مطلوبان', 'error'); return; }

            const order = parseInt(document.getElementById('member-order').value, 10);
            const skills = document.getElementById('member-skills').value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);

            const data = {
                name, role, photoUrl: photoUrl || '', presentationUrl: presentationUrl || '',
                order: Number.isFinite(order) ? order : 99,
                bio: document.getElementById('member-bio').value.trim().slice(0, 800),
                contributions: document.getElementById('member-contributions').value.trim().slice(0, 2000),
                skills: skills.map(s => s.slice(0, 60)),
                updatedAt: new Date().toISOString()
            };

            if (id) {
                await withRetry(() => updateDoc(doc(db, 'team', id), data));
                toast('تم التحديث بنجاح', 'success');
                logActivity('edit', `Updated member: ${name}`);
            } else {
                data.createdAt = new Date().toISOString();
                await withRetry(() => addDoc(collection(db, 'team'), data));
                toast('تمت الإضافة بنجاح', 'success');
                logActivity('add', `Added member: ${name}`);
            }
            closeEditor();
        } catch (err) {
            console.error(err);
            toast('خطأ: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ph ph-check"></i> حفظ العضو'; }
        }
    });
}

async function deleteMember(id) {
    const m = state.team.find(x => x.id === id);
    if (!m) return;
    if (!confirm('حذف "' + (m.name || 'هذا العضو') + '"؟')) return;

    // Snapshot for Undo (preserve the original id + all fields).
    const snapshot = { ...m };

    try {
        await withRetry(() => deleteDoc(doc(db, 'team', id)));
        if (m.photoUrl?.includes('firebasestorage')) {
            try { await deleteObject(ref(storage, m.photoUrl)); } catch (_) {}
        }
        // Show Undo toast — 6 seconds to act.
        toast('تم حذف "' + (m.name || 'العضو') + '"', 'success', 6000, {
            label: 'تراجع',
            onClick: async () => {
                try {
                    const { id: _drop, ...data } = snapshot;
                    await withRetry(() => setDoc(doc(db, 'team', snapshot.id), data));
                    toast('تم استعادة "' + (snapshot.name || 'العضو') + '"', 'success');
                    logActivity('add', `Restored member: ${snapshot.name}`);
                } catch (err) {
                    toast('فشل الاستعادة: ' + (err?.message || err), 'error', 6000);
                }
            }
        });
        logActivity('delete', `Deleted member: ${m.name}`);
    } catch (err) {
        toast('فشل الحذف: ' + (err?.message || err), 'error');
    }
}

// --- POSTS LIST ---
function renderPostsList() {
    const wrap = document.getElementById('adminPostsList');
    if (!wrap) return;
    wrap.innerHTML = '';

    // Apply posts search filter (title, description, author name)
    const q = (state.postsSearch || '').trim().toLowerCase();
    const filtered = state.posts.filter(p => {
        if (!q) return true;
        const haystack = (
            (p.title || '') + ' ' +
            (p.description || '') + ' ' +
            (p.authorType === 'member' ? (state.team.find(m => m.id === p.authorId)?.name || '') : 'الفريق')
        ).toLowerCase();
        return haystack.includes(q);
    });

    if (!state.posts.length) {
        wrap.innerHTML = '<div class="empty-state"><i class="ph ph-presentation-chart"></i><span>لا توجد منشورات</span></div>';
        return;
    }

    if (!filtered.length) {
        wrap.innerHTML = '<div class="empty-state"><i class="ph ph-magnifying-glass"></i><span>لا توجد نتائج لـ "' + _escapeHTML(q) + '"</span></div>';
        return;
    }

    // Bulk bar
    const bulkBar = document.createElement('div');
    bulkBar.className = 'bulk-bar' + (state.selectedPosts.size ? ' active' : '');
    bulkBar.id = 'postsBulkBar';
    bulkBar.innerHTML = `
        <span>${state.selectedPosts.size} محدد</span>
        <button class="btn btn-ghost" id="postsBulkDelete" style="color:var(--danger)"><i class="ph ph-trash"></i> حذف المحدد</button>
        <button class="btn btn-ghost" id="postsBulkClear"><i class="ph ph-x"></i> إلغاء</button>
    `;
    wrap.appendChild(bulkBar);

    filtered.forEach(post => {
        const row = document.createElement('div');
        row.className = 'post-row' + (state.selectedPosts.has(post.id) ? ' selected' : '');
        row.dataset.id = post.id;

        let authorStr = 'الفريق';
        if (post.authorType === 'member') {
            const m = state.team.find(x => x.id === post.authorId);
            authorStr = m ? m.name : 'عضو محذوف';
        }

        row.innerHTML = `
            <div class="checkbox-wrap"><input type="checkbox" ${state.selectedPosts.has(post.id) ? 'checked' : ''} data-select-post="${post.id}"></div>
            <div class="drag-handle"><i class="ph ph-dots-six-vertical"></i></div>
            <div class="post-thumb">${post.photoUrl ? `<img src="${_safeURL(post.photoUrl)}" alt="">` : '<i class="ph ph-image"></i>'}</div>
            <div class="post-info">
                <div class="title">${_escapeHTML(post.title || 'بدون عنوان')}</div>
                <div class="meta">بواسطة: ${authorStr} — الترتيب: ${post.order}</div>
            </div>
            <div class="post-actions">
                <button class="icon-btn" data-action="edit" title="تعديل"><i class="ph ph-pencil-simple"></i></button>
                <button class="icon-btn delete" data-action="delete" title="حذف"><i class="ph ph-trash"></i></button>
            </div>
        `;
        wrap.appendChild(row);
    });

    wrap.querySelectorAll('.post-row').forEach(row => {
        const id = row.dataset.id;
        row.querySelector('[data-action="edit"]')?.addEventListener('click', () => openPostEditor(id));
        row.querySelector('[data-action="delete"]')?.addEventListener('click', () => deletePost(id));
        row.querySelector('input[type="checkbox"]')?.addEventListener('change', (e) => {
            if (e.target.checked) state.selectedPosts.add(id);
            else state.selectedPosts.delete(id);
            renderPostsList();
        });
    });

    document.getElementById('postsBulkDelete')?.addEventListener('click', bulkDeletePosts);
    document.getElementById('postsBulkClear')?.addEventListener('click', () => {
        state.selectedPosts.clear();
        renderPostsList();
    });

    if (window.Sortable) {
        try {
            window.Sortable.create(wrap, {
                handle: '.drag-handle',
                animation: 200,
                filter: '.bulk-bar, .checkbox-wrap, .post-actions',
                onEnd: persistPostOrder
            });
        } catch (_) {}
    }
}

async function persistPostOrder() {
    const wrap = document.getElementById('adminPostsList');
    if (!wrap) return;
    const ids = Array.from(wrap.querySelectorAll('.post-row')).map(r => r.dataset.id).filter(Boolean);
    try {
        const batch = writeBatch(db);
        ids.forEach((id, i) => batch.update(doc(db, 'posts', id), { order: i }));
        await batch.commit();
        toast('تم تحديث ترتيب المنشورات', 'success');
        logActivity('edit', 'Reordered posts');
    } catch (err) {
        toast('فشل الترتيب', 'error');
    }
}

async function bulkDeletePosts() {
    if (!state.selectedPosts.size) return;
    const count = state.selectedPosts.size;
    if (!confirm(`حذف ${count} منشور؟`)) return;

    // Capture snapshots before delete for Undo.
    const snapshots = state.posts.filter(p => state.selectedPosts.has(p.id)).map(p => ({ ...p }));

    try {
        const batch = writeBatch(db);
        state.selectedPosts.forEach(id => batch.delete(doc(db, 'posts', id)));
        await batch.commit();
        toast(`تم حذف ${count} منشور`, 'success', 6000, {
            label: 'تراجع',
            onClick: async () => {
                try {
                    const batch2 = writeBatch(db);
                    snapshots.forEach(p => {
                        const { id: _drop, ...data } = p;
                        batch2.set(doc(db, 'posts', p.id), data);
                    });
                    await withRetry(() => batch2.commit());
                    toast(`تم استعادة ${snapshots.length} منشور`, 'success');
                    logActivity('add', `Restored ${snapshots.length} posts`);
                } catch (err) {
                    toast('فشل الاستعادة: ' + (err?.message || err), 'error', 6000);
                }
            }
        });
        logActivity('delete', `Bulk deleted ${count} posts`);
        state.selectedPosts.clear();
    } catch (err) {
        toast('فشل الحذف الجماعي: ' + (err?.message || err), 'error');
    }
}

document.getElementById('addPostBtn')?.addEventListener('click', () => openPostEditor());

// Posts search input (debounced to avoid re-rendering on every keystroke)
const postsSearch = document.getElementById('adminPostsSearch');
if (postsSearch) {
    postsSearch.addEventListener('input', _debounce((e) => {
        state.postsSearch = e.target.value;
        renderPostsList();
    }, 150));
}

// --- POST EDITOR ---
function openPostEditor(id = null) {
    const modal = document.getElementById('postEditor');
    const form = document.getElementById('postForm');
    if (!modal || !form) return;

    form.reset();
    document.getElementById('post-id').value = '';
    const preview = document.getElementById('postUploadPreview');
    if (preview) preview.innerHTML = '<i class="ph ph-image" style="font-size:2rem;color:var(--text-dim)"></i>';

    updatePostAuthorSelect();

    if (id) {
        const p = state.posts.find(x => x.id === id);
        if (p) {
            document.getElementById('postEditorTitle').textContent = 'تعديل المنشور';
            document.getElementById('post-id').value = p.id;
            document.getElementById('post-title').value = p.title || '';
            document.getElementById('post-desc').value = p.description || '';
            document.getElementById('post-link').value = p.externalLink || '';
            document.getElementById('post-photo-url').value = p.photoUrl || '';
            if (p.photoUrl && preview) preview.innerHTML = `<img src="${_safeURL(p.photoUrl)}" alt="" style="width:100%;height:100%;object-fit:cover">`;
            document.getElementById('post-order').value = p.order !== undefined ? p.order : 0;
            document.getElementById('post-author-type').value = p.authorType || 'team';
            document.getElementById('post-author-type').dispatchEvent(new Event('change'));
            if (p.authorType === 'member' && p.authorId) {
                setTimeout(() => { document.getElementById('post-author-id').value = p.authorId; }, 50);
            }
        }
    } else {
        document.getElementById('postEditorTitle').textContent = 'إضافة منشور جديد';
        document.getElementById('post-author-type').value = 'team';
        document.getElementById('post-author-type').dispatchEvent(new Event('change'));
    }

    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function updatePostAuthorSelect() {
    const select = document.getElementById('post-author-id');
    if (!select) return;
    select.innerHTML = '';
    state.team.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        select.appendChild(opt);
    });
}

function closePostEditor() {
    const modal = document.getElementById('postEditor');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
    document.body.style.overflow = '';
}

document.getElementById('closePostEditor')?.addEventListener('click', closePostEditor);
document.getElementById('cancelPostEditor')?.addEventListener('click', closePostEditor);

document.getElementById('post-author-type')?.addEventListener('change', (e) => {
    document.getElementById('post-member-select-group').style.display = e.target.value === 'member' ? 'block' : 'none';
});

// Post photo upload via Firebase Storage
document.getElementById('post-photo-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('الصورة كبيرة جداً (2MB max)', 'error'); e.target.value = ''; return; }

    const status = document.getElementById('post-editor-status');
    if (status) status.textContent = 'جاري الرفع...';

    try {
        const ext = file.name.split('.').pop();
        const path = `posts/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const url = await uploadToStorage(file, path);
        document.getElementById('post-photo-url').value = url;
        const preview = document.getElementById('postUploadPreview');
        if (preview) preview.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover">`;
        if (status) { status.textContent = 'تم الرفع!'; setTimeout(() => status.textContent = '', 2000); }
    } catch (err) {
        console.error(err);
        if (status) status.textContent = 'فشل الرفع';
        toast('فشل رفع الصورة', 'error');
    } finally {
        e.target.value = '';
    }
});

document.getElementById('postForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const title = document.getElementById('post-title').value.trim();
    if (title.length < 2) { toast('العنوان قصير جداً', 'error'); return; }

    const payload = {
        title,
        description: document.getElementById('post-desc').value.trim(),
        externalLink: _safeURLOrNull(document.getElementById('post-link').value.trim()) || '',
        photoUrl: _safeURLOrNull(document.getElementById('post-photo-url').value.trim()) || '',
        authorType: document.getElementById('post-author-type').value,
        authorId: document.getElementById('post-author-type').value === 'member' ? document.getElementById('post-author-id').value : '',
        order: parseInt(document.getElementById('post-order').value, 10) || 0,
        updatedAt: new Date().toISOString()
    };

    // Save original button label so we can restore it on error.
    const originalLabel = btn ? btn.innerHTML : '';
    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i><span>جاري النشر...</span>';
        }
        const id = document.getElementById('post-id').value;
        if (id) {
            await withRetry(() => updateDoc(doc(db, 'posts', id), payload));
            toast('تم التعديل', 'success');
            logActivity('edit', `Updated post: ${title}`);
        } else {
            payload.createdAt = new Date().toISOString();
            await withRetry(() => addDoc(collection(db, 'posts'), payload));
            toast('تمت الإضافة', 'success');
            logActivity('add', `Created post: ${title}`);
        }
        closePostEditor();
    } catch (err) {
        console.error('[postForm submit] error:', err);
        // Translate common Firestore errors to friendlier Arabic messages.
        let msg = err?.message || 'فشل الحفظ';
        if (err?.code === 'permission-denied') {
            msg = 'صلاحيات مرفوضة — تأكد إن الـ UID موجود في admin_roles';
        } else if (/offline/i.test(msg)) {
            msg = 'لا يوجد اتصال بـ Firestore — تأكد من الإنترنت';
        }
        toast('خطأ: ' + msg, 'error', 6000);
    } finally {
        // ALWAYS re-enable the button — even on unexpected errors — so it
        // never stays "frozen".
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalLabel || '<i class="ph ph-check"></i> حفظ المنشور';
        }
    }
});

async function deletePost(id) {
    const p = state.posts.find(x => x.id === id);
    if (!p) return;
    if (!confirm('حذف المنشور "' + (p.title || '') + '"؟')) return;

    // Snapshot for Undo
    const snapshot = { ...p };

    try {
        await withRetry(() => deleteDoc(doc(db, 'posts', id)));
        toast('تم حذف "' + (p.title || 'المنشور') + '"', 'success', 6000, {
            label: 'تراجع',
            onClick: async () => {
                try {
                    const { id: _drop, ...data } = snapshot;
                    await withRetry(() => setDoc(doc(db, 'posts', snapshot.id), data));
                    toast('تم استعادة "' + (snapshot.title || 'المنشور') + '"', 'success');
                    logActivity('add', `Restored post: ${snapshot.title}`);
                } catch (err) {
                    toast('فشل الاستعادة: ' + (err?.message || err), 'error', 6000);
                }
            }
        });
        logActivity('delete', `Deleted post: ${p.title}`);
    } catch (err) {
        toast('فشل الحذف: ' + (err?.message || err), 'error');
    }
}

// --- SETTINGS ---
const settingsForm = document.getElementById('settings-form');
if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = settingsForm.querySelector('button[type="submit"]');
        const data = {
            title: document.getElementById('site-title').value.trim().slice(0, 100),
            heroDescription: document.getElementById('site-desc').value.trim().slice(0, 2000),
            masterPresentationUrl: _safeURLOrNull(document.getElementById('site-master-url').value.trim()) || '',
            reportPreviewUrl: _safeURLOrNull(document.getElementById('site-preview-url').value.trim()) || '',
            reportUrl: _safeURLOrNull(document.getElementById('site-download-url').value.trim()) || '',
            updatedAt: new Date().toISOString()
        };
        if (data.title.length < 1) { toast('العنوان مطلوب', 'error'); return; }
        const originalLabel = btn ? btn.innerHTML : '';
        try {
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i><span>جاري الحفظ...</span>';
            }
            await withRetry(() => setDoc(doc(db, 'settings', 'site'), data));
            state.settings = data;
            toast('تم الحفظ', 'success');
            logActivity('settings', 'Updated site configuration');
            renderMetrics();
        } catch (err) {
            console.error('[settings submit] error:', err);
            let msg = err?.message || 'فشل الحفظ';
            if (err?.code === 'permission-denied') {
                msg = 'صلاحيات مرفوضة — تأكد إن الـ UID موجود في admin_roles';
            } else if (/offline/i.test(msg)) {
                msg = 'لا يوجد اتصال بـ Firestore — تأكد من الإنترنت';
            }
            toast('فشل الحفظ: ' + msg, 'error', 6000);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalLabel || '<i class="ph ph-floppy-disk"></i><span>حفظ الإعدادات</span>';
            }
        }
    });
}

document.getElementById('resetSettings')?.addEventListener('click', () => {
    loadSettings();
    toast('تم إعادة التعيين', 'info');
});

// --- BACKUP / RESTORE ---
function initBackupRestore() {
    // Export
    document.getElementById('qaExport')?.addEventListener('click', () => {
        const data = {
            settings: state.settings,
            team: state.team,
            posts: state.posts,
            exportedAt: new Date().toISOString(),
            version: '2.0'
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'nti-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(url);
        toast('تم التصدير', 'success');
        logActivity('settings', 'Exported data backup');
    });

    // Import
    const importInput = document.getElementById('importFile');
    if (importInput) {
        importInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!confirm('استيراد البيانات سيستبدل البيانات الحالية. متأكد؟')) return;

                const batch = writeBatch(db);
                // Import team
                if (data.team && Array.isArray(data.team)) {
                    data.team.forEach(m => {
                        const { id, ...rest } = m;
                        if (id) batch.set(doc(db, 'team', id), rest);
                        else batch.set(doc(collection(db, 'team')), rest);
                    });
                }
                // Import posts
                if (data.posts && Array.isArray(data.posts)) {
                    data.posts.forEach(p => {
                        const { id, ...rest } = p;
                        if (id) batch.set(doc(db, 'posts', id), rest);
                        else batch.set(doc(collection(db, 'posts')), rest);
                    });
                }
                // Import settings
                if (data.settings) {
                    batch.set(doc(db, 'settings', 'site'), data.settings);
                }
                await batch.commit();
                toast('تم الاستيراد بنجاح', 'success');
                logActivity('settings', 'Imported data backup');
            } catch (err) {
                toast('فشل الاستيراد: ' + err.message, 'error');
            } finally {
                importInput.value = '';
            }
        });
    }
}

// ============================================================
//   KEYBOARD SHORTCUTS
// ============================================================
//
// Shortcuts:
//   Ctrl/Cmd + N        → New post
//   Ctrl/Cmd + M        → New member
//   Ctrl/Cmd + S        → Save current form (settings / member / post)
//   Esc                 → Close topmost modal
//   /                   → Focus the search input in the active tab
//   ?                   → Show shortcuts help modal
//   1 / 2 / 3 / 4 / 5   → Switch to overview / team / posts / activity / settings
//
// All shortcuts are disabled when the user is typing in an input/textarea
// (except Esc and Ctrl+S, which are explicitly user-driven).
const _isTypingTarget = (el) => {
    if (!el) return false;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
};

const _switchTab = (tab) => {
    const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (navItem) navItem.click();
};

const _focusSearchInActiveTab = () => {
    const active = document.querySelector('.tab-content.active');
    if (!active) return;
    const search = active.querySelector('.search-input input');
    if (search) {
        search.focus();
        search.select?.();
    }
};

const _closeTopmostModal = () => {
    const modals = Array.from(document.querySelectorAll('.modal-backdrop'))
        .filter(m => m.style.display !== 'none' && m.style.display !== '')
        .filter(m => m.getAttribute('aria-hidden') !== 'true');
    if (!modals.length) return;
    const top = modals[modals.length - 1];
    if (top.id === 'postEditor') closePostEditor();
    else if (top.id === 'memberEditor') closeEditor();
    else if (top.classList.contains('shortcuts-modal')) closeShortcutsModal();
};

function showShortcutsModal() {
    if (document.getElementById('shortcutsModal')) return; // already open
    const wrap = document.createElement('div');
    wrap.id = 'shortcutsModal';
    wrap.className = 'modal-backdrop shortcuts-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = `
        <div class="modal-card">
            <div class="modal-header">
                <h2><i class="ph ph-keyboard" style="color:var(--primary);margin-inline-end:0.5rem"></i> اختصارات لوحة المفاتيح</h2>
                <button class="modal-close" type="button" id="closeShortcuts" aria-label="إغلاق">
                    <i class="ph ph-x"></i>
                </button>
            </div>
            <div class="modal-body">
                <div class="shortcuts-list">
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-plus-circle"></i> إضافة منشور جديد</div>
                        <div class="shortcut-keys"><span class="kbd">Ctrl</span><span class="plus">+</span><span class="kbd">N</span></div>
                    </div>
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-user-plus"></i> إضافة عضو جديد</div>
                        <div class="shortcut-keys"><span class="kbd">Ctrl</span><span class="plus">+</span><span class="kbd">M</span></div>
                    </div>
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-floppy-disk"></i> حفظ النموذج الحالي</div>
                        <div class="shortcut-keys"><span class="kbd">Ctrl</span><span class="plus">+</span><span class="kbd">S</span></div>
                    </div>
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-magnifying-glass"></i> التركيز على البحث</div>
                        <div class="shortcut-keys"><span class="kbd">/</span></div>
                    </div>
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-x-circle"></i> إغلاق المودال</div>
                        <div class="shortcut-keys"><span class="kbd">Esc</span></div>
                    </div>
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-squares-four"></i> نظرة عامة</div>
                        <div class="shortcut-keys"><span class="kbd">1</span></div>
                    </div>
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-users-three"></i> الفريق</div>
                        <div class="shortcut-keys"><span class="kbd">2</span></div>
                    </div>
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-article"></i> المنشورات</div>
                        <div class="shortcut-keys"><span class="kbd">3</span></div>
                    </div>
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-clock-counter-clockwise"></i> سجل النشاط</div>
                        <div class="shortcut-keys"><span class="kbd">4</span></div>
                    </div>
                    <div class="shortcut-row">
                        <div class="shortcut-desc"><i class="ph ph-faders"></i> الإعدادات</div>
                        <div class="shortcut-keys"><span class="kbd">5</span></div>
                    </div>
                </div>
                <p style="text-align:center;color:var(--text-dim);font-size:0.85rem;margin-top:1.5rem">
                    اضغط <span class="kbd">?</span> في أي وقت لعرض هذه القائمة
                </p>
            </div>
        </div>
    `;
    document.body.appendChild(wrap);
    wrap.style.display = 'flex';
    requestAnimationFrame(() => {
        wrap.classList.add('active');
        wrap.setAttribute('aria-hidden', 'false');
    });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeShortcutsModal(); });
    document.getElementById('closeShortcuts').addEventListener('click', closeShortcutsModal);
}

function closeShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    setTimeout(() => modal.remove(), 300);
}

document.addEventListener('keydown', (e) => {
    const typing = _isTypingTarget(e.target);
    const ctrl = e.ctrlKey || e.metaKey;

    // Always-on shortcuts (even when typing)
    if (e.key === 'Escape') {
        _closeTopmostModal();
        // If focus is in an input, blur it on Esc
        if (typing && e.target.blur) e.target.blur();
        return;
    }

    if (ctrl && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        // Find the form inside the visible modal OR the active tab.
        const modal = document.querySelector('.modal-backdrop.active form, .modal-backdrop[style*="display: flex"] form');
        const tabForm = document.querySelector('.tab-content.active form');
        const form = modal || tabForm;
        if (form) {
            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            toast('جاري الحفظ...', 'info', 1500);
        } else {
            toast('لا يوجد نموذج للحفظ في الصفحة الحالية', 'warning', 2500);
        }
        return;
    }

    // From here on: ignore all shortcuts when typing in an input
    if (typing) return;

    if (ctrl && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        if (typeof openPostEditor === 'function') openPostEditor();
        return;
    }

    if (ctrl && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        if (typeof openEditor === 'function') openEditor();
        return;
    }

    if (!ctrl) {
        if (e.key === '/') {
            e.preventDefault();
            _focusSearchInActiveTab();
            return;
        }
        if (e.key === '?' || (e.shiftKey && e.key === '/')) {
            e.preventDefault();
            if (document.getElementById('shortcutsModal')) closeShortcutsModal();
            else showShortcutsModal();
            return;
        }
        // Tab switcher: 1-5
        if (['1', '2', '3', '4', '5'].includes(e.key)) {
            const tabs = ['overview', 'team', 'posts', 'activity', 'settings'];
            _switchTab(tabs[parseInt(e.key, 10) - 1]);
            return;
        }
    }
});

// Wire the keyboard icon in the topbar
document.getElementById('shortcutsBtn')?.addEventListener('click', showShortcutsModal);

// ============================================================
//   FORCE UPDATE — nuke the service worker + cache and reload.
//
// Why: even with ?v=3 in the SW URL, some browsers (especially when the
// page is opened in DevTools "Disable cache" OFF, or behind a corporate
// proxy) serve the OLD sw.js from the HTTP cache. The OLD sw.js then
// installs CACHE_NAME v2 and serves the OLD admin.js. This button is the
// last-resort way for the admin to clear the slate without opening
// DevTools. One click does:
//   1. Unregister the service worker
//   2. Delete every cache
//   3. Hard-reload the page
// ============================================================
async function forceUpdate() {
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
        }
        if ('caches' in window) {
            const names = await caches.keys();
            await Promise.all(names.map((n) => caches.delete(n)));
        }
        toast('تم تفريغ الكاش — جاري إعادة التحميل...', 'success', 2000);
    } catch (err) {
        console.error('[forceUpdate] error:', err);
        toast('فشل التحديث: ' + (err?.message || err), 'error');
    } finally {
        // Cache: 'reload' + a fresh URL forces a full network fetch.
        setTimeout(() => {
            const url = new URL(window.location.href);
            url.searchParams.set('_t', Date.now().toString());
            window.location.replace(url.toString());
        }, 600);
    }
}
document.getElementById('forceUpdateBtn')?.addEventListener('click', forceUpdate);
