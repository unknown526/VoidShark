/**
 * Void — server.js
 *
 * Express backend that:
 *  - Accepts a destination URL from the frontend (/proxy?url=...)
 *  - Validates it against SSRF protections
 *  - Fetches it over a pooled, keep-alive connection (following redirects
 *    manually, re-validating each hop), with automatic retry on transient
 *    failures
 *  - Rewrites HTML/CSS so links, scripts, images, etc. keep flowing through
 *    the proxy
 *  - Streams non-rewritable responses straight through (media, downloads,
 *    fonts, JS, JSON) with Range/206 partial-content support, instead of
 *    buffering the whole thing in memory
 *  - Keeps a real per-browser-session cookie jar so logged-in state on a
 *    proxied site survives across requests, without ever handing real
 *    cookies to page JavaScript
 *  - Caches successful GET responses briefly for fast repeat loads, and
 *    revalidates expired entries with conditional requests (ETag /
 *    Last-Modified) instead of always re-fetching the full body
 *  - Rate-limits proxy traffic per client IP
 *  - Relays WebSocket connections opened by proxied pages through
 *    /proxy-ws, with the same SSRF checks as HTTP
 *  - Proxies Void AI chat requests to Groq server-side (API key never
 *    reaches the client), including tool/function calls the browser-side
 *    agent executes against real tabs
 *  - Exposes a lightweight /api/ping for latency reporting in the console
 *    panel
 */

const express = require('express');
const compression = require('compression');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const ipaddr = require('ipaddr.js');
const cheerio = require('cheerio');
const { Agent, fetch: undiciFetch } = require('undici');
const { CookieJar } = require('tough-cookie');
const { WebSocketServer, WebSocket: UpstreamWebSocket } = require('ws');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Compress everything we send back to the browser (HTML, CSS, JSON, the
// rewritten pages, API responses). Doesn't touch streamed proxy bodies that
// are already compressed on the wire (see COMPRESSIBLE_TYPES below).
app.use(compression());

// Void AI's JSON endpoints get JSON body parsing. /proxy gets its own raw
// body capture below so POST/PUT bodies (JSON, form data, protobuf, whatever
// the proxied site's own JS sends) pass through byte-for-byte.
app.use('/api', express.json({ limit: '1mb' }));
app.use('/proxy', express.raw({ type: () => true, limit: '20mb' }));

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15000;
const RETRY_COUNT = 2; // additional attempts beyond the first, on transient failure
const RETRY_BASE_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Pooled, keep-alive outbound connections
// ---------------------------------------------------------------------------
// A fresh TCP+TLS handshake per request is the single biggest latency cost a
// lightweight proxy pays. This pins a shared undici Agent that keeps sockets
// open per-origin and reuses them across requests/redirect hops.
const outboundAgent = new Agent({
  connections: 128, // max sockets per origin
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connectTimeout: 10_000,
});

// ---------------------------------------------------------------------------
// Void AI config
// ---------------------------------------------------------------------------
// All secrets below come ONLY from environment variables (loaded from a
// local .env file via dotenv, or from real env vars in production) — there
// are no hardcoded fallback keys. Copy .env.example to .env and fill it in.
// A feature whose key is missing degrades to a clear "not configured" error
// from its own endpoint instead of crashing the whole server.
const VOID_AI_KEY = process.env.VOID_AI_KEY || '';
const VOID_AI_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.3-70b-versatile and llama-3.1-8b-instant were deprecated by Groq
// (announced June 17, 2026). These are their recommended replacements. All
// three support OpenAI-style tool/function calling, which is what lets Void
// AI open tabs, navigate, and read other tabs (see /api/void-ai below).
const VOID_AI_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']; // primary, then fallbacks
const VOID_AI_TIMEOUT_MS = 25000;

// ---------------------------------------------------------------------------
// Search config (YouTube Data API + Google Custom Search)
// ---------------------------------------------------------------------------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || '';
const GOOGLE_SEARCH_CX = process.env.GOOGLE_SEARCH_CX || '';

// A quick, non-fatal startup warning so a misconfigured .env shows up
// immediately in the terminal instead of as a confusing 500 later.
for (const [name, value] of Object.entries({ VOID_AI_KEY, YOUTUBE_API_KEY, GOOGLE_SEARCH_API_KEY, GOOGLE_SEARCH_CX })) {
  if (!value) console.warn(`[void] Warning: ${name} is not set — the feature(s) that need it will report "not configured".`);
}
const YOUTUBE_SEARCH_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Response cache (GET-only, short TTL, for "connects very fast") + a longer
// -lived ETag/Last-Modified shadow so expired entries can be revalidated
// with a cheap conditional request instead of always re-fetching the body.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 200;
const CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024; // don't cache huge payloads
const REVALIDATION_TTL_MS = 10 * 60 * 1000; // how long we keep etag/last-modified around
const responseCache = new Map(); // url -> { expires, status, contentType, buffer }
const revalidationCache = new Map(); // url -> { etag, lastModified, expiresAt }

function cacheGet(url) {
  const entry = responseCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expires) return null; // kept around for revalidation, see below
  return entry;
}

function cacheSet(url, entry) {
  if (entry.buffer.length > CACHE_MAX_ENTRY_BYTES) return;
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey !== undefined) responseCache.delete(oldestKey);
  }
  responseCache.set(url, entry);
}

function getRevalidators(url) {
  const rev = revalidationCache.get(url);
  if (!rev || Date.now() > rev.expiresAt) return null;
  return rev;
}

function setRevalidators(url, etag, lastModified) {
  if (!etag && !lastModified) return;
  revalidationCache.set(url, { etag, lastModified, expiresAt: Date.now() + REVALIDATION_TTL_MS });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of responseCache) if (now > v.expires + REVALIDATION_TTL_MS) responseCache.delete(k);
  for (const [k, v] of revalidationCache) if (now > v.expiresAt) revalidationCache.delete(k);
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Per-client-session cookie jars
// ---------------------------------------------------------------------------
// Real, RFC-6265-aware cookie handling (domain/path/expiry/secure rules) via
// tough-cookie, keyed by an opaque session id we hand out on our own origin.
// This is what lets a proxied site's login session survive across requests —
// the browser's own document.cookie for the real site is never populated
// (the page itself never runs on the real origin), but the actual HTTP
// requests we make on the browser's behalf now carry the right cookies.
const SESSION_COOKIE_NAME = 'void_sid';
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours of inactivity
const sessionJars = new Map(); // sessionId -> { jar, lastUsed }

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v.replace(/^"|"$/g, ''));
  });
  return out;
}

