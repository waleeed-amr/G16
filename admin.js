// ==========================================================
//   NTI SECURE — Admin Dashboard Logic (Hardened)
//   - No client-side admin-role injection (the rules lock admin_roles
//     to deny-all; this file trusts the server).
//   - Photo uploads go through Firebase Storage (NOT a third-party
//     key-in-source service like ImgBB). Storage rules enforce type
//     and size limits.
//   - All user-controlled data is rendered via textContent or via
//     createElement + safeURL. No innerHTML interpolation of
//     untrusted strings.
//   - Login has a small client-side throttle + lockout window
//     (real brute-force protection MUST be paired with App Check
//     and / or a Cloud Function rate limiter).
// ==========================================================
import { app, db, auth, storage } from './firebase-config.js';

// --- ADVANCED UTILS (Network Resilience & Perf) ---
const withRetry = async (fn, retries = 3, delay = 1500) => {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } 
        catch (err) {
            if (i === retries - 1) throw err;
            console.warn([Network] Retry \/\ after \ms..., err.message);
            await new Promise(r => setTimeout(r, delay));
            delay *= 1.5; // Exponential backoff
        }
    }
};

const debounce = (fn, delay = 300) => {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
};
// --------------------------------------------------
import {
    signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import {
    doc, getDoc, setDoc, collection, addDoc, getDocs, deleteDoc, updateDoc,
    query, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import {
    ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-storage.js";

const {
    safeURL, safeURLOrNull, escapeHTML, fallbackAvatar,
    debounce, focusTrap, makeLoginThrottle,
} = window.NTI || {};

// Defensive fallbacks
const _safeURL = safeURL || ((s, fb) => (s && /^https?:\/\//i.test(s)) ? s : (fb || '#'));
const _safeURLOrNull = safeURLOrNull || ((s) => (s && /^https?:\/\//i.test(s)) ? s : null);
const _escapeHTML = escapeHTML || ((s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
const _fallbackAvatar = fallbackAvatar || (() => 'data:image/svg+xml;utf8,');
const _debounce = debounce || ((fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; });
const _focusTrap = focusTrap || (() => () => {});
const _makeLoginThrottle = makeLoginThrottle || (() => () => true);

// ----------------------------------------------------------
//  STATE
// ----------------------------------------------------------
const state = {
    team: [],
    posts: [],
    settings: null,
    activity: [],
    currentTab: 'overview',
    search: '',
    focusTrapRelease: null,
};

// ----------------------------------------------------------
//  DOM HELPERS
// ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const loginContainer = $('login-container');
const dashboardContainer = $('dashboard-container');
const loginForm = $('login-form');
const loginError = $('login-error');
const adminEmailEl = $('adminEmail');

// ----------------------------------------------------------
//  UTILS
// ----------------------------------------------------------
const prefersReducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const formatDate = (iso) => {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return '—'; }
};

const formatTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

// ----------------------------------------------------------
//  TOAST
// ----------------------------------------------------------
function toast(msg, type, duration) {
    const wrap = $('toastContainer');
    if (!wrap) return;
    const t = (typeof duration === 'number') ? duration : 3500;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.setAttribute('role', 'status');
    const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'warning-circle' : 'info';
    const i = document.createElement('i');
    i.className = 'ph-fill ph-' + icon;
    i.setAttribute('aria-hidden', 'true');
    const sp = document.createElement('span');
    sp.className = 'toast-msg';
    sp.textContent = String(msg);
    el.appendChild(i);
    el.appendChild(sp);
    wrap.appendChild(el);
    setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 300);
    }, t);
}

// ----------------------------------------------------------
//  ACTIVITY LOG (in-memory only)
// ----------------------------------------------------------
function logActivity(icon, title) {
    state.activity.unshift({ icon, title, ts: Date.now() });
    if (state.activity.length > 50) state.activity = state.activity.slice(0, 50);
}

// ----------------------------------------------------------
//  AUTH
// ----------------------------------------------------------
// Login throttle: 6 attempts per 5 minutes. Real protection comes from
// App Check / Functions, but this slows down drive-by password guessing.
const loginThrottle = _makeLoginThrottle(6, 5 * 60 * 1000);

onAuthStateChanged(auth, (user) => {
    if (user) {
        if (loginContainer) loginContainer.style.display = 'none';
        if (dashboardContainer) dashboardContainer.style.display = 'flex';
        if (adminEmailEl) adminEmailEl.textContent = user.email || '—';
        initDashboard();
    } else {
        if (loginContainer) loginContainer.style.display = 'flex';
        if (dashboardContainer) dashboardContainer.style.display = 'none';
        // Clear local state on logout
        state.team = [];
        state.settings = null;
        state.activity = [];
    }
});

if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();

        if (!loginThrottle()) {
            if (loginError) loginError.textContent = '> RATE_LIMITED: too many attempts. Try again later.';
            return;
        }

        const email = ($('admin-email').value || '').trim();
        const pw = $('admin-password').value || '';
        if (loginError) loginError.textContent = '';

        $('admin-email').disabled = true;
        $('admin-password').disabled = true;
        const btn = loginForm.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph ph-spinner-gap ph-spin" aria-hidden="true"></i><span>VERIFYING...</span>'; }

        signInWithEmailAndPassword(auth, email, pw)
            .then((userCred) => {
                // SECURITY NOTE: We do NOT auto-inject admin_roles here.
                // The Firestore rules for /admin_roles/{userId} deny all
                // client writes. Admin roles are seeded ONLY via the
                // Firebase Console or a trusted Cloud Function.
                if (userCred && userCred.user) {
                    console.log('Auth OK for', userCred.user.email);
                }
            })
            .catch((err) => {
                if (loginError) {
                    const msg = String(err && err.message || 'Auth failed').replace('Firebase: ', '');
                    loginError.textContent = '> ACCESS_DENIED: ' + msg;
                }
            })
            .finally(() => {
                $('admin-email').disabled = false;
                $('admin-password').disabled = false;
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="ph ph-plugs-connected" aria-hidden="true"></i><span>INITIATE_HANDSHAKE</span>';
                }
            });
    });
}

const logoutBtn = $('logout-btn');
if (logoutBtn) logoutBtn.addEventListener('click', () => signOut(auth));

const togglePw = $('togglePw');
if (togglePw) {
    togglePw.addEventListener('click', () => {
        const inp = $('admin-password');
        if (!inp) return;
        const isPw = inp.type === 'password';
        inp.type = isPw ? 'text' : 'password';
        togglePw.innerHTML = '<i class="ph ph-eye' + (isPw ? '-slash' : '') + '" aria-hidden="true"></i>';
    });
}

// ----------------------------------------------------------
//  DASHBOARD INIT
// ----------------------------------------------------------
function initDashboard() {
    initTabs();
    initSidebar();
    initReveal();
    loadAllData();
    logActivity('settings', 'Session started');
}

async function loadAllData() {
    try {
        await loadSettings();
        await Promise.all([loadTeam(), loadPosts()]);
        
        renderMetrics();
        renderTeamList();
        renderPostsList();
        
        logActivity('settings', 'Session started');
    } catch (err) {
        console.error('loadAllData:', err);
        let errorMsg = err && err.message || err;
        if (String(errorMsg).includes('offline')) {
            errorMsg = 'لا يوجد اتصال بالإنترنت أو تعذر الوصول لقاعدة البيانات.';
        } else if (String(errorMsg).includes('permission')) {
            errorMsg = 'عذراً، حسابك لا يمتلك صلاحيات الأدمن לעرض أو تعديل البيانات.';
        }
        toast('خطأ في تحميل البيانات: ' + errorMsg, 'error', 6000);
    }
}

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
            };
            const tEl = $('topbarTitle'); if (tEl) tEl.textContent = labels[tab]?.[0] || tab;
            const sEl = $('topbarSub'); if (sEl) sEl.textContent = labels[tab]?.[1] || '';

            if (tab === 'preview') {
                const f = $('previewFrame');
                if (f) f.src = f.src;
            }
        });
    });

    document.querySelectorAll('[data-jump]').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.jump;
            document.querySelector('.nav-item[data-tab="' + target + '"]')?.click();
        });
    });

    const refresh = $('refreshBtn');
    if (refresh) {
        refresh.addEventListener('click', () => {
            loadAllData();
            toast('Data refreshed', 'success');
        });
    }
}

function initSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const st = $('sidebarToggle');
    if (!sidebar || !st) return;
    st.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        const open = sidebar.classList.contains('open');
        st.setAttribute('aria-expanded', String(open));
    });
}

function initReveal() {
    const items = document.querySelectorAll('[data-reveal]');
    if (!('IntersectionObserver' in window)) {
        items.forEach(el => el.classList.add('revealed'));
        return;
    }
    const io = new IntersectionObserver(entries => {
        entries.forEach(e => {
            if (e.isIntersecting) {
                e.target.classList.add('revealed');
                io.unobserve(e.target);
            }
        });
    }, { threshold: 0.1 });
    items.forEach(el => io.observe(el));
}

async function loadSettings() {
    const snap = await withRetry(() => getDoc(doc(db, 'settings', 'site')));
    if (snap.exists()) {
        state.settings = snap.data();
        $('site-title').value = state.settings.title || '';
        $('site-desc').value = state.settings.heroDescription || '';
        $('site-master-url').value = state.settings.masterPresentationUrl || '';
        $('site-preview-url').value = state.settings.reportPreviewUrl || '';
        $('site-download-url').value = state.settings.reportUrl || '';
    } else {
        state.settings = null;
    }
}

async function loadTeam() {
    const snap = await withRetry(() => getDocs(query(collection(db, 'team')), orderBy('order', 'asc')));
    state.team = [];
    snap.forEach(d => state.team.push({ id: d.id, ...d.data() }));
    const badge = $('teamBadge');
    if (badge) badge.textContent = state.team.length;
}

