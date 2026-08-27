import { accessSync, constants, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

const sessionCache = new Map();

export function resolvedCookiesFile(options = {}) {
  const value = options.cookiesFile || options.ytdlpCookiesFile || '';
  return value ? String(value) : '';
}

export function cookiesUnreadableError(filePath, cause) {
  return Object.assign(
    new Error(`YTDLP_COOKIES_FILE is set but the cookies file is missing or unreadable: ${filePath}`),
    {
      kind: 'cookies_unreadable',
      retryable: false,
      stdout: '',
      stderr: '',
      cause,
    },
  );
}

export function emptyCookiesFileError(filePath) {
  return Object.assign(
    new Error(`YTDLP_COOKIES_FILE did not contain any Netscape cookies: ${filePath}`),
    {
      kind: 'cookies_unreadable',
      retryable: false,
      stdout: '',
      stderr: '',
    },
  );
}

export function assertCookiesFileConfigured(filePath) {
  if (!filePath) return;
  try {
    accessSync(filePath, constants.R_OK);
  } catch (error) {
    throw cookiesUnreadableError(filePath, error);
  }

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw cookiesUnreadableError(filePath, error);
  }

  if (!parseNetscapeCookies(text).length) {
    throw emptyCookiesFileError(filePath);
  }
}

export function parseNetscapeCookies(text) {
  const cookies = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#HttpOnly_')) {
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue;
    }

    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const [rawDomain, includeSubdomains, cookiePath, secure, expires, name, ...valueParts] = parts;
    if (!name) continue;

    const domainHasDotPrefix = rawDomain.startsWith('.');
    cookies.push({
      domain: rawDomain.replace(/^\./, '').toLowerCase(),
      hostOnly: String(includeSubdomains).toUpperCase() === 'FALSE' && !domainHasDotPrefix,
      path: cookiePath || '/',
      secure: String(secure).toUpperCase() === 'TRUE',
      expires: Number(expires) || 0,
      name,
      value: valueParts.join('\t'),
    });
  }
  return cookies;
}

export function cookieHeaderForUrl(cookies, urlString, { includeTikTokSession } = {}) {
  let url;
  try {
    url = new URL(String(urlString));
  } catch {
    return '';
  }

  const now = Date.now() / 1000;
  const host = url.hostname.toLowerCase();
  const attachTikTokSession = includeTikTokSession ?? isTikTokRelatedHost(host);
  const selected = [];
  const seen = new Set();

  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (cookie.expires > 0 && cookie.expires < now) continue;
    if (cookie.secure && url.protocol !== 'https:') continue;
    if (!pathMatches(cookie.path || '/', url.pathname || '/')) continue;

    const matchesHost = domainMatches(cookie, host);
    const matchesTikTokSession = attachTikTokSession && domainMatches(cookie, 'www.tiktok.com');
    if (!matchesHost && !matchesTikTokSession) continue;
    if (seen.has(cookie.name)) continue;

    seen.add(cookie.name);
    selected.push(`${cookie.name}=${cookie.value}`);
  }

  return selected.join('; ');
}

export async function loadTikTokCookieSession(options = {}) {
  const cookiesFile = resolvedCookiesFile(options);
  const proxy = String(options.proxy || options.ytdlpProxy || '').trim();
  if (!cookiesFile) {
    return { cookiesFile: '', cookies: [], proxy };
  }

  let info;
  try {
    info = await stat(cookiesFile);
  } catch (error) {
    throw cookiesUnreadableError(cookiesFile, error);
  }

  const cached = sessionCache.get(cookiesFile);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return { cookiesFile, cookies: cached.cookies, proxy };
  }

  let text;
  try {
    text = await readFile(cookiesFile, 'utf8');
  } catch (error) {
    throw cookiesUnreadableError(cookiesFile, error);
  }

  const cookies = parseNetscapeCookies(text);
  if (!cookies.length) throw emptyCookiesFileError(cookiesFile);

  sessionCache.set(cookiesFile, {
    mtimeMs: info.mtimeMs,
    size: info.size,
    cookies,
  });
  return { cookiesFile, cookies, proxy };
}

export function domainMatches(cookie, hostname) {
  const host = String(hostname || '').toLowerCase();
  const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
  if (!host || !domain) return false;
  if (host === domain) return true;
  if (cookie?.hostOnly) return false;
  return host.endsWith(`.${domain}`);
}

function pathMatches(cookiePath, requestPath) {
  const path = cookiePath || '/';
  const req = requestPath || '/';
  if (path === '/') return true;
  if (req === path) return true;
  if (!req.startsWith(path)) return false;
  return path.endsWith('/') || req.charAt(path.length) === '/';
}

function isTikTokRelatedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return /(^|\.)tiktok\.com$/.test(host)
    || /(^|\.)tiktokcdn\.com$/.test(host)
    || /(^|\.)tiktokcdn-eu\.com$/.test(host)
    || /(^|\.)tiktokcdn-us\.com$/.test(host)
    || /(^|\.)tiktokv\.com$/.test(host)
    || /(^|\.)tiktokv\.us$/.test(host)
    || /(^|\.)musical\.ly$/.test(host)
    || /(^|\.)muscdn\.com$/.test(host)
    || /(^|\.)ibyteimg\.com$/.test(host)
    || /(^|\.)ibytedtos\.com$/.test(host)
    || /(^|\.)byteoversea\.com$/.test(host);
}
