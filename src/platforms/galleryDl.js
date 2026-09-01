import { spawn as defaultSpawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { listPrivateHighlights, listPrivatePosts, listPrivateStories } from './instagramPrivate.js';
import os from 'node:os';
import path from 'node:path';
import { createPostReference } from './references.js';

const DEFAULT_EXECUTABLE = 'gallery-dl';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ASSETS = 20;
const DEFAULT_MAX_ITEM_BYTES = 250 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_COOKIE_BYTES = 5 * 1024 * 1024;
const OUTPUT_SCAN_INTERVAL_MS = 100;
const CHILD_KILL_GRACE_MS = 2_000;

const MEDIA_EXTENSIONS = new Set([
  'avif', 'gif', 'heic', 'jpeg', 'jpg', 'm4v', 'mkv', 'mov', 'mp4', 'png', 'webm', 'webp',
]);

const PLATFORM_RULES = Object.freeze({
  instagram: Object.freeze({
    canonicalHost: 'www.instagram.com',
    cookieDomains: Object.freeze(['instagram.com']),
    cookiesOption: 'instagramCookiesFile',
    cookiesEnv: 'INSTAGRAM_COOKIES_FILE',
    proxyOption: 'instagramProxy',
    proxyEnv: 'INSTAGRAM_PROXY',
    pathPattern: /^\/(?:p|reel|tv)\/([A-Za-z0-9_-]{1,64})\/$/,
    storyPathPattern: /^\/stories\/([A-Za-z0-9._]{1,30})\/(\d{1,32})\/$/,
    extractorOptions: Object.freeze([
      'extractor.instagram.videos=merged',
      'extractor.instagram.previews=false',
      'extractor.instagram.audio=false',
    ]),
  }),
  x: Object.freeze({
    canonicalHost: 'x.com',
    cookieDomains: Object.freeze(['x.com', 'twitter.com']),
    cookiesOption: 'xCookiesFile',
    cookiesEnv: 'X_COOKIES_FILE',
    proxyOption: 'xProxy',
    proxyEnv: 'X_PROXY',
    pathPattern: /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/status)\/(\d{1,32})$/,
    extractorOptions: Object.freeze([
      'extractor.twitter.videos=true',
      'extractor.twitter.previews=false',
      'extractor.twitter.cards=false',
      'extractor.twitter.articles=false',
      'extractor.twitter.quoted=false',
      'extractor.twitter.text-tweets=false',
      'extractor.twitter.conversations=false',
    ]),
  }),
});

const INSTAGRAM_LISTING_RANGE_MULTIPLIER = 5;

function normalizeInstagramHandle(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw galleryDlError('invalid_url', 'Instagram username is required.');
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const parts = url.pathname.split('/').filter(Boolean);
    // Handle /stories/{username}/{id} or /stories/{username} or /p/... etc => prefer username
    if (parts[0] === 'stories' && parts[1]) return parts[1].toLowerCase();
    if (parts[0] && !['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct'].includes(parts[0].toLowerCase())) {
      const candidate = parts[0].replace(/^@/, '');
      if (/^[A-Za-z0-9._]{1,30}$/.test(candidate)) return candidate.toLowerCase();
    }
    // Fallback to parsing as profile reference
    const profileMatch = raw.match(/instagram\.com\/([A-Za-z0-9._]{1,30})/i);
    if (profileMatch) return profileMatch[1].toLowerCase();
  } catch {
    // not a URL, treat as plain username
  }
  const cleaned = raw.replace(/^@/, '').trim().toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(cleaned) || cleaned.includes('..')) {
    throw galleryDlError('invalid_url', 'Instagram username is invalid.');
  }
  return cleaned;
}

function instagramPostsListingUrl(handle) {
  return `https://www.instagram.com/${handle}/posts/`;
}

function instagramStoriesListingUrl(handle) {
  return `https://www.instagram.com/stories/${handle}/`;
}

function instagramHighlightsListingUrl(handle) {
  return `https://www.instagram.com/${handle}/highlights/`;
}


function parseGalleryPostDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  // gallery-dl uses "YYYY-MM-DD HH:MM:SS"
  const iso = text.includes(' ') ? text.replace(' ', 'T') + 'Z' : text;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildListingCommonArgs(platform, settings, runtime, rangeEnd) {
  const rule = PLATFORM_RULES[platform];
  if (!rule) throw galleryDlError('invalid_config', `Unsupported platform ${platform} for listing.`);
  const args = [
    '--config-ignore',
    '--no-input',
    '--no-colors',
    '--quiet',
    '--retries',
    '2',
    '--http-timeout',
    String(Math.max(1, Math.min(60, Math.ceil(settings.timeoutMs / 1000)))),
    '--cache-file',
    runtime.cacheFile,
    '--range',
    `1-${rangeEnd}`,
  ];
  for (const value of rule.extractorOptions) {
    args.push('-o', value);
  }
  if (settings.proxy) args.push('--proxy', settings.proxy);
  if (runtime.cookiesFile) args.push('--cookies', runtime.cookiesFile);
  return args;
}