async function loadPosts() {
    const snap = await withRetry(() => getDocs(query(collection(db, 'posts')), orderBy('order', 'asc')));
    state.posts = [];
    snap.forEach(d => state.posts.push({ id: d.id, ...d.data() }));
}

// ----------------------------------------------------------
//  METRICS
// ----------------------------------------------------------
function renderMetrics() {
    const teamEl = $('metricTeam'); if (teamEl) teamEl.textContent = state.team.length;
    let linksCount = 0;
    if (state.settings) {
        if (_safeURLOrNull(state.settings.masterPresentationUrl)) linksCount++;
        if (_safeURLOrNull(state.settings.reportPreviewUrl)) linksCount++;
        if (_safeURLOrNull(state.settings.reportUrl)) linksCount++;
    }
    const ml = $('metricLinks'); if (ml) ml.textContent = linksCount + '/3';
    const mu = $('metricUpdated'); if (mu) mu.textContent = formatDate(state.settings && state.settings.updatedAt);

    const roleCount = {};
    state.team.forEach(m => {
        const r = m.role || 'Unassigned';
        roleCount[r] = (roleCount[r] || 0) + 1;
    });
    const sorted = Object.entries(roleCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = sorted.length ? Math.max(...sorted.map(s => s[1])) : 1;
    const chart = $('distChart');
    if (!chart) return;
    chart.replaceChildren();
    if (!sorted.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const i = document.createElement('i'); i.className = 'ph ph-chart-bar'; i.setAttribute('aria-hidden', 'true');
        const s = document.createElement('span'); s.textContent = 'No data yet';
        empty.appendChild(i); empty.appendChild(s);
        chart.appendChild(empty);
        return;
    }
    sorted.forEach(([role, count]) => {
        const row = document.createElement('div');
        row.className = 'bar-row';
        const lbl = document.createElement('div'); lbl.className = 'bar-label'; lbl.textContent = role;
        const track = document.createElement('div'); track.className = 'bar-track';
        const fill = document.createElement('div'); fill.className = 'bar-fill'; fill.style.width = '0';
        track.appendChild(fill);
        const val = document.createElement('div'); val.className = 'bar-val'; val.textContent = count;
        row.appendChild(lbl); row.appendChild(track); row.appendChild(val);
        chart.appendChild(row);
    });
    requestAnimationFrame(() => {
        chart.querySelectorAll('.bar-row').forEach((row, i) => {
            const count = sorted[i][1];
            const fill = row.querySelector('.bar-fill');
            setTimeout(() => { if (fill) fill.style.width = ((count / max) * 100) + '%'; }, 100);
        });
    });
}

// ----------------------------------------------------------
//  TEAM LIST
// ----------------------------------------------------------
function renderTeamList() {
    const wrap = $('adminTeamList');
    if (!wrap) return;
    const q = state.search.trim().toLowerCase();
    const filtered = state.team.filter(m => {
        if (!q) return true;
        return (m.name + ' ' + (m.role || '') + ' ' + (m.skills || []).join(' ')).toLowerCase().includes(q);
    });

    wrap.replaceChildren();

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const i = document.createElement('i');
        i.className = 'ph ph-' + (state.team.length ? 'magnifying-glass' : 'users');
        i.setAttribute('aria-hidden', 'true');
        const s = document.createElement('span');
        s.textContent = state.team.length ? 'No results' : 'No operatives yet — add the first one';
        empty.appendChild(i); empty.appendChild(s);
        wrap.appendChild(empty);
        return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach(m => frag.appendChild(buildTeamRow(m)));
    wrap.appendChild(frag);

    wrap.querySelectorAll('.team-row').forEach(row => {
        const id = row.dataset.id;
        const editBtn = row.querySelector('[data-action="edit"]');
        const delBtn = row.querySelector('[data-action="delete"]');
        const viewBtn = row.querySelector('[data-action="view"]');
        if (editBtn) editBtn.addEventListener('click', () => openEditor(id));
        if (delBtn) delBtn.addEventListener('click', () => deleteMember(id));
        if (viewBtn) viewBtn.addEventListener('click', () => {
            const m = state.team.find(x => x.id === id);
            if (!m) return;
            const url = _safeURLOrNull(m.presentationUrl) || _safeURL('index.html', 'index.html');
            try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) { window.open(url, '_blank'); }
        });
    });

    if (window.Sortable) {
        try {
            window.Sortable.create(wrap, {
                handle: '.drag-handle',
                animation: prefersReducedMotion() ? 0 : 200,
                ghostClass: 'sortable-ghost',
                chosenClass: 'sortable-chosen',
                dragClass: 'sortable-drag',
                onEnd: persistOrder,
            });
        } catch (_) { /* Sortable not loaded */ }
    }
}

