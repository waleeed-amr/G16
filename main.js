// ==========================================================
//   NTI SECURE — Frontend Logic (Social Media Feed UI)
//   Data · Feed · Modal · Search · Scroll FX
//   All user content is rendered via textContent.
//   No innerHTML interpolation of untrusted strings.
// ==========================================================
import { db } from './firebase-config.js';

// --- ADVANCED UTILS (Network Resilience & Perf) ---
const withRetry = async (fn, retries = 3, delay = 1500) => {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } 
        catch (err) {
            if (i === retries - 1) throw err;
            console.warn('[Network] Retry', i + 1, '/', retries, 'after', delay, 'ms', err.message);
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
    doc, getDoc, collection, getDocs, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

const {
    safeURL, safeURLOrNull, escapeHTML, sanitizeRich,
    fallbackAvatar, focusTrap,
} = window.NTI || {};

// Defensive fallbacks if security.js failed to load
const _safeURL = safeURL || ((s, fb) => (s && /^https?:\/\//i.test(s)) ? s : (fb || '#'));
const _safeURLOrNull = safeURLOrNull || ((s) => (s && /^https?:\/\//i.test(s)) ? s : null);
const _escapeHTML = escapeHTML || ((s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
const _fallbackAvatar = fallbackAvatar || (() => 'data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E');
const _debounce = debounce || ((fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; });
const _focusTrap = focusTrap || (() => () => {});

// ----------------------------------------------------------
//  STATE
// ----------------------------------------------------------
const state = {
    team: [],
    posts: [],
    feed: [],
    filter: '',
    isRevealed: new WeakSet(),
    focusTrapRelease: null,
};

// ----------------------------------------------------------
//  SCROLL REVEAL
// ----------------------------------------------------------
function initScrollReveal() {
    const items = document.querySelectorAll('[data-reveal]');
    if (!('IntersectionObserver' in window)) {
        items.forEach(el => el.classList.add('revealed'));
        return;
    }
    const io = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting && !state.isRevealed.has(entry.target)) {
                state.isRevealed.add(entry.target);
                const delay = entry.target.dataset.revealDelay || '0s';
                entry.target.style.setProperty('--reveal-delay', delay);
                entry.target.classList.add('revealed');
                io.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
    items.forEach(el => io.observe(el));
}

// ----------------------------------------------------------
//  COUNTER ANIMATION
// ----------------------------------------------------------
function animateCounter(el) {
    const target = parseFloat(el.dataset.counter || '0');
    const suffix = el.dataset.suffix || '';
    const duration = 1800;
    const isFloat = target % 1 !== 0;
    if (duration === 0) {
        el.textContent = (isFloat ? target.toFixed(1) : target.toLocaleString('en-US')) + suffix;
        return;
    }
    const startTime = performance.now();
    const tick = (now) => {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = target * eased;
        el.textContent = (isFloat ? current.toFixed(1) : Math.floor(current).toLocaleString('en-US')) + suffix;
        if (progress < 1) requestAnimationFrame(tick);
        else el.textContent = (isFloat ? target.toFixed(1) : target.toLocaleString('en-US')) + suffix;
    };
    requestAnimationFrame(tick);
}

function initCounters() {
    const counters = document.querySelectorAll('[data-counter]');
    if (!('IntersectionObserver' in window)) {
        counters.forEach(animateCounter);
        return;
    }
    const io = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                animateCounter(entry.target);
                io.unobserve(entry.target);
            }
        });
    }, { threshold: 0.4 });
    counters.forEach(c => io.observe(c));
}

// ----------------------------------------------------------
//  NAV EFFECTS
// ----------------------------------------------------------
function initNav() {
    const nav = document.getElementById('mainNav');
    const toggle = document.getElementById('navToggle');
    const links = document.getElementById('navLinks');

    const onScroll = () => {
        if (!nav) return;
        if (window.scrollY > 30) nav.classList.add('scrolled');
        else nav.classList.remove('scrolled');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (!toggle || !links) return;

    const setOpen = (open) => {
        links.classList.toggle('open', open);
        const icon = toggle.querySelector('i');
        if (icon) icon.className = open ? 'ph ph-x' : 'ph ph-list';
        toggle.setAttribute('aria-expanded', String(open));
        links.setAttribute('aria-hidden', String(!open));
    };
    setOpen(false);

    toggle.addEventListener('click', () => {
        setOpen(!links.classList.contains('open'));
    });

    links.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', () => setOpen(false));
    });

    // close on outside click
    document.addEventListener('click', (e) => {
        if (!links.classList.contains('open')) return;
        if (links.contains(e.target) || toggle.contains(e.target)) return;
        setOpen(false);
    });

    // close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && links.classList.contains('open')) setOpen(false);
    });
}

