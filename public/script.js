(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------

  const KEY_REDACT_PATTERN = /gsk_[A-Za-z0-9_-]{8,}/g;

  function redact(str) {
    if (typeof str !== 'string') return str;
    return str.replace(KEY_REDACT_PATTERN, 'gsk_••••••••');
  }

  function toProxyUrl(rawUrl) {
    return '/proxy?url=' + encodeURIComponent(rawUrl);
  }

  function looksLikeUrl(input) {
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) return true;
    return /^([\w-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed);
  }

  function normalizeToUrl(input) {
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return 'https://' + trimmed;
  }

  function buildSearchUrl(query) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(query) + '&igu=1';
  }

  // Recognizes the exact URL shape buildSearchUrl() produces, so a plain
  // typed search (anything that isn't a URL and isn't a "yt:" shortcut)
  // can be routed to the in-app results view instead of iframing Google.
  function detectWebSearchQuery(target) {
    const match = /^https:\/\/www\.google\.com\/search\?q=([^&]+)&igu=1$/.exec(target);
    return match ? decodeURIComponent(match[1]) : null;
  }

  // Images and News reuse Google's own historical tbm= query parameters
  // (isch/nws) so the address bar reads like a real Google URL, even
  // though both are actually served by the Custom Search JSON API.
  function detectTypedSearchQuery(target, tbmValue) {
    try {
      const u = new URL(target);
      if (u.hostname.replace(/^www\./, '') !== 'google.com' || u.pathname !== '/search') return null;
      if (u.searchParams.get('tbm') !== tbmValue) return null;
      const q = u.searchParams.get('q');
      return q ? decodeURIComponent(q) : null;
    } catch {
      return null;
    }
  }

  function buildImageSearchUrl(query) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(query) + '&tbm=isch&igu=1';
  }

  function buildNewsSearchUrl(query) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(query) + '&tbm=nws&igu=1';
  }

  function buildShortsSearchUrl(query) {
    return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&void_short=1';
  }

  function resolveNavTarget(input) {
    const trimmed = input.trim();
    if (!trimmed) return null;
    return looksLikeUrl(trimmed) ? normalizeToUrl(trimmed) : buildSearchUrl(trimmed);
  }

  function decodeProxied(iframeHref) {
    try {
      const u = new URL(iframeHref, window.location.origin);
      const inner = u.searchParams.get('url');
      return inner ? decodeURIComponent(inner) : iframeHref;
    } catch {
      return iframeHref;
    }
  }

  // Detects YouTube/TikTok video URLs so we can hand them off to the
  // platform's own official embed player instead of routing them through
  // /proxy — see the comment on the /embed route in server.js for why.
  function detectEmbeddable(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^www\.|^m\./, '');

    if (host === 'youtube.com') {
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v');
        if (v) return { service: 'youtube', id: v };
      }
      const shorts = u.pathname.match(/^\/shorts\/([\w-]{6,20})/);
      if (shorts) return { service: 'youtube', id: shorts[1] };
    }
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      if (id) return { service: 'youtube', id };
    }
    if (host === 'tiktok.com') {
      const m = u.pathname.match(/\/video\/(\d+)/);
      if (m) return { service: 'tiktok', id: m[1] };
    }
    return null;
  }

  function embedUrl(service, id) {
    return '/embed?service=' + encodeURIComponent(service) + '&id=' + encodeURIComponent(id);
  }

  // Detects a youtube.com/results search URL so we can render results
  // in-app via the YouTube Data API instead of proxying youtube.com's own
  // search, which BotGuard blocks when loaded through /proxy (see server.js).
  function detectYouTubeSearchQuery(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host !== 'youtube.com' || u.pathname !== '/results') return null;
    const q = u.searchParams.get('search_query') || u.searchParams.get('q');
    if (!q) return null;
    return { query: q, short: u.searchParams.get('void_short') === '1' };
  }

  // Lets the address bar act as a shortcut: "yt cat videos" or
  // "youtube: cat videos" goes straight to an in-app YouTube search instead
  // of a generic Google search.
  function shorthandYouTubeQuery(rawInput) {
    const m = rawInput.trim().match(/^(?:yt|youtube)[:\s]+(.+)$/i);
    return m ? m[1].trim() : null;
  }

  // Detects a YouTube search results URL (youtube.com/results?search_query=
  // or ?q=) and returns the plain query string, or null. Works uniformly
  // whether the URL came from a pasted link, the "yt "/"youtube " shorthand
  // (expanded to this URL shape in navigate()), or a back/forward history
  // entry, so search results reopen correctly either way.
  function youtubeSearchQueryFromUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\.|^m\./, '');
      if (host === 'youtube.com' && u.pathname === '/results') {
        return u.searchParams.get('search_query') || u.searchParams.get('q') || null;
      }
    } catch {
      // fall through
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // VoidTube — a dedicated in-app YouTube-style destination, addressed as
  // void://voidtube (mirroring the existing void://home convention for the
  // blank-tab screen). Kept entirely separate from the legacy "yt "/
  // "youtube:" shorthand and its yt-search-view above, so nothing already
  // working changes shape — this is additive.
  // ---------------------------------------------------------------------

  function buildVoidTubeUrl(params) {
    const qs = new URLSearchParams(params || {});
    const s = qs.toString();
    return 'void://voidtube' + (s ? '?' + s : '');
  }

  // Returns null, or { mode: 'home'|'search'|'watch'|'shorts'|'channel', query, videoId }
  function parseVoidTubeUrl(target) {
    if (typeof target !== 'string' || !target.startsWith('void://voidtube')) return null;
    const qs = new URLSearchParams(target.split('?')[1] || '');
    if (qs.get('v')) return { mode: 'watch', videoId: qs.get('v'), query: qs.get('q') || '' };
    if (qs.get('play')) return { mode: 'play', query: qs.get('play') };
    if (qs.get('channel')) return { mode: 'channel', channelId: qs.get('channel'), sort: qs.get('sort') || 'newest' };
    if (qs.get('shorts') === '1') return { mode: 'shorts', query: qs.get('q') || '', start: qs.get('start') || '' };
    if (qs.get('q')) return { mode: 'search', query: qs.get('q') };
    return { mode: 'home', query: '' };
  }

  function parseAiModeUrl(target) {
    if (typeof target !== 'string' || !target.startsWith('void://ai-mode')) return null;
    const qs = new URLSearchParams(target.split('?')[1] || '');
    return { query: qs.get('q') || '' };
  }

  function buildVoidBuildUrl(params) {
    const qs = new URLSearchParams(params || {});
    const s = qs.toString();
    return 'void://voidbuild' + (s ? '?' + s : '');
  }

  function parseVoidBuildUrl(target) {
    if (typeof target !== 'string' || !target.startsWith('void://voidbuild')) return null;
    const qs = new URLSearchParams(target.split('?')[1] || '');
    return { prompt: qs.get('prompt') || '' };
  }

  // "voidbuild: build me a pomodoro timer" / bare "voidbuild" or "vb"
  function shorthandVoidBuildQuery(rawInput) {
    const trimmed = rawInput.trim();
    if (/^(?:vb|voidbuild)$/i.test(trimmed)) return '';
    const m = trimmed.match(/^(?:vb|voidbuild)[:\s]+(.+)$/i);
    return m ? m[1].trim() : null;
  }

  // "vt jazz piano" / "voidtube: jazz piano" / bare "vt" or "voidtube" for
  // the home feed — same shorthand pattern as shorthandYouTubeQuery above.
  function shorthandVoidTubeQuery(rawInput) {
    const trimmed = rawInput.trim();
    if (/^(?:vt|voidtube)$/i.test(trimmed)) return '';
    const m = trimmed.match(/^(?:vt|voidtube)[:\s]+(.+)$/i);
    return m ? m[1].trim() : null;
  }

  // "ai: how do black holes form" / "aimode how do black holes form"
  function shorthandAiModeQuery(rawInput) {
    const m = rawInput.trim().match(/^(?:ai|aimode)[:\s]+(.+)$/i);
    return m ? m[1].trim() : null;
  }

  // Natural-language playback/search commands, understood from the address
  // bar AND from the Void AI sidebar (see the play_video/search_voidtube
  // tools below) — "Play some lofi", "play Bohemian Rhapsody on voidtube",
  // "find videos about volcanoes", "search for videos on cats".
  function detectPlayCommand(rawInput) {
    const m = rawInput.trim().match(/^play\s+(.+?)(?:\s+on\s+void\s*tube)?$/i);
    return m ? m[1].trim() : null;
  }

  function detectFindVideosCommand(rawInput) {
    const m = rawInput.trim().match(/^(?:find|search for|show me)\s+(?:some\s+)?(?:shorts?|videos?)\s+(?:about|for|on|of)\s+(.+)$/i);
    return m ? m[1].trim() : null;
  }

  // ---------------------------------------------------------------------
  // VoidTube recommendations — a small, local "algorithm" built from what
  // you actually search and watch in VoidTube (stored in this browser's
  // localStorage only; nothing is sent anywhere except as ordinary
  // /api/youtube/search queries built from it). Search "Apple" and your
  // VoidTube home feed starts leaning toward Apple/tech results, the same
  // way it would on real YouTube — this is a real, if simple, personalization
  // loop, not a canned feed.
  // ---------------------------------------------------------------------

  const VT_PROFILE_KEY = 'voidtube_profile_v1';
  const VT_PROFILE_MAX_ENTRIES = 30;

  function loadVtProfile() {
    try {
      const raw = localStorage.getItem(VT_PROFILE_KEY);
      if (!raw) return { searches: [], watches: [] };
      const parsed = JSON.parse(raw);
      return {
        searches: Array.isArray(parsed.searches) ? parsed.searches : [],
        watches: Array.isArray(parsed.watches) ? parsed.watches : [],
      };
    } catch {
      return { searches: [], watches: [] };
    }
  }

  function saveVtProfile(profile) {
    try {
      localStorage.setItem(VT_PROFILE_KEY, JSON.stringify(profile));
    } catch {
      // Storage full/unavailable — recommendations just won't persist.
    }
  }

  function vtProfileHasHistory(profile) {
    return !!(profile && (profile.searches.length || profile.watches.length));
  }

  function recordVtSearch(term) {
    const clean = String(term || '').trim();
    if (!clean) return;
    const profile = loadVtProfile();
    profile.searches = profile.searches.filter((s) => s.term.toLowerCase() !== clean.toLowerCase());
    profile.searches.push({ term: clean, ts: Date.now() });
    if (profile.searches.length > VT_PROFILE_MAX_ENTRIES) profile.searches.shift();
    saveVtProfile(profile);
  }

  function recordVtWatch(video) {
    if (!video || !video.videoId) return;
    const profile = loadVtProfile();
    profile.watches = profile.watches.filter((w) => w.videoId !== video.videoId);
    profile.watches.push({
      videoId: video.videoId,
      title: video.title || '',
      channelId: video.channelId || '',
      channelTitle: video.channelTitle || '',
      tags: Array.isArray(video.tags) ? video.tags.slice(0, 5) : [],
      ts: Date.now(),
    });
    if (profile.watches.length > VT_PROFILE_MAX_ENTRIES) profile.watches.shift();
    saveVtProfile(profile);
  }

  // Turns raw history into a short, recency-weighted list of search
  // queries to actually run — most-recent and most-repeated signals win.
  // Channels you've watched more than once, and your most recent search
  // terms, count for more than a single old mention.
  function buildVtRecommendationSignals(profile, limit) {
    const scores = new Map();
    const bump = (key, weight) => {
      if (!key) return;
      const k = key.trim();
      if (!k) return;
      scores.set(k, (scores.get(k) || 0) + weight);
    };
    const now = Date.now();
    const recencyWeight = (ts) => {
      const ageDays = Math.max(0, (now - ts) / 86400000);
      return Math.max(0.2, 1 - ageDays / 30); // fades out over ~30 days, never to zero
    };

    profile.searches.forEach((s) => bump(s.term, 2 * recencyWeight(s.ts)));
    profile.watches.forEach((w) => {
      bump(w.channelTitle, 1.5 * recencyWeight(w.ts));
      (w.tags || []).slice(0, 2).forEach((t) => bump(t, 1 * recencyWeight(w.ts)));
    });

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit || 3)
      .map(([term]) => term);
  }

  function escapeForDisplay(str) {
    const d = document.createElement('div');
    d.textContent = String(str == null ? '' : str);
    return d.innerHTML;
  }

  let idCounter = 0;
  function nextId() {
    idCounter += 1;
    return 'tab-' + idCounter;
  }

  // ---------------------------------------------------------------------
  // Console panel
  // ---------------------------------------------------------------------

  const consoleLogEl = document.getElementById('console-log');
  const consolePanel = document.getElementById('console-panel');
  const consoleSearchEl = document.getElementById('console-search');
  const consoleErrorBadge = document.getElementById('console-error-badge');
  let consoleFilter = 'all';
  let unseenErrorCount = 0;

  function updateConsoleErrorBadge() {
    if (unseenErrorCount > 0 && consolePanel.classList.contains('hidden')) {
      consoleErrorBadge.textContent = unseenErrorCount > 9 ? '9+' : String(unseenErrorCount);
      consoleErrorBadge.classList.remove('hidden');
    } else {
      consoleErrorBadge.classList.add('hidden');
    }
  }

  function applyConsoleLineVisibility(line) {
    const matchesFilter = consoleFilter === 'all' || line.dataset.type === consoleFilter;
    const query = consoleSearchEl.value.trim().toLowerCase();
    const matchesSearch = !query || line.dataset.text.includes(query);
    line.classList.toggle('console-line-hidden', !(matchesFilter && matchesSearch));
  }

  function logToConsole(type, message) {
    const text = redact(message);
    const line = document.createElement('div');
    line.className = 'console-line type-' + type;
    line.dataset.type = type;
    line.dataset.text = text.toLowerCase();

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = new Date().toLocaleTimeString();
    line.appendChild(ts);
    line.appendChild(document.createTextNode(' ' + text));

    if (type === 'error') {
      const fixBtn = document.createElement('button');
      fixBtn.type = 'button';
      fixBtn.className = 'console-fix-btn';
      fixBtn.textContent = '🔧 Fix this';
      const relatedTabId = activeTabId;
      fixBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        requestVoidAiFix(text, relatedTabId);
      });
      line.appendChild(fixBtn);

      unseenErrorCount += 1;
      updateConsoleErrorBadge();
    }

    applyConsoleLineVisibility(line);
    consoleLogEl.appendChild(line);
    consoleLogEl.scrollTop = consoleLogEl.scrollHeight;
  }

  document.getElementById('console-toggle').addEventListener('click', () => {
    consolePanel.classList.toggle('hidden');
    if (!consolePanel.classList.contains('hidden')) {
      unseenErrorCount = 0;
      updateConsoleErrorBadge();
    }
  });
  document.getElementById('console-close-btn').addEventListener('click', () => {
    consolePanel.classList.add('hidden');
  });
  document.getElementById('console-clear-btn').addEventListener('click', () => {
    consoleLogEl.innerHTML = '';
    unseenErrorCount = 0;
    updateConsoleErrorBadge();
  });
  document.getElementById('console-copy-btn').addEventListener('click', () => {
    const btn = document.getElementById('console-copy-btn');
    const lines = Array.from(consoleLogEl.querySelectorAll('.console-line:not(.console-line-hidden)')).map((l) => l.textContent);
    const text = lines.join('\n');
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = original;
        }, 1200);
      })
      .catch(() => {});
  });
  document.querySelectorAll('.console-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.console-filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      consoleFilter = btn.dataset.filter;
      consoleLogEl.querySelectorAll('.console-line').forEach(applyConsoleLineVisibility);
    });
  });
  consoleSearchEl.addEventListener('input', () => {
    consoleLogEl.querySelectorAll('.console-line').forEach(applyConsoleLineVisibility);
  });

  // Hands a console error straight to Void AI to actually investigate and
  // fix — not just explain. Opens the sidebar, attaches the tab the error
  // happened on (if any) as context, and sends a diagnostic prompt through
  // the normal tool-calling loop, so Void AI can reload, navigate, search
  // the web, or read a page as it works the problem.
  function requestVoidAiFix(errorText, relatedTabId) {
    aiPanel.classList.remove('hidden');
    if (relatedTabId && tabs.has(relatedTabId)) {
      selectedContextTabIds.add(relatedTabId);
      renderContextChips();
    }
    const tabNote = relatedTabId && tabs.has(relatedTabId) ? ` It happened on the tab I've attached as context.` : '';
    aiInput.value = `There's an error in the browser console: "${errorText}".${tabNote} Please look into it and actually try to fix it or work around it (reload, navigate somewhere that works, search the web for the error if it's unfamiliar, etc.), then tell me what was wrong and what you did.`;
    aiForm.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  window.addEventListener('error', (e) => {
    logToConsole('error', 'Uncaught error: ' + (e.message || 'unknown error'));
  });
  window.addEventListener('unhandledrejection', (e) => {
    logToConsole('error', 'Unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });

  // Bridges error/network events reported by pages loaded through /proxy
  // (see the shim server.js injects into every proxied HTML page) into this
  // same console panel, so failures happening deep inside a site's own JS —
  // a blocked API call, a script error — are visible here instead of
  // silently breaking the page.
  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || data.__void !== true) return;
    if (data.kind === 'network') {
      logToConsole(data.ok === false ? 'error' : 'network', `[page] ${data.method || 'GET'} ${data.status ?? '?'} ${data.url}`);
    } else if (data.kind === 'error') {
      logToConsole('error', `[page] ${data.message}`);
    }
  });

  // A previous visit to a PWA (YouTube, Reddit, etc.) proxied through this
  // origin may have left a stale service worker registered for
  // http://localhost:3000 itself. A worker like that intercepts network
  // requests for every tab on this origin — including brand-new ones — and
  // can silently serve its own cached "offline" page instead of ever
  // reaching our server, no matter what the current page's own JS does.
  // Clear out anything like that every time Void's shell boots, so a bad
  // state from a previous session can't persist.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => {
        regs.forEach((reg) => reg.unregister());
        if (regs.length) {
          logToConsole('info', `Cleared ${regs.length} stale service worker registration(s) from a previous session.`);
        }
      })
      .catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Shortcuts
  // ---------------------------------------------------------------------

  const SHORTCUT_STORAGE_KEY = 'void-shortcuts-v1';
  const DEFAULT_SHORTCUTS = [
    { name: 'Gmail', url: 'https://mail.google.com', color: '#ea4335' },
    { name: 'YouTube', url: 'https://www.youtube.com', color: '#ff0000' },
    { name: 'Maps', url: 'https://maps.google.com', color: '#34a853' },
    { name: 'Translate', url: 'https://translate.google.com', color: '#4285f4' },
    { name: 'GitHub', url: 'https://github.com', color: '#333333' },
    { name: 'Wikipedia', url: 'https://en.wikipedia.org', color: '#000000' },
    { name: 'VoidBuild', url: 'void://voidbuild', color: '#8b5cf6', beta: true },
  ];

  function loadShortcuts() {
    try {
      const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
      if (!raw) return DEFAULT_SHORTCUTS.slice();
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_SHORTCUTS.slice();
      // Existing saved shortcut lists predate VoidBuild — add its tile once
      // rather than only on a fresh install.
      if (!list.some((sc) => sc.url === 'void://voidbuild')) {
        list.push({ name: 'VoidBuild', url: 'void://voidbuild', color: '#8b5cf6', beta: true });
        saveShortcuts(list);
      }
      return list;
    } catch {
      return DEFAULT_SHORTCUTS.slice();
    }
  }

  function saveShortcuts(list) {
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(list));
  }

  let shortcuts = loadShortcuts();

  function randomColor() {
    const palette = ['#8b5cf6', '#ff4fd8', '#4285f4', '#34a853', '#f59e0b', '#ef4444', '#06b6d4'];
    return palette[Math.floor(Math.random() * palette.length)];
  }

  // ---------------------------------------------------------------------
  // Shortcut modal
  // ---------------------------------------------------------------------

  const shortcutModal = document.getElementById('shortcut-modal');
  const shortcutNameInput = document.getElementById('shortcut-name-input');
  const shortcutUrlInput = document.getElementById('shortcut-url-input');

  document.getElementById('shortcut-cancel-btn').addEventListener('click', () => {
    shortcutModal.classList.add('hidden');
  });

  document.getElementById('shortcut-save-btn').addEventListener('click', () => {
    const name = shortcutNameInput.value.trim();
    const url = shortcutUrlInput.value.trim();
    if (!name || !url) {
      logToConsole('error', 'Shortcut needs both a name and a URL.');
      return;
    }
    shortcuts.push({ name, url: normalizeToUrl(url), color: randomColor() });
    saveShortcuts(shortcuts);
    shortcutModal.classList.add('hidden');
    shortcutNameInput.value = '';
    shortcutUrlInput.value = '';
    renderAllHomeScreens();
    logToConsole('info', `Shortcut added: ${name}`);
  });

  function openShortcutModal() {
    shortcutModal.classList.remove('hidden');
    shortcutNameInput.focus();
  }

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------

  const tabsContainer = document.getElementById('tabs-container');
  const viewport = document.getElementById('viewport');
  const backBtn = document.getElementById('back-btn');
  const forwardBtn = document.getElementById('forward-btn');
  const reloadBtn = document.getElementById('reload-btn');
  const homeBtn = document.getElementById('home-btn');
  const urlInput = document.getElementById('url-input');
  const urlForm = document.getElementById('url-form');
  const loadingBar = document.getElementById('loading-bar');

  const tabs = new Map(); // id -> tab object
  let activeTabId = null;

  function createHomeScreen(tab) {
    const wrap = document.createElement('div');
    wrap.className = 'home-screen';

    const logo = document.createElement('div');
    logo.className = 'void-logo';
    logo.textContent = 'Void';
    wrap.appendChild(logo);

    const searchBar = document.createElement('div');
    searchBar.className = 'home-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search the Void or type a URL';
    const icon = document.createElement('span');
    icon.className = 'home-search-icon';
    icon.textContent = '🔍';
    searchBar.appendChild(icon);
    searchBar.appendChild(searchInput);
    searchBar.addEventListener('click', () => searchInput.focus());
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && searchInput.value.trim()) {
        navigate(tab.id, searchInput.value.trim());
      }
    });
    wrap.appendChild(searchBar);

    const grid = document.createElement('div');
    grid.className = 'shortcuts-grid';
    grid.dataset.role = 'shortcuts-grid';
    wrap.appendChild(grid);

    renderShortcutGrid(grid, tab);

    const customizeBtn = document.createElement('button');
    customizeBtn.type = 'button';
    customizeBtn.className = 'home-customize-btn';
    customizeBtn.innerHTML = '✏️ Customize Void';
    customizeBtn.addEventListener('click', () => openCustomizePanel());
    tab.viewEl.appendChild(customizeBtn);

    tab.homeScreenEl = wrap;
    tab.homeGridEl = grid;
    return wrap;
  }

  // --- Favicons -------------------------------------------------------
  // Real site icons for tabs and shortcuts, via Google's public favicon
  // service — a plain <img>, no proxying needed, and it degrades to a
  // generic icon on its own for sites with nothing set, so no visible
  // error state to worry about.
  function faviconUrl(rawUrl, size) {
    try {
      const u = new URL(rawUrl, window.location.origin);
      if (!/^https?:$/.test(u.protocol)) return null;
      return `https://www.google.com/s2/favicons?sz=${size || 32}&domain=${encodeURIComponent(u.hostname)}`;
    } catch {
      return null;
    }
  }

  function setTabFavicon(tab, url) {
    const src = faviconUrl(url, 32);
    if (!tab.faviconEl) return;
    if (!src) {
      clearTabFavicon(tab);
      return;
    }
    tab.faviconEl.src = src;
    tab.faviconEl.style.display = '';
  }

  function clearTabFavicon(tab) {
    if (!tab.faviconEl) return;
    tab.faviconEl.removeAttribute('src');
    tab.faviconEl.style.display = 'none';
  }

  function renderShortcutGrid(grid, tab) {
    grid.innerHTML = '';
    shortcuts.forEach((sc, index) => {
      const item = document.createElement('div');
      item.className = 'shortcut';

      const remove = document.createElement('div');
      remove.className = 'shortcut-remove';
      remove.textContent = '✕';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        shortcuts.splice(index, 1);
        saveShortcuts(shortcuts);
        renderAllHomeScreens();
      });
      item.appendChild(remove);

      const iconEl = document.createElement('div');
      iconEl.className = 'shortcut-icon';
      iconEl.style.background = sc.color || randomColor();
      iconEl.textContent = sc.name.charAt(0).toUpperCase();
      if (sc.beta) {
        const beta = document.createElement('span');
        beta.className = 'shortcut-beta-badge';
        beta.textContent = 'BETA';
        item.appendChild(beta);
      }

      const favSrc = faviconUrl(sc.url, 64);
      if (favSrc) {
        const favImg = document.createElement('img');
        favImg.className = 'shortcut-icon-img';
        favImg.alt = '';
        favImg.addEventListener('load', () => {
          favImg.style.display = 'block';
        });
        favImg.addEventListener('error', () => favImg.remove());
        favImg.src = favSrc;
        iconEl.appendChild(favImg);
      }

      item.appendChild(iconEl);

      const label = document.createElement('div');
      label.className = 'shortcut-label';
      label.textContent = sc.name;
      item.appendChild(label);

      item.addEventListener('click', () => navigate(tab.id, sc.url));
      grid.appendChild(item);
    });

    const addItem = document.createElement('div');
    addItem.className = 'shortcut shortcut-add';
    const addIcon = document.createElement('div');
    addIcon.className = 'shortcut-icon';
    addIcon.textContent = '+';
    addItem.appendChild(addIcon);
    const addLabel = document.createElement('div');
    addLabel.className = 'shortcut-label';
    addLabel.textContent = 'Add shortcut';
    addItem.appendChild(addLabel);
    addItem.addEventListener('click', openShortcutModal);
    grid.appendChild(addItem);
  }

  function renderAllHomeScreens() {
    tabs.forEach((tab) => {
      if (tab.homeGridEl) renderShortcutGrid(tab.homeGridEl, tab);
    });
  }

  function createTab(initialUrl) {
    const id = nextId();
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.tabId = id;

    const faviconEl = document.createElement('img');
    faviconEl.className = 'tab-favicon';
    faviconEl.alt = '';
    faviconEl.style.display = 'none';
    faviconEl.addEventListener('error', () => {
      faviconEl.style.display = 'none';
    });
    tabEl.appendChild(faviconEl);

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = 'New Tab';
    tabEl.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(id);
    });
    tabEl.appendChild(closeBtn);

    tabEl.addEventListener('click', () => switchTab(id));
    tabsContainer.appendChild(tabEl);

    const viewEl = document.createElement('div');
    viewEl.className = 'tab-view';
    viewport.appendChild(viewEl);

    const tab = {
      id,
      tabEl,
      titleEl,
      faviconEl,
      viewEl,
      iframe: null,
      homeScreenEl: null,
      homeGridEl: null,
      searchViewEl: null,
      history: [],
      historyIndex: -1,
      currentUrl: null,
      suppressPush: false,
      embedMode: false,
    };

    tabs.set(id, tab);
    viewEl.appendChild(createHomeScreen(tab));
    switchTab(id);

    if (initialUrl) {
      navigate(id, initialUrl);
    }

    logToConsole('info', `New tab opened (${id}).`);
    saveSession();
    return tab;
  }

  function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;

    tab.tabEl.remove();
    tab.viewEl.remove();
    tabs.delete(id);
    logToConsole('info', `Tab closed (${id}).`);
    renderContextChips();
    saveSession();

    if (tabs.size === 0) {
      createTab(null);
      return;
    }

    if (activeTabId === id) {
      const remaining = Array.from(tabs.keys());
      switchTab(remaining[remaining.length - 1]);
    }
  }

  function switchTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;

    tabs.forEach((t) => {
      t.tabEl.classList.toggle('active', t.id === id);
      t.viewEl.classList.toggle('active', t.id === id);
    });

    activeTabId = id;
    urlInput.value = tab.currentUrl || '';
    updateNavButtons(tab);
  }

  function updateNavButtons(tab) {
    backBtn.disabled = tab.historyIndex <= 0;
    forwardBtn.disabled = tab.historyIndex >= tab.history.length - 1;
    recordHistory(tab);
    saveSession();
  }

  function setLoading(active) {
    if (active) {
      loadingBar.classList.remove('done');
      loadingBar.classList.add('active');
    } else {
      loadingBar.classList.remove('active');
      loadingBar.classList.add('done');
      setTimeout(() => loadingBar.classList.remove('done'), 350);
    }
  }

  // Shows the iframe (creating it if needed) and hides the search-results
  // view if one exists for this tab. Home screen removal stays one-way, same
  // as before this feature existed.
  // Hides every "page" a tab can show (iframe, search results, VoidTube,
  // AI Mode) without destroying any of them, so switching between modes —
  // e.g. a web search, then a YouTube link, then back — never loses state
  // it doesn't need to.
  function hideAllViews(tab) {
    if (tab.homeScreenEl) {
      tab.homeScreenEl.remove();
      tab.homeScreenEl = null;
    }
    if (tab.iframe) tab.iframe.style.display = 'none';
    if (tab.searchViewEl) tab.searchViewEl.classList.add('hidden');
    if (tab.voidTubeViewEl) tab.voidTubeViewEl.classList.add('hidden');
    if (tab.aiModeViewEl) tab.aiModeViewEl.classList.add('hidden');
    if (tab.voidBuildViewEl) tab.voidBuildViewEl.classList.add('hidden');
  }

  function showIframeView(tab) {
    hideAllViews(tab);
    const iframe = ensureIframe(tab);
    iframe.style.display = '';
    return iframe;
  }

  function ensureSearchView(tab) {
    if (!tab.searchViewEl) {
      const el = document.createElement('div');
      el.className = 'yt-search-view hidden';
      tab.viewEl.appendChild(el);
      tab.searchViewEl = el;
    }
    return tab.searchViewEl;
  }

  // Shows the YouTube search-results view, hiding the iframe (without
  // destroying it, so switching back to normal browsing keeps working).
  function showSearchView(tab) {
    hideAllViews(tab);
    const view = ensureSearchView(tab);
    view.classList.remove('hidden');
    return view;
  }

  function ensureVoidTubeView(tab) {
    if (!tab.voidTubeViewEl) {
      const el = document.createElement('div');
      el.className = 'voidtube-view hidden';
      tab.viewEl.appendChild(el);
      tab.voidTubeViewEl = el;
    }
    return tab.voidTubeViewEl;
  }

  function showVoidTubeView(tab) {
    hideAllViews(tab);
    const view = ensureVoidTubeView(tab);
    view.classList.remove('hidden');
    return view;
  }

  function ensureAiModeView(tab) {
    if (!tab.aiModeViewEl) {
      const el = document.createElement('div');
      el.className = 'ai-mode-view hidden';
      tab.viewEl.appendChild(el);
      tab.aiModeViewEl = el;
    }
    return tab.aiModeViewEl;
  }

  function showAiModeView(tab) {
    hideAllViews(tab);
    const view = ensureAiModeView(tab);
    view.classList.remove('hidden');
    return view;
  }

  function ensureVoidBuildView(tab) {
    if (!tab.voidBuildViewEl) {
      const el = document.createElement('div');
      el.className = 'vb-view hidden';
      tab.viewEl.appendChild(el);
      tab.voidBuildViewEl = el;
    }
    return tab.voidBuildViewEl;
  }

  function showVoidBuildView(tab) {
    hideAllViews(tab);
    const view = ensureVoidBuildView(tab);
    view.classList.remove('hidden');
    return view;
  }

  function setSearchStatus(view, text, isError) {
    view.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'yt-search-status' + (isError ? ' error' : '');
    div.textContent = text;
    view.appendChild(div);
  }

  async function runYouTubeSearch(tab, query, target, logPrefix, short) {
    const view = showSearchView(tab);
    tab.embedMode = false;
    tab.currentUrl = target;
    tab.titleEl.textContent = `"${query}" — ${short ? 'Short videos' : 'YouTube'} search`;
    tab.titleEl.title = target;
    if (activeTabId === tab.id) urlInput.value = target;

    if (!tab.suppressPush) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(target);
      tab.historyIndex = tab.history.length - 1;
    }
    tab.suppressPush = false;
    updateNavButtons(tab);

    logToConsole('info', `${logPrefix} ${short ? 'short video' : 'YouTube'} search: "${query}" (via YouTube Data API, in-app results).`);

    view.innerHTML = '';
    view.appendChild(buildSearchPageHeader(tab, query, short ? 'shorts' : 'videos'));

    const resultsHost = document.createElement('div');
    resultsHost.className = 'gsearch-results-host gsearch-results-host-wide';
    view.appendChild(resultsHost);
    setSearchStatus(resultsHost, short ? 'Searching short videos…' : 'Searching YouTube…');

    try {
      const started = Date.now();
      const qs = new URLSearchParams({ q: query });
      if (short) qs.set('duration', 'short');
      const res = await fetch('/api/youtube/search?' + qs.toString());
      const data = await res.json();
      const elapsed = Date.now() - started;
      setLoading(false);

      if (!res.ok || data.error) {
        setSearchStatus(resultsHost, data.error || 'YouTube search failed.', true);
        logToConsole('error', `YouTube search error: ${data.error || res.status}`);
        return;
      }

      if (!data.results || !data.results.length) {
        setSearchStatus(resultsHost, 'No results.');
        logToConsole('success', `YouTube search returned 0 results in ${elapsed}ms.`);
        return;
      }

      resultsHost.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'yt-search-grid';

      data.results.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'yt-search-card';

        const thumb = document.createElement('img');
        thumb.className = 'yt-search-thumb';
        thumb.src = item.thumbnail;
        thumb.alt = item.title;
        thumb.loading = 'lazy';
        card.appendChild(thumb);

        const titleEl = document.createElement('div');
        titleEl.className = 'yt-search-title';
        titleEl.textContent = item.title;
        card.appendChild(titleEl);

        const channelEl = document.createElement('div');
        channelEl.className = 'yt-search-channel';
        channelEl.textContent = item.channelTitle;
        card.appendChild(channelEl);

        card.addEventListener('click', () => {
          navigate(tab.id, 'https://www.youtube.com/watch?v=' + item.videoId);
        });

        grid.appendChild(card);
      });

      resultsHost.appendChild(grid);
      logToConsole('success', `YouTube search returned ${data.results.length} results in ${elapsed}ms.`);
    } catch (err) {
      setLoading(false);
      setSearchStatus(resultsHost, 'Could not reach YouTube search.', true);
      logToConsole('error', `YouTube search network error: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // VoidTube rendering
  // ---------------------------------------------------------------------

  function relativeTime(iso) {
    const then = new Date(iso).getTime();
    if (!iso || Number.isNaN(then)) return '';
    const diff = Math.max(0, Date.now() - then);
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? '' : 's'} ago`;
  }

  function formatCount(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '';
    if (num >= 1e9) return (num / 1e9).toFixed(num >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(num >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(num >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(num);
  }

  function buildVoidTubeVideoCard(tab, item, opts) {
    opts = opts || {};
    const card = document.createElement('div');
    card.className = 'vt-card' + (opts.compact ? ' vt-card-compact' : '');

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'vt-card-thumb-wrap';
    const thumb = document.createElement('img');
    thumb.className = 'vt-card-thumb';
    thumb.src = item.thumbnail;
    thumb.alt = item.title;
    thumb.loading = 'lazy';
    thumbWrap.appendChild(thumb);
    if (item.duration) {
      const dur = document.createElement('span');
      dur.className = 'vt-card-duration';
      dur.textContent = item.duration;
      thumbWrap.appendChild(dur);
    }
    card.appendChild(thumbWrap);

    const meta = document.createElement('div');
    meta.className = 'vt-card-meta';
    const title = document.createElement('div');
    title.className = 'vt-card-title';
    title.textContent = item.title;
    meta.appendChild(title);

    const channelRow = document.createElement('div');
    channelRow.className = 'vt-card-channel-row';
    if (item.channelId) {
      const avatar = document.createElement('img');
      avatar.className = 'vt-card-avatar';
      avatar.alt = '';
      avatar.loading = 'lazy';
      if (opts.avatarUrl) {
        avatar.src = opts.avatarUrl;
      } else {
        avatar.dataset.channelId = item.channelId;
      }
      channelRow.appendChild(avatar);
    }

    const channel = document.createElement('div');
    channel.className = 'vt-card-channel';
    if (item.channelTitle) {
      const channelLink = document.createElement('span');
      channelLink.className = 'vt-card-channel-link';
      channelLink.textContent = item.channelTitle;
      if (item.channelId) {
        channelLink.addEventListener('click', (e) => {
          e.stopPropagation();
          navigate(tab.id, buildVoidTubeUrl({ channel: item.channelId }));
        });
      }
      channel.appendChild(channelLink);
    }
    const extraBits = [];
    if (item.viewCount) extraBits.push(formatCount(item.viewCount) + ' views');
    if (item.publishedAt) extraBits.push(relativeTime(item.publishedAt));
    if (extraBits.length) {
      const extra = document.createElement('span');
      extra.className = 'vt-card-channel-extra';
      extra.textContent = (item.channelTitle ? ' • ' : '') + extraBits.join(' • ');
      channel.appendChild(extra);
    }
    channelRow.appendChild(channel);
    meta.appendChild(channelRow);
    card.appendChild(meta);

    card.addEventListener('click', () => navigate(tab.id, buildVoidTubeUrl({ v: item.videoId })));
    return card;
  }

  // Batches channel-avatar lookups: every card starts with a plain grey
  // circle (data-channel-id set, no src), and this fills in the real
  // profile pictures for a whole container in one request — channels.list
  // accepts up to 50 ids per call, so a full grid costs one API call, not
  // one per card.
  async function hydrateChannelAvatars(container) {
    if (!container) return;
    const imgs = Array.from(container.querySelectorAll('img.vt-card-avatar[data-channel-id], img.vt-watch-channel-avatar[data-channel-id], img.vt-shorts-info-avatar[data-channel-id]'));
    if (!imgs.length) return;
    const ids = Array.from(new Set(imgs.map((img) => img.dataset.channelId))).slice(0, 50);
    if (!ids.length) return;
    try {
      const res = await fetch('/api/youtube/channels?ids=' + encodeURIComponent(ids.join(',')));
      const data = await res.json();
      if (!res.ok || !data.channels) return;
      imgs.forEach((img) => {
        const info = data.channels[img.dataset.channelId];
        if (info && info.thumbnail) img.src = info.thumbnail;
        delete img.dataset.channelId;
      });
    } catch {
      // Non-fatal — cards just keep their placeholder circle.
    }
  }

  function buildShortsRail(tab, items) {
    const section = document.createElement('div');
    section.className = 'vt-shorts-section';
    const label = document.createElement('div');
    label.className = 'vt-section-label';
    label.textContent = '⚡ Shorts';
    section.appendChild(label);
    const rail = document.createElement('div');
    rail.className = 'vt-shorts-rail';
    items.slice(0, 12).forEach((item) => {
      const card = document.createElement('div');
      card.className = 'vt-shorts-card';
      const thumb = document.createElement('img');
      thumb.className = 'vt-shorts-card-thumb';
      thumb.src = item.thumbnail;
      thumb.alt = item.title;
      thumb.loading = 'lazy';
      card.appendChild(thumb);
      const title = document.createElement('div');
      title.className = 'vt-shorts-card-title';
      title.textContent = item.title;
      card.appendChild(title);
      card.addEventListener('click', () => navigate(tab.id, buildVoidTubeUrl({ shorts: '1', start: item.videoId })));
      rail.appendChild(card);
    });
    section.appendChild(rail);
    return section;
  }

  function buildVoidTubeHeader(tab, parsed) {
    const header = document.createElement('div');
    header.className = 'vt-header';

    const bar = document.createElement('form');
    bar.className = 'vt-search-bar';
    const logo = document.createElement('div');
    logo.className = 'vt-logo';
    logo.innerHTML = '<span class="vt-logo-icon">▶</span> VoidTube';
    logo.addEventListener('click', () => navigate(tab.id, buildVoidTubeUrl({})));
    bar.appendChild(logo);

    const inputWrap = document.createElement('div');
    inputWrap.className = 'vt-search-input-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search VoidTube';
    input.value = parsed.query || '';
    input.spellcheck = false;
    inputWrap.appendChild(input);
    const searchBtn = document.createElement('button');
    searchBtn.type = 'submit';
    searchBtn.className = 'vt-search-btn';
    searchBtn.textContent = '🔍';
    inputWrap.appendChild(searchBtn);
    bar.appendChild(inputWrap);

    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) navigate(tab.id, buildVoidTubeUrl({ q: input.value.trim() }));
    });
    header.appendChild(bar);

    const nav = document.createElement('div');
    nav.className = 'vt-nav';
    [
      { key: 'home', label: '🏠 Home', build: () => buildVoidTubeUrl({}) },
      { key: 'shorts', label: '⚡ Shorts', build: () => buildVoidTubeUrl({ shorts: '1' }) },
    ].forEach((def) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vt-nav-btn';
      btn.textContent = def.label;
      if (def.key === parsed.mode) btn.classList.add('active');
      btn.addEventListener('click', () => navigate(tab.id, def.build()));
      nav.appendChild(btn);
    });
    header.appendChild(nav);

    return header;
  }

  function buildVtEmptyRecommendationCard() {
    const card = document.createElement('div');
    card.className = 'vt-empty-reco-card';
    const title = document.createElement('div');
    title.className = 'vt-empty-reco-title';
    title.textContent = 'Try searching to get started';
    const sub = document.createElement('div');
    sub.className = 'vt-empty-reco-sub';
    sub.textContent = "Start watching videos to help us build a feed of videos you'll love.";
    card.appendChild(title);
    card.appendChild(sub);
    return card;
  }

  async function renderVtRecommendedSection(tab, body, profile) {
    const signals = buildVtRecommendationSignals(profile, 3);
    if (!signals.length) return;

    const label = document.createElement('div');
    label.className = 'vt-section-label';
    label.textContent = 'Recommended for you';
    body.appendChild(label);

    const status = document.createElement('div');
    status.className = 'yt-search-status';
    status.textContent = 'Building your feed…';
    body.appendChild(status);

    try {
      const responses = await Promise.all(
        signals.map((term) => fetch('/api/youtube/search?maxResults=8&q=' + encodeURIComponent(term)).then((r) => r.json()).catch(() => ({})))
      );
      status.remove();
      const watchedIds = new Set(profile.watches.map((w) => w.videoId));
      const seen = new Set();
      const merged = [];
      responses.forEach((data) => {
        (data.results || []).forEach((item) => {
          if (seen.has(item.videoId) || watchedIds.has(item.videoId)) return;
          seen.add(item.videoId);
          merged.push(item);
        });
      });
      if (!merged.length) {
        const empty = document.createElement('div');
        empty.className = 'yt-search-status';
        empty.textContent = 'Nothing new to recommend yet — keep watching!';
        body.appendChild(empty);
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'vt-grid';
      merged.slice(0, 24).forEach((item) => grid.appendChild(buildVoidTubeVideoCard(tab, item)));
      body.appendChild(grid);
      hydrateChannelAvatars(grid);
      const basedOn = document.createElement('div');
      basedOn.className = 'vt-reco-based-on';
      basedOn.textContent = 'Based on: ' + signals.join(', ');
      body.appendChild(basedOn);
    } catch {
      status.textContent = 'Could not build your recommended feed.';
      status.classList.add('error');
    }
  }

  async function renderVoidTubeHome(tab, body) {
    setSearchStatus(body, 'Loading VoidTube…');
    try {
      const [trendingRes, shortsRes] = await Promise.all([
        fetch('/api/youtube/trending'),
        fetch('/api/youtube/search?q=shorts&duration=short&order=viewCount&maxResults=12'),
      ]);
      const trendingData = await trendingRes.json();
      const shortsData = await shortsRes.json().catch(() => ({}));
      setLoading(false);
      body.innerHTML = '';

      const chips = document.createElement('div');
      chips.className = 'vt-chip-row';
      ['Music', 'Gaming', 'News', 'Live', 'Comedy', 'Cooking', 'Technology', 'Sports'].forEach((label) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'vt-chip';
        chip.textContent = label;
        chip.addEventListener('click', () => navigate(tab.id, buildVoidTubeUrl({ q: label })));
        chips.appendChild(chip);
      });
      body.appendChild(chips);

      const profile = loadVtProfile();
      if (!vtProfileHasHistory(profile)) {
        body.appendChild(buildVtEmptyRecommendationCard());
      } else {
        await renderVtRecommendedSection(tab, body, profile);
      }

      if (shortsData.results && shortsData.results.length) {
        body.appendChild(buildShortsRail(tab, shortsData.results));
      }

      const label = document.createElement('div');
      label.className = 'vt-section-label';
      label.textContent = 'Trending';
      body.appendChild(label);

      if (!trendingRes.ok || trendingData.error) {
        const err = document.createElement('div');
        err.className = 'yt-search-status error';
        err.textContent = trendingData.error || 'Could not load trending videos.';
        body.appendChild(err);
      } else if (!trendingData.results || !trendingData.results.length) {
        setSearchStatus(body, 'No trending videos available.');
      } else {
        const grid = document.createElement('div');
        grid.className = 'vt-grid';
        trendingData.results.forEach((item) => grid.appendChild(buildVoidTubeVideoCard(tab, item)));
        body.appendChild(grid);
        hydrateChannelAvatars(grid);
      }
      logToConsole('success', 'VoidTube home loaded.');
    } catch (err) {
      setLoading(false);
      setSearchStatus(body, 'Could not reach VoidTube.', true);
      logToConsole('error', `VoidTube home error: ${err.message}`);
    }
  }

  async function renderVoidTubeSearch(tab, body, query) {
    setSearchStatus(body, `Searching VoidTube for "${query}"…`);
    recordVtSearch(query);
    try {
      const res = await fetch('/api/youtube/search?q=' + encodeURIComponent(query));
      const data = await res.json();
      setLoading(false);
      if (!res.ok || data.error) {
        setSearchStatus(body, data.error || 'VoidTube search failed.', true);
        logToConsole('error', `VoidTube search error: ${data.error || res.status}`);
        return;
      }
      if (!data.results || !data.results.length) {
        setSearchStatus(body, 'No results.');
        return;
      }
      body.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'vt-grid';
      data.results.forEach((item) => grid.appendChild(buildVoidTubeVideoCard(tab, item)));
      body.appendChild(grid);
      hydrateChannelAvatars(grid);
      logToConsole('success', `VoidTube search returned ${data.results.length} results.`);
    } catch (err) {
      setLoading(false);
      setSearchStatus(body, 'Could not reach VoidTube search.', true);
      logToConsole('error', `VoidTube search network error: ${err.message}`);
    }
  }

  function buildVoidTubeAiBox(video) {
    const box = document.createElement('div');
    box.className = 'vt-ai-box';

    const header = document.createElement('div');
    header.className = 'vt-ai-box-header';
    header.innerHTML = '<span class="ai-star">✦</span> Ask Void AI about this video';
    box.appendChild(header);

    const chips = document.createElement('div');
    chips.className = 'vt-ai-chip-row';
    const answerEl = document.createElement('div');
    answerEl.className = 'vt-ai-answer hidden';
    const form = document.createElement('form');
    form.className = 'vt-ai-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ask about this video…';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.textContent = '➤';
    form.appendChild(input);
    form.appendChild(sendBtn);

    const systemMessage =
      'You are Void AI, answering questions about a specific YouTube video inside VoidTube. ' +
      "Use ONLY the metadata below — you cannot watch the video or read a transcript, so never claim to have watched it; " +
      "speak from the title/description/channel instead, and say plainly when something isn't covered by the metadata.\n\n" +
      `Title: ${video.title}\nChannel: ${video.channelTitle}\n` +
      (video.tags && video.tags.length ? `Tags: ${video.tags.join(', ')}\n` : '') +
      `Description:\n${(video.description || '(none provided)').slice(0, 2000)}`;

    function ask(question) {
      answerEl.classList.remove('hidden');
      answerEl.textContent = '';
      const cursor = document.createElement('span');
      cursor.className = 'vt-ai-cursor';
      answerEl.appendChild(cursor);
      streamVoidAi(
        [
          { role: 'system', content: systemMessage },
          { role: 'user', content: question },
        ],
        (soFar) => {
          answerEl.textContent = soFar;
          answerEl.appendChild(cursor);
        },
        () => cursor.remove(),
        (errMsg) => {
          answerEl.textContent = errMsg || 'Void AI could not answer.';
          answerEl.classList.add('vt-ai-answer-error');
        }
      );
    }

    ['Summarize this video', "What's this video about?", 'Key takeaways'].forEach((label) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'vt-ai-chip';
      chip.textContent = label;
      chip.addEventListener('click', () => ask(label));
      chips.appendChild(chip);
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      ask(q);
      input.value = '';
    });

    box.appendChild(chips);
    box.appendChild(answerEl);
    box.appendChild(form);
    return box;
  }

  async function renderVoidTubeWatch(tab, body, videoId) {
    setSearchStatus(body, 'Loading video…');
    try {
      const vRes = await fetch('/api/youtube/videos?ids=' + encodeURIComponent(videoId));
      const vData = await vRes.json();
      setLoading(false);
      if (!vRes.ok || vData.error || !vData.videos || !vData.videos[0]) {
        setSearchStatus(body, (vData && vData.error) || 'Video not found.', true);
        return;
      }
      const video = vData.videos[0];
      tab.titleEl.textContent = `${video.title} — VoidTube`;
      tab.titleEl.title = video.title;
      recordVtWatch(video);

      body.innerHTML = '';
      const layout = document.createElement('div');
      layout.className = 'vt-watch-layout';

      const main = document.createElement('div');
      main.className = 'vt-watch-main';

      const playerWrap = document.createElement('div');
      playerWrap.className = 'vt-player-wrap';
      const iframe = document.createElement('iframe');
      iframe.className = 'vt-player-iframe';
      iframe.src = embedUrl('youtube', video.videoId);
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.allowFullscreen = true;
      playerWrap.appendChild(iframe);
      main.appendChild(playerWrap);

      const titleEl = document.createElement('div');
      titleEl.className = 'vt-watch-title';
      titleEl.textContent = video.title;
      main.appendChild(titleEl);

      const statsRow = document.createElement('div');
      statsRow.className = 'vt-watch-stats';
      const statsBits = [];
      if (video.viewCount) statsBits.push(formatCount(video.viewCount) + ' views');
      if (video.publishedAt) statsBits.push(relativeTime(video.publishedAt));
      if (video.duration) statsBits.push(video.duration);
      statsRow.textContent = statsBits.join(' • ');
      main.appendChild(statsRow);

      const channelRow = document.createElement('div');
      channelRow.className = 'vt-watch-channel-row';
      const channelLeft = document.createElement('div');
      channelLeft.className = 'vt-watch-channel-left';
      if (video.channelId) {
        const channelAvatar = document.createElement('img');
        channelAvatar.className = 'vt-watch-channel-avatar';
        channelAvatar.alt = '';
        channelAvatar.dataset.channelId = video.channelId;
        channelLeft.appendChild(channelAvatar);
      }
      const channelName = document.createElement('div');
      channelName.className = 'vt-watch-channel-name';
      channelName.textContent = video.channelTitle;
      if (video.channelId) {
        channelName.classList.add('vt-watch-channel-link');
        channelName.addEventListener('click', () => navigate(tab.id, buildVoidTubeUrl({ channel: video.channelId })));
      }
      channelLeft.appendChild(channelName);
      channelRow.appendChild(channelLeft);
      if (video.likeCount) {
        const likeEl = document.createElement('div');
        likeEl.className = 'vt-watch-likes';
        likeEl.textContent = '👍 ' + formatCount(video.likeCount);
        channelRow.appendChild(likeEl);
      }
      main.appendChild(channelRow);
      hydrateChannelAvatars(channelRow);

      if (video.description) {
        const descBox = document.createElement('div');
        descBox.className = 'vt-watch-desc';
        descBox.textContent = video.description;
        main.appendChild(descBox);
      }

      main.appendChild(buildVoidTubeAiBox(video));
      layout.appendChild(main);

      const side = document.createElement('div');
      side.className = 'vt-watch-side';
      const sideLabel = document.createElement('div');
      sideLabel.className = 'vt-section-label';
      sideLabel.textContent = 'Related';
      side.appendChild(sideLabel);
      const relStatus = document.createElement('div');
      relStatus.className = 'yt-search-status';
      relStatus.textContent = 'Loading related videos…';
      side.appendChild(relStatus);
      layout.appendChild(side);

      body.appendChild(layout);
      logToConsole('success', `VoidTube loaded "${video.title}".`);

      const relQs = new URLSearchParams({ excludeId: video.videoId });
      if (video.channelId) relQs.set('channelId', video.channelId);
      relQs.set('q', (video.tags && video.tags[0]) || video.title.split(' ').slice(0, 6).join(' '));
      fetch('/api/youtube/related?' + relQs.toString())
        .then((r) => r.json())
        .then((relData) => {
          relStatus.remove();
          if (!relData.results || !relData.results.length) {
            const empty = document.createElement('div');
            empty.className = 'yt-search-status';
            empty.textContent = 'No related videos found.';
            side.appendChild(empty);
            return;
          }
          relData.results.forEach((item) => side.appendChild(buildVoidTubeVideoCard(tab, item, { compact: true })));
          hydrateChannelAvatars(side);
        })
        .catch(() => {
          relStatus.textContent = 'Could not load related videos.';
          relStatus.classList.add('error');
        });
    } catch (err) {
      setLoading(false);
      setSearchStatus(body, 'Could not reach VoidTube.', true);
      logToConsole('error', `VoidTube watch error: ${err.message}`);
    }
  }

  async function renderVoidTubeShorts(tab, body, query, startId) {
    setSearchStatus(body, 'Loading Shorts…');
    try {
      const q = query || 'shorts';
      const res = await fetch('/api/youtube/search?q=' + encodeURIComponent(q) + '&duration=short&order=viewCount&maxResults=20');
      const data = await res.json();
      setLoading(false);
      if (!res.ok || data.error || !data.results || !data.results.length) {
        setSearchStatus(body, (data && data.error) || 'No Shorts found.', true);
        return;
      }

      let queue = data.results.slice();
      if (startId) {
        const idx = queue.findIndex((v) => v.videoId === startId);
        if (idx > 0) {
          const [chosen] = queue.splice(idx, 1);
          queue.unshift(chosen);
        } else if (idx === -1) {
          try {
            const vRes = await fetch('/api/youtube/videos?ids=' + encodeURIComponent(startId));
            const vData = await vRes.json();
            if (vData.videos && vData.videos[0]) queue.unshift(vData.videos[0]);
          } catch {}
        }
      }

      let index = 0;
      body.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'vt-shorts-feed';
      const playerHost = document.createElement('div');
      playerHost.className = 'vt-shorts-player-host';
      wrap.appendChild(playerHost);

      const controls = document.createElement('div');
      controls.className = 'vt-shorts-controls';
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'vt-shorts-ctrl-btn';
      prevBtn.textContent = '⬆';
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'vt-shorts-ctrl-btn';
      nextBtn.textContent = '⬇';
      controls.appendChild(prevBtn);
      controls.appendChild(nextBtn);
      wrap.appendChild(controls);

      const infoEl = document.createElement('div');
      infoEl.className = 'vt-shorts-info';
      wrap.appendChild(infoEl);

      function renderCurrent() {
        const item = queue[index];
        playerHost.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.className = 'vt-shorts-iframe';
        iframe.src = embedUrl('youtube', item.videoId);
        iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        iframe.allowFullscreen = true;
        playerHost.appendChild(iframe);
        infoEl.innerHTML = '';
        const t = document.createElement('div');
        t.className = 'vt-shorts-info-title';
        t.textContent = item.title;
        infoEl.appendChild(t);
        const channelRow = document.createElement('div');
        channelRow.className = 'vt-shorts-info-channel-row';
        if (item.channelId) {
          const avatar = document.createElement('img');
          avatar.className = 'vt-shorts-info-avatar';
          avatar.alt = '';
          avatar.dataset.channelId = item.channelId;
          channelRow.appendChild(avatar);
        }
        const c = document.createElement('div');
        c.className = 'vt-shorts-info-channel';
        c.textContent = item.channelTitle || '';
        if (item.channelId) {
          c.classList.add('vt-shorts-info-channel-link');
          c.addEventListener('click', () => navigate(tab.id, buildVoidTubeUrl({ channel: item.channelId })));
        }
        channelRow.appendChild(c);
        infoEl.appendChild(channelRow);
        hydrateChannelAvatars(channelRow);
        prevBtn.disabled = index === 0;
        nextBtn.disabled = index >= queue.length - 1;
      }
      prevBtn.addEventListener('click', () => {
        if (index > 0) {
          index -= 1;
          renderCurrent();
        }
      });
      nextBtn.addEventListener('click', () => {
        if (index < queue.length - 1) {
          index += 1;
          renderCurrent();
        }
      });

      body.appendChild(wrap);
      renderCurrent();
      logToConsole('success', `VoidTube Shorts loaded ${queue.length} videos.`);
    } catch (err) {
      setLoading(false);
      setSearchStatus(body, 'Could not reach VoidTube Shorts.', true);
      logToConsole('error', `VoidTube Shorts error: ${err.message}`);
    }
  }

  async function renderVoidTubeChannel(tab, body, channelId, sort) {
    setSearchStatus(body, 'Loading channel…');
    try {
      const cRes = await fetch('/api/youtube/channel?channelId=' + encodeURIComponent(channelId));
      const cData = await cRes.json();
      setLoading(false);
      if (!cRes.ok || cData.error) {
        setSearchStatus(body, cData.error || 'Channel not found.', true);
        return;
      }

      tab.titleEl.textContent = `${cData.title} — VoidTube`;
      tab.titleEl.title = cData.title;

      body.innerHTML = '';

      const head = document.createElement('div');
      head.className = 'vt-channel-head';
      const avatar = document.createElement('img');
      avatar.className = 'vt-channel-avatar';
      avatar.src = cData.thumbnail;
      avatar.alt = cData.title;
      head.appendChild(avatar);
      const info = document.createElement('div');
      info.className = 'vt-channel-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'vt-channel-name';
      nameEl.textContent = cData.title;
      info.appendChild(nameEl);
      const statsBits = [];
      if (cData.subscriberCount) statsBits.push(formatCount(cData.subscriberCount) + ' subscribers');
      if (cData.videoCount) statsBits.push(formatCount(cData.videoCount) + ' videos');
      if (statsBits.length) {
        const statsEl = document.createElement('div');
        statsEl.className = 'vt-channel-stats';
        statsEl.textContent = statsBits.join(' • ');
        info.appendChild(statsEl);
      }
      if (cData.description) {
        const descEl = document.createElement('div');
        descEl.className = 'vt-channel-desc';
        descEl.textContent = cData.description.slice(0, 280);
        info.appendChild(descEl);
      }
      head.appendChild(info);
      body.appendChild(head);

      const sortRow = document.createElement('div');
      sortRow.className = 'vt-channel-sort-row';
      const sortLabel = document.createElement('span');
      sortLabel.className = 'vt-channel-sort-label';
      sortLabel.textContent = 'Sort by:';
      sortRow.appendChild(sortLabel);
      const sortOptions = [
        { key: 'newest', label: 'Newest' },
        { key: 'popular', label: 'Popular' },
        { key: 'oldest', label: 'Oldest' },
      ];
      const activeSort = sortOptions.some((o) => o.key === sort) ? sort : 'newest';
      sortOptions.forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vt-chip vt-channel-sort-btn';
        if (opt.key === activeSort) btn.classList.add('active');
        btn.textContent = opt.label;
        btn.addEventListener('click', () => navigate(tab.id, buildVoidTubeUrl({ channel: channelId, sort: opt.key })));
        sortRow.appendChild(btn);
      });
      body.appendChild(sortRow);

      const grid = document.createElement('div');
      grid.className = 'vt-grid';
      body.appendChild(grid);
      const status = document.createElement('div');
      status.className = 'yt-search-status';
      status.textContent = 'Loading videos…';
      body.appendChild(status);

      let nextPageToken = null;

      async function loadPage(pageToken) {
        const qs = new URLSearchParams({ channelId, sort: activeSort });
        if (pageToken) qs.set('pageToken', pageToken);
        const res = await fetch('/api/youtube/channel-videos?' + qs.toString());
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Server responded ${res.status}.`);
        return data;
      }

      const first = await loadPage();
      status.remove();
      if (!first.results || !first.results.length) {
        setSearchStatus(body, 'No videos found for this channel.');
        return;
      }
      first.results.forEach((item) => grid.appendChild(buildVoidTubeVideoCard(tab, item, { avatarUrl: cData.thumbnail })));
      nextPageToken = first.nextPageToken;

      if (nextPageToken) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.type = 'button';
        loadMoreBtn.className = 'vt-load-more-btn';
        loadMoreBtn.textContent = 'Load more';
        loadMoreBtn.addEventListener('click', async () => {
          loadMoreBtn.disabled = true;
          loadMoreBtn.textContent = 'Loading…';
          try {
            const page = await loadPage(nextPageToken);
            (page.results || []).forEach((item) => grid.appendChild(buildVoidTubeVideoCard(tab, item, { avatarUrl: cData.thumbnail })));
            nextPageToken = page.nextPageToken;
            if (!nextPageToken) {
              loadMoreBtn.remove();
            } else {
              loadMoreBtn.disabled = false;
              loadMoreBtn.textContent = 'Load more';
            }
          } catch (err) {
            loadMoreBtn.textContent = 'Could not load more — retry';
            loadMoreBtn.disabled = false;
          }
        });
        body.appendChild(loadMoreBtn);
      }

      logToConsole('success', `VoidTube channel "${cData.title}" loaded (${activeSort}).`);
    } catch (err) {
      setLoading(false);
      setSearchStatus(body, err.message || 'Could not reach VoidTube.', true);
      logToConsole('error', `VoidTube channel error: ${err.message}`);
    }
  }

  async function runVoidTube(tab, parsed, target, logPrefix) {
    const view = showVoidTubeView(tab);
    tab.embedMode = false;
    tab.currentUrl = target;
    if (activeTabId === tab.id) urlInput.value = target;

    if (!tab.suppressPush) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(target);
      tab.historyIndex = tab.history.length - 1;
    }
    tab.suppressPush = false;
    updateNavButtons(tab);
    setLoading(true);

    // "play <query>" resolves to a top search hit, then redirects straight
    // into the watch page — a real search + real navigation, not a canned
    // result.
    if (parsed.mode === 'play') {
      tab.titleEl.textContent = `Playing "${parsed.query}" — VoidTube`;
      view.innerHTML = '';
      view.appendChild(buildVoidTubeHeader(tab, { mode: 'home', query: '' }));
      const body = document.createElement('div');
      body.className = 'vt-body';
      view.appendChild(body);
      setSearchStatus(body, `Finding "${parsed.query}" on VoidTube…`);
      logToConsole('info', `${logPrefix} VoidTube play command: "${parsed.query}".`);
      try {
        const res = await fetch('/api/youtube/search?maxResults=1&q=' + encodeURIComponent(parsed.query));
        const data = await res.json();
        setLoading(false);
        if (!res.ok || data.error || !data.results || !data.results.length) {
          setSearchStatus(body, (data && data.error) || `Couldn't find a video for "${parsed.query}".`, true);
          return;
        }
        loadIntoTab(tab, buildVoidTubeUrl({ v: data.results[0].videoId }), logPrefix);
      } catch (err) {
        setLoading(false);
        setSearchStatus(body, 'Could not reach VoidTube search.', true);
      }
      return;
    }

    tab.titleEl.textContent =
      parsed.mode === 'home' ? 'VoidTube'
      : parsed.mode === 'shorts' ? 'VoidTube Shorts'
      : parsed.mode === 'watch' ? 'VoidTube'
      : parsed.mode === 'channel' ? 'VoidTube'
      : `"${parsed.query}" — VoidTube`;
    tab.titleEl.title = target;

    view.innerHTML = '';
    view.appendChild(buildVoidTubeHeader(tab, parsed));

    const body = document.createElement('div');
    body.className = 'vt-body';
    view.appendChild(body);

    logToConsole('info', `${logPrefix} VoidTube (${parsed.mode}${parsed.query ? `: "${parsed.query}"` : ''}).`);

    if (parsed.mode === 'home') {
      await renderVoidTubeHome(tab, body);
    } else if (parsed.mode === 'search') {
      await renderVoidTubeSearch(tab, body, parsed.query);
    } else if (parsed.mode === 'watch') {
      await renderVoidTubeWatch(tab, body, parsed.videoId);
    } else if (parsed.mode === 'shorts') {
      await renderVoidTubeShorts(tab, body, parsed.query, parsed.start);
    } else if (parsed.mode === 'channel') {
      await renderVoidTubeChannel(tab, body, parsed.channelId, parsed.sort);
    } else {
      setLoading(false);
    }
  }

  // ---------------------------------------------------------------------
  // Void AI Mode — a dedicated, conversational search page (Google AI Mode
  // style): a streamed answer with real progressive text, follow-up
  // questions that keep the conversation's context, and a side panel of
  // real web results for anyone who wants to read the sources themselves.
  // ---------------------------------------------------------------------

  async function runAiMode(tab, query, target, logPrefix) {
    const view = showAiModeView(tab);
    tab.embedMode = false;
    tab.currentUrl = target;
    tab.titleEl.textContent = `${query} — Void AI Mode`;
    tab.titleEl.title = target;
    if (activeTabId === tab.id) urlInput.value = target;

    if (!tab.suppressPush) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(target);
      tab.historyIndex = tab.history.length - 1;
    }
    tab.suppressPush = false;
    updateNavButtons(tab);
    setLoading(false);

    logToConsole('info', `${logPrefix} Void AI Mode: "${query}".`);

    tab.aiModeConversation = [];
    view.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'gsearch-header';
    const bar = document.createElement('form');
    bar.className = 'gsearch-bar';
    const logo = document.createElement('div');
    logo.className = 'gsearch-logo';
    logo.textContent = 'Void';
    bar.appendChild(logo);
    const inputWrap = document.createElement('div');
    inputWrap.className = 'gsearch-input-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = query;
    input.spellcheck = false;
    const icon = document.createElement('span');
    icon.className = 'gsearch-input-icon';
    icon.textContent = '✦';
    inputWrap.appendChild(input);
    inputWrap.appendChild(icon);
    bar.appendChild(inputWrap);
    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) navigate(tab.id, 'void://ai-mode?q=' + encodeURIComponent(input.value.trim()));
    });
    header.appendChild(bar);

    const tabsRow = document.createElement('div');
    tabsRow.className = 'gsearch-tabs';
    [
      { key: 'ai', label: '✦ AI Mode' },
      { key: 'all', label: 'All' },
      { key: 'videos', label: 'Videos' },
    ].forEach((def) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gsearch-tab';
      if (def.key === 'ai') btn.classList.add('active');
      btn.textContent = def.label;
      btn.addEventListener('click', () => {
        if (def.key === 'ai') return;
        if (def.key === 'all') navigate(tab.id, query);
        else if (def.key === 'videos') navigate(tab.id, 'yt:' + query);
      });
      tabsRow.appendChild(btn);
    });
    header.appendChild(tabsRow);
    view.appendChild(header);

    const layout = document.createElement('div');
    layout.className = 'ai-mode-layout';
    const main = document.createElement('div');
    main.className = 'ai-mode-main';
    const thread = document.createElement('div');
    thread.className = 'ai-mode-thread';
    main.appendChild(thread);

    const followForm = document.createElement('form');
    followForm.className = 'ai-mode-follow-form';
    const followInput = document.createElement('input');
    followInput.type = 'text';
    followInput.placeholder = 'Ask a follow-up…';
    const followBtn = document.createElement('button');
    followBtn.type = 'submit';
    followBtn.textContent = '➤';
    followForm.appendChild(followInput);
    followForm.appendChild(followBtn);
    main.appendChild(followForm);
    layout.appendChild(main);

    const side = document.createElement('div');
    side.className = 'ai-mode-side';
    const sideLabel = document.createElement('div');
    sideLabel.className = 'vt-section-label';
    sideLabel.textContent = 'Quick results from the web';
    side.appendChild(sideLabel);
    layout.appendChild(side);

    view.appendChild(layout);

    function askAiMode(q) {
      const turn = document.createElement('div');
      turn.className = 'ai-mode-turn';
      const qEl = document.createElement('div');
      qEl.className = 'ai-mode-question';
      qEl.textContent = q;
      turn.appendChild(qEl);
      const aEl = document.createElement('div');
      aEl.className = 'ai-mode-answer';
      const cursor = document.createElement('span');
      cursor.className = 'vt-ai-cursor';
      aEl.appendChild(cursor);
      turn.appendChild(aEl);
      thread.appendChild(turn);
      thread.scrollTop = thread.scrollHeight;

      tab.aiModeConversation.push({ role: 'user', content: q });
      const messages = [
        {
          role: 'system',
          content:
            'You are Void AI, powering "Void AI Mode" — a conversational search experience in the style of Google AI Mode. ' +
            'Answer the question directly and helpfully in well-organized short paragraphs. Use the earlier turns of this ' +
            'conversation for context on follow-up questions.',
        },
        ...tab.aiModeConversation,
      ];
      streamVoidAi(
        messages,
        (soFar) => {
          aEl.textContent = soFar;
          aEl.appendChild(cursor);
          thread.scrollTop = thread.scrollHeight;
        },
        (full) => {
          cursor.remove();
          tab.aiModeConversation.push({ role: 'assistant', content: full });
        },
        (errMsg) => {
          aEl.textContent = errMsg || 'Void AI Mode could not answer.';
          aEl.classList.add('ai-mode-answer-error');
        }
      );
    }

    followForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = followInput.value.trim();
      if (!q) return;
      followInput.value = '';
      askAiMode(q);
    });

    askAiMode(query);

    fetch('/api/search?type=web&q=' + encodeURIComponent(query))
      .then((r) => r.json())
      .then((data) => {
        if (!data.results || !data.results.length) return;
        const panel = buildResultsSidePanel(tab, data.results);
        if (panel) {
          panel.classList.add('ai-mode-side-panel');
          side.appendChild(panel);
        }
      })
      .catch(() => {});
  }

  // ---------------------------------------------------------------------
  // VoidBuild (Beta) — an in-browser, Claude-Code-style app builder. A real
  // multi-step pipeline (plan → research → generate → self-review → deploy),
  // each step a genuine Void AI call, with a live elapsed timer and a
  // running status label so the process is visible rather than a black box.
  // ---------------------------------------------------------------------

  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Void AI is asked to reply with ONLY JSON, but models sometimes wrap it
  // in a code fence or add a stray sentence — this recovers from both
  // before giving up.
  function parseVbJson(text) {
    if (!text) return null;
    let cleaned = String(text).trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          return JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  // Folds a multi-file project into one self-contained HTML document for
  // the sandboxed preview iframe — Void AI is told to prefer a single
  // index.html anyway, so this mostly just handles the case where it still
  // splits out a .css/.js file.
  function combineVbFiles(files) {
    if (!files || !files.length) return '<!doctype html><html><body>Nothing built yet.</body></html>';
    const htmlFile = files.find((f) => /\.html?$/i.test(f.path)) || files[0];
    let html = htmlFile.content;
    files
      .filter((f) => f !== htmlFile)
      .forEach((f) => {
        if (/\.css$/i.test(f.path)) {
          const tag = `<style>\n${f.content}\n</style>`;
          html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, tag + '\n</head>') : tag + html;
        } else if (/\.js$/i.test(f.path)) {
          const tag = `<script>\n${f.content}\n</script>`;
          html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '\n</body>') : html + tag;
        }
      });
    return html;
  }

  function appendVbMessage(container, role, text) {
    const el = document.createElement('div');
    el.className = 'vb-msg vb-msg-' + role;
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  // A status line with a live mm:ss timer — this is what shows "Planning…
  // 0:04", "Generating files… 0:19", etc. while a build runs.
  function createVbStatusBubble(container) {
    const el = document.createElement('div');
    el.className = 'vb-status';
    const iconEl = document.createElement('span');
    iconEl.className = 'vb-status-icon';
    iconEl.textContent = '⚙️';
    const labelEl = document.createElement('span');
    labelEl.className = 'vb-status-label';
    const timerEl = document.createElement('span');
    timerEl.className = 'vb-status-timer';
    timerEl.textContent = '0:00';
    el.appendChild(iconEl);
    el.appendChild(labelEl);
    el.appendChild(timerEl);
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;

    const start = Date.now();
    const interval = setInterval(() => {
      timerEl.textContent = formatElapsed(Date.now() - start);
    }, 250);

    return {
      el,
      getElapsedMs: () => Date.now() - start,
      setLabel(text) {
        labelEl.textContent = text;
        container.scrollTop = container.scrollHeight;
      },
      done(finalText) {
        clearInterval(interval);
        labelEl.textContent = finalText || 'Done';
        iconEl.textContent = '✅';
        el.classList.add('vb-status-done');
      },
      fail(errText) {
        clearInterval(interval);
        labelEl.textContent = errText || 'Failed';
        iconEl.textContent = '⚠️';
        el.classList.add('vb-status-error');
      },
    };
  }

  function renderVbCanvas(canvasTabs, canvasBody, state, controls) {
    canvasTabs.innerHTML = '';
    canvasBody.innerHTML = '';

    const previewTab = document.createElement('button');
    previewTab.type = 'button';
    previewTab.className = 'vb-canvas-tab active';
    previewTab.textContent = '▶ Preview';
    canvasTabs.appendChild(previewTab);

    const fileButtons = state.files.map((f) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vb-canvas-tab';
      btn.textContent = f.path;
      canvasTabs.appendChild(btn);
      return btn;
    });

    function showPreview() {
      canvasBody.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.className = 'vb-preview-frame';
      iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-same-origin');
      iframe.srcdoc = combineVbFiles(state.files);
      canvasBody.appendChild(iframe);
      previewTab.classList.add('active');
      fileButtons.forEach((b) => b.classList.remove('active'));
    }
    function showFile(idx) {
      canvasBody.innerHTML = '';
      const pre = document.createElement('pre');
      pre.className = 'vb-code-view';
      const code = document.createElement('code');
      code.textContent = state.files[idx].content;
      pre.appendChild(code);
      canvasBody.appendChild(pre);
      previewTab.classList.remove('active');
      fileButtons.forEach((b, i) => b.classList.toggle('active', i === idx));
    }

    previewTab.addEventListener('click', showPreview);
    fileButtons.forEach((btn, idx) => btn.addEventListener('click', () => showFile(idx)));
    showPreview();

    if (controls) {
      controls.openNewTabBtn.disabled = false;
      controls.downloadBtn.disabled = false;
    }
  }

  function triggerBlobDownload(content, filename, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function downloadVbFiles(files) {
    if (files.length === 1) {
      triggerBlobDownload(files[0].content, files[0].path, 'text/plain');
      return;
    }
    // No client-side zip library here — the combined, self-contained HTML
    // is the one file that's guaranteed to actually run on its own.
    triggerBlobDownload(combineVbFiles(files), 'voidbuild-app.html', 'text/html');
  }

  // Deploys straight into a real browser tab via a blob: URL — genuinely
  // running the generated page, not a screenshot or a description of it.
  function openVbBuildInNewTab(files) {
    const html = combineVbFiles(files);
    const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const tab = createTab(null);
    const iframe = showIframeView(tab);
    iframe.src = blobUrl;
    tab.embedMode = false;
    tab.currentUrl = 'void://voidbuild-preview';
    tab.titleEl.textContent = 'VoidBuild preview';
    tab.titleEl.title = 'Built with VoidBuild';
    if (activeTabId === tab.id) urlInput.value = tab.currentUrl;
  }

  async function callVbJson(messages, maxTokens) {
    try {
      const res = await fetch('/api/void-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, max_tokens: maxTokens }),
      });
      const data = await res.json();
      if (!res.ok || data.error) return null;
      return parseVbJson(data.message && data.message.content);
    } catch {
      return null;
    }
  }

  const VB_PLAN_SYSTEM =
    'You are Void AI, planning a build for VoidBuild — this browser\'s own built-in app builder (in the spirit of Claude Code, but inside the browser). Given the user\'s request (and any existing files, if this is a follow-up change), write a short, concrete plan: 2-5 bullet points, each starting with "-", describing what you will build or change and which file(s) it touches. Plain text bullets only — no code, no headers, no preamble, no closing remarks.';

  const VB_GENERATE_SYSTEM =
    'You are Void AI, writing real, runnable code for VoidBuild. Output ONLY a single valid JSON object and nothing else — no markdown fences, no commentary before or after — of the exact shape {"files":[{"path":"index.html","content":"..."}]}. Prefer ONE self-contained index.html with inline <style> and <script> unless the project genuinely needs separate files (in which case reference them with normal relative <link>/<script src> tags, and also still include those files in the JSON). The code must be complete and runnable immediately in a sandboxed iframe with no build step and no npm install — vanilla HTML/CSS/JS only, or a library loaded from a CDN via a full https:// <script src> URL. If you are given existing files and a follow-up request, return the COMPLETE updated set of files (not a diff) — keep whatever still applies and change what the request asks for.';

  const VB_REVIEW_SYSTEM =
    'You are Void AI, reviewing code you just generated for VoidBuild before it ships, looking for real problems: syntax errors, a <script src>/<link href> pointing at a file that isn\'t in this file set, undefined variables or functions, obviously broken logic. Output ONLY a valid JSON object, nothing else. If you find real problems, respond {"issues":["short description", ...], "files":[{"path":"...","content":"..."}]} with the COMPLETE corrected content for every file (not a diff). If it looks fine, respond {"issues":[]}.';

  async function runVbPipeline(tab, state, userPrompt, ui) {
    const { chatMessages, canvasTabs, canvasBody, openNewTabBtn, downloadBtn, chatInput, chatSendBtn } = ui;
    state.building = true;
    chatInput.disabled = true;
    chatSendBtn.disabled = true;

    appendVbMessage(chatMessages, 'user', userPrompt);
    state.conversation.push({ role: 'user', content: userPrompt });

    const status = createVbStatusBubble(chatMessages);
    status.setLabel('Planning…');

    const finish = () => {
      state.building = false;
      chatInput.disabled = false;
      chatSendBtn.disabled = false;
      chatInput.placeholder = state.files.length ? 'Ask for a change…' : 'Describe what to build…';
      chatInput.focus();
    };

    try {
      const priorFilesNote = state.files.length
        ? `Existing files in this project:\n${state.files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')}`
        : '';

      // ---- Plan (streamed, so it reads as Void AI actually thinking) ----
      let planText = '';
      await streamVoidAi(
        [
          { role: 'system', content: VB_PLAN_SYSTEM },
          ...(priorFilesNote ? [{ role: 'system', content: priorFilesNote }] : []),
          { role: 'user', content: userPrompt },
        ],
        (soFar) => {
          planText = soFar;
        },
        () => {},
        (errMsg) => {
          throw new Error(errMsg || 'Planning failed.');
        }
      );
      if (planText.trim()) {
        appendVbMessage(chatMessages, 'assistant', planText.trim());
        state.conversation.push({ role: 'assistant', content: planText.trim() });
      }

      // ---- Research: real web search for reference/example code ----
      status.setLabel('Searching for reference code…');
      const topic = userPrompt.length > 80 ? userPrompt.slice(0, 80) : userPrompt;
      let researchNotes = '';
      for (const q of [`${topic} example code`, `site:github.com ${topic}`]) {
        try {
          const res = await fetch('/api/search?type=web&q=' + encodeURIComponent(q));
          const data = await res.json();
          if (res.ok && data.results && data.results.length) {
            appendVbMessage(chatMessages, 'log', `🔎 Searched "${q}" — ${data.results.length} result${data.results.length === 1 ? '' : 's'}`);
            data.results.slice(0, 2).forEach((r) => {
              researchNotes += `- ${r.title} (${r.displayLink}): ${r.snippet}\n`;
            });
          }
        } catch {
          // Non-fatal — generation proceeds without this source.
        }
      }

      // ---- Generate ----
      status.setLabel('Generating files…');
      const genMessages = [{ role: 'system', content: VB_GENERATE_SYSTEM }, { role: 'system', content: `PLAN:\n${planText || '(none)'}` }];
      if (researchNotes) genMessages.push({ role: 'system', content: `Reference notes from the web (for inspiration only — write original code):\n${researchNotes}` });
      if (priorFilesNote) genMessages.push({ role: 'system', content: priorFilesNote });
      genMessages.push({ role: 'user', content: userPrompt });

      let parsed = await callVbJson(genMessages, 6000);
      if (!parsed || !parsed.files || !parsed.files.length) {
        genMessages.push({ role: 'user', content: 'Reply again with ONLY the JSON object described above, no other text.' });
        parsed = await callVbJson(genMessages, 6000);
      }
      if (!parsed || !parsed.files || !parsed.files.length) {
        throw new Error('Void AI could not produce valid code for this — try rephrasing what you want built.');
      }
      let finalFiles = parsed.files.filter((f) => f && f.path && typeof f.content === 'string');
      if (!finalFiles.length) throw new Error('Void AI returned no usable files.');

      // ---- Self-review / fix ----
      status.setLabel('Reviewing for mistakes…');
      const reviewResult = await callVbJson(
        [
          { role: 'system', content: VB_REVIEW_SYSTEM },
          { role: 'user', content: `Files:\n${finalFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')}` },
        ],
        6000
      );
      if (reviewResult && Array.isArray(reviewResult.issues) && reviewResult.issues.length) {
        appendVbMessage(
          chatMessages,
          'log',
          `🛠️ Found ${reviewResult.issues.length} issue${reviewResult.issues.length === 1 ? '' : 's'} — fixing: ${reviewResult.issues.join('; ')}`
        );
        if (reviewResult.files && reviewResult.files.length) {
          const fixed = reviewResult.files.filter((f) => f && f.path && typeof f.content === 'string');
          if (fixed.length) finalFiles = fixed;
        }
      } else {
        appendVbMessage(chatMessages, 'log', '✅ Reviewed — no issues found.');
      }

      // ---- Deploy ----
      status.setLabel('Deploying…');
      state.files = finalFiles;
      renderVbCanvas(canvasTabs, canvasBody, state, { openNewTabBtn, downloadBtn });

      status.done(`Done in ${formatElapsed(status.getElapsedMs())}`);
      const summary = `Built ${finalFiles.length} file${finalFiles.length === 1 ? '' : 's'} (${finalFiles
        .map((f) => f.path)
        .join(', ')}) and deployed it to the preview on the right — use "Open in new tab" to view it full-page, or tell me what to change.`;
      appendVbMessage(chatMessages, 'assistant', summary);
      state.conversation.push({ role: 'assistant', content: summary });
      logToConsole('success', `VoidBuild finished in ${formatElapsed(status.getElapsedMs())} (${finalFiles.length} files).`);
    } catch (err) {
      status.fail(err.message || 'Build failed.');
      appendVbMessage(chatMessages, 'log', `❌ ${err.message || 'Something went wrong.'}`);
      logToConsole('error', `VoidBuild error: ${err.message}`);
    } finally {
      finish();
    }
  }

  async function runVoidBuild(tab, parsed, target, logPrefix) {
    const view = showVoidBuildView(tab);
    tab.embedMode = false;
    tab.currentUrl = target;
    tab.titleEl.textContent = 'VoidBuild (Beta)';
    tab.titleEl.title = target;
    if (activeTabId === tab.id) urlInput.value = target;

    if (!tab.suppressPush) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(target);
      tab.historyIndex = tab.history.length - 1;
    }
    tab.suppressPush = false;
    updateNavButtons(tab);
    setLoading(false);

    if (!tab.vbState) tab.vbState = { conversation: [], files: [], building: false };
    const state = tab.vbState;

    logToConsole('info', `${logPrefix} VoidBuild.`);

    view.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'vb-header';
    header.innerHTML = '<span class="vb-header-icon">🛠️</span><span class="vb-header-title">VoidBuild</span><span class="vb-beta-pill">BETA</span>';
    view.appendChild(header);

    const layout = document.createElement('div');
    layout.className = 'vb-layout';
    view.appendChild(layout);

    const chatPane = document.createElement('div');
    chatPane.className = 'vb-chat';
    const chatMessages = document.createElement('div');
    chatMessages.className = 'vb-chat-messages';
    chatPane.appendChild(chatMessages);
    const chatForm = document.createElement('form');
    chatForm.className = 'vb-chat-form';
    const chatInput = document.createElement('input');
    chatInput.type = 'text';
    chatInput.placeholder = state.files.length ? 'Ask for a change…' : 'Describe what to build…';
    const chatSendBtn = document.createElement('button');
    chatSendBtn.type = 'submit';
    chatSendBtn.textContent = '➤';
    chatForm.appendChild(chatInput);
    chatForm.appendChild(chatSendBtn);
    chatPane.appendChild(chatForm);
    layout.appendChild(chatPane);

    const canvasPane = document.createElement('div');
    canvasPane.className = 'vb-canvas';
    const canvasTabs = document.createElement('div');
    canvasTabs.className = 'vb-canvas-tabs';
    const canvasBody = document.createElement('div');
    canvasBody.className = 'vb-canvas-body';
    const canvasToolbar = document.createElement('div');
    canvasToolbar.className = 'vb-canvas-toolbar';
    const openNewTabBtn = document.createElement('button');
    openNewTabBtn.type = 'button';
    openNewTabBtn.className = 'vb-toolbar-btn';
    openNewTabBtn.textContent = '↗ Open in new tab';
    openNewTabBtn.disabled = !state.files.length;
    openNewTabBtn.addEventListener('click', () => state.files.length && openVbBuildInNewTab(state.files));
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'vb-toolbar-btn';
    downloadBtn.textContent = '⬇ Download';
    downloadBtn.disabled = !state.files.length;
    downloadBtn.addEventListener('click', () => state.files.length && downloadVbFiles(state.files));
    canvasToolbar.appendChild(openNewTabBtn);
    canvasToolbar.appendChild(downloadBtn);

    canvasPane.appendChild(canvasTabs);
    canvasPane.appendChild(canvasBody);
    canvasPane.appendChild(canvasToolbar);
    layout.appendChild(canvasPane);

    // Rehydrate anything already built if the user navigated away and back.
    state.conversation.forEach((turn) => appendVbMessage(chatMessages, turn.role, turn.content));
    if (state.files.length) {
      renderVbCanvas(canvasTabs, canvasBody, state, { openNewTabBtn, downloadBtn });
    } else {
      canvasBody.innerHTML = '<div class="vb-canvas-empty">Nothing built yet — describe what you want in the chat.</div>';
    }

    const ui = { chatMessages, canvasTabs, canvasBody, openNewTabBtn, downloadBtn, chatInput, chatSendBtn };
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text || state.building) return;
      chatInput.value = '';
      runVbPipeline(tab, state, text, ui);
    });

    // Handoff from Void AI's open_voidbuild tool: auto-run the prompt once.
    if (parsed.prompt && !state.files.length && !state.conversation.length && !state.building) {
      runVbPipeline(tab, state, parsed.prompt, ui);
    }
  }

  async function runWebSearch(tab, query, target, logPrefix, kind) {
    kind = kind || 'web';
    const view = showSearchView(tab);
    tab.embedMode = false;
    tab.currentUrl = target;
    tab.titleEl.textContent = `${query} — Search`;
    tab.titleEl.title = target;
    if (activeTabId === tab.id) urlInput.value = target;

    if (!tab.suppressPush) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(target);
      tab.historyIndex = tab.history.length - 1;
    }
    tab.suppressPush = false;
    updateNavButtons(tab);

    logToConsole('info', `${logPrefix} web search: "${query}" (via Custom Search API, in-app results).`);

    view.innerHTML = '';
    view.appendChild(buildSearchPageHeader(tab, query, kind === 'news' ? 'news' : 'all'));

    if (tab.moreNotice) {
      const notice = document.createElement('div');
      notice.className = 'gsearch-more-notice';
      notice.textContent = `"${tab.moreNotice}" isn't a separate search in Void yet — showing web results instead.`;
      view.appendChild(notice);
      tab.moreNotice = null;
    }

    const resultsHost = document.createElement('div');
    resultsHost.className = 'gsearch-results-host';
    view.appendChild(resultsHost);
    setSearchStatus(resultsHost, 'Searching…');

    try {
      const started = Date.now();
      const res = await fetch('/api/search?type=' + (kind === 'news' ? 'news' : 'web') + '&q=' + encodeURIComponent(query));
      const data = await res.json();
      const elapsed = Date.now() - started;
      setLoading(false);

      if (!res.ok || data.error) {
        setSearchStatus(resultsHost, data.error || 'Search failed.', true);
        logToConsole('error', `Web search error: ${data.error || res.status}`);
        return;
      }

      if (!data.results || !data.results.length) {
        setSearchStatus(resultsHost, 'No results.');
        logToConsole('success', `Web search returned 0 results in ${elapsed}ms.`);
        return;
      }

      resultsHost.innerHTML = '';
      const layout = document.createElement('div');
      layout.className = 'gsearch-layout';

      const main = document.createElement('div');
      main.className = 'gsearch-main';
      main.appendChild(buildAiOverviewCard(tab, query, data.results));

      const list = document.createElement('div');
      list.className = 'web-search-list';

      data.results.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'web-search-row';

        const favicon = document.createElement('div');
        favicon.className = 'web-search-row-favicon';
        const host = (item.displayLink || '').replace(/^www\./, '');
        favicon.textContent = host ? host.charAt(0).toUpperCase() : '?';
        favicon.style.background = colorForString(host || item.link || '');

        const meta = document.createElement('div');
        meta.className = 'web-search-row-meta';

        const linkRow = document.createElement('div');
        linkRow.className = 'web-search-row-link';
        linkRow.appendChild(favicon);
        const linkText = document.createElement('span');
        linkText.textContent = item.displayLink || item.link;
        linkRow.appendChild(linkText);
        meta.appendChild(linkRow);

        const titleEl = document.createElement('div');
        titleEl.className = 'web-search-row-title';
        titleEl.textContent = item.title;
        meta.appendChild(titleEl);

        if (item.snippet) {
          const snippet = document.createElement('div');
          snippet.className = 'web-search-row-snippet';
          snippet.textContent = item.snippet;
          meta.appendChild(snippet);
        }

        row.appendChild(meta);

        if (item.thumbnail) {
          const thumb = document.createElement('img');
          thumb.className = 'web-search-row-thumb';
          thumb.src = item.thumbnail;
          thumb.alt = '';
          thumb.loading = 'lazy';
          row.appendChild(thumb);
        }

        row.addEventListener('click', () => navigate(tab.id, item.link));
        list.appendChild(row);
      });

      main.appendChild(list);
      layout.appendChild(main);

      const sidePanel = buildResultsSidePanel(tab, data.results);
      if (sidePanel) layout.appendChild(sidePanel);

      resultsHost.appendChild(layout);
      logToConsole('success', `Web search returned ${data.results.length} results in ${elapsed}ms.`);
    } catch (err) {
      setLoading(false);
      setSearchStatus(resultsHost, 'Could not reach search.', true);
      logToConsole('error', `Web search network error: ${err.message}`);
    }
  }

  // Images tab: same header/page shell, but a thumbnail grid fed by Custom
  // Search's image mode instead of the text-result list.
  async function runImageSearch(tab, query, target, logPrefix) {
    const view = showSearchView(tab);
    tab.embedMode = false;
    tab.currentUrl = target;
    tab.titleEl.textContent = `${query} — Images`;
    tab.titleEl.title = target;
    if (activeTabId === tab.id) urlInput.value = target;

    if (!tab.suppressPush) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(target);
      tab.historyIndex = tab.history.length - 1;
    }
    tab.suppressPush = false;
    updateNavButtons(tab);

    logToConsole('info', `${logPrefix} image search: "${query}" (via Custom Search API, in-app results).`);

    view.innerHTML = '';
    view.appendChild(buildSearchPageHeader(tab, query, 'images'));

    const resultsHost = document.createElement('div');
    resultsHost.className = 'gsearch-results-host gsearch-results-host-wide';
    view.appendChild(resultsHost);
    setSearchStatus(resultsHost, 'Searching images…');

    try {
      const started = Date.now();
      const res = await fetch('/api/search?type=image&q=' + encodeURIComponent(query));
      const data = await res.json();
      const elapsed = Date.now() - started;
      setLoading(false);

      if (!res.ok || data.error) {
        setSearchStatus(resultsHost, data.error || 'Image search failed.', true);
        logToConsole('error', `Image search error: ${data.error || res.status}`);
        return;
      }

      if (!data.results || !data.results.length) {
        setSearchStatus(resultsHost, 'No results.');
        return;
      }

      resultsHost.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'image-search-grid';

      data.results.forEach((item) => {
        const tile = document.createElement('div');
        tile.className = 'image-search-tile';

        const img = document.createElement('img');
        img.src = item.thumbnail || item.imageUrl;
        img.alt = item.title || '';
        img.loading = 'lazy';
        tile.appendChild(img);

        const caption = document.createElement('div');
        caption.className = 'image-search-caption';
        caption.textContent = item.displayLink || item.title || '';
        tile.appendChild(caption);

        tile.addEventListener('click', () => navigate(tab.id, item.link));
        grid.appendChild(tile);
      });

      resultsHost.appendChild(grid);
      logToConsole('success', `Image search returned ${data.results.length} results in ${elapsed}ms.`);
    } catch (err) {
      setLoading(false);
      setSearchStatus(resultsHost, 'Could not reach image search.', true);
      logToConsole('error', `Image search network error: ${err.message}`);
    }
  }

  // A small deterministic color from a string, used for the favicon-style
  // circles in web search results (we don't have real favicons via the
  // Custom Search API without extra requests per result).
  function colorForString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash << 5) - hash + str.charCodeAt(i);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 42%)`;
  }

  // The right-hand info card Google shows next to web results — here built
  // from whatever the results actually carry (a thumbnail + its title/
  // snippet), never fabricated hours/ratings/map data Void doesn't have.
  function buildResultsSidePanel(tab, results) {
    const withImages = results.filter((r) => r.thumbnail);
    if (!withImages.length) return null;

    const hero = withImages[0];
    const panel = document.createElement('div');
    panel.className = 'gsearch-side';

    const heroImg = document.createElement('img');
    heroImg.className = 'gsearch-side-hero';
    heroImg.src = hero.thumbnail;
    heroImg.alt = '';
    panel.appendChild(heroImg);

    const title = document.createElement('div');
    title.className = 'gsearch-side-title';
    title.textContent = hero.title;
    panel.appendChild(title);

    const link = document.createElement('div');
    link.className = 'gsearch-side-link';
    link.textContent = hero.displayLink || hero.link;
    panel.appendChild(link);

    if (hero.snippet) {
      const desc = document.createElement('div');
      desc.className = 'gsearch-side-desc';
      desc.textContent = hero.snippet;
      panel.appendChild(desc);
    }

    const visitBtn = document.createElement('button');
    visitBtn.type = 'button';
    visitBtn.className = 'gsearch-side-visit';
    visitBtn.textContent = '🌐 Visit site';
    visitBtn.addEventListener('click', () => navigate(tab.id, hero.link));
    panel.appendChild(visitBtn);

    const more = withImages.slice(1, 4);
    if (more.length) {
      const label = document.createElement('div');
      label.className = 'gsearch-side-more-label';
      label.textContent = 'More from the web';
      panel.appendChild(label);

      const strip = document.createElement('div');
      strip.className = 'gsearch-side-strip';
      more.forEach((r) => {
        const thumb = document.createElement('img');
        thumb.className = 'gsearch-side-strip-thumb';
        thumb.src = r.thumbnail;
        thumb.alt = '';
        thumb.title = r.title;
        thumb.loading = 'lazy';
        thumb.addEventListener('click', () => navigate(tab.id, r.link));
        strip.appendChild(thumb);
      });
      panel.appendChild(strip);
    }

    return panel;
  }

  // The Google-style search bar + tab row shown at the top of every in-app
  // search page. All, Images, Videos, News, and Short videos each run a
  // real search; "More" opens a small menu of categories Void doesn't have
  // a dedicated backend for, and falls back to a plain web search.
  function buildSearchPageHeader(tab, query, activeKey) {
    const header = document.createElement('div');
    header.className = 'gsearch-header';

    const bar = document.createElement('form');
    bar.className = 'gsearch-bar';
    const logo = document.createElement('div');
    logo.className = 'gsearch-logo';
    logo.textContent = 'Void';
    bar.appendChild(logo);

    const inputWrap = document.createElement('div');
    inputWrap.className = 'gsearch-input-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = query;
    input.spellcheck = false;
    const icon = document.createElement('span');
    icon.className = 'gsearch-input-icon';
    icon.textContent = '🔍';
    inputWrap.appendChild(input);
    inputWrap.appendChild(icon);
    bar.appendChild(inputWrap);

    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) navigate(tab.id, input.value.trim());
    });
    header.appendChild(bar);

    const tabs = document.createElement('div');
    tabs.className = 'gsearch-tabs';

    const tabDefs = [
      { key: 'ai', label: '✦ AI Mode' },
      { key: 'all', label: 'All' },
      { key: 'images', label: 'Images' },
      { key: 'videos', label: 'Videos' },
      { key: 'news', label: 'News' },
      { key: 'shorts', label: 'Short videos' },
      { key: 'more', label: 'More' },
    ];

    tabDefs.forEach((def) => {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'gsearch-tab';
      tabBtn.textContent = def.label;
      if (def.key === activeKey) tabBtn.classList.add('active');

      tabBtn.addEventListener('click', () => {
        if (def.key === 'ai') navigate(tab.id, 'void://ai-mode?q=' + encodeURIComponent(query));
        else if (def.key === 'all') navigate(tab.id, query);
        else if (def.key === 'images') navigate(tab.id, buildImageSearchUrl(query));
        else if (def.key === 'videos') navigate(tab.id, 'yt:' + query);
        else if (def.key === 'news') navigate(tab.id, buildNewsSearchUrl(query));
        else if (def.key === 'shorts') navigate(tab.id, buildShortsSearchUrl(query));
        else if (def.key === 'more') toggleMoreMenu(tabBtn, tab, query);
      });
      tabs.appendChild(tabBtn);
    });

    header.appendChild(tabs);
    return header;
  }

  // "More" mimics Google's dropdown, but each entry (Shopping, Books,
  // Flights, Finance) is a category Void has no dedicated backend for, so
  // picking one just runs a normal web search and says so via moreNotice.
  let openMoreMenu = null;

  function toggleMoreMenu(anchorBtn, tab, query) {
    if (openMoreMenu) {
      openMoreMenu.remove();
      openMoreMenu = null;
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'gsearch-more-menu';
    ['Shopping', 'Books', 'Flights', 'Finance'].forEach((label) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'gsearch-more-item';
      item.textContent = label;
      item.addEventListener('click', () => {
        tab.moreNotice = label;
        menu.remove();
        openMoreMenu = null;
        navigate(tab.id, query);
      });
      menu.appendChild(item);
    });
    anchorBtn.parentElement.style.position = 'relative';
    anchorBtn.after(menu);
    openMoreMenu = menu;

    const closeOnOutsideClick = (e) => {
      if (!menu.contains(e.target) && e.target !== anchorBtn) {
        menu.remove();
        openMoreMenu = null;
        document.removeEventListener('click', closeOnOutsideClick, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeOnOutsideClick, true), 0);
  }

  // Fetches a short summary from Void AI (Groq-backed, same model behind
  // the AI sidebar) grounded only in the snippets Custom Search returned,
  // and renders it as a Google-style "AI Overview" card above the results.
  function buildAiOverviewCard(tab, query, results) {
    const card = document.createElement('div');
    card.className = 'ai-overview-card';

    const header = document.createElement('div');
    header.className = 'ai-overview-header';
    header.innerHTML = '<span class="ai-overview-icon">✨</span><span>AI Overview</span>';
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'ai-overview-body';
    body.textContent = 'Generating overview…';
    card.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'ai-overview-footer';
    footer.textContent = 'Generated by Void AI from the results below — may be inaccurate.';
    card.appendChild(footer);

    const context = results
      .slice(0, 6)
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || ''}`.trim())
      .join('\n\n');

    fetch('/api/void-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content:
              'You write short "AI Overview" summaries for a search results page, in the style of Google\'s AI Overview. ' +
              'Answer the query directly in 2-4 sentences using ONLY the provided search snippets. ' +
              'Do not invent facts beyond them. No markdown headers, just plain prose.',
          },
          { role: 'user', content: `Query: ${query}\n\nSearch result snippets:\n${context}` },
        ],
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error || !data.message || !data.message.content) {
          body.textContent = 'Void AI couldn\'t generate an overview for this search.';
          card.classList.add('ai-overview-empty');
          return;
        }
        body.textContent = data.message.content;
      })
      .catch(() => {
        body.textContent = 'Void AI couldn\'t generate an overview for this search.';
        card.classList.add('ai-overview-empty');
      });

    return card;
  }

  function ensureIframe(tab) {
    if (tab.iframe) return tab.iframe;
    if (tab.homeScreenEl) tab.homeScreenEl.remove();

    const iframe = document.createElement('iframe');
    iframe.title = 'Void browser content';
    tab.viewEl.appendChild(iframe);
    tab.iframe = iframe;

    iframe.addEventListener('load', () => {
      setLoading(false);
      let realUrl = tab.pendingUrl || tab.currentUrl;
      if (!tab.embedMode) {
        try {
          if (iframe.contentWindow && iframe.contentWindow.location.href !== 'about:blank') {
            realUrl = decodeProxied(iframe.contentWindow.location.href);
          }
        } catch {
          // Cross-origin read blocked; fall back to the URL we requested.
        }
      }

      let title = realUrl;
      try {
        if (iframe.contentDocument && iframe.contentDocument.title) {
          title = iframe.contentDocument.title;
        }
      } catch {
        // ignore
      }

      tab.currentUrl = realUrl;
      tab.titleEl.textContent = title || realUrl;
      tab.titleEl.title = realUrl;
      setTabFavicon(tab, realUrl);
      if (activeTabId === tab.id) urlInput.value = realUrl;

      if (!tab.suppressPush) {
        tab.history = tab.history.slice(0, tab.historyIndex + 1);
        tab.history.push(realUrl);
        tab.historyIndex = tab.history.length - 1;
      }
      tab.suppressPush = false;
      updateNavButtons(tab);

      const elapsed = tab.navStart ? Date.now() - tab.navStart : null;
      logToConsole('success', `Loaded ${realUrl}${elapsed !== null ? ` in ${elapsed}ms` : ''}`);
    });

    iframe.addEventListener('error', () => {
      setLoading(false);
      logToConsole('error', `Failed to load ${tab.pendingUrl || 'page'}.`);
    });

    return iframe;
  }

  // Shared by navigate()/goBack()/goForward()/reload(): sends the tab to a
  // YouTube search view, the real site's official embed player, or through
  // /proxy as usual.
  function loadIntoTab(tab, target, logPrefix) {
    tab.pendingUrl = target;
    setLoading(true);
    clearTabFavicon(tab); // stale icon shouldn't linger while a new page loads

    const ytMatch = detectYouTubeSearchQuery(target);
    if (ytMatch) {
      runYouTubeSearch(tab, ytMatch.query, target, logPrefix, ytMatch.short);
      return;
    }

    const vtMatch = parseVoidTubeUrl(target);
    if (vtMatch) {
      runVoidTube(tab, vtMatch, target, logPrefix);
      return;
    }

    const aiModeMatch = parseAiModeUrl(target);
    if (aiModeMatch) {
      runAiMode(tab, aiModeMatch.query, target, logPrefix);
      return;
    }

    const vbMatch = parseVoidBuildUrl(target);
    if (vbMatch) {
      runVoidBuild(tab, vbMatch, target, logPrefix);
      return;
    }

    const imageQuery = detectTypedSearchQuery(target, 'isch');
    if (imageQuery) {
      runImageSearch(tab, imageQuery, target, logPrefix);
      return;
    }

    const newsQuery = detectTypedSearchQuery(target, 'nws');
    if (newsQuery) {
      runWebSearch(tab, newsQuery, target, logPrefix, 'news');
      return;
    }

    const webQuery = detectWebSearchQuery(target);
    if (webQuery) {
      runWebSearch(tab, webQuery, target, logPrefix, 'web');
      return;
    }

    const embed = detectEmbeddable(target);

    // YouTube links (watch/shorts/youtu.be) now open in VoidTube's own
    // watch page instead of the bare embed — same underlying official
    // player, plus title/stats/description/related videos/Void AI. TikTok
    // isn't part of VoidTube, so it keeps the direct embed as before.
    if (embed && embed.service === 'youtube') {
      logToConsole('info', `${logPrefix} ${target} — opening in VoidTube.`);
      loadIntoTab(tab, buildVoidTubeUrl({ v: embed.id }), logPrefix);
      return;
    }

    const iframe = showIframeView(tab);
    tab.embedMode = !!embed;

    if (embed) {
      logToConsole('info', `${logPrefix} ${target} — using TikTok's official embed player (direct connection, not proxied).`);
      iframe.src = embedUrl(embed.service, embed.id);
    } else {
      logToConsole('network', `${logPrefix} ${target}`);
      iframe.src = toProxyUrl(target);
    }
  }

  function navigate(tabId, rawInput) {
    const tab = tabs.get(tabId);
    if (!tab) return;

    // Already-resolved internal targets (void://voidtube..., void://ai-mode...)
    // — built by card clicks, tool calls, and session restore — pass straight
    // through instead of being re-interpreted as a search query.
    if (/^void:\/\//i.test(rawInput.trim())) {
      const target = rawInput.trim();
      tab.navStart = Date.now();
      loadIntoTab(tab, target, 'Navigating to');
      if (activeTabId === tabId) urlInput.value = target;
      return;
    }

    const ytQuery = shorthandYouTubeQuery(rawInput);
    const vtQuery = shorthandVoidTubeQuery(rawInput);
    const aiQuery = shorthandAiModeQuery(rawInput);
    const vbQuery = shorthandVoidBuildQuery(rawInput);
    const playQuery = detectPlayCommand(rawInput);
    const findQuery = detectFindVideosCommand(rawInput);

    let target;
    if (ytQuery) {
      target = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(ytQuery);
    } else if (playQuery) {
      target = buildVoidTubeUrl({ play: playQuery });
    } else if (findQuery) {
      target = buildVoidTubeUrl({ q: findQuery });
    } else if (vtQuery !== null) {
      target = vtQuery ? buildVoidTubeUrl({ q: vtQuery }) : buildVoidTubeUrl({});
    } else if (aiQuery) {
      target = 'void://ai-mode?q=' + encodeURIComponent(aiQuery);
    } else if (vbQuery !== null) {
      target = vbQuery ? buildVoidBuildUrl({ prompt: vbQuery }) : buildVoidBuildUrl({});
    } else {
      target = resolveNavTarget(rawInput);
    }
    if (!target) return;

    tab.navStart = Date.now();
    loadIntoTab(tab, target, 'Navigating to');

    if (activeTabId === tabId) urlInput.value = target;
  }

  function goBack() {
    const tab = tabs.get(activeTabId);
    if (!tab || tab.historyIndex <= 0) return;
    tab.historyIndex -= 1;
    tab.suppressPush = true;
    tab.navStart = Date.now();
    loadIntoTab(tab, tab.history[tab.historyIndex], 'Back to');
  }

  function goForward() {
    const tab = tabs.get(activeTabId);
    if (!tab || tab.historyIndex >= tab.history.length - 1) return;
    tab.historyIndex += 1;
    tab.suppressPush = true;
    tab.navStart = Date.now();
    loadIntoTab(tab, tab.history[tab.historyIndex], 'Forward to');
  }

  function reloadTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.currentUrl) return false;
    tab.suppressPush = true;
    tab.navStart = Date.now();
    loadIntoTab(tab, tab.currentUrl, 'Reloading');
    return true;
  }

  function reload() {
    reloadTab(activeTabId);
  }

  function goHome() {
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    closeTab(tab.id);
    createTab(null);
  }

  document.getElementById('voidtube-toggle').addEventListener('click', () => {
    if (activeTabId) navigate(activeTabId, buildVoidTubeUrl({}));
    else createTab(buildVoidTubeUrl({}));
  });

  document.getElementById('new-tab-btn').addEventListener('click', () => createTab(null));
  backBtn.addEventListener('click', goBack);
  forwardBtn.addEventListener('click', goForward);
  reloadBtn.addEventListener('click', reload);
  homeBtn.addEventListener('click', goHome);

  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (activeTabId && urlInput.value.trim()) {
      navigate(activeTabId, urlInput.value.trim());
    }
  });

  // ---------------------------------------------------------------------
  // Void AI
  // ---------------------------------------------------------------------

  const aiPanel = document.getElementById('ai-panel');
  const aiMessages = document.getElementById('ai-messages');
  const aiForm = document.getElementById('ai-form');
  const aiInput = document.getElementById('ai-input');
  const aiToggle = document.getElementById('ai-toggle');
  const aiCloseBtn = document.getElementById('ai-close-btn');
  const aiContextRow = document.getElementById('ai-context-row');
  const aiContextBtn = document.getElementById('ai-context-btn');
  const aiContextPopover = document.getElementById('ai-context-popover');
  const aiContextList = document.getElementById('ai-context-list');

  let conversation = [];

  // ---------------------------------------------------------------------
  // Tab context picker — a "+" button (same idea as Gemini's context
  // attach) that opens a checklist of every open tab. Whatever's checked
  // gets its page content pulled into Void AI's system message, in
  // addition to (or instead of) just the active tab.
  // ---------------------------------------------------------------------

  const selectedContextTabIds = new Set();

  function renderContextPopover() {
    aiContextList.innerHTML = '';
    if (tabs.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-context-empty';
      empty.textContent = 'No tabs open.';
      aiContextList.appendChild(empty);
      return;
    }
    tabs.forEach((tab) => {
      const label = document.createElement('label');
      label.className = 'ai-context-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedContextTabIds.has(tab.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedContextTabIds.add(tab.id);
        else selectedContextTabIds.delete(tab.id);
        renderContextChips();
      });
      label.appendChild(checkbox);

      const span = document.createElement('span');
      span.textContent = tab.titleEl.textContent || tab.currentUrl || 'New Tab';
      label.appendChild(span);

      aiContextList.appendChild(label);
    });
  }

  function renderContextChips() {
    // Drop selections for tabs that got closed since.
    for (const id of Array.from(selectedContextTabIds)) {
      if (!tabs.has(id)) selectedContextTabIds.delete(id);
    }

    aiContextRow.innerHTML = '';
    aiContextBtn.classList.toggle('has-context', selectedContextTabIds.size > 0);

    if (selectedContextTabIds.size === 0) {
      aiContextRow.classList.add('hidden');
      return;
    }
    aiContextRow.classList.remove('hidden');

    selectedContextTabIds.forEach((id) => {
      const tab = tabs.get(id);
      if (!tab) return;
      const chip = document.createElement('div');
      chip.className = 'ai-context-chip';

      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = tab.titleEl.textContent || tab.currentUrl || 'New Tab';
      chip.appendChild(label);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        selectedContextTabIds.delete(id);
        renderContextChips();
      });
      chip.appendChild(removeBtn);

      aiContextRow.appendChild(chip);
    });
  }

  aiContextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willShow = aiContextPopover.classList.contains('hidden');
    if (willShow) renderContextPopover();
    aiContextPopover.classList.toggle('hidden', !willShow);
  });

  document.addEventListener('click', (e) => {
    if (!aiContextPopover.classList.contains('hidden') && !aiContextPopover.contains(e.target) && e.target !== aiContextBtn) {
      aiContextPopover.classList.add('hidden');
    }
  });

  aiToggle.addEventListener('click', () => aiPanel.classList.toggle('hidden'));
  aiCloseBtn.addEventListener('click', () => aiPanel.classList.add('hidden'));

  document.querySelectorAll('.ai-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      aiInput.value = chip.dataset.prompt;
      aiForm.dispatchEvent(new Event('submit', { cancelable: true }));
    });
  });

  function appendAiMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'ai-msg ' + role;
    el.textContent = text;
    aiMessages.appendChild(el);
    aiMessages.scrollTop = aiMessages.scrollHeight;
    return el;
  }

  // --- Minimal markdown renderer for assistant replies -------------------
  // Escapes first (so model output can never inject raw HTML), then parses
  // line-by-line: fenced code, tables, lists, headers, paragraphs. Inline
  // bold/italic/code are applied within each of those.

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inlineFormat(str) {
    return str
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  function renderMarkdown(raw) {
    const lines = escapeHtml(raw).split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (/^```/.test(line.trim())) {
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        html += `<pre><code>${codeLines.join('\n')}</code></pre>`;
        continue;
      }

      const isTableSeparator = (l) => /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(l);
      if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const headerCells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
          i++;
        }
        html += '<table class="ai-table"><thead><tr>' +
          headerCells.map((c) => `<th>${inlineFormat(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inlineFormat(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>';
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
          i++;
        }
        html += '<ul>' + items.map((it) => `<li>${inlineFormat(it)}</li>`).join('') + '</ul>';
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
        }
        html += '<ol>' + items.map((it) => `<li>${inlineFormat(it)}</li>`).join('') + '</ol>';
        continue;
      }

      const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
      if (headerMatch) {
        html += `<h3>${inlineFormat(headerMatch[2])}</h3>`;
        i++;
        continue;
      }

      if (line.trim() === '') {
        i++;
        continue;
      }

      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^```/.test(lines[i].trim()) &&
        !/^\s*\|/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^#{1,3}\s+/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      html += `<p>${inlineFormat(paraLines.join(' '))}</p>`;
    }

    return html;
  }

  const MAX_PAGE_CONTEXT_CHARS = 6000;

  // Pulls a snapshot of what's currently on screen in a given tab so Void AI
  // can answer questions about it. Same-origin (the proxy serves everything
  // from this host), so contentDocument reads succeed for pages that loaded
  // through /proxy; if a page blocks itself from framing or the read
  // otherwise fails, this degrades to just the URL/title. `charBudget` lets
  // the caller shrink the snapshot when several tabs are attached at once.
  function getTabContext(tabId, charBudget) {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    const budget = charBudget || MAX_PAGE_CONTEXT_CHARS;

    // VoidTube and Void AI Mode render into their own view elements instead
    // of the iframe, so pull visible text from there directly.
    if (tab.voidTubeViewEl && !tab.voidTubeViewEl.classList.contains('hidden')) {
      let text = (tab.voidTubeViewEl.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > budget) text = text.slice(0, budget) + ' …(truncated)';
      return { tabId, url: tab.currentUrl || 'void://voidtube', title: tab.titleEl ? tab.titleEl.textContent : 'VoidTube', text };
    }
    if (tab.aiModeViewEl && !tab.aiModeViewEl.classList.contains('hidden')) {
      let text = (tab.aiModeViewEl.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > budget) text = text.slice(0, budget) + ' …(truncated)';
      return { tabId, url: tab.currentUrl || 'void://ai-mode', title: tab.titleEl ? tab.titleEl.textContent : 'Void AI Mode', text };
    }
    if (tab.voidBuildViewEl && !tab.voidBuildViewEl.classList.contains('hidden')) {
      let text = (tab.voidBuildViewEl.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > budget) text = text.slice(0, budget) + ' …(truncated)';
      return { tabId, url: tab.currentUrl || 'void://voidbuild', title: tab.titleEl ? tab.titleEl.textContent : 'VoidBuild', text };
    }

    if (!tab.iframe) {
      return { tabId, url: 'void://home', title: 'Void home screen', text: '' };
    }

    const url = tab.currentUrl || 'unknown';
    let title = tab.titleEl ? tab.titleEl.textContent : url;
    let text = '';

    try {
      const doc = tab.iframe.contentDocument;
      if (doc) {
        if (doc.title) title = doc.title;
        if (doc.body) {
          text = doc.body.innerText || '';
          text = text.replace(/\s+/g, ' ').trim();
          if (text.length > budget) {
            text = text.slice(0, budget) + ' …(truncated)';
          }
        }
      }
    } catch {
      // Cross-origin or otherwise blocked — fall back to url/title only.
    }

    return { tabId, url, title, text };
  }

  function getActiveTabContext() {
    return activeTabId ? getTabContext(activeTabId) : null;
  }

  const FORMATTING_GUIDANCE =
    "Formatting note: you're replying inside a narrow ~380px chat sidebar. Prefer short paragraphs or a brief bullet list. Only use a markdown table when the data genuinely needs columns to compare — for a couple of options, plain sentences or a short list read better than a table.";

  const TOOLS_GUIDANCE =
    'You can act on the browser directly using the provided tools: open new tabs, navigate, reload, or close existing ones, switch which tab is active, list every open tab, or read the text of a tab that is not currently attached as context. Use a tool whenever the request asks you to do something in the browser rather than just answer a question (e.g. "open twitter in a new tab", "close this tab", "what tabs do I have open", "check what\'s on my other tab"). ' +
    'If the user reports or asks you to fix a console error (they may paste the error message directly, or a "Fix this" button may hand you one), diagnose it like a real debugging session: read the relevant tab for context if it is not already attached, consider what the error actually means, and take real action rather than just describing the problem — reload_tab to retry a transient failure, navigate_tab to try a corrected URL, web_search to look up an unfamiliar error message or API, read_url to check documentation or a GitHub issue about it. Try more than one approach if the first does not resolve it, then tell the user plainly what the error meant, what you tried, and whether it is fixed now. ' +
    'For ANY request to find, search for, show, or play a video — including things like "find me a video on X", "play some music", "show me videos about X", or "what\'s a good video on X" — always use search_voidtube or play_video, never web_search or open_tab with a youtube.com URL. VoidTube is this browser\'s own YouTube-style video app; treat it as the only place videos come from. IMPORTANT: search_voidtube and play_video never open or navigate anywhere by themselves — they only look videos up, and the results are shown to the user as clickable cards right in this chat. Do not call open_voidtube_result afterward unless the user explicitly says to open/play one of those results ("play that one", "open it", "yes"). After the cards are shown, just describe what you found and give your recommendation in plain language — don\'t say "done" or repeat the tool call back to them, and don\'t claim you opened or played anything you didn\'t. ' +
    'You can also research the live web: call web_search whenever a question depends on current events, facts you\'re unsure of, or anything outside the attached page context (this excludes video requests, which always go through search_voidtube/play_video instead) — then call read_url on the one or two most relevant results to read their full text before answering (don\'t just answer from search snippets alone if the question needs real detail). Weave what you learned into a normal answer and mention sources by name in plain language (e.g. "according to Reuters") rather than dumping raw links. ' +
    'If the user asks you to build, create, or make something that\'s really a coding/app project — a website, game, script, tool, or similar — do not write the code yourself in this chat. Instead ask them: "Want me to build this in VoidBuild?" and wait for them to confirm. If they say yes, call open_voidbuild with a clear build_prompt describing exactly what to build, using their own words and any details they gave. Don\'t call open_voidbuild before they\'ve confirmed. ' +
    'After a tool result comes back, keep going with more tool calls if needed, then give the user a short plain-language summary — never narrate raw tool syntax or tool names.';

  function describeOpenTabs() {
    if (tabs.size === 0) return 'No tabs are currently open.';
    const lines = [];
    tabs.forEach((tab) => {
      const title = tab.titleEl ? tab.titleEl.textContent : 'New Tab';
      lines.push(`- id=${tab.id}${tab.id === activeTabId ? ' (active)' : ''}: "${title}" — ${tab.currentUrl || 'void://home'}`);
    });
    return `Currently open tabs:\n${lines.join('\n')}`;
  }

  // `attachedContexts` is an array of getTabContext() results for whatever
  // the user picked with the "+" context button. When empty, this falls
  // back to just the active tab, same as Void AI's original behavior.
  function buildSystemMessage(attachedContexts) {
    const parts = [`You are Void AI, the assistant built into the Void browser.`, describeOpenTabs(), TOOLS_GUIDANCE];

    if (!attachedContexts || attachedContexts.length === 0) {
      parts.push('No page context has been attached beyond the tab list above — use the read_tab tool if you need to see a page\'s content.');
    } else {
      const perTabBudget = Math.max(1200, Math.floor(MAX_PAGE_CONTEXT_CHARS / attachedContexts.length));
      attachedContexts.forEach((context) => {
        if (!context.text) {
          parts.push(`Attached tab — URL: ${context.url}\nTitle: ${context.title}\n(No readable page content was available.)`);
          return;
        }
        const text = context.text.length > perTabBudget ? context.text.slice(0, perTabBudget) + ' …(truncated)' : context.text;
        parts.push(`Attached tab — URL: ${context.url}\nTitle: ${context.title}\nVisible page text (truncated snapshot):\n"""\n${text}\n"""`);
      });
    }

    parts.push(FORMATTING_GUIDANCE);
    return parts.join('\n\n');
  }

  // ---------------------------------------------------------------------
  // Void AI tool calling — lets the model actually drive the browser
  // (open/navigate/close/switch tabs, list tabs, read another tab's
  // content) instead of only answering questions about the active tab.
  // Tools are described here (OpenAI-style function schema, which is what
  // Groq's chat-completions endpoint expects) and executed locally; the
  // server (/api/void-ai) only relays messages/tools to Groq and back, it
  // never touches a tab itself.
  // ---------------------------------------------------------------------

  const MAX_TOOL_ITERATIONS = 6;

  const AI_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'open_tab',
        description: 'Open a brand-new browser tab and navigate it to a URL or search query.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'A URL (e.g. "https://github.com") or a search query to look up.' },
            make_active: { type: 'boolean', description: 'Whether to switch to the new tab immediately. Defaults to true.' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'navigate_tab',
        description: 'Navigate an existing tab to a new URL or search query.',
        parameters: {
          type: 'object',
          properties: {
            tab_id: { type: 'string', description: 'The id of the tab to navigate, from list_tabs.' },
            url: { type: 'string', description: 'A URL or search query to load in that tab.' },
          },
          required: ['tab_id', 'url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'close_tab',
        description: 'Close an existing browser tab.',
        parameters: {
          type: 'object',
          properties: { tab_id: { type: 'string', description: 'The id of the tab to close, from list_tabs.' } },
          required: ['tab_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'switch_tab',
        description: 'Make an existing tab the active/foreground tab.',
        parameters: {
          type: 'object',
          properties: { tab_id: { type: 'string', description: 'The id of the tab to switch to, from list_tabs.' } },
          required: ['tab_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_tabs',
        description: 'List every currently open tab with its id, title, and URL.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_tab',
        description: "Read a snapshot of a tab's visible page text, title, and URL — including tabs not attached as context.",
        parameters: {
          type: 'object',
          properties: { tab_id: { type: 'string', description: 'The id of the tab to read, from list_tabs.' } },
          required: ['tab_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the live web for up-to-date information. Returns a list of results with title, URL, and a short snippet. Use this for anything current, factual-but-uncertain, or outside the attached page context.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query.' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_url',
        description: "Fetch a URL directly from the web and return its title and readable text — without needing to open it as a browser tab. Use this on the most promising web_search result(s) to get real detail, or whenever the user gives you a link.",
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'The absolute URL to fetch and read.' } },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_voidtube',
        description:
          'The ONLY way to find videos in this browser — searches VoidTube (the built-in YouTube-style video app) for a topic and returns the top real results (title/channel/date/video_id). This does NOT open or navigate anywhere — results are shown to the user as clickable cards in this chat. Use this for any "find/show me a video on X" style request instead of web_search.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search VoidTube for.' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'play_video',
        description:
          'Searches VoidTube for a video/song and returns the top result\'s real title/channel/video_id. This does NOT open or play anything — the result is shown to the user as a clickable card in this chat. Use this for "play X" requests instead of web_search or opening youtube.com.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for, e.g. "lofi hip hop radio" or a song title.' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_voidtube_result',
        description:
          'Actually opens/plays a specific video on VoidTube. Only call this after the user has explicitly asked you to open or play a specific result you already showed them (e.g. "play that one", "open the second one", "yes play it") — never call it right after search_voidtube/play_video on your own.',
        parameters: {
          type: 'object',
          properties: {
            video_id: { type: 'string', description: 'The video_id of the result to open, from a previous search_voidtube/play_video result.' },
            tab_id: { type: 'string', description: 'Optional: an existing tab id to navigate instead of opening a new tab.' },
          },
          required: ['video_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'reload_tab',
        description: 'Reloads a tab (re-navigates it to its current URL). Useful for retrying after a transient error, or after fixing something that should now load correctly.',
        parameters: {
          type: 'object',
          properties: {
            tab_id: { type: 'string', description: 'Tab id to reload. Defaults to the currently active tab if omitted.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_voidbuild',
        description:
          'Opens VoidBuild (Beta) — this browser\'s built-in app builder — and starts building the described project there. Only call this AFTER the user has confirmed they want to build it in VoidBuild (you should ask first, e.g. "Want me to build this in VoidBuild?").',
        parameters: {
          type: 'object',
          properties: {
            build_prompt: { type: 'string', description: 'A clear, complete description of what to build, in the user\'s own words/details.' },
          },
          required: ['build_prompt'],
        },
      },
    },
  ];

  function appendToolNotice(text) {
    const el = document.createElement('div');
    el.className = 'ai-tool-msg';
    el.textContent = text;
    aiMessages.appendChild(el);
    aiMessages.scrollTop = aiMessages.scrollHeight;
    return el;
  }

  // Renders video results as clickable cards INSIDE the chat, instead of
  // navigating any tab automatically. Nothing opens until the user clicks
  // a card (or tells Void AI to open/play one, which calls
  // open_voidtube_result). Each card opens in the active tab if there is
  // one, otherwise a new tab.
  function appendVideoResultsCard(results, heading) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-video-card-group';
    if (heading) {
      const h = document.createElement('div');
      h.className = 'ai-video-card-heading';
      h.textContent = heading;
      wrap.appendChild(h);
    }
    results.slice(0, 6).forEach((item) => {
      const card = document.createElement('div');
      card.className = 'ai-video-card';
      const thumb = document.createElement('img');
      thumb.className = 'ai-video-card-thumb';
      thumb.src = item.thumbnail || '';
      thumb.alt = item.title || '';
      thumb.loading = 'lazy';
      card.appendChild(thumb);
      const meta = document.createElement('div');
      meta.className = 'ai-video-card-meta';
      const title = document.createElement('div');
      title.className = 'ai-video-card-title';
      title.textContent = item.title || '';
      meta.appendChild(title);
      if (item.channelTitle) {
        const channel = document.createElement('div');
        channel.className = 'ai-video-card-channel';
        channel.textContent = item.channelTitle;
        meta.appendChild(channel);
      }
      card.appendChild(meta);
      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'ai-video-card-play';
      playBtn.textContent = '▶';
      playBtn.title = 'Open on VoidTube';
      card.appendChild(playBtn);

      const openIt = (e) => {
        e.stopPropagation();
        const url = buildVoidTubeUrl({ v: item.videoId });
        if (activeTabId && tabs.has(activeTabId)) navigate(activeTabId, url);
        else createTab(url);
      };
      card.addEventListener('click', openIt);
      playBtn.addEventListener('click', openIt);
      wrap.appendChild(card);
    });
    aiMessages.appendChild(wrap);
    aiMessages.scrollTop = aiMessages.scrollHeight;
    return wrap;
  }

  // Executes one model-requested tool call against the real tab manager and
  // returns a small JSON-serializable result the model can read back.
  // Async because web_search/read_url hit the server; the agent loop below
  // awaits this for every tool, tab tools included.
  async function executeToolCall(name, args) {
    switch (name) {
      case 'open_tab': {
        const makeActive = args.make_active !== false;
        const previousActive = activeTabId;
        const tab = createTab(args.url);
        if (!makeActive && previousActive && tabs.has(previousActive)) switchTab(previousActive);
        appendToolNotice(`🔧 Opened a new tab → ${args.url}`);
        return { ok: true, tab_id: tab.id, url: args.url };
      }
      case 'navigate_tab': {
        if (!tabs.has(args.tab_id)) return { ok: false, error: `No tab with id ${args.tab_id}.` };
        navigate(args.tab_id, args.url);
        appendToolNotice(`🔧 Navigated tab ${args.tab_id} → ${args.url}`);
        return { ok: true, tab_id: args.tab_id, url: args.url };
      }
      case 'close_tab': {
        if (!tabs.has(args.tab_id)) return { ok: false, error: `No tab with id ${args.tab_id}.` };
        const wasActive = activeTabId === args.tab_id;
        closeTab(args.tab_id);
        appendToolNotice(`🔧 Closed tab ${args.tab_id}${wasActive ? ' (was active)' : ''}`);
        return { ok: true, tab_id: args.tab_id };
      }
      case 'switch_tab': {
        if (!tabs.has(args.tab_id)) return { ok: false, error: `No tab with id ${args.tab_id}.` };
        switchTab(args.tab_id);
        appendToolNotice(`🔧 Switched to tab ${args.tab_id}`);
        return { ok: true, tab_id: args.tab_id };
      }
      case 'list_tabs': {
        const list = [];
        tabs.forEach((tab) => {
          list.push({
            tab_id: tab.id,
            title: tab.titleEl ? tab.titleEl.textContent : 'New Tab',
            url: tab.currentUrl || 'void://home',
            active: tab.id === activeTabId,
          });
        });
        return { ok: true, tabs: list };
      }
      case 'read_tab': {
        const context = getTabContext(args.tab_id, MAX_PAGE_CONTEXT_CHARS);
        if (!context) return { ok: false, error: `No tab with id ${args.tab_id}.` };
        appendToolNotice(`🔧 Read tab ${args.tab_id} (${context.url})`);
        return { ok: true, ...context };
      }
      case 'web_search': {
        const query = String(args.query || '').trim();
        if (!query) return { ok: false, error: 'Missing search query.' };
        try {
          const res = await fetch(`/api/search?type=web&q=${encodeURIComponent(query)}`);
          const data = await res.json();
          if (!res.ok || data.error) return { ok: false, error: data.error || `Search failed (${res.status}).` };
          const results = (data.results || []).slice(0, 8).map((r) => ({
            title: r.title,
            url: r.link,
            source: r.displayLink,
            snippet: r.snippet,
          }));
          appendToolNotice(`🔎 Searched the web for "${query}" — ${results.length} result${results.length === 1 ? '' : 's'}`);
          return { ok: true, query, results };
        } catch (err) {
          return { ok: false, error: err.message || 'Web search failed.' };
        }
      }
      case 'read_url': {
        const url = String(args.url || '').trim();
        if (!url) return { ok: false, error: 'Missing url.' };
        try {
          const res = await fetch(`/api/void-ai/read-url?url=${encodeURIComponent(url)}`);
          const data = await res.json();
          if (!res.ok || data.error) return { ok: false, error: data.error || `Could not read that page (${res.status}).` };
          appendToolNotice(`📄 Read ${data.title ? `"${data.title}"` : data.url}`);
          return { ok: true, url: data.url, title: data.title, text: data.text };
        } catch (err) {
          return { ok: false, error: err.message || 'Reading the page failed.' };
        }
      }
      case 'search_voidtube': {
        const query = String(args.query || '').trim();
        if (!query) return { ok: false, error: 'Missing query.' };
        try {
          const res = await fetch('/api/youtube/search?maxResults=6&q=' + encodeURIComponent(query));
          const data = await res.json();
          if (!res.ok || data.error || !data.results || !data.results.length) {
            return { ok: false, error: data.error || `No videos found for "${query}".` };
          }
          appendVideoResultsCard(data.results, `Results for "${query}"`);
          return {
            ok: true,
            query,
            shown_to_user_as_cards: true,
            instruction: 'These are already shown to the user as clickable cards — do NOT navigate anywhere yourself. Only call open_voidtube_result if the user explicitly asks you to open/play one of these by name.',
            results: data.results.map((r) => ({ video_id: r.videoId, title: r.title, channel: r.channelTitle, published: r.publishedAt })),
          };
        } catch {
          return { ok: false, error: 'Could not reach VoidTube search.' };
        }
      }
      case 'play_video': {
        const query = String(args.query || '').trim();
        if (!query) return { ok: false, error: 'Missing query.' };
        try {
          const res = await fetch('/api/youtube/search?maxResults=1&q=' + encodeURIComponent(query));
          const data = await res.json();
          const top = data.results && data.results[0];
          if (!res.ok || data.error || !top) {
            return { ok: false, error: data.error || `Couldn't find a video for "${query}".` };
          }
          appendVideoResultsCard([top], `Found for "${query}"`);
          return {
            ok: true,
            query,
            shown_to_user_as_a_card: true,
            instruction: 'This is already shown to the user as a clickable card — do NOT open or navigate anywhere yourself. Only call open_voidtube_result if the user explicitly confirms they want it opened/played.',
            video_id: top.videoId,
            title: top.title,
            channel: top.channelTitle,
          };
        } catch {
          return { ok: false, error: 'Could not reach VoidTube search.' };
        }
      }
      case 'open_voidtube_result': {
        const videoId = String(args.video_id || '').trim();
        if (!videoId) return { ok: false, error: 'Missing video_id.' };
        const url = buildVoidTubeUrl({ v: videoId });
        let tabId;
        if (args.tab_id && tabs.has(args.tab_id)) {
          navigate(args.tab_id, url);
          tabId = args.tab_id;
        } else {
          const tab = createTab(url);
          tabId = tab.id;
        }
        appendToolNotice(`▶️ Opened on VoidTube`);
        return { ok: true, tab_id: tabId, video_id: videoId };
      }
      case 'reload_tab': {
        const tabId = args.tab_id && tabs.has(args.tab_id) ? args.tab_id : activeTabId;
        if (!tabId || !tabs.has(tabId)) return { ok: false, error: 'No tab to reload.' };
        const ok = reloadTab(tabId);
        if (!ok) return { ok: false, error: "That tab has nothing loaded to reload." };
        appendToolNotice(`🔄 Reloaded tab`);
        return { ok: true, tab_id: tabId };
      }
      case 'open_voidbuild': {
        const buildPrompt = String(args.build_prompt || '').trim();
        if (!buildPrompt) return { ok: false, error: 'Missing build_prompt.' };
        const tab = createTab(buildVoidBuildUrl({ prompt: buildPrompt }));
        appendToolNotice(`🛠️ Opened VoidBuild and started building: "${buildPrompt}"`);
        return { ok: true, tab_id: tab.id, build_prompt: buildPrompt };
      }
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  }

  // Reveals assistant replies a chunk at a time instead of all at once.
  // Total reveal time is capped so long replies don't take forever to appear.
  function typewriterReveal(el, fullText, onDone) {
    const MIN_MS = 300;
    const MAX_MS = 5000;
    const FRAME_MS = 16;
    const targetDuration = Math.max(MIN_MS, Math.min(MAX_MS, fullText.length * 10));
    const totalFrames = Math.max(1, Math.round(targetDuration / FRAME_MS));
    const charsPerFrame = Math.max(1, Math.ceil(fullText.length / totalFrames));

    let shown = 0;
    el.textContent = '';

    const timer = setInterval(() => {
      shown += charsPerFrame;
      if (shown >= fullText.length) {
        el.innerHTML = renderMarkdown(fullText);
        clearInterval(timer);
        aiMessages.scrollTop = aiMessages.scrollHeight;
        if (typeof onDone === 'function') onDone();
        return;
      }
      el.textContent = fullText.slice(0, shown);
      aiMessages.scrollTop = aiMessages.scrollHeight;
    }, FRAME_MS);
  }

  // A single status bubble that morphs in place through whatever the agent
  // loop is currently doing — thinking, searching the web, reading a page,
  // or driving the browser — instead of stacking a new "Thinking…" line
  // every iteration. It's removed (with a small fade) once a real answer
  // is ready, so the whole tool-using process reads as one continuous
  // thought rather than a log of separate steps.
  const STATUS_ICONS = {
    thinking: '<span class="dot"></span><span class="dot"></span><span class="dot"></span>',
    searching: '<span class="ai-status-glyph">🔎</span>',
    reading: '<span class="ai-status-glyph">📄</span>',
    acting: '<span class="ai-status-glyph">⚙️</span>',
    connecting: '<span class="ai-status-glyph ai-status-glyph-voidtube">📺</span>',
    building: '<span class="ai-status-glyph">🛠️</span>',
  };

  function createStatusBubble(label) {
    const el = document.createElement('div');
    el.className = 'ai-msg ai-status';
    el.dataset.phase = 'thinking';
    el.innerHTML = `<span class="ai-status-icon">${STATUS_ICONS.thinking}</span><span class="ai-status-label">${label}</span>`;
    aiMessages.appendChild(el);
    aiMessages.scrollTop = aiMessages.scrollHeight;

    const iconEl = el.querySelector('.ai-status-icon');
    const labelEl = el.querySelector('.ai-status-label');
    let swapToken = 0;

    function setPhase(phase, nextLabel) {
      const token = ++swapToken;
      el.classList.add('ai-status-swap');
      setTimeout(() => {
        if (token !== swapToken) return; // a newer phase change already landed
        el.dataset.phase = phase;
        iconEl.innerHTML = STATUS_ICONS[phase] || STATUS_ICONS.thinking;
        labelEl.textContent = nextLabel;
        el.classList.remove('ai-status-swap');
        aiMessages.scrollTop = aiMessages.scrollHeight;
      }, 140);
    }

    function remove() {
      el.classList.add('ai-status-exit');
      setTimeout(() => el.remove(), 200);
    }

    return { el, setPhase, remove };
  }

  // Picks a phase + human-readable label for whatever tool call(s) the
  // model just requested, so the status bubble reflects what's actually
  // happening (searching, reading a specific page, or using a browser tool)
  // rather than a generic "working…".
  function describeToolPhase(toolCalls) {
    if (toolCalls.length > 1) {
      if (toolCalls.every((c) => c.function.name === 'search_voidtube' || c.function.name === 'play_video' || c.function.name === 'open_voidtube_result')) {
        return ['connecting', 'Connecting to VoidTube…'];
      }
      return ['acting', `Using ${toolCalls.length} tools…`];
    }
    const call = toolCalls[0];
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      args = {};
    }
    if (call.function.name === 'web_search') {
      return ['searching', args.query ? `Searching the web for "${args.query}"…` : 'Searching the web…'];
    }
    if (call.function.name === 'read_url') {
      let domain = args.url || 'that page';
      try {
        domain = new URL(args.url).hostname.replace(/^www\./, '');
      } catch {
        /* leave as-is */
      }
      return ['reading', `Reading ${domain}…`];
    }
    if (call.function.name === 'search_voidtube' || call.function.name === 'play_video' || call.function.name === 'open_voidtube_result') {
      return ['connecting', 'Connecting to VoidTube…'];
    }
    if (call.function.name === 'open_voidbuild') {
      return ['building', 'Opening VoidBuild…'];
    }
    return ['acting', `Using ${call.function.name.replace(/_/g, ' ')}…`];
  }

  let aiBusy = false;

  // Real streaming (not a simulated typewriter over an already-complete
  // reply): reads /api/void-ai/stream's SSE body chunk by chunk and hands
  // the caller the accumulated text so far after every delta. Used by Void
  // AI Mode and the VoidTube "ask about this video" box — neither needs
  // tool calling, just a plain streamed answer.
  async function streamVoidAi(messages, onDelta, onDone, onError) {
    let full = '';
    try {
      const res = await fetch('/api/void-ai/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        onError(data.error || `Void AI responded ${res.status}.`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            if (json.error) {
              onError(json.error);
              return;
            }
            if (typeof json.delta === 'string') {
              full += json.delta;
              onDelta(full);
            }
          } catch {
            // Ignore any stray non-JSON line.
          }
        }
      }
      onDone(full);
    } catch (err) {
      onError(err.message || 'Void AI stream failed.');
    }
  }

  async function callVoidAi(outgoingMessages) {
    const res = await fetch('/api/void-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: outgoingMessages, tools: AI_TOOLS }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `Void AI request failed (${res.status}).`);
    }
    return data;
  }

  aiForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (aiBusy) return;

    const text = aiInput.value.trim();
    if (!text) return;

    aiBusy = true;
    aiInput.value = '';
    aiInput.disabled = true;
    document.getElementById('ai-send-btn').disabled = true;

    appendAiMessage('user', text);
    conversation.push({ role: 'user', content: text });

    const attachedContexts = Array.from(selectedContextTabIds)
      .map((id) => getTabContext(id))
      .filter(Boolean);
    const fallbackContext = attachedContexts.length === 0 ? getActiveTabContext() : null;
    const systemMessage = { role: 'system', content: buildSystemMessage(fallbackContext ? [fallbackContext] : attachedContexts) };

    logToConsole(
      'ai',
      `Void AI request sent — context: ${
        attachedContexts.length ? attachedContexts.map((c) => c.url).join(', ') : fallbackContext ? fallbackContext.url : 'none'
      } (${conversation.length} turns).`
    );

    const status = createStatusBubble('Thinking…');

    const finishUp = () => {
      aiBusy = false;
      aiInput.disabled = false;
      document.getElementById('ai-send-btn').disabled = false;
      aiInput.focus();
    };

    try {
      let iterations = 0;
      // The agent loop: call the model, and if it comes back wanting to use
      // a tool, run that tool against the real tab manager, feed the result
      // back in as a role:"tool" message, and let the model continue —
      // until it produces a plain text answer or we hit the iteration cap.
      while (true) {
        iterations += 1;
        if (iterations > MAX_TOOL_ITERATIONS) {
          throw new Error('Void AI made too many tool calls in a row without finishing — stopping to avoid a runaway loop.');
        }

        const started = Date.now();
        const outgoing = [systemMessage, ...conversation];
        const data = await callVoidAi(outgoing);
        const elapsed = Date.now() - started;
        const message = data.message;

        if (message.tool_calls && message.tool_calls.length) {
          conversation.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
          logToConsole('ai', `Void AI (${data.model}) requested ${message.tool_calls.length} tool call(s) in ${elapsed}ms.`);

          const [phase, label] = describeToolPhase(message.tool_calls);
          status.setPhase(phase, label);

          for (const call of message.tool_calls) {
            let args = {};
            try {
              args = JSON.parse(call.function.arguments || '{}');
            } catch {
              args = {};
            }
            let result;
            try {
              result = await executeToolCall(call.function.name, args);
            } catch (toolErr) {
              result = { ok: false, error: toolErr.message || 'Tool execution failed.' };
            }
            logToConsole('ai', `Tool ${call.function.name}(${JSON.stringify(args)}) → ${JSON.stringify(result).slice(0, 200)}`);
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          }

          status.setPhase('thinking', 'Thinking…');
          continue; // let the model see the tool results and keep going
        }

        // Plain text reply — done. Fade the status bubble out and the
        // typed answer in, so search → read → think → answer reads as one
        // continuous thing rather than a stack of separate messages.
        status.remove();
        conversation.push({ role: 'assistant', content: message.content || '' });
        logToConsole('ai', `Void AI replied via ${data.model} in ${elapsed}ms.`);
        const replyEl = appendAiMessage('assistant', '');
        replyEl.classList.add('ai-msg-enter');
        typewriterReveal(replyEl, message.content || '(No reply text.)', finishUp);
        return;
      }
    } catch (err) {
      status.remove();
      appendAiMessage('error', err.message || 'Could not reach Void AI. Check the server is running.');
      logToConsole('error', `Void AI error: ${err.message}`);
      finishUp();
    }
  });

  // ---------------------------------------------------------------------
  // Music — an Apple Music–style panel that searches YouTube's Music
  // category via /api/youtube/search and plays results with the official
  // YouTube IFrame Player API. This only streams; nothing is downloaded
  // or written to disk, in keeping with YouTube's Terms of Service.
  // ---------------------------------------------------------------------

  const MUSIC_LIBRARY_KEY = 'void-music-library-v1';

  const musicPanel = document.getElementById('music-panel');
  const musicToggle = document.getElementById('music-toggle');
  const musicCloseBtn = document.getElementById('music-close-btn');
  const musicSearchForm = document.getElementById('music-search-form');
  const musicSearchInput = document.getElementById('music-search-input');
  const musicSearchResults = document.getElementById('music-search-results');
  const musicSearchEmpty = document.getElementById('music-search-empty');
  const musicLibraryList = document.getElementById('music-library-list');
  const musicLibraryEmpty = document.getElementById('music-library-empty');
  const musicPlaylistsList = document.getElementById('music-playlists-list');
  const musicNewPlaylistInput = document.getElementById('music-new-playlist-input');
  const musicNewPlaylistBtn = document.getElementById('music-new-playlist-btn');
  const musicTabBtns = document.querySelectorAll('.music-tab-btn');
  const musicViews = {
    search: document.getElementById('music-view-search'),
    library: document.getElementById('music-view-library'),
    playlists: document.getElementById('music-view-playlists'),
  };
  const musicNowPlaying = document.getElementById('music-now-playing');
  const musicNowArt = document.getElementById('music-now-art');
  const musicNowTitle = document.getElementById('music-now-title');
  const musicNowChannel = document.getElementById('music-now-channel');
  const musicNowTime = document.getElementById('music-now-time');
  const musicNowDuration = document.getElementById('music-now-duration');
  const musicSeek = document.getElementById('music-now-seek');
  const musicPrevBtn = document.getElementById('music-prev-btn');
  const musicPlayPauseBtn = document.getElementById('music-playpause-btn');
  const musicNextBtn = document.getElementById('music-next-btn');
  const musicLikeBtn = document.getElementById('music-like-btn');

  function loadMusicLibrary() {
    try {
      const raw = localStorage.getItem(MUSIC_LIBRARY_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.liked) && Array.isArray(parsed.playlists)) return parsed;
    } catch {}
    return { liked: [], playlists: [] };
  }

  function saveMusicLibrary() {
    try {
      localStorage.setItem(MUSIC_LIBRARY_KEY, JSON.stringify(musicLibrary));
    } catch {}
  }

  const musicLibrary = loadMusicLibrary();

  // The current play queue (an array of track objects) and index into it,
  // so next/prev work whether the queue came from search results, the
  // library, or a playlist.
  let musicQueue = [];
  let musicQueueIndex = -1;
  let musicPlayer = null; // YT.Player instance, created lazily
  let musicPlayerReady = false;
  let musicProgressTimer = null;
  let musicActiveTab = 'search';

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function trackInLibrary(videoId) {
    return musicLibrary.liked.some((t) => t.videoId === videoId);
  }

  function toggleLibraryTrack(track) {
    const idx = musicLibrary.liked.findIndex((t) => t.videoId === track.videoId);
    if (idx >= 0) {
      musicLibrary.liked.splice(idx, 1);
    } else {
      musicLibrary.liked.unshift(track);
    }
    saveMusicLibrary();
    renderMusicLibrary();
    if (musicQueue[musicQueueIndex] && musicQueue[musicQueueIndex].videoId === track.videoId) {
      updateLikeButton(track.videoId);
    }
  }

  function updateLikeButton(videoId) {
    musicLikeBtn.textContent = trackInLibrary(videoId) ? '♥' : '♡';
  }

  // -----------------------------------------------------------------
  // Rendering: a shared "track row" used by search results, the
  // library view, and playlist detail views.
  // -----------------------------------------------------------------

  function buildTrackRow(track, queue, indexInQueue) {
    const row = document.createElement('div');
    row.className = 'music-row';
    if (musicQueue[musicQueueIndex] && musicQueue[musicQueueIndex].videoId === track.videoId) {
      row.classList.add('playing');
    }

    const art = document.createElement('img');
    art.className = 'music-row-art';
    art.src = track.thumbnail || '';
    art.alt = '';
    row.appendChild(art);

    const meta = document.createElement('div');
    meta.className = 'music-row-meta';
    const title = document.createElement('div');
    title.className = 'music-row-title';
    title.textContent = track.title;
    const channel = document.createElement('div');
    channel.className = 'music-row-channel';
    channel.textContent = track.channelTitle;
    meta.appendChild(title);
    meta.appendChild(channel);
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'music-row-actions';

    const likeBtn = document.createElement('button');
    likeBtn.className = 'music-row-btn';
    likeBtn.title = 'Add to Library';
    likeBtn.textContent = trackInLibrary(track.videoId) ? '♥' : '♡';
    likeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLibraryTrack(track);
      likeBtn.textContent = trackInLibrary(track.videoId) ? '♥' : '♡';
    });
    actions.appendChild(likeBtn);

    if (musicLibrary.playlists.length) {
      const addBtn = document.createElement('button');
      addBtn.className = 'music-row-btn';
      addBtn.title = 'Add to playlist';
      addBtn.textContent = '⋯';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddToPlaylistMenu(track, addBtn);
      });
      actions.appendChild(addBtn);
    }

    row.appendChild(actions);

    row.addEventListener('click', () => playQueue(queue, indexInQueue));
    return row;
  }

  function openAddToPlaylistMenu(track, anchorEl) {
    const names = musicLibrary.playlists.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    const choice = window.prompt(`Add "${track.title}" to which playlist?\n${names}\n\nEnter a number:`);
    const i = parseInt(choice, 10) - 1;
    if (Number.isInteger(i) && musicLibrary.playlists[i]) {
      const playlist = musicLibrary.playlists[i];
      if (!playlist.tracks.some((t) => t.videoId === track.videoId)) {
        playlist.tracks.push(track);
        saveMusicLibrary();
        logToConsole('info', `Added "${track.title}" to playlist "${playlist.name}".`);
      }
    }
  }

  function renderMusicLibrary() {
    musicLibraryList.innerHTML = '';
    musicLibraryEmpty.classList.toggle('hidden', musicLibrary.liked.length > 0);
    musicLibrary.liked.forEach((track, i) => {
      musicLibraryList.appendChild(buildTrackRow(track, musicLibrary.liked, i));
    });
  }

  function renderPlaylistsRoot() {
    musicPlaylistsList.innerHTML = '';
    musicLibrary.playlists.forEach((playlist, i) => {
      const card = document.createElement('div');
      card.className = 'music-playlist-card';
      const name = document.createElement('div');
      name.className = 'music-playlist-card-name';
      name.textContent = playlist.name;
      const count = document.createElement('div');
      count.className = 'music-playlist-card-count';
      count.textContent = `${playlist.tracks.length} song${playlist.tracks.length === 1 ? '' : 's'}`;
      card.appendChild(name);
      card.appendChild(count);
      card.addEventListener('click', () => renderPlaylistDetail(i));
      musicPlaylistsList.appendChild(card);
    });
  }

  function renderPlaylistDetail(playlistIndex) {
    const playlist = musicLibrary.playlists[playlistIndex];
    musicPlaylistsList.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'music-playlist-detail-header';
    const back = document.createElement('button');
    back.className = 'music-playlist-back';
    back.textContent = '←';
    back.addEventListener('click', renderPlaylistsRoot);
    const h3 = document.createElement('h3');
    h3.textContent = playlist.name;
    header.appendChild(back);
    header.appendChild(h3);
    musicPlaylistsList.appendChild(header);

    playlist.tracks.forEach((track, i) => {
      musicPlaylistsList.appendChild(buildTrackRow(track, playlist.tracks, i));
    });
  }

  musicNewPlaylistBtn.addEventListener('click', () => {
    const name = musicNewPlaylistInput.value.trim();
    if (!name) return;
    musicLibrary.playlists.push({ id: 'pl-' + Date.now(), name, tracks: [] });
    saveMusicLibrary();
    musicNewPlaylistInput.value = '';
    renderPlaylistsRoot();
  });

  // -----------------------------------------------------------------
  // Tabs
  // -----------------------------------------------------------------

  musicTabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      musicActiveTab = btn.dataset.tab;
      musicTabBtns.forEach((b) => b.classList.toggle('active', b === btn));
      Object.keys(musicViews).forEach((key) => {
        musicViews[key].classList.toggle('hidden', key !== musicActiveTab);
      });
      if (musicActiveTab === 'library') renderMusicLibrary();
      if (musicActiveTab === 'playlists') renderPlaylistsRoot();
    });
  });

  // -----------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------

  musicSearchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = musicSearchInput.value.trim();
    if (!q) return;
    musicSearchResults.innerHTML = '';
    musicSearchEmpty.textContent = 'Searching…';
    musicSearchEmpty.classList.remove('hidden');
    try {
      const res = await fetch('/api/youtube/search?category=music&q=' + encodeURIComponent(q));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed.');
      const tracks = (data.results || []).map((r) => ({
        videoId: r.videoId,
        title: r.title,
        channelTitle: r.channelTitle,
        thumbnail: r.thumbnail,
      }));
      musicSearchEmpty.classList.toggle('hidden', tracks.length > 0);
      if (!tracks.length) musicSearchEmpty.textContent = 'No results.';
      tracks.forEach((track, i) => musicSearchResults.appendChild(buildTrackRow(track, tracks, i)));
      logToConsole('info', `Music search "${q}" → ${tracks.length} result(s).`);
    } catch (err) {
      musicSearchEmpty.textContent = err.message || 'Search failed.';
      musicSearchEmpty.classList.remove('hidden');
      logToConsole('error', `Music search error: ${err.message}`);
    }
  });

  // -----------------------------------------------------------------
  // Playback — the YouTube IFrame Player streams audio (video hidden
  // off-screen); this only plays, it never saves media anywhere.
  // -----------------------------------------------------------------

  function ensureMusicPlayer(onReady) {
    if (musicPlayer) return onReady();
    if (typeof YT === 'undefined' || !YT.Player) {
      // The IFrame API script hasn't finished loading yet; try again shortly.
      setTimeout(() => ensureMusicPlayer(onReady), 200);
      return;
    }
    musicPlayer = new YT.Player('music-yt-host', {
      height: '1',
      width: '1',
      playerVars: { autoplay: 1, controls: 0, disablekb: 1 },
      events: {
        onReady: () => {
          musicPlayerReady = true;
          onReady();
        },
        onStateChange: onMusicPlayerStateChange,
        onError: (e) => {
          logToConsole('error', `Music playback error (code ${e.data}).`);
          playNextInQueue();
        },
      },
    });
  }

  function onMusicPlayerStateChange(e) {
    if (e.data === YT.PlayerState.PLAYING) {
      musicPlayPauseBtn.textContent = '⏸';
      startProgressTimer();
    } else if (e.data === YT.PlayerState.PAUSED) {
      musicPlayPauseBtn.textContent = '▶';
      stopProgressTimer();
    } else if (e.data === YT.PlayerState.ENDED) {
      playNextInQueue();
    }
  }

  function startProgressTimer() {
    stopProgressTimer();
    musicProgressTimer = setInterval(() => {
      if (!musicPlayer || typeof musicPlayer.getCurrentTime !== 'function') return;
      const current = musicPlayer.getCurrentTime() || 0;
      const duration = musicPlayer.getDuration() || 0;
      musicNowTime.textContent = formatTime(current);
      musicNowDuration.textContent = formatTime(duration);
      if (duration > 0) musicSeek.value = String(Math.round((current / duration) * 1000));
    }, 500);
  }

  function stopProgressTimer() {
    if (musicProgressTimer) clearInterval(musicProgressTimer);
    musicProgressTimer = null;
  }

  function playQueue(queue, index) {
    musicQueue = queue.slice();
    musicQueueIndex = index;
    const track = musicQueue[musicQueueIndex];
    if (!track) return;

    musicNowPlaying.classList.remove('hidden');
    musicNowArt.src = track.thumbnail || '';
    musicNowTitle.textContent = track.title;
    musicNowChannel.textContent = track.channelTitle;
    updateLikeButton(track.videoId);
    musicSeek.value = '0';
    musicNowTime.textContent = '0:00';
    musicNowDuration.textContent = '0:00';

    ensureMusicPlayer(() => {
      musicPlayer.loadVideoById(track.videoId);
    });

    // Re-highlight whichever row list is currently visible.
    [musicSearchResults, musicLibraryList, musicPlaylistsList].forEach((list) => {
      list.querySelectorAll('.music-row').forEach((row) => row.classList.remove('playing'));
    });
    logToConsole('info', `Now playing: ${track.title}`);
  }

  function playNextInQueue() {
    if (!musicQueue.length) return;
    const nextIndex = (musicQueueIndex + 1) % musicQueue.length;
    playQueue(musicQueue, nextIndex);
  }

  function playPrevInQueue() {
    if (!musicQueue.length) return;
    const prevIndex = (musicQueueIndex - 1 + musicQueue.length) % musicQueue.length;
    playQueue(musicQueue, prevIndex);
  }

  musicPlayPauseBtn.addEventListener('click', () => {
    if (!musicPlayer || !musicPlayerReady) return;
    const state = musicPlayer.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      musicPlayer.pauseVideo();
    } else {
      musicPlayer.playVideo();
    }
  });

  musicNextBtn.addEventListener('click', playNextInQueue);
  musicPrevBtn.addEventListener('click', playPrevInQueue);

  musicLikeBtn.addEventListener('click', () => {
    const track = musicQueue[musicQueueIndex];
    if (track) toggleLibraryTrack(track);
  });

  musicSeek.addEventListener('input', () => {
    if (!musicPlayer || typeof musicPlayer.getDuration !== 'function') return;
    const duration = musicPlayer.getDuration() || 0;
    if (duration > 0) {
      musicPlayer.seekTo((Number(musicSeek.value) / 1000) * duration, true);
    }
  });

  // -----------------------------------------------------------------
  // Panel open/close
  // -----------------------------------------------------------------

  musicToggle.addEventListener('click', () => musicPanel.classList.toggle('hidden'));
  musicCloseBtn.addEventListener('click', () => musicPanel.classList.add('hidden'));

  // ---------------------------------------------------------------------
  // Customize — a Chrome-style panel for theme mode, accent color, and
  // the new-tab background (solid colors, built-in gradients, or an
  // image the person uploads from their own device).
  // ---------------------------------------------------------------------

  const CUSTOMIZE_KEY = 'void-customize-v1';

  const ACCENT_PRESETS = [
    { name: 'Void', accent: '#8b5cf6', bright: '#b28dff' },
    { name: 'Blue', accent: '#3b82f6', bright: '#93c5fd' },
    { name: 'Indigo', accent: '#6366f1', bright: '#a5b4fc' },
    { name: 'Slate', accent: '#64748b', bright: '#cbd5e1' },
    { name: 'Teal', accent: '#14b8a6', bright: '#5eead4' },
    { name: 'Green', accent: '#22c55e', bright: '#86efac' },
    { name: 'Amber', accent: '#f59e0b', bright: '#fcd34d' },
    { name: 'Orange', accent: '#f97316', bright: '#fdba74' },
    { name: 'Rose', accent: '#f43f5e', bright: '#fda4af' },
    { name: 'Pink', accent: '#ec4899', bright: '#f9a8d4' },
    { name: 'Purple', accent: '#a855f7', bright: '#d8b4fe' },
    { name: 'Magenta', accent: '#ff4fd8', bright: '#ff8be9' },
  ];

  const SOLID_BG_COLORS = ['#07050d', '#111827', '#1e293b', '#3f3f46', '#450a0a', '#1e1b4b', '#052e16', '#164e63', '#3f2d1a', '#3b0764', '#4a044e', '#0c0a09'];

  const BG_PRESETS = [
    { id: 'aurora', label: 'Aurora', css: 'linear-gradient(135deg, #1e1b4b, #4c1d95, #831843)' },
    { id: 'sunset', label: 'Sunset', css: 'linear-gradient(135deg, #7c2d12, #b91c1c, #d97706)' },
    { id: 'ocean', label: 'Ocean', css: 'linear-gradient(135deg, #0c4a6e, #075985, #0e7490)' },
    { id: 'forest', label: 'Forest', css: 'linear-gradient(135deg, #14532d, #166534, #365314)' },
    { id: 'nebula', label: 'Nebula', css: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)' },
    { id: 'rosegold', label: 'Rose Gold', css: 'linear-gradient(135deg, #831843, #9d174d, #d97706)' },
    { id: 'midnight', label: 'Midnight', css: 'linear-gradient(135deg, #000000, #1e1e2f)' },
    { id: 'dawn', label: 'Dawn', css: 'linear-gradient(135deg, #1e293b, #7c3aed, #f472b6)' },
  ];

  function loadCustomizeSettings() {
    const defaults = {
      themeMode: 'dark',
      accent: ACCENT_PRESETS[0],
      background: { type: 'none', value: '' },
    };
    try {
      const raw = localStorage.getItem(CUSTOMIZE_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return Object.assign({}, defaults, parsed);
    } catch {
      return defaults;
    }
  }

  const customizeSettings = loadCustomizeSettings();

  function saveCustomizeSettings() {
    try {
      localStorage.setItem(CUSTOMIZE_KEY, JSON.stringify(customizeSettings));
    } catch (err) {
      logToConsole('error', 'Could not save appearance settings (storage may be full).');
    }
  }

  function resolvedThemeMode() {
    if (customizeSettings.themeMode !== 'device') return customizeSettings.themeMode;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyCustomizeSettings() {
    document.documentElement.dataset.theme = resolvedThemeMode();

    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--accent', customizeSettings.accent.accent);
    rootStyle.setProperty('--accent-bright', customizeSettings.accent.bright);

    const bg = customizeSettings.background;
    if (bg.type === 'solid') {
      rootStyle.setProperty('--home-bg-image', 'none');
      rootStyle.setProperty('--home-bg-color', bg.value);
    } else if (bg.type === 'preset') {
      rootStyle.setProperty('--home-bg-image', bg.value);
      rootStyle.setProperty('--home-bg-color', 'transparent');
    } else if (bg.type === 'upload') {
      rootStyle.setProperty('--home-bg-image', `url("${bg.value}")`);
      rootStyle.setProperty('--home-bg-color', 'transparent');
    } else {
      rootStyle.setProperty('--home-bg-image', 'none');
      rootStyle.setProperty('--home-bg-color', 'transparent');
    }
  }

  // Re-resolve "Device" mode if the OS theme changes while Void is open.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (customizeSettings.themeMode === 'device') applyCustomizeSettings();
    });
  }

  const customizePanel = document.getElementById('customize-panel');
  const customizeCloseBtn = document.getElementById('customize-close-btn');
  const customizeBackBtn = document.getElementById('customize-back-btn');
  const customizeTitle = document.getElementById('customize-title');
  const customizeViewMain = document.getElementById('customize-view-main');
  const customizeViewBg = document.getElementById('customize-view-bg');
  const customizeModeBtns = document.querySelectorAll('.customize-mode-btn');
  const customizeAccentGrid = document.getElementById('customize-accent-grid');
  const customizeOpenBgBtn = document.getElementById('customize-open-bg-btn');
  const customizeSolidGrid = document.getElementById('customize-solid-grid');
  const customizePresetGrid = document.getElementById('customize-preset-grid');
  const customizeUploadTile = document.getElementById('customize-upload-tile');
  const customizeBgNoneTile = document.getElementById('customize-bg-none-tile');
  const customizeUploadInput = document.getElementById('customize-upload-input');

  function openCustomizePanel() {
    customizePanel.classList.remove('hidden');
    showCustomizeView('main');
  }

  function showCustomizeView(view) {
    customizeViewMain.classList.toggle('hidden', view !== 'main');
    customizeViewBg.classList.toggle('hidden', view !== 'bg');
    customizeBackBtn.classList.toggle('hidden', view === 'main');
    customizeTitle.textContent = view === 'main' ? 'Customize Void' : 'Background';
  }

  customizeCloseBtn.addEventListener('click', () => customizePanel.classList.add('hidden'));
  customizeBackBtn.addEventListener('click', () => showCustomizeView('main'));
  customizeOpenBgBtn.addEventListener('click', () => showCustomizeView('bg'));

  customizeModeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      customizeSettings.themeMode = btn.dataset.mode;
      saveCustomizeSettings();
      applyCustomizeSettings();
      renderCustomizeModeButtons();
    });
  });

  function renderCustomizeModeButtons() {
    customizeModeBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === customizeSettings.themeMode);
    });
  }

  function renderAccentGrid() {
    customizeAccentGrid.innerHTML = '';
    ACCENT_PRESETS.forEach((preset) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'customize-swatch';
      sw.title = preset.name;
      sw.style.background = `linear-gradient(135deg, ${preset.accent}, ${preset.bright})`;
      if (customizeSettings.accent.accent === preset.accent) sw.classList.add('active');
      sw.addEventListener('click', () => {
        customizeSettings.accent = preset;
        saveCustomizeSettings();
        applyCustomizeSettings();
        renderAccentGrid();
      });
      customizeAccentGrid.appendChild(sw);
    });

    // A "custom" swatch backed by a native color picker, so any color
    // works, not just the presets above.
    const customSw = document.createElement('button');
    customSw.type = 'button';
    customSw.className = 'customize-swatch customize-swatch-custom';
    customSw.title = 'Custom color';
    customSw.textContent = '🎨';
    customSw.addEventListener('click', () => {
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = customizeSettings.accent.accent;
      picker.addEventListener('input', () => {
        customizeSettings.accent = { name: 'Custom', accent: picker.value, bright: picker.value };
        saveCustomizeSettings();
        applyCustomizeSettings();
        renderAccentGrid();
      });
      picker.click();
    });
    customizeAccentGrid.appendChild(customSw);
  }

  function renderSolidGrid() {
    customizeSolidGrid.innerHTML = '';
    SOLID_BG_COLORS.forEach((color) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'customize-swatch';
      sw.style.background = color;
      if (customizeSettings.background.type === 'solid' && customizeSettings.background.value === color) {
        sw.classList.add('active');
      }
      sw.addEventListener('click', () => {
        customizeSettings.background = { type: 'solid', value: color };
        saveCustomizeSettings();
        applyCustomizeSettings();
        renderBgViews();
      });
      customizeSolidGrid.appendChild(sw);
    });
  }

  function renderPresetGrid() {
    customizePresetGrid.innerHTML = '';
    BG_PRESETS.forEach((preset) => {
      const tile = document.createElement('div');
      tile.className = 'customize-bg-tile';
      tile.style.backgroundImage = preset.css;
      tile.textContent = preset.label;
      if (customizeSettings.background.type === 'preset' && customizeSettings.background.value === preset.css) {
        tile.classList.add('active');
      }
      tile.addEventListener('click', () => {
        customizeSettings.background = { type: 'preset', value: preset.css };
        saveCustomizeSettings();
        applyCustomizeSettings();
        renderBgViews();
      });
      customizePresetGrid.appendChild(tile);
    });
  }

  function renderBgViews() {
    renderSolidGrid();
    renderPresetGrid();
    customizeBgNoneTile.classList.toggle('active', customizeSettings.background.type === 'none');
    customizeUploadTile.classList.toggle('active', customizeSettings.background.type === 'upload');
    if (customizeSettings.background.type === 'upload') {
      customizeUploadTile.style.backgroundImage = `url("${customizeSettings.background.value}")`;
    } else {
      customizeUploadTile.style.backgroundImage = '';
    }
  }

  customizeBgNoneTile.addEventListener('click', () => {
    customizeSettings.background = { type: 'none', value: '' };
    saveCustomizeSettings();
    applyCustomizeSettings();
    renderBgViews();
  });

  // The upload only ever touches the person's own local file, is read
  // in-browser with FileReader, and is stored (as a data URL) in this
  // browser's own localStorage — nothing is uploaded anywhere.
  customizeUploadTile.addEventListener('click', () => customizeUploadInput.click());
  customizeUploadInput.addEventListener('change', () => {
    const file = customizeUploadInput.files && customizeUploadInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      logToConsole('error', 'Please choose an image file for the background.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      customizeSettings.background = { type: 'upload', value: reader.result };
      saveCustomizeSettings();
      applyCustomizeSettings();
      renderBgViews();
      logToConsole('info', 'Custom wallpaper applied.');
    };
    reader.onerror = () => logToConsole('error', 'Could not read that image file.');
    reader.readAsDataURL(file);
  });

  renderCustomizeModeButtons();
  renderAccentGrid();
  renderBgViews();
  applyCustomizeSettings();

  // ---------------------------------------------------------------------
  // History — every real navigation (not the home screen) is logged to
  // localStorage with a title, url, and timestamp, and browsable from a
  // panel with search and per-entry click-to-reopen.
  // ---------------------------------------------------------------------

  const HISTORY_KEY = 'void-history-v1';
  const HISTORY_MAX = 500;

  function loadHistoryLog() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  let historyLog = loadHistoryLog();

  function saveHistoryLog() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(historyLog.slice(0, HISTORY_MAX)));
    } catch {
      // Storage full or unavailable — history just won't persist this entry.
    }
  }

  // Called from updateNavButtons(), so it fires after every real navigation
  // (initial load, back/forward, reload, and the in-app search views).
  function recordHistory(tab) {
    if (!tab.currentUrl) return; // void://home — not a real visit
    const title = tab.titleEl.textContent || tab.currentUrl;
    const last = historyLog[0];
    if (last && last.url === tab.currentUrl) {
      last.title = title;
      last.timestamp = Date.now();
    } else {
      historyLog.unshift({ url: tab.currentUrl, title, timestamp: Date.now() });
      if (historyLog.length > HISTORY_MAX) historyLog.length = HISTORY_MAX;
    }
    saveHistoryLog();
    if (!historyPanel.classList.contains('hidden')) renderHistoryList();
  }

  const historyPanel = document.getElementById('history-panel');
  const historyToggle = document.getElementById('history-toggle');
  const historyCloseBtn = document.getElementById('history-close-btn');
  const historyClearBtn = document.getElementById('history-clear-btn');
  const historySearchInput = document.getElementById('history-search-input');
  const historyListEl = document.getElementById('history-list');

  function dayLabelFor(timestamp) {
    const d = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(d, today)) return 'Today';
    if (sameDay(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderHistoryList() {
    const filter = historySearchInput.value.trim().toLowerCase();
    const entries = filter
      ? historyLog.filter((e) => e.title.toLowerCase().includes(filter) || e.url.toLowerCase().includes(filter))
      : historyLog;

    historyListEl.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = filter ? 'No matching history.' : 'No browsing history yet.';
      historyListEl.appendChild(empty);
      return;
    }

    let lastDay = null;
    entries.forEach((entry) => {
      const day = dayLabelFor(entry.timestamp);
      if (day !== lastDay) {
        const label = document.createElement('div');
        label.className = 'history-day-label';
        label.textContent = day;
        historyListEl.appendChild(label);
        lastDay = day;
      }

      const row = document.createElement('div');
      row.className = 'history-row';

      const favicon = document.createElement('div');
      favicon.className = 'history-row-favicon';
      let host = '';
      try {
        host = new URL(entry.url).hostname.replace(/^www\./, '');
      } catch {
        host = entry.url;
      }
      favicon.textContent = host ? host.charAt(0).toUpperCase() : '?';
      favicon.style.background = colorForString(host);
      row.appendChild(favicon);

      const meta = document.createElement('div');
      meta.className = 'history-row-meta';
      const titleEl = document.createElement('div');
      titleEl.className = 'history-row-title';
      titleEl.textContent = entry.title;
      const urlEl = document.createElement('div');
      urlEl.className = 'history-row-url';
      urlEl.textContent = entry.url;
      meta.appendChild(titleEl);
      meta.appendChild(urlEl);
      row.appendChild(meta);

      const time = document.createElement('div');
      time.className = 'history-row-time';
      time.textContent = new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      row.appendChild(time);

      row.addEventListener('click', () => {
        const tab = tabs.get(activeTabId);
        if (tab) navigate(tab.id, entry.url);
        historyPanel.classList.add('hidden');
      });

      historyListEl.appendChild(row);
    });
  }

  function openHistoryPanel() {
    historyPanel.classList.remove('hidden');
    historySearchInput.value = '';
    renderHistoryList();
    historySearchInput.focus();
  }

  historyToggle.addEventListener('click', () => {
    if (historyPanel.classList.contains('hidden')) openHistoryPanel();
    else historyPanel.classList.add('hidden');
  });
  historyCloseBtn.addEventListener('click', () => historyPanel.classList.add('hidden'));
  historySearchInput.addEventListener('input', renderHistoryList);
  historyClearBtn.addEventListener('click', () => {
    if (!historyLog.length) return;
    if (!window.confirm('Clear all browsing history? This can\'t be undone.')) return;
    historyLog = [];
    saveHistoryLog();
    renderHistoryList();
    logToConsole('info', 'Browsing history cleared.');
  });

  // ---------------------------------------------------------------------
  // Session restore — remembers which tabs were open (by their current
  // URL) so closing and reopening Void picks up where you left off.
  // ---------------------------------------------------------------------

  const SESSION_KEY = 'void-session-v1';

  function saveSession() {
    try {
      const urls = Array.from(tabs.values()).map((t) => t.currentUrl || null);
      localStorage.setItem(SESSION_KEY, JSON.stringify(urls));
    } catch {
      // Non-fatal — session just won't restore next launch.
    }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Keyboard shortcuts — only combinations real browsers don't already
  // reserve (Ctrl/Cmd+T, +W, +L, +1-9 etc. can't be intercepted by a page
  // running inside an actual browser tab, so Void uses Alt+ combos instead).
  // ---------------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === 't') {
        e.preventDefault();
        createTab(null);
      } else if (key === 'w') {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
      } else if (key === 'h') {
        e.preventDefault();
        if (historyPanel.classList.contains('hidden')) openHistoryPanel();
        else historyPanel.classList.add('hidden');
      } else if (key === 'l') {
        e.preventDefault();
        urlInput.focus();
        urlInput.select();
      }
      return;
    }

    if (e.key === 'Escape') {
      [aiPanel, musicPanel, customizePanel, historyPanel].forEach((p) => {
        if (p && !p.classList.contains('hidden')) p.classList.add('hidden');
      });
    }
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  const savedSession = loadSession();
  if (savedSession && savedSession.length) {
    savedSession.forEach((url) => createTab(url || null));
    logToConsole('info', `Restored ${savedSession.length} tab(s) from your last session.`);
  } else {
    createTab(null);
  }
  logToConsole('info', 'Void initialized.');
})();