function getSessionJar(req, res) {
  const cookies = parseCookieHeader(req.headers.cookie);
  let sid = cookies[SESSION_COOKIE_NAME];
  let entry = sid ? sessionJars.get(sid) : undefined;

  if (!entry) {
    sid = crypto.randomUUID();
    entry = { jar: new CookieJar(), lastUsed: Date.now() };
    sessionJars.set(sid, entry);
    res.append('Set-Cookie', `${SESSION_COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }

  entry.lastUsed = Date.now();
  return entry.jar;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessionJars) {
    if (now - entry.lastUsed > SESSION_TTL_MS) sessionJars.delete(id);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Per-IP rate limiting for proxy traffic
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 300;
const rateBuckets = new Map(); // ip -> { count, resetAt }

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    return res.status(429).send(renderErrorPage('Too many requests from this connection. Slow down and try again shortly.'));
  }
  return next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) if (now > bucket.resetAt) rateBuckets.delete(ip);
}, 5 * 60 * 1000).unref();

// IP address categories (from ipaddr.js) that we refuse to fetch.
const DISALLOWED_RANGES = new Set([
  'private',
  'loopback',
  'linkLocal',
  'uniqueLocal',
  'multicast',
  'reserved',
  'broadcast',
  'unspecified',
  'carrierGradeNat',
]);

// ---------------------------------------------------------------------------
// Security: URL / SSRF validation
// ---------------------------------------------------------------------------

function isDisallowedIp(ip) {
  try {
    const addr = ipaddr.process(ip);
    return DISALLOWED_RANGES.has(addr.range());
  } catch {
    return true;
  }
}

async function validateUrl(rawUrl, allowedProtocols = ['http:', 'https:']) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`Only ${allowedProtocols.join(' and ')} URLs are supported.`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Requests to localhost are not allowed.');
  }

  if (net.isIP(hostname)) {
    if (isDisallowedIp(hostname)) {
      throw new Error('Requests to private or internal IP addresses are not allowed.');
    }
    return parsed;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve that hostname.');
  }

  if (!addresses.length) {
    throw new Error('Could not resolve that hostname.');
  }

  for (const { address } of addresses) {
    if (isDisallowedIp(address)) {
      throw new Error('This address resolves to a private or internal IP and cannot be proxied.');
    }
  }

  return parsed;
}

// validateUrl but for ws:/wss: URLs — reuses the same hostname/IP checks by
// briefly treating them as their http/https equivalents.
async function validateWsUrl(rawUrl) {
  let scheme;
  try {
    scheme = new URL(rawUrl).protocol;
  } catch {
    throw new Error('That does not look like a valid WebSocket URL.');
  }
  if (scheme !== 'ws:' && scheme !== 'wss:') {
    throw new Error('Only ws:// and wss:// URLs are supported here.');
  }
  const httpEquivalent = rawUrl.replace(/^ws/i, 'http');
  await validateUrl(httpEquivalent, ['http:', 'https:']);
  return new URL(rawUrl);
}

// ---------------------------------------------------------------------------
// Fetching: pooled connections, manual redirects, retry with backoff
// ---------------------------------------------------------------------------

// Request headers we forward from the client's original request. Anything
// not in this list is dropped (host, cookie, origin, etc. stay local to the
// browser<->proxy hop — real cookies are managed by the session jar instead,
// not forwarded straight from the browser).
const FORWARDABLE_REQUEST_HEADERS = ['content-type', 'accept', 'accept-language', 'x-requested-with', 'range', 'if-range'];

function buildOutgoingHeaders(reqHeaders, targetOrigin, cookieHeader) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; Void/1.0)',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
  };
  for (const name of FORWARDABLE_REQUEST_HEADERS) {
    const value = reqHeaders[name];
    if (value) headers[name] = value;
  }
  headers.Origin = targetOrigin;
  headers.Referer = targetOrigin + '/';
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

async function rawFetch(urlObj, options) {
  const method = options.method || 'GET';
  const hasBody = options.body && !['GET', 'HEAD'].includes(method);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await undiciFetch(urlObj.href, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      dispatcher: outboundAgent,
      headers: options.headers || { 'User-Agent': 'Mozilla/5.0 (compatible; Void/1.0)', Accept: '*/*' },
      body: hasBody ? options.body : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The request timed out.');
    throw new Error('Could not reach that server.');
  } finally {
    clearTimeout(timer);
  }
}

// Wraps rawFetch with automatic retry (idempotent methods only) on network
// failure or a transient 502/503/504 from the origin, with a short
// exponential backoff between attempts.
async function fetchWithRetry(urlObj, options) {
  const method = (options.method || 'GET').toUpperCase();
  const canRetry = method === 'GET' || method === 'HEAD';
  let lastErr;

  for (let attempt = 0; attempt <= (canRetry ? RETRY_COUNT : 0); attempt++) {
    try {
      const response = await rawFetch(urlObj, options);
      if (attempt < RETRY_COUNT && canRetry && isRetryableStatus(response.status)) {
        lastErr = new Error(`Upstream responded ${response.status}`);
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (attempt < (canRetry ? RETRY_COUNT : 0)) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function safeFetch(urlObj, options = {}, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error('Too many redirects.');
  }

  const response = await fetchWithRetry(urlObj, options);

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('Server sent a redirect with no destination.');
    }
    let nextUrl;
    try {
      nextUrl = new URL(location, urlObj.href);
    } catch {
      throw new Error('Server sent an invalid redirect.');
    }
    const validatedNext = await validateUrl(nextUrl.href);
    // 303 (and browsers' handling of 301/302 on POST) downgrades to GET;
    // 307/308 must preserve the original method and body.
    const nextOptions = [307, 308].includes(response.status)
      ? { ...options, headers: { ...options.headers, Origin: validatedNext.origin, Referer: validatedNext.origin + '/' } }
      : { method: 'GET', headers: buildOutgoingHeaders({}, validatedNext.origin, options.headers && options.headers.Cookie) };
    return safeFetch(validatedNext, nextOptions, redirectCount + 1);
  }

  return response;
}

async function readBodyWithLimit(response, maxBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error('The response is too large to proxy.');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('The response is too large to proxy.');
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

// Streams a response body straight to the client with a hard byte cap,
// instead of buffering the whole thing — used for anything that doesn't
// need HTML/CSS rewriting (media, downloads, fonts, JS bundles, JSON, XHR
// payloads). This is what makes large files and video/audio seeking (via
// Range/206) actually work well instead of stalling on a full in-memory
// buffer first.
async function streamBodyWithLimit(response, res, maxBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error('The response is too large to proxy.');
  }
  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        res.end();
        return;
      }
      const ok = res.write(Buffer.from(value));
      if (!ok) await new Promise((resolve) => res.once('drain', resolve));
    }
  } finally {
    res.end();
  }
}

// Content types we rewrite (and therefore must buffer in memory); everything
// else streams through untouched.
function needsRewriting(contentType) {
  return contentType.includes('text/html') || contentType.includes('text/css');
}

// ---------------------------------------------------------------------------
// HTML / CSS rewriting so navigation keeps flowing through the proxy
// ---------------------------------------------------------------------------

function toProxyUrl(absoluteUrl) {
  return '/proxy?url=' + encodeURIComponent(absoluteUrl);
}

function resolveUrl(maybeRelative, baseHref) {
  try {
    return new URL(maybeRelative, baseHref).href;
  } catch {
    return null;
  }
}

function rewriteCssUrls(cssText, baseHref) {
  if (!cssText) return cssText;
  return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, url) => {
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('data:')) return match;
    const absolute = resolveUrl(trimmed, baseHref);
    if (!absolute) return match;
    return `url(${quote}${toProxyUrl(absolute)}${quote})`;
  });
}

function rewriteSrcset(srcset, baseHref) {
  return srcset
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const [url, descriptor] = trimmed.split(/\s+/, 2);
      const absolute = resolveUrl(url, baseHref);
      if (!absolute) return trimmed;
      return toProxyUrl(absolute) + (descriptor ? ' ' + descriptor : '');
    })
    .join(', ');
}

const URL_ATTRS = [
  ['a', 'href'],
  ['link', 'href'],
  ['script', 'src'],
  ['img', 'src'],
  ['iframe', 'src'],
  ['source', 'src'],
  ['video', 'src'],
  ['audio', 'src'],
  ['embed', 'src'],
  ['track', 'src'],
  ['form', 'action'],
];

const SKIP_PREFIXES = ['data:', 'javascript:', 'mailto:', 'tel:', '#'];

function rewriteHtml(html, baseHref) {
  const $ = cheerio.load(html, { decodeEntities: false });

  if ($('head').length === 0) {
    $('html').prepend('<head></head>');
  }
  $('head').prepend(buildShimScript(baseHref));

  URL_ATTRS.forEach(([tag, attr]) => {
    $(tag).each((_, el) => {
      const $el = $(el);
      const val = $el.attr(attr);
      if (!val) return;
      if (SKIP_PREFIXES.some((p) => val.trim().toLowerCase().startsWith(p))) return;
      const absolute = resolveUrl(val, baseHref);
      if (!absolute) return;
      $el.attr(attr, toProxyUrl(absolute));
      $el.removeAttr('integrity');
      $el.removeAttr('crossorigin');
    });
  });

  $('img, source').each((_, el) => {
    const $el = $(el);
    const srcset = $el.attr('srcset');
    if (srcset) $el.attr('srcset', rewriteSrcset(srcset, baseHref));
  });

  $('[style]').each((_, el) => {
    const $el = $(el);
    $el.attr('style', rewriteCssUrls($el.attr('style'), baseHref));
  });

  $('style').each((_, el) => {
    const $el = $(el);
    $el.text(rewriteCssUrls($el.text(), baseHref));
  });

  $('base').remove();

  $('meta[http-equiv="refresh" i]').each((_, el) => {
    const $el = $(el);
    const content = $el.attr('content');
    if (!content) return;
    const match = content.match(/url\s*=\s*(.+)$/i);
    if (!match) return;
    const target = match[1].trim().replace(/^['"]|['"]$/g, '');
    const absolute = resolveUrl(target, baseHref);
    if (!absolute) return;
    const delaySeconds = content.split(';')[0].trim();
    $el.attr('content', `${delaySeconds};url=${toProxyUrl(absolute)}`);
  });

  return $.html();
}

function jsStringEscape(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/<\/script/gi, '<\\/script');
}

// Proxied pages often load an initial HTML shell fine, then do all their
// real work via fetch()/XHR/WebSocket calls with either relative paths
// (resolved against the REAL site, not our /proxy URL) or hardcoded
// absolute URLs to the real host. Neither goes through our rewriter, and
// the browser blocks the cross-origin ones via CORS — which is exactly
// what shows up as a dead page or a fake "you're offline" screen. This shim
// patches window.fetch, XMLHttpRequest.open, navigator.sendBeacon, and
// window.WebSocket so those calls get rewritten to /proxy (or /proxy-ws for
// sockets) too, making them same-origin (no CORS) before they leave the
// page. It's injected as the very first thing in <head> so it runs before
// any of the page's own scripts.
function buildShimScript(baseHref) {
  const safeBase = jsStringEscape(baseHref);
  return `<script>(function(){
var VOID_BASE = '${safeBase}';

// Service workers are the real culprit behind "you're offline" surviving
// the fetch/XHR fix, and why it can leak into unrelated tabs. A PWA like
// YouTube installs a service worker scoped to the origin it thinks it owns
// — here that's our own localhost origin, not youtube.com. Once installed,
// that worker intercepts EVERY fetch from EVERY tab on this origin (Maps
// included), running in its own thread where our fetch/XHR patches below
// don't apply. If it can't complete its own network calls, it falls back to
// its cached offline page. Fixing this means never letting one register,
// and clearing out any that got installed before this fix existed.
if (window.navigator && 'serviceWorker' in navigator) {
  try {
    navigator.serviceWorker.getRegistrations().then(function(regs){
      regs.forEach(function(r){ r.unregister(); });
    }).catch(function(){});
  } catch (e) {}
  try {
    navigator.serviceWorker.register = function(){
      return Promise.reject(new Error('Service workers are disabled inside Void.'));
    };
  } catch (e) {}
}
if (window.caches && caches.keys) {
  try {
    caches.keys().then(function(names){
      names.forEach(function(n){ caches.delete(n); });
    }).catch(function(){});
  } catch (e) {}
}

function toProxied(u){
  if (typeof u !== 'string') return u;
  if (/^(data:|blob:|javascript:|about:|mailto:|tel:)/i.test(u)) return u;

  var path = u;
  // Some app code resolves relative paths against window.location.origin
  // itself. That property correctly reports OUR origin (since this page is
  // genuinely running same-origin under the proxy) — but the app then
  // treats that as if it were the real site's origin, producing a URL that
  // points back at us instead of the real site. Strip our own origin back
  // off so the remaining path resolves against the real site instead.
  if (path.indexOf(window.location.origin) === 0) {
    path = path.slice(window.location.origin.length) || '/';
  }
  if (path.indexOf('/proxy?url=') === 0) return path; // already a proxied link — leave as-is

  try {
    var abs = new URL(path, VOID_BASE).href;
    return '/proxy?url=' + encodeURIComponent(abs);
  } catch (e) { return u; }
}
window.__VOID_BASE__ = VOID_BASE;

// Reports what's happening inside this proxied page back to Void's own
// built-in console panel (in the parent window), so a failure deep inside
// a site's app shell — a blocked API call, a script error — is actually
// visible instead of silently breaking the page.
function report(kind, payload) {
  try {
    window.parent.postMessage(Object.assign({ __void: true, kind: kind }, payload), '*');
  } catch (e) {}
}

window.addEventListener('error', function(e){
  report('error', { message: (e.message || 'Script error') + (e.filename ? ' @ ' + e.filename.replace(/^.*url=/, '') + ':' + e.lineno : '') });
}, true);
window.addEventListener('unhandledrejection', function(e){
  report('error', { message: 'Unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)) });
});

if (window.fetch) {
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    var urlForLog = typeof input === 'string' ? input : (input && input.url) || String(input);
    try {
      if (typeof input === 'string') {
        input = toProxied(input);
      } else if (input && typeof input === 'object' && typeof input.url === 'string') {
        var rewritten = toProxied(input.url);
        if (rewritten !== input.url) input = new Request(rewritten, input);
      }
    } catch (e) {}
    return _fetch.call(this, input, init).then(function(res){
      report('network', { method: (init && init.method) || 'GET', url: urlForLog, status: res.status, ok: res.ok });
      return res;
    }, function(err){
      report('error', { message: 'fetch failed: ' + urlForLog + ' (' + (err && err.message) + ')' });
      throw err;
    });
  };
}

if (window.XMLHttpRequest) {
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = Array.prototype.slice.call(arguments);
    var urlForLog = url;
    try { args[1] = toProxied(url); } catch (e) {}
    this.addEventListener('loadend', function(){
      report('network', { method: method, url: urlForLog, status: this.status, ok: this.status >= 200 && this.status < 400 });
    });
    return _open.apply(this, args);
  };
}

if (navigator.sendBeacon) {
  var _beacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function(url, data) {
    try { url = toProxied(url); } catch (e) {}
    return _beacon(url, data);
  };
}

// WebSocket connections a proxied page opens (chat apps, live dashboards,
// realtime APIs) get rewritten to our own /proxy-ws relay the same way
// fetch/XHR are rewritten to /proxy — otherwise they'd try to connect
// straight to the real host and fail (wrong origin / mixed content).
if (window.WebSocket) {
  var _WS = window.WebSocket;
  var WSProxy = function(url, protocols) {
    var target = url;
    try {
      if (typeof url === 'string') {
        var httpForm = url.replace(/^ws/i, 'http');
        var abs = new URL(httpForm, VOID_BASE.replace(/^http/i, 'http')).href.replace(/^http/i, 'ws');
        var scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        target = scheme + window.location.host + '/proxy-ws?url=' + encodeURIComponent(abs);
      }
    } catch (e) {}
    report('network', { method: 'WS', url: (typeof url === 'string' ? url : 'socket'), status: 'connecting', ok: true });
    return protocols !== undefined ? new _WS(target, protocols) : new _WS(target);
  };
  WSProxy.prototype = _WS.prototype;
  WSProxy.CONNECTING = _WS.CONNECTING;
  WSProxy.OPEN = _WS.OPEN;
  WSProxy.CLOSING = _WS.CLOSING;
  WSProxy.CLOSED = _WS.CLOSED;
  window.WebSocket = WSProxy;
}
})();</script>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function renderErrorPage(message, requestedUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Unable to load page</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0a0612;
    color: #e8e8e8;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    text-align: center;
    padding: 24px;
    box-sizing: border-box;
  }
  .box { max-width: 460px; }
  .icon { font-size: 44px; margin-bottom: 14px; }
  h1 { font-size: 19px; margin: 0 0 10px; font-weight: 600; }
  p { font-size: 14px; line-height: 1.5; color: #9a9a9a; margin: 0 0 6px; word-break: break-word; }
  code { color: #b28dff; font-size: 12px; }
</style>
</head>
<body>
  <div class="box">
    <div class="icon">&#9888;&#65039;</div>
    <h1>This page couldn't be loaded</h1>
    <p>${escapeHtml(message)}</p>
    ${requestedUrl ? `<p><code>${escapeHtml(requestedUrl)}</code></p>` : ''}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));
app.use('/proxy', rateLimit);

// Sites like YouTube and TikTok run client-side anti-automation checks
// (Google's BotGuard/WAA, TikTok's X-Bogus/msToken signatures) that a
// rewriting proxy fails by design, which is why video playback breaks even
// though the rest of the page loads. Rather than fight that, for known video
// URLs we hand the browser the platform's own *official, publicly
// documented* embed player instead — a direct, unmodified connection to the
// real site, not routed through /proxy. That's a sanctioned integration
// surface (the same one any website uses to embed a video), not a bypass of
// anything; it just means this piece isn't going through our proxy/rewriting
// layer, so only the player loads, not the full site UI around it.
const EMBED_SOURCES = {
  youtube: (id) => `https://www.youtube.com/embed/${encodeURIComponent(id)}`,
  tiktok: (id) => `https://www.tiktok.com/embed/v2/${encodeURIComponent(id)}`,
};
const EMBED_LABELS = { youtube: 'YouTube', tiktok: 'TikTok' };
const SAFE_EMBED_ID_RE = /^[\w-]{1,64}$/;

app.get('/embed', (req, res) => {
  const service = String(req.query.service || '');
  const id = String(req.query.id || '');

  if (!EMBED_SOURCES[service] || !SAFE_EMBED_ID_RE.test(id)) {
    return res.status(400).send(renderErrorPage('Invalid or unsupported embed request.'));
  }

  const label = EMBED_LABELS[service];
  const src = EMBED_SOURCES[service](id);

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(label)} — direct playback</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b14; }
  .wrap { height: 100%; display: flex; flex-direction: column; }
  .banner {
    flex-shrink: 0; padding: 8px 14px;
    font: 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #14141f; color: #9a9aa8; border-bottom: 1px solid #24243a;
  }
  .banner strong { color: #e9e9f2; }
  iframe { flex: 1; width: 100%; border: none; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="banner">▶️ Playing via ${escapeHtml(label)}'s official embed player — a direct connection, not routed through the proxy.</div>
    <iframe src="${src}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
  </div>
</body>
</html>`);
});

app.all('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).send(renderErrorPage('No URL was provided to the proxy.'));
  }

  let validatedUrl;
  try {
    validatedUrl = await validateUrl(targetUrl);
  } catch (err) {
    return res.status(400).send(renderErrorPage(err.message, targetUrl));
  }

  const method = req.method.toUpperCase();
  const hasRange = Boolean(req.headers.range);
  const isCacheable = method === 'GET' && !hasRange;

  if (isCacheable) {
    const cached = cacheGet(validatedUrl.href);
    if (cached) {
      res.set('Content-Type', cached.contentType);
      res.set('X-Void-Cache', 'HIT');
      return res.status(cached.status).send(cached.buffer);
    }
  }

  const jar = getSessionJar(req, res);
  let cookieHeader;
  try {
    cookieHeader = await jar.getCookieString(validatedUrl.href);
  } catch {
    cookieHeader = undefined;
  }

  const outgoingHeaders = buildOutgoingHeaders(req.headers, validatedUrl.origin, cookieHeader);

  // Expired-but-recent cache entries get a conditional revalidation request
  // instead of a full unconditional re-fetch — cheap for us and for the
  // origin, and the origin can just say "304, unchanged" instead of resending
  // the whole body.
  if (isCacheable) {
    const rev = getRevalidators(validatedUrl.href);
    if (rev) {
      if (rev.etag) outgoingHeaders['If-None-Match'] = rev.etag;
      if (rev.lastModified) outgoingHeaders['If-Modified-Since'] = rev.lastModified;
    }
  }

  const bodyBuffer = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

  try {
    const started = Date.now();
    const response = await safeFetch(validatedUrl, { method, headers: outgoingHeaders, body: bodyBuffer });

    // Store any cookies the origin set for us, into this session's jar —
    // never forwarded to the page itself, only replayed on our next request
    // to the same site.
    if (typeof response.headers.getSetCookie === 'function') {
      const setCookies = response.headers.getSetCookie();
      for (const sc of setCookies) {
        try {
          await jar.setCookie(sc, validatedUrl.href);
        } catch {
          // Malformed or rejected cookie — ignore rather than fail the page.
        }
      }
    }

    if (response.status === 304 && isCacheable) {
      const rev = getRevalidators(validatedUrl.href);
      // We don't keep the stale body around explicitly, so a bare 304 with
      // nothing to serve just falls through to a normal fetch retry below.
      if (rev) {
        setRevalidators(validatedUrl.href, response.headers.get('etag') || rev.etag, response.headers.get('last-modified') || rev.lastModified);
      }
    }

    if (!response.ok && response.status !== 304) {
      // Non-HTML failures (a broken API call, say) shouldn't get the pretty
      // error page — the page's own JS is expecting raw JSON/text and will
      // handle the status itself.
      const failContentType = response.headers.get('content-type') || '';
      if (!failContentType.includes('text/html')) {
        const failBuffer = await readBodyWithLimit(response, MAX_RESPONSE_BYTES).catch(() => Buffer.alloc(0));
        res.set('Content-Type', failContentType || 'application/octet-stream');
        return res.status(response.status).send(failBuffer);
      }
      return res
        .status(response.status)
        .send(renderErrorPage(`The site responded with ${response.status} ${response.statusText}.`, validatedUrl.href));
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const elapsed0 = Date.now() - started;

    if (needsRewriting(contentType)) {
      const buffer = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
      let finalBuffer = buffer;
      let finalContentType = contentType;

      if (contentType.includes('text/html')) {
        finalBuffer = Buffer.from(rewriteHtml(buffer.toString('utf-8'), validatedUrl.href), 'utf-8');
        finalContentType = 'text/html; charset=utf-8';
      } else {
        finalBuffer = Buffer.from(rewriteCssUrls(buffer.toString('utf-8'), validatedUrl.href), 'utf-8');
        finalContentType = 'text/css; charset=utf-8';
      }

      if (isCacheable) {
        cacheSet(validatedUrl.href, { expires: Date.now() + CACHE_TTL_MS, status: 200, contentType: finalContentType, buffer: finalBuffer });
        setRevalidators(validatedUrl.href, response.headers.get('etag'), response.headers.get('last-modified'));
      }

      res.set('Content-Type', finalContentType);
      res.set('X-Void-Cache', 'MISS');
      res.set('X-Void-Time-Ms', String(Date.now() - started));
      return res.send(finalBuffer);
    }

    // Everything else (media, downloads, fonts, scripts, JSON, images)
    // streams straight through with a byte cap, preserving Range/206 partial
    // -content semantics so video/audio seeking and resumable downloads
    // actually work instead of forcing a full buffered fetch first.
    res.status(response.status);
    res.set('Content-Type', contentType);
    res.set('Accept-Ranges', 'bytes');
    for (const h of ['content-range', 'content-length', 'content-disposition', 'cache-control', 'expires']) {
      const v = response.headers.get(h);
      if (v) res.set(h.replace(/(^|-)./g, (m) => m.toUpperCase()), v);
    }
    res.set('X-Void-Cache', 'BYPASS');
    res.set('X-Void-Time-Ms', String(elapsed0));
    await streamBodyWithLimit(response, res, MAX_RESPONSE_BYTES);
  } catch (err) {
    return res.status(502).send(renderErrorPage(err.message || 'Failed to load the requested page.', validatedUrl.href));
  }
});

// Fast latency probe used by the console panel — validates the same way the
// proxy does, then times a lightweight fetch without returning the body.
app.get('/api/ping', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter.' });
  }

  let validatedUrl;
  try {
    validatedUrl = await validateUrl(targetUrl);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const started = Date.now();
  try {
    const response = await safeFetch(validatedUrl, { method: 'GET', headers: buildOutgoingHeaders({}, validatedUrl.origin) });
    const elapsed = Date.now() - started;
    return res.json({ ok: response.ok, status: response.status, ms: elapsed });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Ping failed.', ms: Date.now() - started });
  }
});

// In-app web search via Google Custom Search — the key stays server-side;
// the response is stripped down to just what the results view needs.
// ?type=image switches to Custom Search's image mode (real thumbnails,
// source pages). ?type=news is an approximation: the JSON API has no true
// "news" vertical, so this just sorts by date instead — it's still plain
// web results, only newer-biased.
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || 'web');
  if (!q) {
    return res.status(400).json({ error: 'Missing search query.' });
  }
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX) {
    return res.status(500).json({ error: 'Web search is not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX.' });
  }

  const params = new URLSearchParams({
    key: GOOGLE_SEARCH_API_KEY,
    cx: GOOGLE_SEARCH_CX,
    q,
    num: '10',
    safe: 'active',
  });
  if (type === 'image') params.set('searchType', 'image');
  if (type === 'news') params.set('sort', 'date');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), YOUTUBE_SEARCH_TIMEOUT_MS);

  try {
    const apiRes = await undiciFetch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`, {
      signal: controller.signal,
    });
    const data = await apiRes.json();

    if (!apiRes.ok) {
      return res.status(502).json({ error: data.error?.message || `Search API responded ${apiRes.status}.` });
    }

    const results = (data.items || []).map((item) => {
      if (type === 'image') {
        return {
          title: item.title || '',
          link: item.image?.contextLink || item.link,
          imageUrl: item.link,
          thumbnail: item.image?.thumbnailLink || item.link,
          displayLink: item.displayLink || '',
          width: item.image?.width,
          height: item.image?.height,
        };
      }
      return {
        title: item.title || item.link,
        link: item.link,
        displayLink: item.displayLink || '',
        snippet: item.snippet || '',
        thumbnail:
          item.pagemap?.cse_thumbnail?.[0]?.src ||
          item.pagemap?.cse_image?.[0]?.src ||
          null,
      };
    });

    return res.json({ results, searchTimeMs: data.searchInformation?.searchTime });
  } catch (err) {
    return res.status(502).json({ error: err.name === 'AbortError' ? 'Search timed out.' : 'Could not reach search API.' });
  } finally {
    clearTimeout(timer);
  }
});

app.get('/api/youtube/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'Missing search query.' });
  }
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YouTube search is not configured. Set the YOUTUBE_API_KEY environment variable.' });
  }

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '16',
    safeSearch: 'moderate',
    q,
    key: YOUTUBE_API_KEY,
  });
  // The Music panel passes category=music so results are scoped to
  // YouTube's "Music" video category (id 10) instead of general video
  // search. Optional and additive — existing callers are unaffected.
  if (String(req.query.category || '') === 'music') {
    params.set('videoCategoryId', '10');
  }
  // Short videos tab: bias toward YouTube's own "short" duration bucket
  // (under 4 minutes) as the closest approximation Shorts the Data API
  // exposes — it isn't a true Shorts-only filter.
  if (String(req.query.duration || '') === 'short') {
    params.set('videoDuration', 'short');
  }
  // VoidTube passes order=viewCount for its Shorts rail / trending-ish
  // feeds, and order=date for "more from this channel". Anything else the
  // API accepts (relevance/rating/title) is allowed straight through.
  const order = String(req.query.order || '');
  if (/^(relevance|date|rating|title|viewCount)$/.test(order)) {
    params.set('order', order);
  }
  if (req.query.channelId) {
    params.set('channelId', String(req.query.channelId));
  }
  const maxResults = parseInt(req.query.maxResults, 10);
  if (Number.isFinite(maxResults) && maxResults > 0 && maxResults <= 50) {
    params.set('maxResults', String(maxResults));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), YOUTUBE_SEARCH_TIMEOUT_MS);

  try {
    const apiRes = await undiciFetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`, {
      signal: controller.signal,
    });
    const data = await apiRes.json();

    if (!apiRes.ok) {
      return res.status(502).json({ error: data.error?.message || `YouTube API responded ${apiRes.status}.` });
    }

    const results = (data.items || [])
      .filter((item) => item.id && item.id.videoId)
      .map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet?.title || '',
        channelId: item.snippet?.channelId || '',
        channelTitle: item.snippet?.channelTitle || '',
        thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
        description: item.snippet?.description || '',
        publishedAt: item.snippet?.publishedAt || '',
      }));

    return res.json({ results });
  } catch (err) {
    return res.status(502).json({ error: err.name === 'AbortError' ? 'YouTube search timed out.' : 'Could not reach YouTube search.' });
  } finally {
    clearTimeout(timer);
  }
});

// ---------------------------------------------------------------------------
// VoidTube — video details, channel details, "related" videos, and a
// trending feed. All real YouTube Data API v3 calls, server-side only, same
// key/timeout/abort pattern as /api/youtube/search above.
// ---------------------------------------------------------------------------

function ytFetch(pathAndQuery) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), YOUTUBE_SEARCH_TIMEOUT_MS);
  const promise = undiciFetch(`https://www.googleapis.com/youtube/v3/${pathAndQuery}`, { signal: controller.signal });
  promise.finally(() => clearTimeout(timer));
  return promise;
}

