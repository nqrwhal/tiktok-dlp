import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { cookieHeaderForUrl, loadTikTokCookieSession } from './cookies.js';

// TikTok gates the /photo/{id} web route for some posts ("View photos on the
// TikTok app."), but the same aweme is served to an authenticated session on
// the /video/{id} page and through the unsigned web item-detail API. The
// resolver tries those transports with the desktop web profile before falling
// back to the legacy mobile-UA fetch of the caller's URL.
const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MOBILE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const ITEM_DETAIL_API = 'https://www.tiktok.com/api/item/detail/';

const proxyAgents = new Map();

export function parseTikTokPostRef(value = '') {
  const text = String(value ?? '').trim();
  const ref = { username: '', awemeId: '' };

  const postMatch = text.match(/tiktok\.com\/@([\w.]+)\/(?:video|photo|story)\/(\d{6,})/i);
  if (postMatch) {
    ref.username = postMatch[1].toLowerCase();
    ref.awemeId = postMatch[2];
    return ref;
  }

  try {
    const url = new URL(text);
    if (/(^|\.)tiktok\.com$/i.test(url.hostname)) {
      const segments = url.pathname.split('/').filter(Boolean);
      const userSegment = segments.find((segment) => segment.startsWith('@'));
      if (userSegment) ref.username = userSegment.slice(1).toLowerCase();
    }
  } catch {
    // Not a URL; fall through to the bare id check.
  }

  const idMatch = text.match(/(?:video|photo|story)\/(\d{6,})/i) ?? text.match(/(?:^|[^\d])(\d{15,20})(?:[^\d]|$)/);
  if (idMatch) ref.awemeId = idMatch[1];
  return ref;
}

export async function resolvePhotoPost(input = {}, options = {}) {
  const sourceUrl = String(input.url ?? '').trim();
  const explicitId = normalizeAwemeId(input.awemeId ?? input.id);
  const ref = parseTikTokPostRef(sourceUrl);
  const awemeId = explicitId || ref.awemeId;
  const username = String(input.username ?? '').trim().toLowerCase() || ref.username;

  if (!awemeId && !sourceUrl) {
    return failure('invalid_input', 'A TikTok post URL or aweme id is required.');
  }

  const session = await loadTikTokCookieSession(options);
  const attempts = [];
  if (awemeId) {
    // TikTok resolves the post from the aweme id alone; the handle in the
    // /video/{id} path is decorative, so a placeholder works without one.
    attempts.push(() => resolveViaVideoPage({ username: username || '_', awemeId }, session, options));
    attempts.push(() => resolveViaItemApi({ username, awemeId }, session, options));
  }
  if (sourceUrl) {
    attempts.push(() => resolveViaSourcePage({ sourceUrl, awemeId }, session, options));
  }

  let sawItem = false;
  let sawNoAccess = false;
  for (const attempt of attempts) {
    let outcome;
    try {
      outcome = await attempt();
    } catch (error) {
      if (isFatalResolverError(error)) throw error;
      if (isTransportError(error)) continue;
      throw error;
    }
    if (outcome.status === 'found') {
      if (!outcome.item) continue;
      sawItem = true;
      return contractFromAwemeItem(outcome.item, { awemeId, username, sourceUrl });
    }
    if (outcome.status === 'item_without_images') sawItem = true;
    if (outcome.status === 'no_access') sawNoAccess = true;
  }

  if (sawItem) return failure('no_images', 'The post resolved but did not include downloadable images.');
  if (sawNoAccess) return failure('no_access', 'The configured TikTok session cannot access this post.');
  return failure('not_found', 'TikTok photo post metadata was not found.');
}

async function resolveViaVideoPage({ username, awemeId }, session, options) {
  const url = `https://www.tiktok.com/@${username}/video/${awemeId}`;
  const html = await resolverFetchText(url, session, options, {
    maxBytes: metadataByteLimit(options),
    label: 'TikTok photo page',
    headers: desktopPageHeaders(),
  });
  const item = findAwemeItemInRehydration(html, awemeId);
  return classifyItem(item);
}

async function resolveViaItemApi({ username, awemeId }, session, options) {
  const apiUrl = new URL(ITEM_DETAIL_API);
  apiUrl.searchParams.set('itemId', awemeId);
  apiUrl.searchParams.set('aid', '1988');
  apiUrl.searchParams.set('lang', 'en');
  apiUrl.searchParams.set('app_name', 'tiktok_web');
  apiUrl.searchParams.set('channel', 'tiktok_web');
  apiUrl.searchParams.set('device_platform', 'web_pc');
  apiUrl.searchParams.set('region', 'US');

  const body = await resolverFetchText(apiUrl.toString(), session, options, {
    maxBytes: metadataByteLimit(options),
    label: 'TikTok item detail',
    headers: {
      'user-agent': DESKTOP_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'application/json,text/plain,*/*',
      ...(username
        ? { referer: `https://www.tiktok.com/@${username}/video/${awemeId}` }
        : { referer: 'https://www.tiktok.com/' }),
    },
  });
  if (!body.trim()) return { status: 'empty' };

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { status: 'empty' };
  }
  if (Number(payload?.statusCode) === 10221 || Number(payload?.statusCode) === 10204) {
    return { status: 'no_access' };
  }
  return classifyItem(payload?.itemInfo?.itemStruct ?? null);
}