async function withPlatformRuntime(platform, settings, callback) {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), `${platform}-gallery-dl-runtime-`));
  try {
    const syntheticReference = { platform, canonicalUrl: `https://${PLATFORM_RULES[platform].canonicalHost}/`, remoteId: 'listing' };
    const cookiesFile = await stagePlatformCookies(syntheticReference, settings, runtimeDir);
    const cacheFile = path.join(runtimeDir, 'cache.sqlite3');
    return await callback({ runtimeDir, cookiesFile, cacheFile });
  } finally {
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveListingSettings(platform, options = {}) {
  const values = options?.config && typeof options.config === 'object'
    ? { ...options.config, ...options }
    : (options ?? {});
  const rule = PLATFORM_RULES[platform];
  if (!rule) throw galleryDlError('invalid_config', `Unsupported platform ${platform}.`);
  const executable = String(values.galleryDlPath ?? DEFAULT_EXECUTABLE).trim();
  if (!executable) throw galleryDlError('invalid_config', 'GALLERY_DL_PATH cannot be empty.');
  const proxy = normalizeProxy(values[rule.proxyOption], rule.proxyEnv);
  return {
    executable,
    spawnImpl: values.spawnImpl ?? defaultSpawn,
    signal: values.signal ?? null,
    timeoutMs: positiveInteger(values.galleryDlTimeoutMs, DEFAULT_TIMEOUT_MS),
    maxAssets: positiveInteger(values.galleryDlMaxAssets, DEFAULT_MAX_ASSETS),
    maxItemBytes: positiveInteger(values.galleryDlMaxItemBytes, DEFAULT_MAX_ITEM_BYTES),
    maxTotalBytes: positiveInteger(values.galleryDlMaxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
    tempParentDir: path.resolve(String(values.galleryDlTempDir ?? os.tmpdir())),
    cookiesSource: values[rule.cookiesOption] ? path.resolve(String(values[rule.cookiesOption])) : '',
    cookiesEnv: rule.cookiesEnv,
    cookieDomains: rule.cookieDomains,
    proxy,
  };
}

export async function listInstagramCreatorPosts(usernameOrUrl, options = {}) {
  const handle = normalizeInstagramHandle(usernameOrUrl);
  try {
    return await listPrivatePosts(handle, options);
  } catch (privateError) {
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 5));
    const rangeEnd = Math.max(limit * INSTAGRAM_LISTING_RANGE_MULTIPLIER, limit + 2);
    const listingUrl = instagramPostsListingUrl(handle);
    const settings = resolveListingSettings('instagram', options);
    try {
      return await withPlatformRuntime('instagram', settings, async (runtime) => {
        const args = [
          ...buildListingCommonArgs('instagram', settings, runtime, rangeEnd),
          '-o',
          'output.num-to-str=true',
          '--dump-json',
          '--',
          listingUrl,
        ];
        const { stdout } = await runGalleryDl(settings.executable, args, settings);
        return parseInstagramPostsListing(stdout, handle, listingUrl, limit);
      });
    } catch (galleryError) {
      if (String(privateError?.kind ?? '') === 'not_found') throw privateError;
      if (String(galleryError?.kind ?? '') === 'rate_limited' && String(privateError?.kind ?? '') !== 'rate_limited') throw privateError;
      throw galleryError;
    }
  }
}
export async function listInstagramCreatorStories(usernameOrUrl, options = {}) {
  const handle = normalizeInstagramHandle(usernameOrUrl);
  try {
    return await listPrivateStories(handle, options);
  } catch (privateError) {
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 5));
    const listingUrl = instagramStoriesListingUrl(handle);
    const settings = resolveListingSettings('instagram', options);
    try {
      return await withPlatformRuntime('instagram', settings, async (runtime) => {
        const args = [
          ...buildListingCommonArgs('instagram', settings, runtime, limit * 2),
          '-o',
          'output.num-to-str=true',
          '--dump-json',
          '--',
          listingUrl,
        ];
        const { stdout } = await runGalleryDl(settings.executable, args, settings);
        return parseInstagramStoriesListing(stdout, handle, listingUrl, limit);
      });
    } catch (galleryError) {
      if (String(privateError?.kind ?? '') === 'not_found') throw privateError;
      throw galleryError;
    }
  }
}