function formatYouTubeDuration(iso) {
  // ISO 8601 duration (e.g. "PT4M13S") -> "4:13". YouTube omits higher units
  // that are zero, so this fills in 0/00 as needed for a normal clock look.
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!m) return '';
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  const parts = h ? [h, String(min).padStart(2, '0'), String(s).padStart(2, '0')] : [min, String(s).padStart(2, '0')];
  return parts.join(':');
}

app.get('/api/youtube/videos', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (!ids.length) return res.status(400).json({ error: 'Missing ids parameter.' });
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YouTube is not configured. Set the YOUTUBE_API_KEY environment variable.' });

  const params = new URLSearchParams({ part: 'snippet,statistics,contentDetails', id: ids.join(','), key: YOUTUBE_API_KEY });
  try {
    const apiRes = await ytFetch(`videos?${params.toString()}`);
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(502).json({ error: data.error?.message || `YouTube API responded ${apiRes.status}.` });

    const videos = (data.items || []).map((item) => ({
      videoId: item.id,
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
      channelId: item.snippet?.channelId || '',
      channelTitle: item.snippet?.channelTitle || '',
      thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || '',
      publishedAt: item.snippet?.publishedAt || '',
      tags: Array.isArray(item.snippet?.tags) ? item.snippet.tags.slice(0, 10) : [],
      viewCount: item.statistics?.viewCount || null,
      likeCount: item.statistics?.likeCount || null,
      commentCount: item.statistics?.commentCount || null,
      duration: formatYouTubeDuration(item.contentDetails?.duration),
    }));
    return res.json({ videos });
  } catch (err) {
    return res.status(502).json({ error: err.name === 'AbortError' ? 'Request timed out.' : 'Could not reach YouTube.' });
  }
});

