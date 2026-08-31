import { createPostReference, createProfileReference } from './references.js';
import { definePlatformAdapter, parseCredentialFreeHttpsUrl } from './registry.js';
import { downloadGalleryDlPost, probeGalleryDlPost } from './galleryDl.js';
import {
  downloadVideo as downloadTikTokVideo,
  fetchVideoMetadata as probeTikTokPost,
  listProfileStories as listTikTokCreatorStories,
  listProfileVideos as listTikTokCreatorPosts,
} from '../tiktok/ytdlp.js';

const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'igsh',
  'igshid',
  'ref_src',
  's',
  'source',
  't',
]);

export const TIKTOK_HOSTS = Object.freeze([
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
]);

export const INSTAGRAM_HOSTS = Object.freeze([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
]);

export const X_HOSTS = Object.freeze([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'm.twitter.com',
]);

const INSTAGRAM_RESERVED_PATHS = new Set([
  'about', 'accounts', 'challenge', 'developer', 'direct', 'directory', 'emails',
  'explore', 'legal', 'p', 'privacy', 'reel', 'reels', 'stories', 'tv', 'web',
]);

const X_RESERVED_PATHS = new Set([
  'compose', 'explore', 'hashtag', 'home', 'i', 'intent', 'login', 'logout',
  'messages', 'notifications', 'privacy', 'search', 'settings', 'share', 'signup',
  'tos',
]);

export const tiktokAdapter = definePlatformAdapter({
  platform: 'tiktok',
  displayName: 'TikTok',
  hosts: TIKTOK_HOSTS,
  canonicalHost: 'www.tiktok.com',
  capabilities: {
    directDownload: true,
    directStories: true,
    multiAsset: true,
    creatorListing: true,
    stories: true,
    availability: true,
    probeBeforeDownload: true,
    archiveOwnedStaging: false,
    preferRequestedCreatorHandle: true,
    legacyVideoIdentity: true,
  },
  canonicalizeUrl(value) {
    const url = requireAdapterUrl(value, TIKTOK_HOSTS, 'TikTok');
    const post = parseTikTokPost(url);
    if (post) return post.canonicalUrl;
    const profile = parseTikTokProfile(url);
    if (profile) return profile.canonicalUrl;

    const preserveShortHost = url.hostname === 'vm.tiktok.com' || url.hostname === 'vt.tiktok.com';
    return canonicalizeGenericUrl(url, preserveShortHost ? url.hostname : 'www.tiktok.com');
  },
  parsePostReference(value) {
    const url = requireAdapterUrl(value, TIKTOK_HOSTS, 'TikTok');
    return parseTikTokPost(url);
  },
  parseProfileReference(value) {
    const url = requireAdapterUrl(value, TIKTOK_HOSTS, 'TikTok');
    return parseTikTokProfile(url);
  },
  probe(value, options = {}) {
    return probeTikTokPost(requireTikTokPostUrl(value), flattenAdapterOptions(options));
  },
  download(value, options = {}) {
    return downloadTikTokVideo(requireTikTokPostUrl(value), flattenAdapterOptions(options));
  },
  listCreatorPosts(value, options = {}) {
    return listTikTokCreatorPosts(value, flattenAdapterOptions(options));
  },
  listCreatorStories(value, options = {}) {
    return listTikTokCreatorStories(value, flattenAdapterOptions(options));
  },
  async checkAvailability(value, options = {}) {
    try {
      await probeTikTokPost(requireTikTokPostUrl(value), flattenAdapterOptions(options));
      return { available: true };
    } catch (error) {
      if (String(error?.kind ?? '') === 'not_found') {
        return { available: false, reason: error.message ?? String(error) };
      }
      throw error;
    }
  },
});