export async function listInstagramCreatorHighlights(usernameOrUrl, options = {}) {
  const handle = normalizeInstagramHandle(usernameOrUrl);
  try {
    return await listPrivateHighlights(handle, options);
  } catch (privateError) {
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
    const listingUrl = instagramHighlightsListingUrl(handle);
    const settings = resolveListingSettings('instagram', options);
    try {
      return await withPlatformRuntime('instagram', settings, async (runtime) => {
        const args = [
          ...buildListingCommonArgs('instagram', settings, runtime, Math.max(limit * 5, 50)),
          '-o',
          'output.num-to-str=true',
          '--dump-json',
          '--',
          listingUrl,
        ];
        const { stdout } = await runGalleryDl(settings.executable, args, settings);
        return parseInstagramHighlightsListing(stdout, handle, listingUrl, limit);
      });
    } catch (galleryError) {
      if (String(privateError?.kind ?? '') === 'not_found') throw privateError;
      throw galleryError;
    }
  }
}
export function parseInstagramPostsListing(stdout, handle, sourceUrl, limit = 5) {
  let messages;
  try {
    messages = JSON.parse(String(stdout ?? ''));
  } catch (cause) {
    throw galleryDlError('invalid_output', 'gallery-dl returned invalid JSON metadata.', { retryable: false, cause });
  }
  if (!Array.isArray(messages)) throw galleryDlError('invalid_output', 'gallery-dl returned an invalid metadata message stream.');
  const dirs = [];
  for (const message of messages) {
    if (!Array.isArray(message)) continue;
    if (message[0] === -1) {
      const details = message[1] && typeof message[1] === 'object' ? message[1] : {};
      throw classifyGalleryDlFailure(details.message || details.error || 'gallery-dl extraction failed.');
    }
    if (message[0] === 2 && message[1] && typeof message[1] === 'object') {
      dirs.push(message[1]);
    } else if (message[0] === 6) {
      throw galleryDlError('unexpected_output', 'gallery-dl tried to leave the requested post extractor.');
    }
  }
  // Some listings emit no dirs when user has no posts; return empty
  const entries = [];
  const bounded = Math.max(1, Math.min(50, Number(limit) || 5));
  for (const dir of dirs.slice(0, bounded)) {
    const shortcode = String(dir.post_shortcode ?? dir.sidecar_shortcode ?? dir.shortcode ?? '').trim();
    const numericId = String(dir.post_id ?? dir.sidecar_media_id ?? dir.id ?? '').trim();
    const canonical = shortcode ? `https://www.instagram.com/p/${shortcode}/` : sourceUrl;
    const remoteId = shortcode || numericId;
    if (!remoteId) continue;
    const dateText = String(dir.post_date ?? dir.date ?? '');
    const parsedMs = parseGalleryPostDate(dateText);
    const uploadDate = dateText ? dateText.slice(0, 10).replace(/-/g, '') : '';
    entries.push({
      id: remoteId,
      videoId: remoteId,
      webpage_url: canonical,
      url: canonical,
      source_url: canonical,
      original_url: canonical,
      title: String(dir.description ?? '').slice(0, 200),
      description: String(dir.description ?? ''),
      uploader: String(dir.username ?? handle),
      username: String(dir.username ?? handle),
      uploader_id: String(dir.owner_id ?? dir.user?.id ?? ''),
      user_id: String(dir.owner_id ?? ''),
      channel_id: String(dir.owner_id ?? ''),
      creator_id: String(dir.owner_id ?? ''),
      timestamp: parsedMs ? Math.floor(parsedMs / 1000) : null,
      upload_date: /^\d{8}$/.test(uploadDate) ? uploadDate : '',
      created_at: dateText,
      date: dateText,
      mediaType: '',
      post_shortcode: shortcode,
      post_id: numericId,
      owner_id: String(dir.owner_id ?? ''),
      _galleryMeta: dir,
    });
  }
  const first = dirs[0];
  const metadata = {
    id: String(first?.owner_id ?? first?.user?.id ?? ''),
    user_id: String(first?.owner_id ?? ''),
    uploader_id: String(first?.owner_id ?? ''),
    channel_id: String(first?.owner_id ?? ''),
    uploader: String(first?.username ?? handle),
    username: String(first?.username ?? handle),
    creator_id: String(first?.owner_id ?? ''),
    hasStory: null,
  };
  return {
    sourceUrl,
    count: entries.length,
    metadata,
    entries,
  };
}

export function parseInstagramStoriesListing(stdout, handle, sourceUrl, limit = 5) {
  let messages;
  try {
    messages = JSON.parse(String(stdout ?? ''));
  } catch (cause) {
    throw galleryDlError('invalid_output', 'gallery-dl returned invalid JSON metadata.', { retryable: false, cause });
  }
  if (!Array.isArray(messages)) throw galleryDlError('invalid_output', 'gallery-dl returned an invalid metadata message stream.');
  const dirs = [];
  const urlMessages = [];
  for (const message of messages) {
    if (!Array.isArray(message)) continue;
    if (message[0] === -1) {
      const details = message[1] && typeof message[1] === 'object' ? message[1] : {};
      throw classifyGalleryDlFailure(details.message || details.error || 'gallery-dl extraction failed.');
    }
    if (message[0] === 2 && message[1] && typeof message[1] === 'object') dirs.push(message[1]);
    else if (message[0] === 3 && typeof message[1] === 'string' && message[2] && typeof message[2] === 'object') {
      urlMessages.push({ url: message[1], metadata: message[2] });
    }
  }
  const bounded = Math.max(1, Math.min(50, Number(limit) || 5));
  const entries = [];
  // Story items are url messages; each has media_id
  for (const { url, metadata } of urlMessages.slice(0, bounded)) {
    const mediaId = String(metadata.media_id ?? metadata.id ?? '').trim();
    if (!mediaId) continue;
    const canonical = `https://www.instagram.com/stories/${handle}/${mediaId}/`;
    const dateText = String(metadata.date ?? metadata.post_date ?? dirs[0]?.date ?? '');
    const parsedMs = parseGalleryPostDate(dateText);
    const shortcode = String(metadata.shortcode ?? '').trim();
    entries.push({
      id: `story_${mediaId}`,
      videoId: `story_${mediaId}`,
      media_id: mediaId,
      webpage_url: canonical,
      url: canonical,
      source_url: canonical,
      original_url: canonical,
      title: String(metadata.description ?? '').slice(0, 200),
      description: String(metadata.description ?? ''),
      uploader: String(metadata.username ?? handle),
      username: String(metadata.username ?? handle),
      uploader_id: String(metadata.owner_id ?? metadata.owner?.id ?? dirs[0]?.owner_id ?? ''),
      user_id: String(metadata.owner_id ?? ''),
      timestamp: parsedMs ? Math.floor(parsedMs / 1000) : null,
      upload_date: dateText ? dateText.slice(0, 10).replace(/-/g, '') : '',
      date: dateText,
      mediaType: 'story',
      type: 'story',
      media_url: String(metadata.video_url ?? metadata.display_url ?? url ?? ''),
      shortcode,
      _galleryMeta: metadata,
    });
  }
  const firstDir = dirs[0];
  const firstUrl = urlMessages[0]?.metadata;
  const metadata = {
    id: String(firstDir?.owner_id ?? firstUrl?.owner_id ?? ''),
    user_id: String(firstDir?.owner_id ?? firstUrl?.owner_id ?? ''),
    uploader_id: String(firstDir?.owner_id ?? ''),
    channel_id: String(firstDir?.owner_id ?? ''),
    uploader: String(firstDir?.username ?? firstUrl?.username ?? handle),
    username: String(firstDir?.username ?? handle),
    creator_id: String(firstDir?.owner_id ?? ''),
    hasStory: entries.length > 0,
    mediaType: 'story',
  };
  return {
    sourceUrl,
    storyUrl: `https://www.instagram.com/stories/${handle}/`,
    count: entries.length,
    metadata,
    entries,
  };
}