app.get('/api/youtube/channel', async (req, res) => {
  const channelId = String(req.query.channelId || '').trim();
  if (!channelId) return res.status(400).json({ error: 'Missing channelId parameter.' });
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YouTube is not configured. Set the YOUTUBE_API_KEY environment variable.' });

  const params = new URLSearchParams({ part: 'snippet,statistics', id: channelId, key: YOUTUBE_API_KEY });
  try {
    const apiRes = await ytFetch(`channels?${params.toString()}`);
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(502).json({ error: data.error?.message || `YouTube API responded ${apiRes.status}.` });
    const item = (data.items || [])[0];
    if (!item) return res.status(404).json({ error: 'Channel not found.' });
    return res.json({
      channelId: item.id,
      title: item.snippet?.title || '',
      thumbnail: item.snippet?.thumbnails?.default?.url || '',
      description: item.snippet?.description || '',
      subscriberCount: item.statistics?.hiddenSubscriberCount ? null : item.statistics?.subscriberCount || null,
      videoCount: item.statistics?.videoCount || null,
    });
  } catch (err) {
    return res.status(502).json({ error: err.name === 'AbortError' ? 'Request timed out.' : 'Could not reach YouTube.' });
  }
});

// Batch variant of the above, purely for avatars: one channels.list call
// (accepts up to 50 ids) covers every channel shown in a whole grid of
// video cards, instead of one request per card.
app.get('/api/youtube/channels', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (!ids.length) return res.status(400).json({ error: 'Missing ids parameter.' });
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YouTube is not configured. Set the YOUTUBE_API_KEY environment variable.' });

  const params = new URLSearchParams({ part: 'snippet', id: ids.join(','), key: YOUTUBE_API_KEY });
  try {
    const apiRes = await ytFetch(`channels?${params.toString()}`);
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(502).json({ error: data.error?.message || `YouTube API responded ${apiRes.status}.` });
    const channels = {};
    (data.items || []).forEach((item) => {
      channels[item.id] = {
        title: item.snippet?.title || '',
        thumbnail: item.snippet?.thumbnails?.default?.url || item.snippet?.thumbnails?.medium?.url || '',
      };
    });
    return res.json({ channels });
  } catch (err) {
    return res.status(502).json({ error: err.name === 'AbortError' ? 'Request timed out.' : 'Could not reach YouTube.' });
  }
});