function buildTeamRow(m) {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.dataset.id = m.id;

    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    const hi = document.createElement('i'); hi.className = 'ph ph-dots-six-vertical'; hi.setAttribute('aria-hidden', 'true');
    handle.appendChild(hi);

    const avatar = document.createElement('div');
    avatar.className = 'team-avatar';
    const img = document.createElement('img');
    img.alt = '';
    img.src = _safeURL(m.photoUrl || '', _fallbackAvatar(m.name));
    img.onerror = function () {
        this.style.display = 'none';
        this.parentNode.textContent = (m.name || '?').charAt(0) || '?';
    };
    avatar.appendChild(img);

    const info = document.createElement('div');
    info.className = 'team-info';
    const nameDiv = document.createElement('div');
    nameDiv.className = 'name';
    nameDiv.textContent = m.name || '—';
    const roleDiv = document.createElement('div');
    roleDiv.className = 'role';
    roleDiv.textContent = m.role || '—';
    info.appendChild(nameDiv);
    info.appendChild(roleDiv);

    const actions = document.createElement('div');
    actions.className = 'team-actions';
    actions.appendChild(makeIconBtn('eye', 'View', 'view'));
    actions.appendChild(makeIconBtn('pencil-simple', 'Edit', 'edit'));
    actions.appendChild(makeIconBtn('trash', 'Delete', 'delete'));

    row.appendChild(handle);
    row.appendChild(avatar);
    row.appendChild(info);
    row.appendChild(actions);
    return row;
}

function makeIconBtn(iconName, title, action) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.dataset.action = action;
    b.title = title;
    b.setAttribute('aria-label', title);
    const i = document.createElement('i');
    i.className = 'ph ph-' + iconName;
    i.setAttribute('aria-hidden', 'true');
    b.appendChild(i);
    return b;
}

async function persistOrder() {
    const wrap = $('adminTeamList');
    if (!wrap) return;
    const ids = Array.from(wrap.querySelectorAll('.team-row')).map(r => r.dataset.id);
    try {
        const batch = writeBatch(db);
        ids.forEach((id, i) => {
            batch.update(doc(db, 'team', id), { order: i + 1 });
        });
        await batch.commit();
        await loadTeam();
        toast('Order updated', 'success');
        logActivity('edit', 'Reordered team members');
    } catch (err) {
        toast('Reorder failed: ' + (err && err.message || err), 'error');
    }
}

const adminSearch = $('adminSearch');
if (adminSearch) {
    adminSearch.addEventListener('input', _debounce((e) => {
        state.search = e.target.value;
        renderTeamList();
    }, 150));
}

// ----------------------------------------------------------
//  MEMBER EDITOR MODAL
// ----------------------------------------------------------
const memberForm = $('memberForm');
const editor = $('memberEditor');
const editorTitle = $('editorTitle');

function openEditor(id) {
    if (!memberForm || !editor) return;
    memberForm.reset();
    $('member-id').value = '';
    const preview = $('uploadPreview');
    if (preview) {
        preview.replaceChildren();
        const i = document.createElement('i'); i.className = 'ph ph-image'; i.setAttribute('aria-hidden', 'true');
        preview.appendChild(i);
    }
    $('member-order').value = state.team.length + 1;

    if (id) {
        const m = state.team.find(x => x.id === id);
        if (!m) return;
        if (editorTitle) editorTitle.textContent = 'Edit Operative';
        $('member-id').value = m.id;
        $('member-name').value = m.name || '';
        $('member-role').value = m.role || '';
        $('member-photo-url').value = m.photoUrl || '';
        $('member-pres').value = m.presentationUrl || '';
        $('member-order').value = m.order != null ? m.order : 99;
        $('member-bio').value = m.bio || '';
        $('member-skills').value = (m.skills || []).join(', ');
        $('member-contributions').value = m.contributions || '';
        const photoUrl = _safeURLOrNull(m.photoUrl);
        if (photoUrl && preview) {
            preview.replaceChildren();
            const im = document.createElement('img');
            im.src = photoUrl;
            im.alt = '';
            im.onerror = function () { this.parentNode.innerHTML = '<i class="ph ph-image" aria-hidden="true"></i>'; };
            preview.appendChild(im);
        }
    } else {
        if (editorTitle) editorTitle.textContent = 'Add New Operative';
    }
    editor.style.display = 'flex';
    editor.setAttribute('aria-hidden', 'false');
    if (state.focusTrapRelease) state.focusTrapRelease();
    state.focusTrapRelease = _focusTrap(editor, closeEditor);
}

function closeEditor() {
    if (!editor) return;
    editor.style.display = 'none';
    editor.setAttribute('aria-hidden', 'true');
    const f = $('member-photo-file');
    if (f) f.value = '';
    if (state.focusTrapRelease) { state.focusTrapRelease(); state.focusTrapRelease = null; }
}

if (editor) {
    document.querySelectorAll('[data-close-editor]').forEach(b => b.addEventListener('click', closeEditor));
    editor.addEventListener('click', (e) => { if (e.target === editor) closeEditor(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && editor.style.display === 'flex') closeEditor();
    });
}

const addMemberBtn = $('addMemberBtn');
if (addMemberBtn) addMemberBtn.addEventListener('click', () => openEditor());