export function parseInstagramHighlightsListing(stdout, handle, sourceUrl, limit = 20) {
  let messages;
  try {
    messages = JSON.parse(String(stdout ?? ''));
  } catch (cause) {
    throw galleryDlError('invalid_output', 'gallery-dl returned invalid JSON metadata.', { retryable: false, cause });
  }
  if (!Array.isArray(messages)) throw galleryDlError('invalid_output', 'gallery-dl returned an invalid metadata message stream.');
  const dirs = [];
  const urlMessages = [];
  for (const message of messages) {
    if (!Array.isArray(message)) continue;
    if (message[0] === -1) {
      const details = message[1] && typeof message[1] === 'object' ? message[1] : {};
      throw classifyGalleryDlFailure(details.message || details.error || 'gallery-dl extraction failed.');
    }
    if (message[0] === 2 && message[1] && typeof message[1] === 'object') dirs.push(message[1]);
    else if (message[0] === 3 && typeof message[1] === 'string' && message[2] && typeof message[2] === 'object') {
      urlMessages.push({ url: message[1], metadata: message[2] });
    }
  }
  const bounded = Math.max(1, Math.min(20, Number(limit) || 20));
  const entries = [];
  // Highlights: each directory is a highlight reel; URL messages are items inside.
  // For monitoring we track highlight reels (not individual items) — a new reel or an updated reel
  // will be detected via the highlight's post_id. Item-level updates inside an existing highlight
  // would need per-item tracking; for now we treat the reel as the unit.
  for (const dir of dirs.slice(0, bounded)) {
    const highlightId = String(dir.post_id ?? dir.id ?? '').trim();
    if (!highlightId) continue;
    const canonical = `https://www.instagram.com/stories/highlights/${highlightId}/`;
    const dateText = String(dir.post_date ?? dir.date ?? '');
    const parsedMs = parseGalleryPostDate(dateText);
    const title = String(dir.highlight_title ?? dir.title ?? '').trim();
    const itemCount = urlMessages.filter((m) => String(m.metadata.post_id ?? '') === highlightId).length;
    entries.push({
      id: `highlight_${highlightId}`,
      videoId: `highlight_${highlightId}`,
      media_id: highlightId,
      highlight_id: highlightId,
      highlight_title: title,
      webpage_url: canonical,
      url: canonical,
      source_url: canonical,
      original_url: canonical,
      title: title || `Highlight ${highlightId}`,
      description: title,
      uploader: String(dir.username ?? handle),
      username: String(dir.username ?? handle),
      uploader_id: String(dir.owner_id ?? dir.user?.id ?? ''),
      user_id: String(dir.owner_id ?? ''),
      timestamp: parsedMs ? Math.floor(parsedMs / 1000) : null,
      upload_date: dateText ? dateText.slice(0, 10).replace(/-/g, '') : '',
      date: dateText,
      mediaType: 'highlight',
      type: 'highlight',
      count: itemCount || Number(dir.count ?? 0) || 0,
      _galleryMeta: dir,
    });
  }
  const firstDir = dirs[0];
  const metadata = {
    id: String(firstDir?.owner_id ?? ''),
    user_id: String(firstDir?.owner_id ?? ''),
    uploader_id: String(firstDir?.owner_id ?? ''),
    channel_id: String(firstDir?.owner_id ?? ''),
    uploader: String(firstDir?.username ?? handle),
    username: String(firstDir?.username ?? handle),
    creator_id: String(firstDir?.owner_id ?? ''),
    hasStory: null,
    mediaType: 'highlight',
  };
  return {
    sourceUrl,
    count: entries.length,
    metadata,
    entries,
  };
}


export async function probeGalleryDlPost(referenceInput, options = {}) {
  const reference = requireGalleryDlReference(referenceInput);
  const settings = resolveSettings(reference, options);
  return withRuntime(reference, settings, async (runtime) => {
    return probeWithRuntime(reference, settings, runtime);
  });
}