// ----------------------------------------------------------
//  SCROLL-SPY — highlight nav link for visible section
// ----------------------------------------------------------
function initScrollSpy() {
    if (!('IntersectionObserver' in window)) return;
    const links = document.querySelectorAll('.nav-links a[href^="#"]');
    if (!links.length) return;
    const byHash = new Map();
    links.forEach(a => {
        const id = a.getAttribute('href').slice(1);
        const section = document.getElementById(id);
        if (section) byHash.set(section, a);
    });
    if (!byHash.size) return;

    const io = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const link = byHash.get(entry.target);
            if (!link) return;
            if (entry.isIntersecting) {
                links.forEach(l => l.classList.remove('is-active'));
                link.classList.add('is-active');
            }
        });
    }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
    byHash.forEach((_, section) => io.observe(section));
}

// ----------------------------------------------------------
//  BACK TO TOP
// ----------------------------------------------------------
function initBackToTop() {
    const btn = document.getElementById('backToTop');
    if (!btn) return;
    const onScroll = () => {
        if (window.scrollY > 600) btn.classList.add('visible');
        else btn.classList.remove('visible');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    btn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    });
}

// ----------------------------------------------------------
//  DATA LOAD
// ----------------------------------------------------------
async function loadSiteData() {
    const heroTitle = document.getElementById('hero-title');
    const heroDesc = document.getElementById('hero-desc');
    const seoTitle = document.getElementById('seo-title');
    const masterPresLink = document.getElementById('master-pres-link');
    const reportPreviewLink = document.getElementById('report-preview-link');
    const reportDownloadLink = document.getElementById('report-download-link');
    const teamGrid = document.getElementById('team-grid');

    try {
        const settingsSnap = await withRetry(() => getDoc(doc(db, "settings", "site")));
        if (settingsSnap.exists()) {
            const data = settingsSnap.data();
            const title = data.title || 'مشروع تخرج NTI';
            const desc = data.heroDescription || 'منصة السايبر سيكيورتي المتقدمة - جروب 16';

            if (heroTitle) {
                heroTitle.textContent = title;
            }
            if (seoTitle) seoTitle.textContent = title;
            if (heroDesc) heroDesc.textContent = desc;

            const setLinkHref = (el, url) => {
                if (!el) return;
                const safe = _safeURLOrNull(url);
                if (safe) {
                    el.href = safe;
                    el.style.display = 'inline-flex';
                } else {
                    el.style.display = 'none';
                }
            };
            setLinkHref(masterPresLink, data.masterPresentationUrl);
            setLinkHref(reportPreviewLink, data.reportPreviewUrl);
            setLinkHref(reportDownloadLink, data.reportUrl);
        } else {
            if (heroTitle) heroTitle.textContent = 'لا توجد بيانات';
            if (heroDesc) heroDesc.textContent = 'يرجى ضبط إعدادات الموقع من لوحة التحكم.';
        }

        const teamSnap = await withRetry(() => getDocs(query(collection(db, "team"), orderBy("order", "asc"))));
        state.team = [];
        teamSnap.forEach(d => state.team.push({ id: d.id, type: 'team', ...d.data() }));

        const postsSnap = await withRetry(() => getDocs(query(collection(db, "posts"), orderBy("order", "asc"))));
        state.posts = [];
        postsSnap.forEach(d => state.posts.push({ id: d.id, type: 'post', ...d.data() }));

        state.feed = [...state.team, ...state.posts].sort((a, b) => (a.order || 0) - (b.order || 0));

        // Update stats
        const statMembers = document.getElementById('stat-members');
        const statPosts = document.getElementById('stat-posts');

        if (statMembers) statMembers.dataset.counter = state.team.length;
        if (statPosts) statPosts.dataset.counter = state.posts.length;

        initCounters(); // Re-trigger the counter animation with the actual values
        
        renderFeed();
    } catch (err) {
        console.error("Firebase Error:", err);
        if (heroTitle) heroTitle.textContent = 'خطأ في الاتصال';
        if (heroDesc) heroDesc.textContent = 'تعذر الاتصال بقاعدة البيانات';
        if (teamGrid) {
            teamGrid.replaceChildren();
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const ic = document.createElement('i'); ic.className = 'ph-fill ph-warning-octagon'; ic.setAttribute('aria-hidden', 'true');
            const span = document.createElement('span'); span.textContent = 'تعذر الاتصال بقاعدة البيانات';
            empty.appendChild(ic); empty.appendChild(span);
            teamGrid.appendChild(empty);
        }
    }
}