// The v3 Data API removed the old relatedToVideoId search parameter, so
// there is no first-party "related videos" endpoint anymore. This builds
// the closest honest equivalent from two real calls — recent uploads from
// the same channel, plus a keyword search built from the video's own title
// — rather than faking a relation the API can no longer compute for us.
app.get('/api/youtube/related', async (req, res) => {
  const excludeId = String(req.query.excludeId || '').trim();
  const channelId = String(req.query.channelId || '').trim();
  const q = String(req.query.q || '').trim();
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YouTube is not configured. Set the YOUTUBE_API_KEY environment variable.' });
  if (!channelId && !q) return res.status(400).json({ error: 'Provide channelId and/or q.' });

  const seen = new Set(excludeId ? [excludeId] : []);
  const out = [];

  async function runSearch(params) {
    try {
      const apiRes = await ytFetch(`search?${params.toString()}`);
      const data = await apiRes.json();
      if (!apiRes.ok) return [];
      return (data.items || []).filter((item) => item.id && item.id.videoId);
    } catch {
      return [];
    }
  }

  if (channelId) {
    const params = new URLSearchParams({ part: 'snippet', type: 'video', channelId, order: 'date', maxResults: '8', key: YOUTUBE_API_KEY });
    for (const item of await runSearch(params)) {
      if (seen.has(item.id.videoId)) continue;
      seen.add(item.id.videoId);
      out.push(item);
    }
  }
  if (q) {
    const params = new URLSearchParams({ part: 'snippet', type: 'video', q, maxResults: '12', safeSearch: 'moderate', key: YOUTUBE_API_KEY });
    for (const item of await runSearch(params)) {
      if (seen.has(item.id.videoId)) continue;
      seen.add(item.id.videoId);
      out.push(item);
    }
  }

  const results = out.slice(0, 16).map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet?.title || '',
    channelId: item.snippet?.channelId || '',
    channelTitle: item.snippet?.channelTitle || '',
    thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
    publishedAt: item.snippet?.publishedAt || '',
  }));
  return res.json({ results });
});

