import { builtInPlatformAdapters } from './builtins.js';
import { createPlatformRegistry, unsupportedUrlError } from './registry.js';

export {
  INSTAGRAM_HOSTS,
  TIKTOK_HOSTS,
  X_HOSTS,
  builtInPlatformAdapters,
  instagramAdapter,
  tiktokAdapter,
  xAdapter,
} from './builtins.js';
export {
  SUPPORTED_PLATFORMS,
  createPostReference,
  createProfileReference,
  normalizePlatform,
  normalizePlatformHandle,
  postReferenceKey,
  profileReferenceKey,
} from './references.js';
export {
  PLATFORM_ADAPTER_OPERATIONS,
  createPlatformRegistry,
  definePlatformAdapter,
  parseCredentialFreeHttpsUrl,
} from './registry.js';
export {
  downloadGalleryDlPost,
  parseGalleryDlProbeOutput,
  probeGalleryDlPost,
} from './galleryDl.js';

export const platformRegistry = createPlatformRegistry(builtInPlatformAdapters);

export function getPlatformAdapter(platform) {
  return platformRegistry.get(platform);
}

export function detectPlatform(value) {
  return platformRegistry.forUrl(value)?.adapter.platform ?? null;
}

export function detectPlatformUrl(value) {
  const match = platformRegistry.forUrl(value);
  if (!match) return null;
  return Object.freeze({
    platform: match.adapter.platform,
    canonicalUrl: match.adapter.canonicalizeUrl(match.url),
  });
}

export function isSupportedPlatformUrl(value) {
  return platformRegistry.forUrl(value) !== null;
}

export function canonicalizePlatformUrl(value) {
  return platformRegistry.canonicalizeUrl(value);
}

export function assertSupportedPlatformUrl(value) {
  if (!isSupportedPlatformUrl(value)) throw unsupportedUrlError();
  return canonicalizePlatformUrl(value);
}

export function parsePostReference(value) {
  return platformRegistry.parsePostReference(value);
}

export function parseProfileReference(value) {
  return platformRegistry.parseProfileReference(value);
}

export function parsePlatformReference(value) {
  return parsePostReference(value) ?? parseProfileReference(value);
}

export function extractSupportedPlatformUrls(value, limit = 5) {
  const maximum = Math.max(0, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 5);
  if (maximum === 0) return [];
  const matches = String(value ?? '').match(/https?:\/\/[^\s<>()]+/gi) ?? [];
  const urls = [];
  const seen = new Set();

  for (const match of matches) {
    const cleaned = match.replace(/[.,!?;:)\]}>'"]+$/g, '');
    if (!isSupportedPlatformUrl(cleaned)) continue;
    const canonicalUrl = canonicalizePlatformUrl(cleaned);
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    urls.push(canonicalUrl);
    if (urls.length >= maximum) break;
  }
  return urls;
}