export async function downloadGalleryDlPost(referenceInput, options = {}) {
  const reference = requireGalleryDlReference(referenceInput);
  const settings = resolveSettings(reference, options);

  return withRuntime(reference, settings, async (runtime) => {
    const probe = await probeWithRuntime(reference, settings, runtime);
    await mkdir(settings.tempParentDir, { recursive: true, mode: 0o700 });
    const outputDir = await mkdtemp(path.join(settings.tempParentDir, `${reference.platform}-gallery-dl-`));

    try {
      const args = buildDownloadArgs(reference, settings, runtime, outputDir);
      await runGalleryDl(settings.executable, args, {
        ...settings,
        outputDir,
      });
      const artifacts = await inspectOutputDirectory(outputDir, settings, {
        expectedCount: probe.assets.length,
        allowPartial: false,
      });
      const normalizedArtifacts = await normalizeArtifactNames(outputDir, artifacts);
      const assets = probe.assets.map((asset, index) => {
        const artifact = normalizedArtifacts[index];
        const extension = path.extname(artifact.filename).slice(1).toLowerCase();
        return {
          ...asset,
          extension,
          mimeType: mimeTypeFor(extension),
          filePath: artifact.filePath,
          filename: artifact.filename,
          sizeBytes: artifact.sizeBytes,
        };
      });

      return {
        ...probe,
        outputDir,
        assets,
        totalSizeBytes: assets.reduce((total, asset) => total + asset.sizeBytes, 0),
      };
    } catch (error) {
      await rm(outputDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

export function parseGalleryDlProbeOutput(stdout, referenceInput, options = {}) {
  const reference = requireGalleryDlReference(referenceInput);
  const maxAssets = positiveInteger(options.maxAssets ?? options.galleryDlMaxAssets, DEFAULT_MAX_ASSETS);
  let messages;
  try {
    messages = JSON.parse(String(stdout ?? ''));
  } catch (cause) {
    throw galleryDlError('invalid_output', 'gallery-dl returned invalid JSON metadata.', {
      retryable: false,
      cause,
    });
  }
  if (!Array.isArray(messages)) {
    throw galleryDlError('invalid_output', 'gallery-dl returned an invalid metadata message stream.');
  }

  const directoryMessages = [];
  const urlMessages = [];
  for (const message of messages) {
    if (!Array.isArray(message)) continue;
    if (message[0] === -1) {
      const details = message[1] && typeof message[1] === 'object' ? message[1] : {};
      throw classifyGalleryDlFailure(details.message || details.error || 'gallery-dl extraction failed.');
    }
    if (message[0] === 2 && message[1] && typeof message[1] === 'object') {
      directoryMessages.push(message[1]);
    } else if (message[0] === 3 && typeof message[1] === 'string' && message[2] && typeof message[2] === 'object') {
      urlMessages.push({ url: message[1], metadata: message[2] });
    } else if (message[0] === 6) {
      throw galleryDlError('unexpected_output', 'gallery-dl tried to leave the requested post extractor.');
    }
  }

  if (directoryMessages.length !== 1) {
    throw galleryDlError(
      'unexpected_output',
      directoryMessages.length
        ? 'gallery-dl returned more than one post for a single-post URL.'
        : 'gallery-dl returned no post metadata.',
    );
  }

  const postMetadata = directoryMessages[0];
  if (urlMessages.length > maxAssets) {
    throw galleryDlError('asset_limit', `The post contains more than ${maxAssets} media assets.`);
  }
  if (!urlMessages.length) {
    throw galleryDlError('no_media', 'The post does not contain downloadable image or video media.');
  }
  const assets = urlMessages.map(({ url, metadata }, index) => normalizeAsset(
    reference,
    metadata,
    url,
    index + 1,
  ));
  const post = normalizePost(reference, postMetadata, assets);
  return { post, assets };
}

async function probeWithRuntime(reference, settings, runtime) {
  const args = buildProbeArgs(reference, settings, runtime);
  const { stdout } = await runGalleryDl(settings.executable, args, settings);
  return parseGalleryDlProbeOutput(stdout, reference, { maxAssets: settings.maxAssets });
}

async function withRuntime(reference, settings, callback) {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), `${reference.platform}-gallery-dl-runtime-`));
  try {
    const cookiesFile = await stagePlatformCookies(reference, settings, runtimeDir);
    const cacheFile = path.join(runtimeDir, 'cache.sqlite3');
    return await callback({ runtimeDir, cookiesFile, cacheFile });
  } finally {
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildProbeArgs(reference, settings, runtime) {
  return [
    ...buildCommonArgs(reference, settings, runtime, settings.maxAssets + 1),
    '-o',
    'output.num-to-str=true',
    '--dump-json',
    '--',
    reference.canonicalUrl,
  ];
}

function buildDownloadArgs(reference, settings, runtime, outputDir) {
  return [
    ...buildCommonArgs(reference, settings, runtime, settings.maxAssets),
    '--no-postprocessors',
    '--filesize-max',
    String(settings.maxItemBytes),
    '--restrict-filenames',
    'ascii+',
    '--filename',
    'asset_{num:03}.{extension}',
    '--directory',
    outputDir,
    '--',
    reference.canonicalUrl,
  ];
}

function buildCommonArgs(reference, settings, runtime, rangeEnd) {
  const args = [
    '--config-ignore',
    '--no-input',
    '--no-colors',
    '--quiet',
    '--retries',
    '2',
    '--http-timeout',
    String(Math.max(1, Math.min(60, Math.ceil(settings.timeoutMs / 1000)))),
    '--cache-file',
    runtime.cacheFile,
    '--range',
    `1-${rangeEnd}`,
  ];
  for (const value of PLATFORM_RULES[reference.platform].extractorOptions) {
    args.push('-o', value);
  }
  if (settings.proxy) args.push('--proxy', settings.proxy);
  if (runtime.cookiesFile) args.push('--cookies', runtime.cookiesFile);
  return args;
}

function resolveSettings(reference, options) {
  const values = options?.config && typeof options.config === 'object'
    ? { ...options.config, ...options }
    : (options ?? {});
  const rule = PLATFORM_RULES[reference.platform];
  const executable = String(values.galleryDlPath ?? DEFAULT_EXECUTABLE).trim();
  if (!executable) throw galleryDlError('invalid_config', 'GALLERY_DL_PATH cannot be empty.');
  const proxy = normalizeProxy(values[rule.proxyOption], rule.proxyEnv);
  return {
    executable,
    spawnImpl: values.spawnImpl ?? defaultSpawn,
    signal: values.signal ?? null,
    timeoutMs: positiveInteger(values.galleryDlTimeoutMs, DEFAULT_TIMEOUT_MS),
    maxAssets: positiveInteger(values.galleryDlMaxAssets, DEFAULT_MAX_ASSETS),
    maxItemBytes: positiveInteger(values.galleryDlMaxItemBytes, DEFAULT_MAX_ITEM_BYTES),
    maxTotalBytes: positiveInteger(values.galleryDlMaxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
    tempParentDir: path.resolve(String(values.galleryDlTempDir ?? os.tmpdir())),
    cookiesSource: values[rule.cookiesOption] ? path.resolve(String(values[rule.cookiesOption])) : '',
    cookiesEnv: rule.cookiesEnv,
    cookieDomains: rule.cookieDomains,
    proxy,
  };
}

async function stagePlatformCookies(reference, settings, runtimeDir) {
  if (!settings.cookiesSource) {
    if (isInstagramStoryReference(reference)) {
      throw galleryDlError(
        'access_denied',
        'Instagram Story downloads require INSTAGRAM_COOKIES_FILE from a logged-in Instagram session.',
      );
    }
    return '';
  }
  let info;
  try {
    info = await stat(settings.cookiesSource);
  } catch (cause) {
    throw galleryDlError(
      'cookies_unreadable',
      `${settings.cookiesEnv} is set but its cookie file is missing or unreadable.`,
      { cause },
    );
  }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_COOKIE_BYTES) {
    throw galleryDlError(
      'cookies_unreadable',
      `${settings.cookiesEnv} must point to a non-empty Netscape cookie file smaller than ${MAX_COOKIE_BYTES} bytes.`,
    );
  }

  let source;
  try {
    source = await readFile(settings.cookiesSource, 'utf8');
  } catch (cause) {
    throw galleryDlError('cookies_unreadable', `${settings.cookiesEnv} could not be read.`, { cause });
  }
  const filtered = filterNetscapeCookies(source, settings.cookieDomains);
  if (!filtered.cookieCount) {
    throw galleryDlError(
      'cookies_unreadable',
      `${settings.cookiesEnv} does not contain cookies for ${reference.platform}.`,
    );
  }
  if (isInstagramStoryReference(reference) && !filtered.cookieNames.has('sessionid')) {
    throw galleryDlError(
      'cookies_unreadable',
      'INSTAGRAM_COOKIES_FILE must contain the Instagram sessionid cookie to download Stories.',
    );
  }

  const destination = path.join(runtimeDir, 'cookies.txt');
  await writeFile(destination, filtered.text, { mode: 0o600 });
  await chmod(destination, 0o600);
  return destination;
}

function filterNetscapeCookies(source, allowedDomains) {
  const lines = ['# Netscape HTTP Cookie File'];
  let cookieCount = 0;
  const cookieNames = new Set();
  for (const rawLine of String(source ?? '').split(/\r?\n/)) {
    let candidate = rawLine.trim();
    if (!candidate) continue;
    if (candidate.startsWith('#HttpOnly_')) candidate = candidate.slice('#HttpOnly_'.length);
    else if (candidate.startsWith('#')) continue;
    const [rawDomain] = candidate.split('\t');
    const domain = String(rawDomain ?? '').replace(/^\./, '').toLowerCase();
    if (!domain || !allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))) continue;
    const fields = candidate.split('\t');
    if (fields.length < 7) continue;
    lines.push(rawLine.trim());
    cookieCount += 1;
    cookieNames.add(String(fields[5] ?? '').trim());
  }
  return { cookieCount, cookieNames, text: `${lines.join('\n')}\n` };
}

async function runGalleryDl(executable, args, options) {
  if (options.signal?.aborted) {
    throw galleryDlError('aborted', 'gallery-dl was aborted.');
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = options.spawnImpl(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: galleryDlChildEnv(),
        shell: false,
        windowsHide: true,
      });
    } catch (cause) {
      reject(classifySpawnFailure(cause));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let forcedError = null;
    let settled = false;
    let scanPending = false;
    let killFallback = null;
    let timeout = null;
    let scanTimer = null;
    let abortListener = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killFallback);
      clearInterval(scanTimer);
      options.signal?.removeEventListener?.('abort', abortListener);
      if (error) reject(error);
      else resolve(result);
    };
    const stop = (error) => {
      if (settled || forcedError) return;
      forcedError = error;
      child.kill?.('SIGKILL');
      killFallback = setTimeout(() => finish(forcedError), CHILD_KILL_GRACE_MS);
      killFallback.unref?.();
    };
    const appendOutput = (stream, chunk) => {
      const value = String(chunk);
      const bytes = Buffer.byteLength(value);
      if (stream === 'stdout') {
        stdoutBytes += bytes;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          stop(galleryDlError('output_limit', 'gallery-dl metadata output exceeded its safety limit.'));
          return;
        }
        stdout += value;
      } else {
        stderrBytes += bytes;
        if (stderrBytes > MAX_STDERR_BYTES) {
          stop(galleryDlError('output_limit', 'gallery-dl error output exceeded its safety limit.'));
          return;
        }
        stderr += value;
      }
    };

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => appendOutput('stdout', chunk));
    child.stderr?.on?.('data', (chunk) => appendOutput('stderr', chunk));
    child.on?.('error', (cause) => finish(forcedError ?? classifySpawnFailure(cause)));
    child.on?.('close', (code, signal) => {
      if (forcedError) {
        finish(forcedError);
      } else if (code === 0) {
        finish(null, { stdout, stderr, code, signal });
      } else {
        finish(classifyGalleryDlFailure(stderr || `gallery-dl exited with code ${code}.`, {
          code,
          signal,
        }));
      }
    });

    abortListener = () => stop(galleryDlError('aborted', 'gallery-dl was aborted.'));
    options.signal?.addEventListener?.('abort', abortListener, { once: true });
    timeout = setTimeout(() => {
      stop(galleryDlError('timeout', 'gallery-dl timed out.', { retryable: true }));
    }, options.timeoutMs);
    timeout.unref?.();

    scanTimer = options.outputDir
      ? setInterval(() => {
          if (scanPending || settled || forcedError) return;
          scanPending = true;
          inspectOutputDirectory(options.outputDir, options, { allowPartial: true })
            .catch(stop)
            .finally(() => { scanPending = false; });
        }, OUTPUT_SCAN_INTERVAL_MS)
      : null;
    scanTimer?.unref?.();
  });
}