export const instagramAdapter = definePlatformAdapter({
  platform: 'instagram',
  displayName: 'Instagram',
  hosts: INSTAGRAM_HOSTS,
  canonicalHost: 'www.instagram.com',
  capabilities: {
    directDownload: true,
    multiAsset: true,
    probeBeforeDownload: false,
    archiveOwnedStaging: true,
    preferRequestedCreatorHandle: false,
    legacyVideoIdentity: false,
  },
  canonicalizeUrl(value) {
    const url = requireAdapterUrl(value, INSTAGRAM_HOSTS, 'Instagram');
    const post = parseInstagramPost(url);
    if (post) return post.canonicalUrl;
    const profile = parseInstagramProfile(url);
    if (profile) return profile.canonicalUrl;
    return canonicalizeGenericUrl(url, 'www.instagram.com');
  },
  parsePostReference(value) {
    const url = requireAdapterUrl(value, INSTAGRAM_HOSTS, 'Instagram');
    return parseInstagramPost(url);
  },
  parseProfileReference(value) {
    const url = requireAdapterUrl(value, INSTAGRAM_HOSTS, 'Instagram');
    return parseInstagramProfile(url);
  },
  probe(value, options = {}) {
    return probeGalleryDlPost(requirePostReference(value, INSTAGRAM_HOSTS, 'Instagram', parseInstagramPost), options);
  },
  download(value, options = {}) {
    return downloadGalleryDlPost(requirePostReference(value, INSTAGRAM_HOSTS, 'Instagram', parseInstagramPost), options);
  },
});

export const xAdapter = definePlatformAdapter({
  platform: 'x',
  displayName: 'X',
  hosts: X_HOSTS,
  canonicalHost: 'x.com',
  capabilities: {
    directDownload: true,
    multiAsset: true,
    probeBeforeDownload: false,
    archiveOwnedStaging: true,
    preferRequestedCreatorHandle: false,
    legacyVideoIdentity: false,
  },
  canonicalizeUrl(value) {
    const url = requireAdapterUrl(value, X_HOSTS, 'X/Twitter');
    const post = parseXPost(url);
    if (post) return post.canonicalUrl;
    const profile = parseXProfile(url);
    if (profile) return profile.canonicalUrl;
    return canonicalizeGenericUrl(url, 'x.com');
  },
  parsePostReference(value) {
    const url = requireAdapterUrl(value, X_HOSTS, 'X/Twitter');
    return parseXPost(url);
  },
  parseProfileReference(value) {
    const url = requireAdapterUrl(value, X_HOSTS, 'X/Twitter');
    return parseXProfile(url);
  },
  probe(value, options = {}) {
    return probeGalleryDlPost(requirePostReference(value, X_HOSTS, 'X/Twitter', parseXPost), options);
  },
  download(value, options = {}) {
    return downloadGalleryDlPost(requirePostReference(value, X_HOSTS, 'X/Twitter', parseXPost), options);
  },
});

export const builtInPlatformAdapters = Object.freeze([
  tiktokAdapter,
  instagramAdapter,
  xAdapter,
]);

function parseTikTokPost(url) {
  const match = url.pathname.match(/^\/@([A-Za-z0-9._]{1,32})\/(?:video|photo|story)\/(\d{1,32})\/?$/i);
  if (!match) return null;
  const creatorHandle = match[1].toLowerCase();
  const remoteId = match[2];
  const route = url.pathname.split('/')[2].toLowerCase();
  return createPostReference({
    platform: 'tiktok',
    remoteId,
    creatorHandle,
    canonicalUrl: `https://www.tiktok.com/@${creatorHandle}/${route}/${remoteId}`,
  });
}

function parseTikTokProfile(url) {
  const match = url.pathname.match(/^\/@([A-Za-z0-9._]{1,32})\/?$/i);
  if (!match) return null;
  const handle = match[1].toLowerCase();
  return createProfileReference({
    platform: 'tiktok',
    handle,
    canonicalUrl: `https://www.tiktok.com/@${handle}`,
  });
}