// ----------------------------------------------------------
//  FEED RENDER  (XSS-safe: no innerHTML)
// ----------------------------------------------------------
function renderFeed() {
    const grid = document.getElementById('team-grid');
    if (!grid) return;
    const filter = state.filter.trim().toLowerCase();
    
    const filtered = state.feed.filter(item => {
        if (!filter) return true;
        if (item.type === 'team') {
            return (item.name + ' ' + (item.role || '') + ' ' + (item.skills || []).join(' ')).toLowerCase().includes(filter);
        } else {
            return (item.title + ' ' + (item.description || '')).toLowerCase().includes(filter);
        }
    });

    grid.replaceChildren();

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const ic = document.createElement('i');
        ic.className = state.feed.length ? 'ph ph-magnifying-glass' : 'ph ph-users-three';
        ic.setAttribute('aria-hidden', 'true');
        const span = document.createElement('span');
        span.textContent = state.feed.length ? 'لا توجد نتائج للبحث' : 'لا توجد منشورات حتى الآن';
        empty.appendChild(ic); empty.appendChild(span);
        grid.appendChild(empty);
        return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach(item => {
        if (item.type === 'team') {
            frag.appendChild(buildTeamCard(item));
        } else {
            frag.appendChild(buildPostCard(item));
        }
    });
    grid.appendChild(frag);
}

