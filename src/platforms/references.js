const PLATFORM_ALIASES = Object.freeze({
  tiktok: 'tiktok',
  instagram: 'instagram',
  x: 'x',
  twitter: 'x',
});

const HANDLE_PATTERNS = Object.freeze({
  tiktok: /^[A-Za-z0-9._]{1,32}$/,
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  x: /^[A-Za-z0-9_]{1,15}$/,
});

const POST_ID_PATTERNS = Object.freeze({
  tiktok: /^\d{1,32}$/,
  instagram: /^[A-Za-z0-9_-]{1,64}$/,
  x: /^\d{1,32}$/,
});

const REMOTE_PROFILE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const SUPPORTED_PLATFORMS = Object.freeze(['tiktok', 'instagram', 'x']);

export function normalizePlatform(value) {
  const input = String(value ?? '').trim().toLowerCase();
  const platform = PLATFORM_ALIASES[input];
  if (!platform) {
    throw new Error(`Unsupported platform: ${input || '(empty)'}.`);
  }
  return platform;
}

export function normalizePlatformHandle(platformInput, value) {
  const platform = normalizePlatform(platformInput);
  const handle = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!HANDLE_PATTERNS[platform].test(handle) || handle.includes('..')) {
    throw new Error(`Invalid ${platform} profile handle.`);
  }
  return handle;
}

export function createPostReference(input = {}) {
  const platform = normalizePlatform(input.platform);
  const remoteId = String(input.remoteId ?? input.remotePostId ?? '').trim();
  if (!POST_ID_PATTERNS[platform].test(remoteId)) {
    throw new Error(`Invalid ${platform} post ID.`);
  }

  const creatorHandle = input.creatorHandle == null || input.creatorHandle === ''
    ? null
    : normalizePlatformHandle(platform, input.creatorHandle);

  return Object.freeze({
    kind: 'post',
    platform,
    remoteId,
    creatorHandle,
    canonicalUrl: normalizeReferenceUrl(input.canonicalUrl),
  });
}

export function createProfileReference(input = {}) {
  const platform = normalizePlatform(input.platform);
  const handle = input.handle == null || input.handle === ''
    ? null
    : normalizePlatformHandle(platform, input.handle);
  const remoteId = normalizeRemoteProfileId(input.remoteId ?? input.remoteProfileId);
  if (!handle && !remoteId) {
    throw new Error('A profile reference requires a handle or remote profile ID.');
  }

  return Object.freeze({
    kind: 'profile',
    platform,
    remoteId,
    handle,
    canonicalUrl: normalizeReferenceUrl(input.canonicalUrl),
  });
}

export function postReferenceKey(reference) {
  const normalized = createPostReference(reference);
  return `${normalized.platform}:post:${encodeURIComponent(normalized.remoteId)}`;
}

export function profileReferenceKey(reference) {
  const normalized = createProfileReference(reference);
  if (normalized.remoteId) {
    return `${normalized.platform}:profile:id:${encodeURIComponent(normalized.remoteId)}`;
  }
  return `${normalized.platform}:profile:handle:${encodeURIComponent(normalized.handle)}`;
}

function normalizeRemoteProfileId(value) {
  if (value == null || value === '') return null;
  const remoteId = String(value).trim();
  if (!REMOTE_PROFILE_ID_PATTERN.test(remoteId)) {
    throw new Error('Invalid remote profile ID.');
  }
  return remoteId;
}

function normalizeReferenceUrl(value) {
  if (value == null || value === '') return null;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('Reference URLs must be valid credential-free HTTPS URLs.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Reference URLs must be valid credential-free HTTPS URLs.');
  }
  return url.href;
}