app.get('/api/youtube/trending', async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YouTube is not configured. Set the YOUTUBE_API_KEY environment variable.' });
  const params = new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    chart: 'mostPopular',
    regionCode: String(req.query.region || 'US'),
    maxResults: '24',
    key: YOUTUBE_API_KEY,
  });
  if (req.query.category) params.set('videoCategoryId', String(req.query.category));

  try {
    const apiRes = await ytFetch(`videos?${params.toString()}`);
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(502).json({ error: data.error?.message || `YouTube API responded ${apiRes.status}.` });
    const results = (data.items || []).map((item) => ({
      videoId: item.id,
      title: item.snippet?.title || '',
      channelId: item.snippet?.channelId || '',
      channelTitle: item.snippet?.channelTitle || '',
      thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
      publishedAt: item.snippet?.publishedAt || '',
      viewCount: item.statistics?.viewCount || null,
      duration: formatYouTubeDuration(item.contentDetails?.duration),
    }));
    return res.json({ results });
  } catch (err) {
    return res.status(502).json({ error: err.name === 'AbortError' ? 'Request timed out.' : 'Could not reach YouTube.' });
  }
});

// Small in-memory cache: channelId -> uploads playlist id. This never
// changes for a given channel, so there's no reason to spend a
// channels.list call on it more than once per server process.
const uploadsPlaylistCache = new Map();