function buildTeamCard(m) {
    const card = document.createElement('article');
    card.className = 'post-card';
    card.dataset.id = m.id;
    card.setAttribute('role', 'article');

    // Header (Avatar + Name/Role)
    const header = document.createElement('header');
    header.className = 'post-header';
    
    const img = document.createElement('img');
    img.className = 'post-avatar';
    img.loading = 'lazy';
    img.alt = '';
    const photoSrc = m.photoUrl || _fallbackAvatar(m.name);
    img.src = _safeURL(photoSrc, _fallbackAvatar(m.name));
    img.onerror = function () { this.onerror = null; this.src = _fallbackAvatar(m.name); };
    
    const info = document.createElement('div');
    info.className = 'post-author-info';
    
    const name = document.createElement('div');
    name.className = 'post-author-name';
    name.textContent = m.name || 'مستخدم غير معروف';
    // Clicking the name opens the modal
    name.addEventListener('click', () => openMemberModal(m.id));
    
    const role = document.createElement('div');
    role.className = 'post-author-role';
    role.textContent = m.role || 'عضو بالفريق';
    
    info.appendChild(name);
    info.appendChild(role);
    header.appendChild(img);
    header.appendChild(info);

    // Content (Bio snippet)
    const content = document.createElement('div');
    content.className = 'post-content';
    let bioText = m.bio || '';
    if (bioText.length > 150) {
        bioText = bioText.substring(0, 150) + '...';
    }
    content.textContent = bioText || 'لا توجد نبذة شخصية حتى الآن.';

    // Tags (Skills)
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'post-tags';
    if (m.skills && Array.isArray(m.skills)) {
        m.skills.slice(0, 3).forEach(s => {
            const tag = document.createElement('span');
            tag.className = 'post-tag';
            tag.textContent = '#' + s;
            tagsDiv.appendChild(tag);
        });
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'post-actions';
    
    const viewBtn = document.createElement('button');
    viewBtn.className = 'post-action-btn';
    const viewIcon = document.createElement('i'); viewIcon.className = 'ph ph-user-circle'; viewIcon.setAttribute('aria-hidden', 'true');
    viewBtn.appendChild(viewIcon);
    viewBtn.appendChild(document.createTextNode(' عرض التفاصيل'));
    viewBtn.addEventListener('click', () => openMemberModal(m.id));

    if (m.presentationUrl) {
        const presBtn = document.createElement('a');
        presBtn.className = 'post-action-btn';
        presBtn.href = _safeURL(m.presentationUrl, '#');
        presBtn.target = '_blank';
        const presIcon = document.createElement('i'); presIcon.className = 'ph ph-presentation-chart'; presIcon.setAttribute('aria-hidden', 'true');
        presBtn.appendChild(presIcon);
        presBtn.appendChild(document.createTextNode(' العرض التقديمي'));
        actions.appendChild(viewBtn);
        actions.appendChild(presBtn);
    } else {
        viewBtn.style.flex = '1';
        actions.appendChild(viewBtn);
    }

    card.appendChild(header);
    card.appendChild(content);
    card.appendChild(tagsDiv);
    card.appendChild(actions);

    return card;
}

function buildPostCard(p) {
    const card = document.createElement('article');
    card.className = 'post-card post-type-project';
    card.dataset.id = p.id;
    card.setAttribute('role', 'article');

    // Header (Icon + Title)
    const header = document.createElement('header');
    header.className = 'post-header';
    
    // Instead of a user avatar, show the post's photo if it exists, else an icon
    const imgWrapper = document.createElement('div');
    imgWrapper.className = 'post-avatar';
    imgWrapper.style.borderRadius = '8px'; // Make it look less like a user avatar and more like a project icon
    if (p.photoUrl) {
        const img = document.createElement('img');
        img.src = _safeURL(p.photoUrl);
        img.alt = '';
        imgWrapper.appendChild(img);
    } else {
        const ic = document.createElement('i');
        ic.className = 'ph ph-presentation-chart';
        ic.style.fontSize = '2rem';
        ic.style.color = 'var(--primary)';
        imgWrapper.appendChild(ic);
        imgWrapper.style.display = 'flex';
        imgWrapper.style.alignItems = 'center';
        imgWrapper.style.justifyContent = 'center';
        imgWrapper.style.backgroundColor = 'rgba(255, 62, 108, 0.1)';
    }

    const info = document.createElement('div');
    info.className = 'post-author-info';
    
    const title = document.createElement('div');
    title.className = 'post-author-name';
    title.textContent = p.title || 'مشروع بدون عنوان';
    
    const authorRole = document.createElement('div');
    authorRole.className = 'post-author-role';
    if (p.authorType === 'team') {
        authorRole.textContent = 'بواسطة الفريق';
    } else {
        const m = state.team.find(x => x.id === p.authorId);
        authorRole.textContent = m ? 'بواسطة ' + m.name : 'بواسطة عضو محذوف';
    }
    
    info.appendChild(title);
    info.appendChild(authorRole);
    header.appendChild(imgWrapper);
    header.appendChild(info);

    // Content
    const content = document.createElement('div');
    content.className = 'post-content';
    let descText = p.description || '';
    if (descText.length > 200) {
        descText = descText.substring(0, 200) + '...';
    }
    content.textContent = descText;

    // Actions
    const actions = document.createElement('div');
    actions.className = 'post-actions';
    
    if (p.externalLink) {
        const linkBtn = document.createElement('a');
        linkBtn.className = 'post-action-btn';
        linkBtn.href = _safeURL(p.externalLink, '#');
        linkBtn.target = '_blank';
        const linkIcon = document.createElement('i'); 
        linkIcon.className = 'ph ph-arrow-up-right'; 
        linkIcon.setAttribute('aria-hidden', 'true');
        linkBtn.appendChild(linkIcon);
        linkBtn.appendChild(document.createTextNode(' عرض المزيد'));
        actions.appendChild(linkBtn);
    }

    card.appendChild(header);
    card.appendChild(content);
    if (p.externalLink) {
        card.appendChild(actions);
    }

    return card;
}

// ----------------------------------------------------------
//  MEMBER MODAL
// ----------------------------------------------------------
function openMemberModal(id) {
    const m = state.team.find(x => x.id === id);
    if (!m) return;

    const modal = document.getElementById('memberModal');
    if (!modal) return;

    // Build all content safely
    const photo = _safeURL(m.photoUrl || '', _fallbackAvatar(m.name));
    const modalPhoto = document.getElementById('modalPhoto');
    if (modalPhoto) {
        modalPhoto.src = photo;
        modalPhoto.onerror = function () { this.onerror = null; this.src = _fallbackAvatar(m.name); };
    }
    document.getElementById('modalName').textContent = m.name || '—';
    document.getElementById('modalRole').textContent = m.role || '—';
    document.getElementById('modalBio').textContent = m.bio || 'عضو فعّال في فريق NTI، شارك في مراحل تطوير المشروع.';
    document.getElementById('modalContributions').textContent = m.contributions || 'تطوير جزء من المشروع والمساهمة في التقرير النهائي والعرض التقديمي.';

    // Skills — chip list, each chip is a span (textContent only)
    const skillsWrap = document.getElementById('modalSkills');
    skillsWrap.replaceChildren();
    const skills = (m.skills && m.skills.length) ? m.skills : ['Cybersecurity', 'Teamwork', 'Problem Solving', 'Communication'];
    skills.forEach(s => {
        const chip = document.createElement('span');
        chip.className = 'skill-chip';
        chip.textContent = s;
        skillsWrap.appendChild(chip);
    });

    // Actions — only render link if URL passes safeURL
    const actions = document.getElementById('modalActions');
    actions.replaceChildren();
    const presURL = _safeURLOrNull(m.presentationUrl);
    if (presURL) {
        const a = document.createElement('a');
        a.href = presURL;
        a.className = 'btn btn-primary';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const i = document.createElement('i'); i.className = 'ph ph-presentation'; i.setAttribute('aria-hidden', 'true');
        const sp = document.createElement('span'); sp.textContent = 'العرض التقديمي';
        a.appendChild(i); a.appendChild(sp);
        actions.appendChild(a);
    }
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-ghost';
    closeBtn.id = 'modalClose2';
    const ci = document.createElement('i'); ci.className = 'ph ph-x'; ci.setAttribute('aria-hidden', 'true');
    const cs = document.createElement('span'); cs.textContent = 'إغلاق';
    closeBtn.appendChild(ci); closeBtn.appendChild(cs);
    closeBtn.addEventListener('click', closeMemberModal);
    actions.appendChild(closeBtn);

    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (state.focusTrapRelease) state.focusTrapRelease();
    state.focusTrapRelease = _focusTrap(modal, closeMemberModal);
}

function closeMemberModal() {
    const modal = document.getElementById('memberModal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (state.focusTrapRelease) { state.focusTrapRelease(); state.focusTrapRelease = null; }
}

function initModal() {
    document.getElementById('modalClose').addEventListener('click', closeMemberModal);
    document.getElementById('memberModal').addEventListener('click', (e) => {
        if (e.target.id === 'memberModal') closeMemberModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('memberModal').classList.contains('active')) {
            closeMemberModal();
        }
    });
}

// ----------------------------------------------------------
//  SEARCH
// ----------------------------------------------------------
function initSearch() {
    const input = document.getElementById('search-input');
    const clear = document.getElementById('clearSearch');
    if (!input) return;
    const wrap = input.closest('.search-wrapper');

    const apply = _debounce((v) => {
        state.filter = v;
        renderFeed();
    }, 150);

    input.addEventListener('input', (e) => {
        const v = e.target.value;
        if (wrap) wrap.classList.toggle('has-value', !!v);
        apply(v);
    });

    if (clear) {
        clear.addEventListener('click', () => {
            input.value = '';
            if (wrap) wrap.classList.remove('has-value');
            state.filter = '';
            renderFeed();
            input.focus();
        });
    }

    // Keyboard shortcut: "/" focuses the search (when not in another input)
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
        e.preventDefault();
        input.focus();
        input.select();
    });
}

// ----------------------------------------------------------
//  INIT
// ----------------------------------------------------------
async function init() {
    initNav();
    initModal();
    initSearch();
    initCounters();
    initScrollSpy();
    initBackToTop();

    await loadSiteData().catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