function galleryDlChildEnv() {
  const env = {};
  for (const name of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'SystemRoot',
    'WINDIR',
  ]) {
    if (process.env[name] != null) env[name] = process.env[name];
  }
  return env;
}

async function inspectOutputDirectory(outputDir, settings, { expectedCount = null, allowPartial = false } = {}) {
  const root = await realpath(outputDir);
  const entries = await readdir(root, { withFileTypes: true });
  const artifacts = [];
  let totalSizeBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink() || !entry.isFile()) {
      throw galleryDlError('unsafe_artifact', 'gallery-dl produced an unexpected filesystem artifact.');
    }
    if (!isAllowedArtifactFilename(entry.name, allowPartial)) {
      throw galleryDlError('unsafe_artifact', 'gallery-dl produced an unexpected output filename.');
    }
    const filePath = path.join(root, entry.name);
    assertContainedPath(root, filePath);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw galleryDlError('unsafe_artifact', 'gallery-dl produced a non-regular media file.');
    }
    if (info.size > settings.maxItemBytes) {
      throw galleryDlError('item_size_limit', 'A downloaded media asset exceeded the per-item size limit.');
    }
    totalSizeBytes += info.size;
    if (totalSizeBytes > settings.maxTotalBytes) {
      throw galleryDlError('total_size_limit', 'The downloaded post exceeded the total size limit.');
    }
    artifacts.push({ filePath, filename: entry.name, sizeBytes: info.size });
  }

  if (artifacts.length > settings.maxAssets) {
    throw galleryDlError('asset_limit', `gallery-dl produced more than ${settings.maxAssets} media assets.`);
  }
  if (!allowPartial && expectedCount != null && artifacts.length !== expectedCount) {
    throw galleryDlError('incomplete_download', 'gallery-dl did not download every media asset in the post.');
  }
  return artifacts.sort(compareArtifacts);
}