async function getUploadsPlaylistId(channelId) {
  if (uploadsPlaylistCache.has(channelId)) return uploadsPlaylistCache.get(channelId);
  const params = new URLSearchParams({ part: 'contentDetails', id: channelId, key: YOUTUBE_API_KEY });
  const apiRes = await ytFetch(`channels?${params.toString()}`);
  const data = await apiRes.json();
  if (!apiRes.ok) throw new Error(data.error?.message || `YouTube API responded ${apiRes.status}.`);
  const id = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
  if (id) uploadsPlaylistCache.set(channelId, id);
  return id;
}

// A channel's video list, sorted three honest ways:
//  - newest / popular: search.list already supports order=date|viewCount
//    directly for a channelId, so these are exact, real API ordering.
//  - oldest: search.list has no ascending-date order, so this walks the
//    channel's auto-generated "uploads" playlist from the beginning —
//    that playlist's position 0 is the channel's very first upload, a
//    well-known trick for exactly this, and playlistItems.list is 1 quota
//    unit vs. search.list's 100, so it's also far cheaper.
app.get('/api/youtube/channel-videos', async (req, res) => {
  const channelId = String(req.query.channelId || '').trim();
  const sort = String(req.query.sort || 'newest');
  const pageToken = req.query.pageToken ? String(req.query.pageToken) : undefined;
  if (!channelId) return res.status(400).json({ error: 'Missing channelId parameter.' });
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YouTube is not configured. Set the YOUTUBE_API_KEY environment variable.' });

  try {
    if (sort === 'oldest') {
      const uploadsId = await getUploadsPlaylistId(channelId);
      if (!uploadsId) return res.status(404).json({ error: 'Could not find this channel\'s uploads.' });
      const params = new URLSearchParams({ part: 'snippet', playlistId: uploadsId, maxResults: '24', key: YOUTUBE_API_KEY });
      if (pageToken) params.set('pageToken', pageToken);
      const apiRes = await ytFetch(`playlistItems?${params.toString()}`);
      const data = await apiRes.json();
      if (!apiRes.ok) return res.status(502).json({ error: data.error?.message || `YouTube API responded ${apiRes.status}.` });
      const results = (data.items || [])
        .filter((item) => item.snippet?.resourceId?.videoId)
        .map((item) => ({
          videoId: item.snippet.resourceId.videoId,
          title: item.snippet.title || '',
          channelId,
          channelTitle: item.snippet.videoOwnerChannelTitle || item.snippet.channelTitle || '',
          thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
          publishedAt: item.snippet.publishedAt || '',
        }));
      return res.json({ results, nextPageToken: data.nextPageToken || null });
    }

    const order = sort === 'popular' ? 'viewCount' : 'date';
    const params = new URLSearchParams({ part: 'snippet', type: 'video', channelId, order, maxResults: '24', key: YOUTUBE_API_KEY });
    if (pageToken) params.set('pageToken', pageToken);
    const apiRes = await ytFetch(`search?${params.toString()}`);
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(502).json({ error: data.error?.message || `YouTube API responded ${apiRes.status}.` });
    const results = (data.items || [])
      .filter((item) => item.id && item.id.videoId)
      .map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet?.title || '',
        channelId,
        channelTitle: item.snippet?.channelTitle || '',
        thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
        publishedAt: item.snippet?.publishedAt || '',
      }));
    return res.json({ results, nextPageToken: data.nextPageToken || null });
  } catch (err) {
    return res.status(502).json({ error: err.name === 'AbortError' ? 'Request timed out.' : err.message || 'Could not reach YouTube.' });
  }
});

// ---------------------------------------------------------------------------
// Void AI — server-side proxy to Groq, with tool/function calling.
//
// The model can request tools (open_tab, navigate_tab, close_tab,
// switch_tab, list_tabs, read_tab) — but tabs live in the browser, not here.
// So this endpoint is stateless per call: it forwards whatever
// messages/tools the client sends, returns Groq's raw assistant message
// (which may contain tool_calls instead of, or alongside, text), and the
// browser-side agent loop (see script.js) actually executes the requested
// tab actions, then calls back in with role:"tool" results appended so the
// model can continue. This endpoint never touches a tab itself.
// ---------------------------------------------------------------------------
function isValidMessage(m) {
  if (!m || typeof m.role !== 'string') return false;
  if (m.role === 'tool') {
    return typeof m.tool_call_id === 'string' && typeof m.content === 'string';
  }
  if (m.role === 'assistant') {
    const contentOk = m.content === null || m.content === undefined || typeof m.content === 'string';
    const toolCallsOk = m.tool_calls === undefined || Array.isArray(m.tool_calls);
    return contentOk && toolCallsOk;
  }
  return typeof m.content === 'string';
}

// Lets Void AI read any URL directly (not just tabs already open in the
// browser) — typically used right after a web_search tool call to pull the
// full text of a promising result. Same SSRF-safe fetch path as /proxy and
// /api/ping (validateUrl + safeFetch), but returns extracted plain text
// instead of a renderable page.
const READ_URL_TIMEOUT_MS = 10000;
const READ_URL_MAX_BYTES = 3 * 1024 * 1024; // 3 MB — plenty for an article, cheap to hold in memory
const READ_URL_MAX_CHARS = 8000; // keeps a single tool result from blowing the model's context

app.get('/api/void-ai/read-url', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter.' });
  }

  let validatedUrl;
  try {
    validatedUrl = await validateUrl(targetUrl);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_URL_TIMEOUT_MS);

  try {
    const response = await safeFetch(validatedUrl, {
      method: 'GET',
      headers: buildOutgoingHeaders({}, validatedUrl.origin),
      signal: controller.signal,
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Page responded ${response.status}.` });
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
      return res.status(415).json({ error: `Can't read this content type (${contentType.split(';')[0] || 'unknown'}) as text.` });
    }

    const buffer = await readBodyWithLimit(response, READ_URL_MAX_BYTES);
    const html = buffer.toString('utf8');
    const $ = cheerio.load(html);
    $('script, style, noscript, svg, iframe, nav, footer, header, form, [aria-hidden="true"]').remove();

    const title = $('title').first().text().trim().slice(0, 200);
    let text = ($('main').text() || $('article').text() || $('body').text() || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length > READ_URL_MAX_CHARS) text = text.slice(0, READ_URL_MAX_CHARS) + ' …(truncated)';

    return res.json({ url: validatedUrl.href, title, text });
  } catch (err) {
    return res.status(502).json({ error: err.name === 'AbortError' ? 'Reading the page timed out.' : err.message || 'Could not read that page.' });
  } finally {
    clearTimeout(timer);
  }
});