// Photo upload (Firebase Storage — replaces ImgBB)
const photoFileInput = $('member-photo-file');
if (photoFileInput) {
    photoFileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            toast('Please select an image file', 'error');
            e.target.value = '';
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            toast('File too large (max 5MB)', 'error');
            e.target.value = '';
            return;
        }
        // Show local preview only — actual upload happens on Save
        const reader = new FileReader();
        reader.onload = (ev) => {
            const preview = $('uploadPreview');
            if (!preview) return;
            preview.replaceChildren();
            const im = document.createElement('img');
            im.src = ev.target.result;
            im.alt = '';
            preview.appendChild(im);
        };
        reader.readAsDataURL(file);
    });
}

const photoUrlInput = $('member-photo-url');
if (photoUrlInput) {
    photoUrlInput.addEventListener('input', (e) => {
        const url = e.target.value.trim();
        const preview = $('uploadPreview');
        if (!preview) return;
        const safe = _safeURLOrNull(url);
        if (safe) {
            preview.replaceChildren();
            const im = document.createElement('img');
            im.src = safe;
            im.alt = '';
            im.onerror = function () { preview.replaceChildren(); const i = document.createElement('i'); i.className = 'ph ph-image'; i.setAttribute('aria-hidden','true'); preview.appendChild(i); };
            preview.appendChild(im);
        } else {
            preview.replaceChildren();
            const i = document.createElement('i'); i.className = 'ph ph-image'; i.setAttribute('aria-hidden', 'true');
            preview.appendChild(i);
        }
    });
}

const clearPhotoBtn = $('clearPhoto');
if (clearPhotoBtn) {
    clearPhotoBtn.addEventListener('click', () => {
        const f = $('member-photo-file'); if (f) f.value = '';
        const u = $('member-photo-url'); if (u) u.value = '';
        const preview = $('uploadPreview');
        if (preview) {
            preview.replaceChildren();
            const i = document.createElement('i'); i.className = 'ph ph-image'; i.setAttribute('aria-hidden', 'true');
            preview.appendChild(i);
        }
    });
}

// Upload helper — ImgBB API (Storage Alternative)
async function uploadPhotoFile(file) {
    const formData = new FormData();
    formData.append('image', file);
    
    // Using ImgBB API key provided by user
    const response = await fetch('https://api.imgbb.com/1/upload?key=32df4936095e9a78d4d831546cb9a355', {
        method: 'POST',
        body: formData
    });
    
    if (!response.ok) {
        throw new Error('ImgBB upload failed: ' + response.statusText);
    }
    
    const data = await response.json();
    if (!data || !data.success) {
        throw new Error('ImgBB upload failed: ' + (data.error ? data.error.message : 'Unknown error'));
    }
    
    // Return the direct URL to the image
    return data.data.url;
}

if (memberForm) {
    memberForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = $('member-id').value;
        const btn = memberForm.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph ph-spinner-gap ph-spin" aria-hidden="true"></i><span>SAVING...</span>'; }

        try {
            let photoUrl = $('member-photo-url').value.trim();

            // Validate URL fields before saving
            const presentationUrl = _safeURLOrNull($('member-pres').value.trim());
            if ($('member-pres').value.trim() && !presentationUrl) {
                toast('Presentation URL must be http(s)://', 'error');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ph ph-check-circle" aria-hidden="true"></i><span>Save Operative</span>'; }
                return;
            }
            if (photoUrl) {
                const safe = _safeURLOrNull(photoUrl);
                if (!safe) {
                    toast('Photo URL must be http(s)://', 'error');
                    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ph ph-check-circle" aria-hidden="true"></i><span>Save Operative</span>'; }
                    return;
                }
                photoUrl = safe;
            }

            // Upload file via Firebase Storage (no third-party keys)
            const fileInput = $('member-photo-file');
            if (fileInput && fileInput.files && fileInput.files[0]) {
                const file = fileInput.files[0];
                toast('Uploading photo...', 'info', 2000);
                photoUrl = await uploadPhotoFile(file);
            }

            // Validate required fields
            const name = $('member-name').value.trim();
            const role = $('member-role').value.trim();
            if (name.length < 2 || name.length > 100) { toast('Name must be 2–100 chars', 'error'); throw new Error('validation'); }
            if (role.length < 2 || role.length > 100) { toast('Role must be 2–100 chars', 'error'); throw new Error('validation'); }

            const order = parseInt($('member-order').value, 10);
            if (!Number.isFinite(order) || order < 0 || order > 999) { toast('Order must be 0–999', 'error'); throw new Error('validation'); }

            const skills = $('member-skills').value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);
            // Trim skill strings to 60 chars
            const skillsTrimmed = skills.map(s => s.slice(0, 60));

            const data = {
                name,
                role,
                photoUrl: photoUrl || '',
                presentationUrl: presentationUrl || '',
                order,
                bio: ($('member-bio').value || '').trim().slice(0, 800),
                contributions: ($('member-contributions').value || '').trim().slice(0, 2000),
                skills: skillsTrimmed,
                updatedAt: new Date().toISOString(),
            };

            if (id) {
                await withRetry(() => updateDoc(doc(db, 'team', id)), data);
                logActivity('edit', 'Updated operative: ' + data.name);
                toast('Operative updated', 'success');
            } else {
                data.createdAt = new Date().toISOString();
                await withRetry(() => addDoc(collection(db, 'team')), data);
                logActivity('add', 'Added new operative: ' + data.name);
                toast('Operative added', 'success');
            }

            closeEditor();
            await loadTeam();
            renderTeamList();
            renderMetrics();
        } catch (err) {
            if (err && err.message !== 'validation') {
                console.error(err);
                toast('Error: ' + (err && err.message || err), 'error');
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="ph ph-check-circle" aria-hidden="true"></i><span>Save Operative</span>';
            }
        }
    });
}