function isAllowedArtifactFilename(filename, allowPartial) {
  const suffix = allowPartial ? '(?:\\.part)?' : '';
  return new RegExp(`^asset_(?:\\d{1,6}|None)?\\.([A-Za-z0-9]{1,8})${suffix}$`).test(filename)
    && MEDIA_EXTENSIONS.has(filename.replace(/\.part$/i, '').split('.').at(-1).toLowerCase());
}

async function normalizeArtifactNames(outputDir, artifacts) {
  if (artifacts.length > 1 && artifacts.some((artifact, index) => {
    return Number(artifact.filename.match(/^asset_(\d+)/)?.[1]) !== index + 1;
  })) {
    throw galleryDlError('unsafe_artifact', 'gallery-dl produced ambiguous media asset ordering.');
  }
  const normalized = [];
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    const extension = path.extname(artifact.filename).slice(1).toLowerCase();
    const filename = `asset_${String(index + 1).padStart(3, '0')}.${extension}`;
    const filePath = path.join(outputDir, filename);
    assertContainedPath(outputDir, filePath);
    if (path.resolve(artifact.filePath) !== path.resolve(filePath)) {
      await rename(artifact.filePath, filePath);
    }
    normalized.push({ ...artifact, filename, filePath });
  }
  return normalized;
}