function parseInstagramPost(url) {
  const storyMatch = url.pathname.match(/^\/stories\/([A-Za-z0-9._]{1,30})\/(\d{1,32})\/?$/i);
  if (storyMatch && !storyMatch[1].includes('..')) {
    const creatorHandle = storyMatch[1].toLowerCase();
    const storyId = storyMatch[2];
    return createPostReference({
      platform: 'instagram',
      remoteId: `story_${storyId}`,
      creatorHandle,
      canonicalUrl: `https://www.instagram.com/stories/${creatorHandle}/${storyId}/`,
    });
  }
  const match = url.pathname.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{1,64})\/?$/i);
  if (!match) return null;
  const route = match[1].toLowerCase() === 'reels' ? 'reel' : match[1].toLowerCase();
  const remoteId = match[2];
  return createPostReference({
    platform: 'instagram',
    remoteId,
    canonicalUrl: `https://www.instagram.com/${route}/${remoteId}/`,
  });
}

function parseInstagramProfile(url) {
  const match = url.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
  if (!match || INSTAGRAM_RESERVED_PATHS.has(match[1].toLowerCase()) || match[1].includes('..')) return null;
  const handle = match[1].toLowerCase();
  return createProfileReference({
    platform: 'instagram',
    handle,
    canonicalUrl: `https://www.instagram.com/${handle}/`,
  });
}

function parseXPost(url) {
  let match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,32})(?:\/(?:photo|video)\/\d+)?\/?$/i);
  let creatorHandle = match?.[1]?.toLowerCase() ?? null;
  let remoteId = match?.[2] ?? null;

  if (!match) {
    match = url.pathname.match(/^\/i\/(?:web\/)?status\/(\d{1,32})\/?$/i);
    remoteId = match?.[1] ?? null;
  }
  if (!remoteId) return null;

  const canonicalPath = creatorHandle
    ? `/${creatorHandle}/status/${remoteId}`
    : `/i/status/${remoteId}`;
  return createPostReference({
    platform: 'x',
    remoteId,
    creatorHandle,
    canonicalUrl: `https://x.com${canonicalPath}`,
  });
}

function parseXProfile(url) {
  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
  if (!match || X_RESERVED_PATHS.has(match[1].toLowerCase())) return null;
  const handle = match[1].toLowerCase();
  return createProfileReference({
    platform: 'x',
    handle,
    canonicalUrl: `https://x.com/${handle}`,
  });
}

function requireAdapterUrl(value, hosts, displayName) {
  const url = value instanceof URL ? new URL(value.href) : parseCredentialFreeHttpsUrl(value);
  if (
    !url
    || url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || !hosts.includes(url.hostname.toLowerCase())
  ) {
    throw new Error(`A credential-free HTTPS ${displayName} URL is required.`);
  }
  return url;
}

function requirePostReference(value, hosts, displayName, parser) {
  const url = requireAdapterUrl(value, hosts, displayName);
  const reference = parser(url);
  if (!reference) throw new Error(`A canonical ${displayName} post URL is required.`);
  return reference;
}

function requireTikTokPostUrl(value) {
  const url = requireAdapterUrl(value, TIKTOK_HOSTS, 'TikTok');
  const post = parseTikTokPost(url);
  if (post) return post.canonicalUrl;
  const host = url.hostname.toLowerCase();
  const shortPost = (host === 'vm.tiktok.com' || host === 'vt.tiktok.com')
    ? /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    : /^\/t\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname);
  if (!shortPost) throw new Error('A canonical TikTok post URL or TikTok short link is required.');
  return canonicalizeGenericUrl(url, host === 'vm.tiktok.com' || host === 'vt.tiktok.com' ? host : 'www.tiktok.com');
}

function flattenAdapterOptions(options = {}) {
  if (!options?.config || typeof options.config !== 'object') return options;
  const { config, ...context } = options;
  return { ...config, ...context };
}

function canonicalizeGenericUrl(input, canonicalHost) {
  const url = new URL(input.href);
  url.hostname = canonicalHost;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_QUERY_KEYS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.href;
}