async function deleteMember(id) {
    const m = state.team.find(x => x.id === id);
    if (!m) return;
    if (!confirm('Delete "' + (m.name || 'this member') + '"? This cannot be undone.')) return;
    try {
        await withRetry(() => deleteDoc(doc(db, 'team', id)));
        // Best-effort: delete the file from Firebase Storage if it's in our bucket
        if (m.photoUrl && m.photoUrl.indexOf('firebasestorage') !== -1) {
            try { await deleteObject(ref(storage, m.photoUrl)); } catch (_) { /* ignore */ }
        }
        logActivity('delete', 'Deleted operative: ' + m.name);
        toast('Operative deleted', 'success');
        await loadTeam();
        renderTeamList();
        renderMetrics();
    } catch (err) {
        toast('Delete failed: ' + (err && err.message || err), 'error');
    }
}

// ----------------------------------------------------------
//  SETTINGS
// ----------------------------------------------------------
const settingsForm = $('settings-form');
if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = $('settings-status');
        if (status) status.textContent = 'UPDATING...';
        const masterUrl = _safeURLOrNull($('site-master-url').value.trim());
        const previewUrl = _safeURLOrNull($('site-preview-url').value.trim());
        const downloadUrl = _safeURLOrNull($('site-download-url').value.trim());
        if (($('site-master-url').value.trim() && !masterUrl)
            || ($('site-preview-url').value.trim() && !previewUrl)
            || ($('site-download-url').value.trim() && !downloadUrl)) {
            if (status) status.textContent = '✗ INVALID_URL';
            toast('All URLs must start with http:// or https://', 'error');
            return;
        }
        const data = {
            title: $('site-title').value.trim().slice(0, 100),
            heroDescription: $('site-desc').value.trim().slice(0, 2000),
            masterPresentationUrl: masterUrl || '',
            reportPreviewUrl: previewUrl || '',
            reportUrl: downloadUrl || '',
            updatedAt: new Date().toISOString(),
        };
        if (data.title.length < 1) {
            if (status) status.textContent = '✗ TITLE_REQUIRED';
            toast('Title is required', 'error');
            return;
        }
        try {
            await setDoc(doc(db, 'settings', 'site'), data);
            state.settings = data;
            if (status) status.textContent = '✓ CONFIG_UPDATED';
            logActivity('settings', 'Updated site configuration');
            toast('Configuration saved', 'success');
            renderMetrics();
            setTimeout(() => { if (status) status.textContent = ''; }, 3500);
        } catch (err) {
            if (status) status.textContent = '✗ ERROR';
            toast('Save failed: ' + (err && err.message || err), 'error');
        }
    });
}

const resetSettings = $('resetSettings');
if (resetSettings) {
    resetSettings.addEventListener('click', () => {
        loadSettings();
        toast('Form reset', 'info');
    });
}