async function resolveViaSourcePage({ sourceUrl }, session, options) {
  const html = await resolverFetchText(sourceUrl, session, options, {
    maxBytes: metadataByteLimit(options),
    label: 'TikTok photo metadata',
    headers: {
      'user-agent': MOBILE_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  const item = findAwemeItemInRehydration(html, '');
  return classifyItem(item);
}

function desktopPageHeaders() {
  return {
    'user-agent': DESKTOP_USER_AGENT,
    'accept-language': 'en-US,en;q=0.9',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

function classifyItem(item) {
  if (!item) return { status: 'empty' };
  if (!item.id || !item.author) return { status: 'empty' };
  const images = extractPostImages(item);
  if (!images.length) return { status: 'item_without_images' };
  return { status: 'found', item };
}

function findAwemeItemInRehydration(html, awemeId) {
  const text = String(html ?? '');
  const scriptMatch = text.match(/<script[^>]+id=["'](?:__UNIVERSAL_DATA_FOR_REHYDRATION__|SIGI_STATE)["'][^>]*>([\s\S]*?)<\/script>/i);
  const marker = 'id="__UNIVERSAL_DATA_FOR_REHYDRATION__"';
  const markerIndex = text.indexOf(marker);
  let raw = '';
  if (scriptMatch) {
    raw = scriptMatch[1];
  } else if (markerIndex >= 0) {
    const contentStart = text.indexOf('>', markerIndex);
    const contentEnd = text.indexOf('</script>', contentStart);
    if (contentStart >= 0 && contentEnd >= 0) raw = text.slice(contentStart + 1, contentEnd);
  }
  if (!raw.trim()) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const scopes = data?.__DEFAULT_SCOPE__ ?? data;
  const detail = scopes?.['webapp.video-detail'] ?? scopes?.['webapp.reflow.video.detail'];
  const statusCode = Number(detail?.statusCode ?? 0);
  if (statusCode === 10221 || statusCode === 10204) return null;

  const item = detail?.itemInfo?.itemStruct;
  if (item?.id && item?.author) return item;
  return findNestedAwemeItem(data, awemeId);
}

function findNestedAwemeItem(value, awemeId, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNestedAwemeItem(entry, awemeId, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const hasImages = Array.isArray(value.imagePost?.images) || Array.isArray(value.image_post_info?.images);
  if (value.id && value.author && hasImages) {
    if (!awemeId || String(value.id) === String(awemeId)) return value;
  }
  for (const entry of Object.values(value)) {
    const found = findNestedAwemeItem(entry, awemeId, depth + 1);
    if (found) return found;
  }
  return null;
}

function contractFromAwemeItem(item, context) {
  const images = extractPostImages(item)
    .map((image, index) => ({
      index: index + 1,
      url: image.url,
      width: positiveIntOrNull(image.width),
      height: positiveIntOrNull(image.height),
      headers: {
        'user-agent': DESKTOP_USER_AGENT,
        referer: 'https://www.tiktok.com/',
      },
    }));
  if (!images.length) {
    return failure('no_images', 'The post resolved but did not include downloadable images.');
  }

  const username = String(item.author?.uniqueId ?? item.author?.nickname ?? context.username ?? '').toLowerCase();
  const description = String(item.desc ?? '');
  const duration = firstPositiveNumber(
    item.music?.duration,
    item.imagePost?.music?.duration,
    item.image_post_info?.music?.duration,
    item.video?.duration,
  );
  return {
    ok: true,
    awemeId: String(item.id ?? context.awemeId ?? ''),
    username,
    title: description || String(item.id ?? context.awemeId ?? ''),
    description,
    createTime: firstPositiveNumber(item.createTime) ?? 0,
    durationSeconds: duration ?? 0,
    mediaType: 'slideshow',
    audioUrl: firstUrl(
      item.music?.playUrl?.urlList,
      item.music?.play_url?.url_list,
      item.music?.playAddr,
      item.imagePost?.music?.playUrl?.urlList,
      item.image_post_info?.music?.play_url?.url_list,
    ),
    coverUrl: firstUrl(
      item.video?.cover?.urlList,
      item.video?.originCover?.urlList,
      item.imagePost?.cover,
      item.image_post_info?.cover,
    ),
    images,
  };
}

function extractPostImages(item) {
  const rawImages = Array.isArray(item?.imagePost?.images)
    ? item.imagePost.images
    : Array.isArray(item?.image_post_info?.images)
      ? item.image_post_info.images
      : [];
  const images = [];
  for (const image of rawImages) {
    const url = firstUrl(
      image?.imageURL?.urlList,
      image?.image_url?.url_list,
      image?.display_image?.url_list,
      image?.downloadURL?.urlList,
      image?.download_url?.url_list,
    );
    if (!url) continue;
    images.push({
      url,
      width: firstPositiveNumber(image?.imageWidth, image?.width),
      height: firstPositiveNumber(image?.imageHeight, image?.height),
    });
  }
  return images;
}

async function resolverFetchText(url, session, options, { maxBytes, timeoutMs, label, headers }) {
  const requestHeaders = { ...(headers || {}) };
  const cookie = cookieHeaderForUrl(session.cookies, url, { includeTikTokSession: true });
  if (cookie) requestHeaders.cookie = cookie;

  const dispatcher = session.proxy ? getProxyAgent(session.proxy) : undefined;
  const fetchImpl = resolveFetchImpl(options, session.proxy);
  const response = await fetchWithLimits(url, fetchImpl, {
    timeoutMs: timeoutMs ?? fetchTimeoutMs(options),
    maxBytes,
    label,
    headers: requestHeaders,
    dispatcher,
  });
  return readResponseText(response, { maxBytes, timeoutMs: timeoutMs ?? fetchTimeoutMs(options), label });
}

function resolveFetchImpl(options, proxy) {
  if (typeof options.fetchImpl === 'function') return options.fetchImpl;
  if (proxy) return (url, init) => undiciFetch(url, init);
  if (typeof globalThis.fetch === 'function') return globalThis.fetch;
  throw new Error('Fetch API is not available for TikTok photo resolution.');
}

function getProxyAgent(proxyUrl) {
  const key = String(proxyUrl);
  let agent = proxyAgents.get(key);
  if (!agent) {
    agent = new ProxyAgent(key);
    proxyAgents.set(key, agent);
  }
  return agent;
}

async function fetchWithLimits(url, fetchImpl, {
  timeoutMs = 30_000,
  maxBytes = 10 * 1024 * 1024,
  headers = {},
  label = 'TikTok photo metadata',
  dispatcher,
} = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await fetchImpl(String(url), {
      redirect: 'follow',
      headers,
      ...(dispatcher ? { dispatcher } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response?.ok) {
      throw Object.assign(new Error(`${label} request failed with status ${response?.status ?? 'unknown'}.`), {
        kind: 'resolver_http_error',
        statusCode: response?.status ?? 0,
      });
    }
    const contentLength = Number(response.headers?.get?.('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw Object.assign(new Error(`${label} exceeds the configured size limit of ${maxBytes} bytes.`), {
        kind: 'media_size_limit',
      });
    }
    return response;
  } catch (error) {
    if (controller?.signal?.aborted) {
      throw Object.assign(new Error(`${label} request timed out.`), { kind: 'fetch_timeout', cause: error });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readResponseText(response, { maxBytes, timeoutMs = 30_000, label = 'TikTok response' } = {}) {
  const body = response?.body;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    const text = typeof response?.text === 'function' ? await response.text() : '';
    if (Buffer.byteLength(text) > maxBytes) {
      throw Object.assign(new Error(`${label} exceeds the configured size limit of ${maxBytes} bytes.`), {
        kind: 'media_size_limit',
      });
    }
    return text;
  }

  const chunks = [];
  let bytes = 0;
  const timeoutError = Object.assign(new Error(`${label} request timed out.`), { kind: 'fetch_timeout' });
  const timer = timeoutMs > 0
    ? setTimeout(() => body.destroy?.(timeoutError), timeoutMs)
    : null;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw Object.assign(new Error(`${label} exceeds the configured size limit of ${maxBytes} bytes.`), {
          kind: 'media_size_limit',
        });
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    if (timer) clearTimeout(timer);
    body.destroy?.();
  }
}

function isFatalResolverError(error) {
  const kind = String(error?.kind ?? '');
  return kind === 'media_size_limit' || kind === 'fetch_timeout' || kind === 'cookies_unreadable';
}

// Expected per-transport failures (HTTP statuses, network-level fetch errors)
// move the chain to the next transport; anything else is a bug and surfaces.
function isTransportError(error) {
  if (error?.kind === 'resolver_http_error') return true;
  if (/^fetch failed$/i.test(String(error?.message ?? ''))) return true;
  return Boolean(error?.cause) && !error?.kind;
}

function metadataByteLimit(options) {
  const value = Number(options.maxPhotoMetadataBytes);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10 * 1024 * 1024;
}

function fetchTimeoutMs(options = {}) {
  const seconds = Number(options.fetchTimeoutSeconds);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
}

function normalizeAwemeId(value = '') {
  const text = String(value ?? '').trim();
  return /^\d{6,20}$/.test(text) ? text : '';
}

function firstUrl(...values) {
  for (const value of values) {
    const url = firstUrlIn(value);
    if (url) return url;
  }
  return '';
}

function firstUrlIn(value) {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : '';
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = firstUrlIn(entry);
      if (url) return url;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    return firstUrlIn(value.UrlList ?? value.urlList ?? value.url_list ?? value.url);
  }
  return '';
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return null;
}

function positiveIntOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function failure(error, message) {
  return { ok: false, error, message };
}