function compareArtifacts(left, right) {
  const leftOrder = Number(left.filename.match(/^asset_(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const rightOrder = Number(right.filename.match(/^asset_(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return leftOrder - rightOrder || left.filename.localeCompare(right.filename);
}

function normalizePost(reference, metadata, assets) {
  const author = metadata.author && typeof metadata.author === 'object' ? metadata.author : {};
  const creatorHandle = stringOrNull(
    reference.platform === 'instagram' ? metadata.username : author.name,
  ) ?? reference.creatorHandle;
  const creatorRemoteId = stringOrNull(
    reference.platform === 'instagram' ? metadata.owner_id : author.id,
  );
  const creatorDisplayName = stringOrNull(
    reference.platform === 'instagram' ? metadata.fullname : author.nick,
  );
  const caption = String(
    reference.platform === 'instagram' ? metadata.description ?? '' : metadata.content ?? '',
  );
  const kinds = new Set(assets.map((asset) => asset.kind));
  let mediaType;
  if (isInstagramStoryReference(reference) || metadata.type === 'story') mediaType = 'story';
  else if (assets.length === 1) mediaType = assets[0].kind;
  else if (kinds.size === 1) mediaType = 'carousel';
  else mediaType = 'mixed';

  return {
    platform: reference.platform,
    remoteId: reference.remoteId,
    canonicalUrl: reference.canonicalUrl,
    creator: {
      remoteId: creatorRemoteId,
      handle: creatorHandle,
      displayName: creatorDisplayName,
    },
    caption,
    publishedAt: normalizeDate(metadata.post_date ?? metadata.date),
    mediaType,
    assetCount: assets.length,
  };
}

function normalizeAsset(reference, metadata, sourceUrl, position) {
  const url = safeMediaUrl(sourceUrl);
  const extension = normalizeExtension(metadata.extension, url);
  const kind = mediaKind(metadata.type, extension);
  return {
    position,
    remoteId: stringOrNull(metadata.media_id ?? metadata.id ?? metadata.shortcode)
      ?? `${reference.remoteId}:${position}`,
    kind,
    mimeType: mimeTypeFor(extension),
    extension,
    sourceUrl: url,
    width: finiteNumber(metadata.width),
    height: finiteNumber(metadata.height),
    duration: finiteNumber(metadata.duration),
    altText: String(metadata.description ?? ''),
  };
}

function requireGalleryDlReference(input) {
  const reference = createPostReference(input);
  const rule = PLATFORM_RULES[reference.platform];
  if (!rule || !reference.canonicalUrl) {
    throw galleryDlError('invalid_url', 'gallery-dl supports only Instagram and X post references.');
  }
  let url;
  try {
    url = new URL(reference.canonicalUrl);
  } catch {
    throw galleryDlError('invalid_url', 'The post reference has an invalid canonical URL.');
  }
  const match = rule.pathPattern.exec(url.pathname);
  const storyMatch = rule.storyPathPattern?.exec(url.pathname) ?? null;
  const regularIdentityMatches = Boolean(match && match[1] === reference.remoteId);
  const storyIdentityMatches = Boolean(
    storyMatch
      && reference.remoteId === `story_${storyMatch[2]}`
      && reference.creatorHandle === storyMatch[1].toLowerCase(),
  );
  if (
    url.protocol !== 'https:'
    || url.hostname !== rule.canonicalHost
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || (!regularIdentityMatches && !storyIdentityMatches)
  ) {
    throw galleryDlError('invalid_url', `The ${reference.platform} post reference is not canonical.`);
  }
  return reference;
}

function isInstagramStoryReference(reference) {
  return reference?.platform === 'instagram'
    && /^story_\d{1,32}$/.test(String(reference.remoteId ?? ''))
    && /^https:\/\/www\.instagram\.com\/stories\/[A-Za-z0-9._]{1,30}\/\d{1,32}\/$/.test(
      String(reference.canonicalUrl ?? ''),
    );
}

function safeMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw galleryDlError('invalid_output', 'gallery-dl returned an invalid media URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw galleryDlError('invalid_output', 'gallery-dl returned an unsafe media URL.');
  }
  return url.href;
}

function normalizeExtension(value, sourceUrl) {
  let extension = String(value ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!extension) extension = path.extname(new URL(sourceUrl).pathname).slice(1).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) {
    throw galleryDlError('unsupported_media', `gallery-dl returned unsupported media type: ${extension || 'unknown'}.`);
  }
  return extension;
}

function mediaKind(typeValue, extension) {
  const type = String(typeValue ?? '').toLowerCase();
  if (type.includes('animated') || type === 'gif') return 'animated';
  if (['m4v', 'mkv', 'mov', 'mp4', 'webm'].includes(extension) || type.includes('video')) return 'video';
  return 'image';
}

function mimeTypeFor(extension) {
  const values = {
    avif: 'image/avif',
    gif: 'image/gif',
    heic: 'image/heic',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    m4v: 'video/x-m4v',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    mp4: 'video/mp4',
    png: 'image/png',
    webm: 'video/webm',
    webp: 'image/webp',
  };
  return values[extension] ?? 'application/octet-stream';
}

function normalizeDate(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  let date;
  if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(String(value))) {
    date = new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
  } else {
    date = new Date(String(value));
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeProxy(value, envName) {
  const proxy = String(value ?? '').trim();
  if (!proxy) return '';
  let url;
  try {
    url = new URL(proxy);
  } catch {
    throw galleryDlError('invalid_config', `${envName} must be a valid HTTP or SOCKS proxy URL.`);
  }
  if (!['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname) {
    throw galleryDlError('invalid_config', `${envName} must be a valid HTTP or SOCKS proxy URL.`);
  }
  return proxy;
}

function classifySpawnFailure(cause) {
  if (cause?.code === 'ENOENT') {
    return galleryDlError('not_installed', 'gallery-dl executable was not found.', { cause });
  }
  return galleryDlError('spawn_error', 'gallery-dl could not be started.', { cause, retryable: true });
}

function classifyGalleryDlFailure(message, details = {}) {
  const text = String(message ?? '');
  const lower = text.toLowerCase();
  let kind = 'gallery_dl_error';
  let userMessage = 'gallery-dl failed to extract the post.';
  let retryable = false;
  if (/429|too many requests|rate.?limit/.test(lower)) {
    kind = 'rate_limited';
    userMessage = 'The platform rate-limited gallery-dl.';
    retryable = true;
  } else if (/timed? out|timeout/.test(lower)) {
    kind = 'timeout';
    userMessage = 'gallery-dl timed out.';
    retryable = true;
  } else if (/not found|does not exist|404|unavailable/.test(lower)) {
    kind = 'not_found';
    userMessage = 'The requested post could not be found.';
  } else if (/login|required|auth|cookie|private|permission|challenge/.test(lower)) {
    kind = 'access_denied';
    userMessage = 'The configured platform session cannot access this post.';
  } else if (/unsupported|invalid url|no suitable extractor/.test(lower)) {
    kind = 'invalid_url';
    userMessage = 'gallery-dl could not parse the post URL.';
  }
  return galleryDlError(kind, userMessage, {
    ...details,
    retryable,
    stderr: text.slice(0, 4_096),
  });
}

function galleryDlError(kind, message, details = {}) {
  return Object.assign(new Error(message), {
    kind,
    retryable: Boolean(details.retryable),
    code: details.code ?? null,
    signal: details.signal ?? null,
    stdout: '',
    stderr: String(details.stderr ?? ''),
    ...(details.cause ? { cause: details.cause } : {}),
  });
}

function assertContainedPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    if (!relative) return;
    throw galleryDlError('unsafe_artifact', 'gallery-dl output escaped its staging directory.');
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function stringOrNull(value) {
  if (value == null || value === '') return null;
  return String(value);
}