app.post('/api/void-ai', async (req, res) => {
  const { messages, tools, tool_choice: toolChoice, max_tokens: requestedMaxTokens } = req.body || {};
  const maxTokens = Number.isFinite(requestedMaxTokens) ? Math.max(256, Math.min(8000, Math.floor(requestedMaxTokens))) : 2048;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty messages array.' });
  }
  if (!messages.every(isValidMessage)) {
    return res.status(400).json({ error: 'One or more messages had an invalid shape.' });
  }
  if (tools !== undefined && !Array.isArray(tools)) {
    return res.status(400).json({ error: 'tools must be an array when provided.' });
  }

  if (!VOID_AI_KEY) {
    return res.status(500).json({ error: 'Void AI is not configured. Set the VOID_AI_KEY environment variable.' });
  }

  let lastError = null;

  for (const model of VOID_AI_MODELS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VOID_AI_TIMEOUT_MS);

    const payload = {
      model,
      messages,
      temperature: 0.6,
      max_tokens: maxTokens,
    };
    if (Array.isArray(tools) && tools.length) {
      payload.tools = tools;
      payload.tool_choice = toolChoice || 'auto';
    }

    try {
      const response = await undiciFetch(VOID_AI_ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VOID_AI_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        lastError = `Groq responded ${response.status} for model ${model}: ${errBody.slice(0, 200)}`;
        continue; // try the next model in the fallback list
      }

      const data = await response.json();
      const message = data?.choices?.[0]?.message;

      if (!message || (message.content == null && !(Array.isArray(message.tool_calls) && message.tool_calls.length))) {
        lastError = `Model ${model} returned no content or tool calls.`;
        continue;
      }

      return res.json({
        message: {
          role: 'assistant',
          content: message.content ?? null,
          tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
        },
        model,
      });
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === 'AbortError' ? `Model ${model} timed out.` : err.message;
    }
  }

  return res.status(502).json({ error: lastError || 'Void AI is unavailable right now.' });
});

// ---------------------------------------------------------------------------
// Void AI — streaming variant, used by Void AI Mode and the VoidTube "Ask
// Void AI about this video" box, where progressive text (not a single JSON
// blob) is what makes the typing effect real instead of simulated. Relays
// Groq's own SSE stream chunk-for-chunk as plain `data: {"delta":"..."}`
// events so the browser can render tokens as they actually arrive. No tool
// calling here — these callers only ever want a plain streamed answer.
// ---------------------------------------------------------------------------
app.post('/api/void-ai/stream', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty messages array.' });
  }
  if (!messages.every(isValidMessage)) {
    return res.status(400).json({ error: 'One or more messages had an invalid shape.' });
  }
  if (!VOID_AI_KEY) {
    return res.status(500).json({ error: 'Void AI is not configured. Set the VOID_AI_KEY environment variable.' });
  }

  // Each fallback model gets its OWN AbortController/timer, created fresh
  // inside the loop — sharing a single one across every attempt (as an
  // earlier version of this endpoint did) means a slow first model silently
  // eats the whole timeout budget, so by the time a later model is tried its
  // signal is already aborted and it fails instantly, blaming the wrong
  // model. clientAborted lets a real client disconnect cancel whichever
  // attempt (or the body stream) is currently in flight.
  let clientAborted = false;
  let activeController = null;
  req.on('close', () => {
    clientAborted = true;
    if (activeController) activeController.abort();
  });

  let upstream;
  let lastError = null;
  for (const model of VOID_AI_MODELS) {
    if (clientAborted) break;
    const controller = new AbortController();
    activeController = controller;
    const timer = setTimeout(() => controller.abort(), VOID_AI_TIMEOUT_MS);
    try {
      upstream = await undiciFetch(VOID_AI_ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VOID_AI_KEY}` },
        body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 2048, stream: true }),
      });
      clearTimeout(timer);
      if (upstream.ok) break;
      lastError = `Groq responded ${upstream.status} for model ${model}.`;
      upstream = null;
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === 'AbortError' ? `Model ${model} timed out.` : err.message;
      upstream = null;
    }
  }

  if (!upstream) {
    return res.status(502).json({ error: lastError || 'Void AI is unavailable right now.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let buffer = '';
  try {
    for await (const chunk of upstream.body) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep the last, possibly-incomplete line for next time

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) {
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
        } catch {
          // Ignore any non-JSON keep-alive lines Groq's stream may send.
        }
      }
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message || 'Stream interrupted.' })}\n\n`);
  } finally {
    res.end();
  }
});

// A proxied page's own JS occasionally does a raw `location.href =`/
// `location.assign()` navigation using a path it resolved against
// window.location.origin — which is US, not the real site (see the shim's
// comment in buildShimScript for the same issue with fetch/XHR). There's no
// reliable way to intercept a bare location.href assignment in JS, so those
// navigations land directly on our own server instead of going through
// /proxy. Rescue them here: if the request's Referer shows we were just
// viewing a proxied page, rebuild the real destination from that page's real
// origin + this (otherwise-404) request's own path/query, and hand the
// browser off to /proxy properly instead of dead-ending on a bare 404.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const referer = req.headers['referer'];
  if (!referer) return next();

  try {
    const refererUrl = new URL(referer);
    const ownOrigin = `${req.protocol}://${req.get('host')}`;
    if (refererUrl.origin !== ownOrigin || refererUrl.pathname !== '/proxy') return next();

    const realTargetHref = refererUrl.searchParams.get('url');
    if (!realTargetHref) return next();

    const realOrigin = new URL(realTargetHref).origin;
    const rebuiltHref = new URL(req.originalUrl, realOrigin).href;
    return res.redirect(302, '/proxy?url=' + encodeURIComponent(rebuiltHref));
  } catch (err) {
    return next();
  }
});

app.use((req, res) => {
  res.status(404).send('Not found.');
});

const server = app.listen(PORT, () => {
  console.log(`Void running at http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// WebSocket relay — /proxy-ws?url=ws(s)://...
// ---------------------------------------------------------------------------
// Proxied pages that open real-time connections (chat, live dashboards,
// trading tickers, collaborative editors) get relayed here by the client
// -side shim's WebSocket patch. Same SSRF validation as HTTP, same
// same-origin trick (this connection is same-origin to the browser, so no
// CORS/mixed-content issues), just bidirectional frame piping instead of a
// request/response cycle.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }

  if (requestUrl.pathname !== '/proxy-ws') {
    socket.destroy();
    return;
  }

  const target = requestUrl.searchParams.get('url');
  if (!target) {
    socket.destroy();
    return;
  }

  let validatedTarget;
  try {
    validatedTarget = await validateWsUrl(target);
  } catch {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (clientSocket) => {
    let upstream;
    try {
      upstream = new UpstreamWebSocket(validatedTarget.href, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Void/1.0)',
          Origin: `${validatedTarget.protocol === 'wss:' ? 'https:' : 'http:'}//${validatedTarget.host}`,
        },
        handshakeTimeout: FETCH_TIMEOUT_MS,
      });
    } catch {
      clientSocket.close(1011, 'Could not open upstream connection.');
      return;
    }

    let upstreamOpen = false;
    const pending = [];

    clientSocket.on('message', (data, isBinary) => {
      if (upstreamOpen && upstream.readyState === UpstreamWebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else {
        pending.push({ data, isBinary });
      }
    });
    clientSocket.on('close', () => {
      try {
        upstream.close();
      } catch {}
    });
    clientSocket.on('error', () => {
      try {
        upstream.close();
      } catch {}
    });

    upstream.on('open', () => {
      upstreamOpen = true;
      for (const { data, isBinary } of pending.splice(0)) {
        upstream.send(data, { binary: isBinary });
      }
    });
    upstream.on('message', (data, isBinary) => {
      if (clientSocket.readyState === clientSocket.OPEN) {
        clientSocket.send(data, { binary: isBinary });
      }
    });
    upstream.on('close', (code, reason) => {
      try {
        clientSocket.close(code && code >= 1000 && code <= 4999 ? code : 1000, reason);
      } catch {}
    });
    upstream.on('error', () => {
      try {
        clientSocket.close(1011, 'Upstream connection error.');
      } catch {}
    });
  });
});