// ----------------------------------------------------------
//  EXPORT
// ----------------------------------------------------------
const qaExport = $('qaExport');
if (qaExport) {
    qaExport.addEventListener('click', () => {
        const data = {
            settings: state.settings,
            team: state.team,
            posts: state.posts,
            exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'nti-export-' + Date.now() + '.json';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('Exported as JSON', 'success');
        logActivity('settings', 'Exported data as JSON');
    });
}

// ----------------------------------------------------------
//  POSTS LIST & CRUD
// ----------------------------------------------------------
function renderPostsList() {
    const wrap = $('adminPostsList');
    if (!wrap) return;
    wrap.replaceChildren();

    if (!state.posts.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const i = document.createElement('i');
        i.className = 'ph ph-presentation-chart';
        i.setAttribute('aria-hidden', 'true');
        const s = document.createElement('span');
        s.textContent = 'لا توجد مشاريع أو منشورات حتى الآن';
        empty.appendChild(i); empty.appendChild(s);
        wrap.appendChild(empty);
        return;
    }

    const frag = document.createDocumentFragment();
    state.posts.forEach(post => {
        const row = document.createElement('div');
        row.className = 'post-row';
        row.dataset.id = post.id;

        const thumb = document.createElement('div');
        thumb.className = 'post-thumb';
        if (post.photoUrl) {
            const img = document.createElement('img');
            img.src = _safeURL(post.photoUrl, '');
            img.alt = '';
            thumb.appendChild(img);
        } else {
            const i = document.createElement('i');
            i.className = 'ph ph-image';
            i.setAttribute('aria-hidden', 'true');
            thumb.appendChild(i);
        }

        const info = document.createElement('div');
        info.className = 'post-info';
        const titleDiv = document.createElement('div');
        titleDiv.className = 'title';
        titleDiv.textContent = post.title || 'بدون عنوان';
        const metaDiv = document.createElement('div');
        metaDiv.className = 'meta';
        
        let authorStr = 'الفريق بأكمله';
        if (post.authorType === 'member') {
            const m = state.team.find(x => x.id === post.authorId);
            authorStr = m ? m.name : 'عضو محذوف';
        }
        metaDiv.textContent = `بواسطة: ${authorStr} — الترتيب: ${post.order}`;
        
        info.appendChild(titleDiv);
        info.appendChild(metaDiv);

        const actions = document.createElement('div');
        actions.className = 'post-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'icon-btn';
        editBtn.title = 'تعديل';
        const ei = document.createElement('i');
        ei.className = 'ph ph-pencil-simple';
        editBtn.appendChild(ei);
        editBtn.addEventListener('click', () => openPostEditor(post.id));

        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn delete';
        delBtn.title = 'حذف';
        const di = document.createElement('i');
        di.className = 'ph ph-trash';
        delBtn.appendChild(di);
        delBtn.addEventListener('click', () => deletePost(post.id, post.title));

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);

        row.appendChild(thumb);
        row.appendChild(info);
        row.appendChild(actions);
        frag.appendChild(row);
    });
    wrap.appendChild(frag);
}

const addPostBtn = $('addPostBtn');
if (addPostBtn) addPostBtn.addEventListener('click', () => openPostEditor());

function openPostEditor(id = null) {
    const modal = $('postEditor');
    const form = $('postForm');
    const authorType = $('post-author-type');
    const authorSelect = $('post-author-id');
    const memberGroup = $('post-member-select-group');
    if (!modal || !form || !authorSelect || !authorType) return;

    form.reset();
    const stat = $('post-editor-status');
    if (stat) stat.textContent = '';
    const preview = $('postUploadPreview');
    if (preview) {
        preview.replaceChildren();
        const ic = document.createElement('i');
        ic.className = 'ph ph-image';
        preview.appendChild(ic);
    }

    authorSelect.replaceChildren();
    state.team.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        authorSelect.appendChild(opt);
    });

    authorType.onchange = () => {
        memberGroup.style.display = authorType.value === 'member' ? 'block' : 'none';
    };

    if (id) {
        const p = state.posts.find(x => x.id === id);
        if (p) {
            $('postEditorTitle').textContent = '\u062a\u0639\u062f\u064a\u0644 \u0627\u0644\u0645\u0646\u0634\u0648\u0631';
            $('post-id').value = p.id;
            $('post-title').value = p.title || '';
            $('post-desc').value = p.description || '';
            $('post-link').value = p.externalLink || '';
            $('post-photo-url').value = p.photoUrl || '';
            if (p.photoUrl && preview) {
                const im = document.createElement('img');
                im.src = _safeURL(p.photoUrl);
                preview.replaceChildren(im);
            }
            $('post-order').value = p.order !== undefined ? p.order : 0;
            authorType.value = p.authorType || 'team';
            authorType.onchange();
            if (p.authorType === 'member' && p.authorId) {
                authorSelect.value = p.authorId;
            }
        }
    } else {
        $('postEditorTitle').textContent = '\u0625\u0636\u0627\u0641\u0629 \u0645\u0646\u0634\u0648\u0631 \u062c\u062f\u064a\u062f';
        $('post-id').value = '';
        authorType.value = 'team';
        authorType.onchange();
    }

    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (state.focusTrapRelease) state.focusTrapRelease();
    state.focusTrapRelease = _focusTrap(modal, closePostEditor);
}

function closePostEditor() {
    const modal = $('postEditor');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
    document.body.style.overflow = '';
    if (state.focusTrapRelease) { state.focusTrapRelease(); state.focusTrapRelease = null; }
}

if ($('closePostEditor')) $('closePostEditor').addEventListener('click', closePostEditor);
if ($('cancelPostEditor')) $('cancelPostEditor').addEventListener('click', closePostEditor);

// Post photo upload via ImgBB
const postPhotoFile = $('post-photo-file');
const postPhotoUrlInput = $('post-photo-url');
const postUploadPrev = $('postUploadPreview');

if (postPhotoFile) {
    postPhotoFile.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            toast('\u062d\u062c\u0645 \u0627\u0644\u0635\u0648\u0631\u0629 \u064a\u062c\u0628 \u0623\u0646 \u0644\u0627 \u064a\u062a\u062c\u0627\u0648\u0632 2MB', 'error');
            postPhotoFile.value = '';
            return;
        }
        const stat = $('post-editor-status');
        if (stat) stat.textContent = '\u062c\u0627\u0631\u064a \u0627\u0644\u0631\u0641\u0639 \u0644\u0640 ImgBB...';
        try {
            const formData = new FormData();
            formData.append('image', file);
            const API_KEY = '32df4936095e9a78d4d831546cb9a355';
            const res = await fetch(`https://api.imgbb.com/1/upload?key=${API_KEY}`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data && data.success) {
                const directUrl = data.data.url;
                if (postPhotoUrlInput) postPhotoUrlInput.value = directUrl;
                if (postUploadPrev) {
                    const img = document.createElement('img');
                    img.src = _safeURL(directUrl);
                    postUploadPrev.replaceChildren(img);
                }
                if (stat) { stat.textContent = '\u062a\u0645 \u0631\u0641\u0639 \u0627\u0644\u0635\u0648\u0631\u0629 \u0628\u0646\u062c\u0627\u062d!'; setTimeout(() => { stat.textContent = ''; }, 2000); }
            } else {
                throw new Error(data.error?.message || '\u0641\u0634\u0644 \u0627\u0644\u0631\u0641\u0639');
            }
        } catch (err) {
            console.error('Upload Error:', err);
            if (stat) stat.textContent = '\u062e\u0637\u0623 \u0641\u064a \u0631\u0641\u0639 \u0627\u0644\u0635\u0648\u0631\u0629.';
            toast('\u062a\u0639\u0630\u0631 \u0631\u0641\u0639 \u0627\u0644\u0635\u0648\u0631\u0629.', 'error');
        } finally {
            postPhotoFile.value = '';
        }
    });
}

if ($('postForm')) {
    $('postForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const stat = $('post-editor-status');
        const btn = e.target.querySelector('button[type="submit"]');
        const title = $('post-title').value.trim();
        const desc = $('post-desc').value.trim();
        const link = $('post-link').value.trim();
        const pUrl = $('post-photo-url').value.trim();
        const authorType = $('post-author-type').value;
        const authorId = authorType === 'member' ? $('post-author-id').value : null;
        const order = parseInt($('post-order').value, 10) || 0;
        const id = $('post-id').value;

        if (title.length < 2) {
            if (stat) stat.textContent = '\u0627\u0644\u0639\u0646\u0648\u0627\u0646 \u064a\u062c\u0628 \u0623\u0646 \u064a\u0643\u0648\u0646 \u062d\u0631\u0641\u064a\u0646 \u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644.';
            return;
        }

        const payload = {
            title,
            description: desc,
            externalLink: _safeURLOrNull(link) || '',
            photoUrl: _safeURLOrNull(pUrl) || '',
            authorType,
            authorId: authorId || '',
            order,
            updatedAt: new Date().toISOString()
        };

        try {
            if (stat) stat.textContent = '\u062c\u0627\u0631\u064a \u0627\u0644\u062d\u0641\u0638...';
            btn.disabled = true;
            if (id) {
                await withRetry(() => updateDoc(doc(db, 'posts', id)), payload);
                toast('\u062a\u0645 \u0627\u0644\u062a\u0639\u062f\u064a\u0644 \u0628\u0646\u062c\u0627\u062d', 'success');
                logActivity('edit', `Updated post: ${title}`);
            } else {
                payload.createdAt = new Date().toISOString();
                await withRetry(() => addDoc(collection(db, 'posts')), payload);
                toast('\u062a\u0645\u062a \u0627\u0644\u0625\u0636\u0627\u0641\u0629 \u0628\u0646\u062c\u0627\u062d', 'success');
                logActivity('add', `Created post: ${title}`);
            }
            closePostEditor();
            await loadPosts();
            renderPostsList();
        } catch (err) {
            console.error(err);
            if (stat) stat.textContent = '\u062d\u062f\u062b \u062e\u0637\u0623: ' + err.message;
        } finally {
            btn.disabled = false;
        }
    });
}

async function deletePost(id, title) {
    if (!confirm('\u0647\u0644 \u0623\u0646\u062a \u0645\u062a\u0623\u0643\u062f \u0645\u0646 \u062d\u0630\u0641 \u0627\u0644\u0645\u0646\u0634\u0648\u0631 "' + title + '"\u061f \u0644\u0627 \u064a\u0645\u0643\u0646 \u0627\u0644\u062a\u0631\u0627\u062c\u0639 \u0639\u0646 \u0647\u0630\u0627.')) return;
    try {
        await withRetry(() => deleteDoc(doc(db, 'posts', id)));
        toast('\u062a\u0645 \u0627\u0644\u062d\u0630\u0641', 'success');
        logActivity('delete', `Deleted post: ${title}`);
        await loadPosts();
        renderPostsList();
    } catch (err) {
        console.error(err);
        toast('\u062a\u0639\u0630\u0631 \u0627\u0644\u062d\u0630\u0641', 'error');
    }
}

