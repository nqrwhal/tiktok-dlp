import { spawn as defaultSpawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileSize, isTikTokUrl, makeDownloadLayout, moveDirectoryContents, pickPrimaryVideo, profileUrl as makeProfileUrl, storyUrl as makeStoryUrl, slugify } from '../util/files.js';

const METADATA_BASE_ARGS = [
  '--ignore-config',
  '--no-warnings',
  '--no-progress',
  '--quiet',
  '--socket-timeout',
  '20',
  '--skip-download',
  '--dump-single-json',
];

const DOWNLOAD_BASE_ARGS = [
  '--ignore-config',
  '--no-warnings',
  '--no-progress',
  '--quiet',
  '--newline',
  '--retries',
  '3',
  '--fragment-retries',
  '3',
  '--extractor-retries',
  '3',
  '--retry-sleep',
  'exp=1:30',
  '--socket-timeout',
  '20',
  '--no-playlist',
  '--format',
  'bv*+ba/b',
  '--restrict-filenames',
  '--merge-output-format',
  'mp4',
  '--write-info-json',
  '--write-thumbnail',
  '--write-description',
  '--output',
  '%(id)s.%(ext)s',
];

const MOBILE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export function buildMetadataArgs(sourceUrl, options = {}) {
  const args = [...METADATA_BASE_ARGS];
  if (options.flatPlaylist) args.push('--flat-playlist');
  if (options.playlist === true || options.flatPlaylist) args.push('--yes-playlist');
  else args.push('--no-playlist');
  const playlistEnd = normalizePositiveInt(options.playlistEnd ?? options.limit);
  if ((options.playlist === true || options.flatPlaylist) && playlistEnd) {
    args.push('--playlist-end', String(playlistEnd));
  }
  if (options.cookiesFile) args.push('--cookies', String(options.cookiesFile));
  if (options.ytdlpCookiesFile) args.push('--cookies', String(options.ytdlpCookiesFile));
  if (Array.isArray(options.extraArgs)) args.push(...options.extraArgs.map(String));
  args.push(String(sourceUrl));
  return args;
}

export function buildDownloadArgs(sourceUrl, options = {}) {
  if (!options.outputDir) throw new Error('outputDir is required.');

  const outputDir = path.resolve(options.outputDir);
  const args = [
    ...DOWNLOAD_BASE_ARGS,
    '--paths',
    `home:${outputDir}`,
    '--paths',
    `temp:${outputDir}`,
  ];
  if (options.cookiesFile) args.push('--cookies', String(options.cookiesFile));
  if (options.ytdlpCookiesFile) args.push('--cookies', String(options.ytdlpCookiesFile));
  if (options.format) replaceArgValue(args, '--format', String(options.format));
  if (options.ytdlpRetries) {
    replaceArgValue(args, '--retries', String(options.ytdlpRetries));
    replaceArgValue(args, '--fragment-retries', String(options.ytdlpRetries));
    replaceArgValue(args, '--extractor-retries', String(options.ytdlpRetries));
  }
  if (Array.isArray(options.extraArgs)) args.push(...options.extraArgs.map(String));
  args.push(String(sourceUrl));
  return args;
}

export async function fetchVideoMetadata(sourceUrl, options = {}) {
  try {
    const { stdout } = await runYtDlp(options.ytdlpPath ?? 'yt-dlp', buildMetadataArgs(sourceUrl, options), options);
    return parseJsonOutput(stdout, 'metadata');
  } catch (error) {
    if (!shouldTryPhotoFallback(sourceUrl, error, options)) throw error;
    return fetchPhotoPostMetadata(sourceUrl, options);
  }
}

export async function listProfileVideos(usernameOrUrl, options = {}) {
  const cachedSecUid = normalizeSecUid(options.watch?.sec_uid ?? options.watch?.secUid ?? options.secUid);
  const sourceUrl = cachedSecUid
    ? `tiktokuser:${cachedSecUid}`
    : String(usernameOrUrl).startsWith('http') ? String(usernameOrUrl) : makeProfileUrl(usernameOrUrl);
  const raw = await fetchVideoMetadata(sourceUrl, {
    ...options,
    playlist: true,
    flatPlaylist: true,
  });

  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((entry, index) => normalizePlaylistEntry(entry, sourceUrl, index))
    : [];
  const metadata = normalizeMetadata(raw, sourceUrl);
  if (cachedSecUid && !metadata.secUid) metadata.secUid = cachedSecUid;
  if (cachedSecUid && !metadata.channel_id) metadata.channel_id = cachedSecUid;
  if (options.username && !metadata.uploader) metadata.uploader = String(options.username);
  if (options.username && !metadata.username) metadata.username = String(options.username);

  return {
    sourceUrl: String(sourceUrl),
    count: entries.length,
    metadata,
    entries,
  };
}

export async function listProfileStories(usernameOrUrl, options = {}) {
  const profileUrl = resolveProfileUrl(usernameOrUrl);
  const cachedAuthorId = normalizeNumericId(options.watch?.author_id ?? options.watch?.authorId ?? options.authorId);
  const cachedSecUid = normalizeSecUid(options.watch?.sec_uid ?? options.watch?.secUid ?? options.secUid);
  const cachedHasStory = normalizeOptionalBoolean(options.watch?.has_story ?? options.watch?.hasStory);
  const cachedUsername = String(options.username ?? options.watch?.username ?? extractUsernameFromUrl(profileUrl) ?? '');
  const profile = cachedAuthorId && cachedHasStory !== false
    ? {
        profileUrl,
        userId: cachedAuthorId,
        username: cachedUsername,
        secUid: cachedSecUid,
        hasStory: cachedHasStory ?? undefined,
      }
    : await fetchProfileStoryIdentity(profileUrl, options);
  if (!profile.userId || profile.hasStory === false) {
    return {
      sourceUrl: profileUrl,
      storyUrl: makeStoryUrl(profile.username || usernameOrUrl),
      count: 0,
      metadata: normalizeMetadata({
        id: profile.userId || '',
        user_id: profile.userId || '',
        uploader_id: profile.userId || '',
        channel_id: profile.secUid || '',
        secUid: profile.secUid || '',
        uploader: profile.username || '',
        username: profile.username || '',
        mediaType: 'story',
        hasStory: profile.hasStory ?? false,
      }, profileUrl),
      entries: [],
    };
  }

  const raw = await fetchStoryItemList(profile, options);
  const storySourceUrl = makeStoryUrl(profile.username || usernameOrUrl);
  const entries = Array.isArray(raw.itemList)
    ? raw.itemList.map((entry, index) => normalizeStoryEntry(entry, {
        ...profile,
        sourceUrl: storySourceUrl,
      }, index)).filter((entry) => entry.videoId && entry.directVideoUrl)
    : [];
  const hasStory = entries.length > 0;

  return {
    sourceUrl: profileUrl,
    storyUrl: storySourceUrl,
    count: entries.length,
    metadata: normalizeMetadata({
      id: profile.userId,
      user_id: profile.userId,
      uploader_id: profile.userId,
      channel_id: profile.secUid || '',
      secUid: profile.secUid || '',
      uploader: profile.username,
      username: profile.username,
      mediaType: 'story',
      hasStory,
    }, profileUrl),
    entries,
  };
}

export async function downloadVideo(sourceUrl, options = {}) {
  const ytdlpPath = options.ytdlpPath ?? 'yt-dlp';
  const metadata = options.metadata ?? await fetchVideoMetadata(sourceUrl, options);
  const tempParent = options.downloadDir
    ? path.join(path.resolve(options.downloadDir), '.tmp')
    : os.tmpdir();
  const tempDir = options.outputDir
    ? path.resolve(options.outputDir)
    : await makeTempDownloadDir(tempParent);

  await ensureTempDir(tempDir);

  if (isPhotoPostMetadata(metadata)) {
    return downloadPhotoPost(sourceUrl, metadata, tempDir, options);
  }

  if (isStoryMetadata(metadata)) {
    return downloadStoryPost(sourceUrl, metadata, tempDir, options);
  }

  let stdout = '';
  let stderr = '';
  try {
    const result = await runYtDlp(ytdlpPath, buildDownloadArgs(sourceUrl, {
      ...options,
      outputDir: tempDir,
    }), options);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    if (!shouldTryPhotoFallback(sourceUrl, error, options)) throw error;
    return downloadPhotoPost(sourceUrl, await fetchPhotoPostMetadata(sourceUrl, options), tempDir, options);
  }

  let downloadDir = tempDir;
  let files = await collectFiles(tempDir);
  if (!files.length) {
    throw Object.assign(new Error('yt-dlp completed without producing any files.'), {
      kind: 'no_files',
      sourceUrl: String(sourceUrl),
      downloadDir: tempDir,
      stdout,
      stderr,
    });
  }

  const normalized = normalizeMetadata(metadata, sourceUrl);
  if (options.downloadDir) {
    const layout = makeDownloadLayout({ downloadDir: options.downloadDir }, normalized);
    downloadDir = layout.dir;
    files = await moveDirectoryContents(tempDir, downloadDir);
  }

  const primaryFile = pickPrimaryVideo(files) || pickPrimaryFile(files);
  const sizeBytes = primaryFile ? await fileSize(primaryFile) : 0;

  return {
    sourceUrl: String(sourceUrl),
    metadata: normalized,
    downloadDir,
    files,
    primaryFile,
    filePath: primaryFile,
    filename: primaryFile ? path.basename(primaryFile) : '',
    sizeBytes,
    videoId: normalized.videoId || normalized.id || '',
    username: normalized.uploader || '',
    title: normalized.title || '',
    description: normalized.description || '',
    thumbnailUrl: normalized.thumbnail || '',
    mediaType: normalized.mediaType || '',
    duration: numberOrNull(normalized.duration) ?? 0,
    stdout,
    stderr,
  };
}

export async function fetchPhotoPostMetadata(sourceUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is not available for TikTok photo fallback.');
  }

  const response = await fetchImpl(String(sourceUrl), {
    redirect: 'follow',
    headers: {
      'user-agent': MOBILE_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!response?.ok) {
    throw new Error(`TikTok photo metadata request failed with status ${response?.status ?? 'unknown'}.`);
  }

  const html = await response.text();
  return parsePhotoPostMetadata(html, response.url || sourceUrl);
}

export function parsePhotoPostMetadata(html, sourceUrl = '') {
  const data = parseRehydrationJson(html);
  const item = findPhotoItem(data);
  if (!item) {
    throw Object.assign(new Error('TikTok photo post metadata was not found.'), {
      kind: 'photo_metadata_not_found',
      sourceUrl: String(sourceUrl),
      stdout: '',
      stderr: '',
    });
  }

  const imageUrls = item.imagePost.images
    .map((image) => image?.imageURL?.urlList?.find(Boolean))
    .filter(Boolean);
  if (!imageUrls.length) {
    throw Object.assign(new Error('TikTok photo post did not include downloadable images.'), {
      kind: 'photo_images_not_found',
      sourceUrl: String(sourceUrl),
      stdout: '',
      stderr: '',
    });
  }

  const username = String(item.author?.uniqueId ?? item.author?.nickname ?? '');
  const id = String(item.id ?? '');
  return {
    id,
    title: String(item.desc ?? id),
    description: String(item.desc ?? ''),
    uploader: username,
    channel: username,
    creator: username,
    webpage_url: sourceUrl || makePhotoUrl(username, id),
    original_url: sourceUrl || makePhotoUrl(username, id),
    thumbnail: imageUrls[0],
    timestamp: numberOrNull(item.createTime) ?? 0,
    mediaType: 'slideshow',
    imageCount: imageUrls.length,
    imageUrls,
    imagePost: item.imagePost,
  };
}

export function classifyYtdlpError(error) {
  if (!error) {
    return {
      kind: 'unknown',
      message: 'Unknown yt-dlp error.',
      retryable: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
    };
  }

  if (typeof error === 'object' && error.kind && error.message && 'stderr' in error) {
    return {
      kind: String(error.kind),
      message: String(error.message),
      retryable: Boolean(error.retryable),
      exitCode: numberOrNull(error.exitCode),
      signal: error.signal ?? null,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }

  const stdout = String(error.stdout ?? error.output ?? '');
  const stderr = String(error.stderr ?? error.message ?? '');
  const code = error.code ?? null;
  const signal = error.signal ?? null;
  const exitCode = numberOrNull(code);
  const combined = `${stderr}\n${stdout}`.toLowerCase();

  if (code === 'ENOENT') {
    return makeClassification('not_installed', 'yt-dlp executable was not found.', false, exitCode, signal, stdout, stderr);
  }

  if (code === 'ETIMEDOUT' || /timed out/.test(combined)) {
    return makeClassification('timeout', 'yt-dlp timed out.', true, exitCode, signal, stdout, stderr);
  }

  if (/too many requests|429|rate limit/.test(combined)) {
    return makeClassification('rate_limited', 'yt-dlp was rate limited.', true, exitCode, signal, stdout, stderr);
  }

  if (/sign in|login|logged in|authentication|cookies?/.test(combined)) {
    return makeClassification('auth_required', 'yt-dlp needs authentication cookies for this source.', false, exitCode, signal, stdout, stderr);
  }

  if (/private|age[- ]restricted|members[- ]only|video is private|not available in your country/.test(combined)) {
    return makeClassification('access_denied', 'The video is not publicly accessible.', false, exitCode, signal, stdout, stderr);
  }

  if (/unsupported url|invalid url|no suitable extractor/.test(combined)) {
    return makeClassification('invalid_url', 'yt-dlp could not parse the URL.', false, exitCode, signal, stdout, stderr);
  }

  if (/no video formats found|requested format is not available|could not find matching format/.test(combined)) {
    return makeClassification('no_formats', 'yt-dlp could not find a downloadable format.', false, exitCode, signal, stdout, stderr);
  }

  if (/not found|video unavailable|404/.test(combined)) {
    return makeClassification('not_found', 'The requested video could not be found.', false, exitCode, signal, stdout, stderr);
  }

  return makeClassification('yt_dlp_error', 'yt-dlp failed.', false, exitCode, signal, stdout, stderr);
}

async function runYtDlp(executable, args, options = {}) {
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const timeoutMs = Number(options.timeoutMs ?? 120000);

  return new Promise((resolve, reject) => {
    let timeout = null;
    const child = spawnImpl(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finish(reject, Object.assign(error, { stdout, stderr }));
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(reject, Object.assign(new Error('yt-dlp timed out.'), {
          code: 'ETIMEDOUT',
          stdout,
          stderr,
          signal,
        }));
        return;
      }

      if (code === 0) {
        finish(resolve, { stdout, stderr, code, signal });
        return;
      }

      finish(reject, Object.assign(new Error(`yt-dlp exited with code ${code}.`), {
        code,
        stdout,
        stderr,
        signal,
      }));
    });

    timeout = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;
  }).catch((error) => {
    const classified = classifyYtdlpError(error);
    throw Object.assign(new Error(classified.message), classified, { cause: error });
  });
}

function parseJsonOutput(stdout, label) {
  const text = String(stdout ?? '').trim();
  if (!text) {
    throw Object.assign(new Error(`yt-dlp returned no ${label} output.`), {
      kind: 'invalid_json',
      stdout: '',
      stderr: '',
    });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw Object.assign(new Error(`yt-dlp returned invalid ${label} JSON.`), {
      kind: 'invalid_json',
      stdout: text,
      stderr: '',
      cause: error,
    });
  }
}

function normalizeMetadata(metadata, sourceUrl) {
  const raw = metadata && typeof metadata === 'object' ? metadata : {};
  const videoId = String(raw.id ?? '');
  const webpageUrl = String(raw.webpage_url ?? raw.original_url ?? sourceUrl ?? '');
  const mediaType = resolveMediaType(raw, webpageUrl || sourceUrl);
  return {
    ...raw,
    sourceUrl: String(sourceUrl),
    webpageUrl,
    videoId,
    uploader: String(raw.uploader ?? raw.channel ?? raw.creator ?? ''),
    title: String(raw.title ?? ''),
    mediaType,
  };
}

function normalizePlaylistEntry(entry, sourceUrl, index, defaults = {}) {
  const raw = entry && typeof entry === 'object' ? entry : {};
  const mediaType = resolveMediaType({ ...defaults, ...raw }, raw.webpage_url ?? raw.original_url ?? raw.url ?? sourceUrl);
  const videoId = String(raw.id ?? extractIdFromEntryUrl(raw.url) ?? '');
  const videoUrl = resolvePlaylistEntryUrl(raw, sourceUrl, mediaType, videoId);
  return {
    ...raw,
    id: videoId,
    position: index + 1,
    sourceUrl: String(sourceUrl),
    url: videoUrl,
    webpage_url: videoUrl,
    videoUrl,
    videoId,
    title: String(raw.title ?? ''),
    uploader: String(raw.uploader ?? raw.channel ?? raw.creator ?? ''),
    mediaType,
  };
}

function resolvePlaylistEntryUrl(entry = {}, sourceUrl = '', mediaType = '', videoId = '') {
  for (const value of [entry.webpage_url, entry.original_url, entry.url]) {
    const text = String(value ?? '');
    if (/^https?:\/\//i.test(text)) return text;
  }

  const username = String(
    entry.uploader
      ?? entry.channel
      ?? entry.creator
      ?? extractUsernameFromUrl(sourceUrl)
      ?? '',
  );
  if (username && videoId) {
    const kind = mediaType === 'story' ? 'story' : 'video';
    return `https://www.tiktok.com/@${username}/${kind}/${videoId}`;
  }

  return String(sourceUrl ?? '');
}

function extractUsernameFromUrl(sourceUrl = '') {
  const match = String(sourceUrl).match(/\/@([^/?#]+)/);
  return match?.[1] ?? '';
}

function extractIdFromEntryUrl(value = '') {
  const text = String(value ?? '');
  if (/^\d{10,}$/.test(text)) return text;
  return text.match(/(\d{10,})/g)?.at(-1) ?? '';
}

function normalizeSecUid(value = '') {
  const text = String(value ?? '').trim();
  return /^MS4wLjABAAAA[\w-]{64}$/.test(text) ? text : '';
}

function normalizeNumericId(value = '') {
  const text = String(value ?? '').trim();
  return /^\d{10,}$/.test(text) ? text : '';
}

function normalizeOptionalBoolean(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function normalizePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveMediaType(metadata = {}, sourceUrl = '') {
  const explicit = String(metadata.mediaType ?? metadata.media_type ?? metadata.type ?? '').toLowerCase();
  if (explicit.includes('story')) return 'story';
  if (explicit.includes('slideshow') || explicit.includes('photo')) return 'slideshow';
  const textUrl = String(sourceUrl ?? '').toLowerCase();
  if (/\/story(\/|$)/.test(textUrl)) return 'story';
  if (/\/photo(\/|$)/.test(textUrl)) return 'slideshow';
  return '';
}

function resolveProfileUrl(usernameOrUrl) {
  const text = String(usernameOrUrl ?? '');
  if (/^https?:\/\//i.test(text)) {
    const username = extractUsernameFromUrl(text);
    return username ? makeProfileUrl(username) : text;
  }
  return makeProfileUrl(text);
}

async function fetchProfileStoryIdentity(profileUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is not available for TikTok story lookup.');
  }

  const response = await fetchImpl(String(profileUrl), {
    redirect: 'follow',
    headers: {
      'user-agent': MOBILE_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!response?.ok) {
    throw new Error(`TikTok profile request failed with status ${response?.status ?? 'unknown'}.`);
  }

  let data;
  try {
    data = parseRehydrationJson(await response.text());
  } catch (error) {
    throw Object.assign(new Error('TikTok profile identity data was not found.'), {
      kind: 'story_profile_not_found',
      sourceUrl: String(profileUrl),
      cause: error,
    });
  }

  const user = findProfileUser(data);
  if (!user?.id) {
    throw Object.assign(new Error('TikTok profile identity data was not found.'), {
      kind: 'story_profile_not_found',
      sourceUrl: String(profileUrl),
    });
  }

  const username = String(user.uniqueId ?? extractUsernameFromUrl(profileUrl) ?? '');
  const storyStatus = numberOrNull(user.UserStoryStatus ?? user.userStoryStatus ?? user.storyStatus);
  return {
    profileUrl: String(response.url || profileUrl),
    userId: String(user.id),
    username,
    secUid: String(user.secUid ?? ''),
    hasStory: storyStatus === 0 ? false : storyStatus > 0 ? true : undefined,
  };
}

async function fetchStoryItemList(profile, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is not available for TikTok story lookup.');
  }

  const apiUrl = new URL('/api/story/item_list/', 'https://www.tiktok.com');
  apiUrl.searchParams.set('authorId', profile.userId);
  apiUrl.searchParams.set('cursor', '0');
  apiUrl.searchParams.set('loadBackward', 'false');
  apiUrl.searchParams.set('aid', '1988');
  apiUrl.searchParams.set('count', String(Number(options.limit ?? 4) || 4));

  const response = await fetchImpl(apiUrl.toString(), {
    redirect: 'follow',
    headers: {
      'user-agent': MOBILE_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'application/json,text/plain,*/*',
      referer: profile.profileUrl || makeProfileUrl(profile.username || ''),
    },
  });
  if (!response?.ok) {
    throw new Error(`TikTok story request failed with status ${response?.status ?? 'unknown'}.`);
  }

  const payload = await response.json();
  const statusCode = numberOrNull(payload?.statusCode ?? payload?.status_code ?? 0) ?? 0;
  if (statusCode !== 0) {
    throw Object.assign(new Error(String(payload?.statusMsg ?? payload?.status_msg ?? 'TikTok story request failed.')), {
      kind: 'story_lookup_failed',
      statusCode,
    });
  }
  return payload;
}

function normalizeStoryEntry(item, profile = {}, index = 0) {
  const raw = item && typeof item === 'object' ? item : {};
  const video = raw.video && typeof raw.video === 'object' ? raw.video : {};
  const id = String(raw.id ?? video.id ?? video.videoID ?? '');
  const username = String(raw.author?.uniqueId ?? profile.username ?? '');
  const storyPageUrl = username && id ? `https://www.tiktok.com/@${username}/story/${id}` : String(profile.sourceUrl ?? '');
  const directVideoUrl = firstString(
    video.playAddr,
    video.downloadAddr,
    video.PlayAddrStruct?.UrlList,
    video.PlayAddrStruct?.urlList,
    video.bitRateInfo?.map((entry) => entry?.PlayAddr?.UrlList ?? entry?.PlayAddr?.urlList),
  );
  const dataSize = numberOrNull(video.PlayAddrStruct?.DataSize ?? video.size ?? video.dataSize) ?? 0;
  return {
    id,
    position: index + 1,
    sourceUrl: String(profile.sourceUrl ?? storyPageUrl),
    url: storyPageUrl,
    webpage_url: storyPageUrl,
    videoUrl: storyPageUrl,
    videoId: id,
    title: String(raw.desc || (id ? `Story ${id}` : 'Story')),
    description: String(raw.desc ?? ''),
    uploader: username,
    username,
    mediaType: 'story',
    directVideoUrl,
    timestamp: numberOrNull(raw.createTime) ?? 0,
    duration: numberOrNull(video.duration) ?? 0,
    thumbnail: firstString(video.cover, video.dynamicCover, video.originCover) || '',
    filesizeApprox: dataSize,
    storyExpiresAt: numberOrNull(raw.story?.ExpiredAt ?? raw.story?.expiredAt) ?? 0,
  };
}

function firstString(...values) {
  for (const value of values) {
    const text = firstStringValue(value);
    if (text) return text;
  }
  return '';
}

function firstStringValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = firstStringValue(entry);
      if (text) return text;
    }
  }
  if (value && typeof value === 'object') {
    return firstStringValue(value.UrlList ?? value.urlList ?? value.urls ?? value.url);
  }
  return '';
}

async function downloadPhotoPost(sourceUrl, metadata, tempDir, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is not available for TikTok photo fallback.');
  }

  const normalized = normalizeMetadata(metadata, sourceUrl);
  const imageEntries = [];
  for (const [index, imageUrl] of metadata.imageUrls.entries()) {
    const image = await fetchImage(imageUrl, fetchImpl);
    const filename = `${String(index + 1).padStart(3, '0')}.${image.extension}`;
    imageEntries.push({
      name: filename,
      data: image.data,
    });
  }

  const videoId = normalized.videoId || normalized.id || 'slideshow';
  const zipFilename = makeSlideshowZipFilename(normalized);
  const zipBase = path.basename(zipFilename, '.zip');
  const zipPath = path.join(tempDir, zipFilename);
  const infoJson = `${videoId}.info.json`;
  const descriptionFile = `${videoId}.description`;
  const galleryImageEntries = options.keepSlideshowImages && imageEntries.length <= 10
    ? imageEntries.map((entry) => ({
        ...entry,
        name: `${zipBase}__${entry.name}`,
      }))
    : [];
  const manifest = {
    id: videoId,
    sourceUrl: String(sourceUrl),
    title: normalized.title,
    uploader: normalized.uploader,
    imageCount: imageEntries.length,
    images: imageEntries.map((entry) => entry.name),
  };

  await createZipFile(zipPath, [
    ...imageEntries,
    {
      name: infoJson,
      data: Buffer.from(JSON.stringify({ ...metadata, imageUrls: metadata.imageUrls }, null, 2)),
    },
    {
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2)),
    },
    ...(normalized.description ? [{
      name: descriptionFile,
      data: Buffer.from(String(normalized.description)),
    }] : []),
  ]);
  await writeFile(path.join(tempDir, infoJson), JSON.stringify(metadata, null, 2));
  if (normalized.description) {
    await writeFile(path.join(tempDir, descriptionFile), String(normalized.description));
  }
  for (const entry of galleryImageEntries) {
    await writeFile(path.join(tempDir, entry.name), entry.data);
  }

  let downloadDir = tempDir;
  let files = await collectFiles(tempDir);
  if (options.downloadDir) {
    const layout = makeDownloadLayout({ downloadDir: options.downloadDir }, normalized);
    downloadDir = layout.dir;
    files = await moveDirectoryContents(tempDir, downloadDir);
  }

  const primaryFile = pickPrimaryFile(files);
  const galleryImageNames = new Set(galleryImageEntries.map((entry) => entry.name));
  const slideshowImagePaths = files
    .filter((file) => galleryImageNames.has(path.basename(file)))
    .sort();
  const sizeBytes = primaryFile ? await fileSize(primaryFile) : 0;
  return {
    sourceUrl: String(sourceUrl),
    metadata: normalized,
    downloadDir,
    files,
    primaryFile,
    filePath: primaryFile,
    filename: primaryFile ? path.basename(primaryFile) : '',
    sizeBytes,
    videoId,
    username: normalized.uploader || '',
    title: normalized.title || '',
    description: normalized.description || '',
    thumbnailUrl: normalized.thumbnail || '',
    mediaType: 'slideshow',
    imageCount: imageEntries.length,
    slideshowImagePaths,
    duration: 0,
    stdout: '',
    stderr: '',
  };
}

async function downloadStoryPost(sourceUrl, metadata, tempDir, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is not available for TikTok story download.');
  }

  const normalized = normalizeMetadata(metadata, sourceUrl);
  const directVideoUrl = firstString(
    metadata.directVideoUrl,
    metadata.playAddr,
    metadata.downloadAddr,
    metadata.video?.playAddr,
    metadata.video?.downloadAddr,
    metadata.video?.PlayAddrStruct?.UrlList,
  );
  if (!directVideoUrl) {
    throw Object.assign(new Error('TikTok story did not include a downloadable video URL.'), {
      kind: 'story_video_url_not_found',
      sourceUrl: String(sourceUrl),
    });
  }

  const response = await fetchImpl(directVideoUrl, {
    redirect: 'follow',
    headers: {
      'user-agent': MOBILE_USER_AGENT,
      accept: 'video/mp4,video/*,*/*',
      referer: normalized.webpageUrl || String(sourceUrl),
    },
  });
  if (!response?.ok) {
    throw new Error(`TikTok story video request failed with status ${response?.status ?? 'unknown'}.`);
  }

  const videoId = normalized.videoId || normalized.id || 'story';
  const contentType = String(response.headers?.get?.('content-type') ?? '');
  const extension = extensionFromVideoContentType(contentType) || extensionFromVideoUrl(response.url || directVideoUrl) || 'mp4';
  const videoPath = path.join(tempDir, `${slugify(videoId, 'story')}.${extension}`);
  const infoJson = `${videoId}.info.json`;
  const descriptionFile = `${videoId}.description`;
  await writeFile(videoPath, Buffer.from(await response.arrayBuffer()));
  await writeFile(path.join(tempDir, infoJson), JSON.stringify(metadata, null, 2));
  if (normalized.description) {
    await writeFile(path.join(tempDir, descriptionFile), String(normalized.description));
  }

  let downloadDir = tempDir;
  let files = await collectFiles(tempDir);
  if (options.downloadDir) {
    const layout = makeDownloadLayout({ downloadDir: options.downloadDir }, normalized);
    downloadDir = layout.dir;
    files = await moveDirectoryContents(tempDir, downloadDir);
  }

  const primaryFile = pickPrimaryVideo(files) || pickPrimaryFile(files);
  const sizeBytes = primaryFile ? await fileSize(primaryFile) : 0;
  return {
    sourceUrl: String(sourceUrl),
    metadata: normalized,
    downloadDir,
    files,
    primaryFile,
    filePath: primaryFile,
    filename: primaryFile ? path.basename(primaryFile) : '',
    sizeBytes,
    videoId,
    username: normalized.uploader || '',
    title: normalized.title || '',
    description: normalized.description || '',
    thumbnailUrl: normalized.thumbnail || '',
    mediaType: 'story',
    duration: numberOrNull(normalized.duration) ?? 0,
    stdout: '',
    stderr: '',
  };
}

function makeSlideshowZipFilename(metadata) {
  const videoId = slugify(metadata.videoId || metadata.id || 'slideshow', 'slideshow');
  const username = slugify(metadata.uploader || metadata.channel || metadata.creator || metadata.username || 'unknown', 'unknown');
  const timestamp = metadata.timestamp
    ? new Date(Number(metadata.timestamp) * 1000)
    : parseUploadDate(metadata.upload_date) ?? new Date();
  const stamp = timestamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}__${username}__${videoId}.zip`;
}

function parseUploadDate(value) {
  const text = String(value ?? '');
  if (!/^\d{8}$/.test(text)) return null;
  const yyyy = Number(text.slice(0, 4));
  const mm = Number(text.slice(4, 6));
  const dd = Number(text.slice(6, 8));
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath));
      continue;
    }
    if (entry.isFile()) files.push(entryPath);
  }
  files.sort();
  return files;
}

async function ensureTempDir(dir) {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error(`Output path is not a directory: ${dir}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      await mkdir(dir, { recursive: true });
      return;
    }
    throw error;
  }
}

async function makeTempDownloadDir(parentDir) {
  await ensureTempDir(parentDir);
  return mkdtemp(path.join(parentDir, 'tiktok-ytdlp-'));
}

function pickPrimaryFile(files) {
  return files.find((entry) => /\.mp4$/i.test(entry))
    ?? files.find((entry) => /\.(webm|mov|mkv|m4v)$/i.test(entry))
    ?? files.find((entry) => /\.zip$/i.test(entry))
    ?? files.find((entry) => /\.(jpe?g|png|webp|gif|heic)$/i.test(entry))
    ?? files[0]
    ?? '';
}

function replaceArgValue(args, flag, value) {
  const index = args.indexOf(flag);
  if (index >= 0) args[index + 1] = value;
}

function makeClassification(kind, message, retryable, exitCode, signal, stdout, stderr) {
  return {
    kind,
    message,
    retryable,
    exitCode,
    signal,
    stdout,
    stderr,
  };
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldTryPhotoFallback(sourceUrl, error, options = {}) {
  if (options.disablePhotoFallback) return false;
  if (!isTikTokUrl(sourceUrl)) return false;
  const kind = String(error?.kind ?? '');
  const text = `${error?.message ?? ''}\n${error?.stderr ?? ''}\n${error?.stdout ?? ''}`.toLowerCase();
  return kind === 'invalid_url'
    || kind === 'no_formats'
    || /\/photo\/|unsupported url|no video formats found|requested format is not available/.test(text);
}

function isPhotoPostMetadata(metadata) {
  return metadata?.mediaType === 'slideshow'
    && Array.isArray(metadata?.imageUrls)
    && metadata.imageUrls.length > 0;
}

function isStoryMetadata(metadata) {
  return resolveMediaType(metadata, metadata?.webpage_url ?? metadata?.webpageUrl ?? metadata?.url ?? '') === 'story'
    && Boolean(firstString(
      metadata?.directVideoUrl,
      metadata?.playAddr,
      metadata?.downloadAddr,
      metadata?.video?.playAddr,
      metadata?.video?.downloadAddr,
      metadata?.video?.PlayAddrStruct?.UrlList,
    ));
}

function parseRehydrationJson(html) {
  const text = String(html);
  const scriptMatch = text.match(/<script[^>]+id=["'](?:__UNIVERSAL_DATA_FOR_REHYDRATION__|SIGI_STATE)["'][^>]*>([\s\S]*?)<\/script>/i);
  if (scriptMatch) {
    return JSON.parse(scriptMatch[1]);
  }

  const marker = 'id="__UNIVERSAL_DATA_FOR_REHYDRATION__"';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    throw Object.assign(new Error('TikTok rehydration data was not found.'), {
      kind: 'photo_metadata_not_found',
      stdout: '',
      stderr: '',
    });
  }

  const contentStart = text.indexOf('>', markerIndex);
  const contentEnd = text.indexOf('</script>', contentStart);
  if (contentStart < 0 || contentEnd < 0) {
    throw Object.assign(new Error('TikTok rehydration data was malformed.'), {
      kind: 'photo_metadata_not_found',
      stdout: '',
      stderr: '',
    });
  }

  return JSON.parse(text.slice(contentStart + 1, contentEnd));
}

function findPhotoItem(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findPhotoItem(entry);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value.imagePost?.images)) return value;
  for (const entry of Object.values(value)) {
    const found = findPhotoItem(entry);
    if (found) return found;
  }
  return null;
}

function findProfileUser(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findProfileUser(entry);
      if (found) return found;
    }
    return null;
  }

  const scoped = value.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user;
  if (scoped?.id && scoped?.uniqueId) return scoped;

  const userInfo = value.userInfo?.user;
  if (userInfo?.id && userInfo?.uniqueId) return userInfo;

  if (value.id && value.uniqueId && value.secUid) return value;

  for (const entry of Object.values(value)) {
    const found = findProfileUser(entry);
    if (found) return found;
  }
  return null;
}

async function fetchImage(url, fetchImpl) {
  const response = await fetchImpl(String(url), {
    redirect: 'follow',
    headers: {
      'user-agent': MOBILE_USER_AGENT,
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });
  if (!response?.ok) {
    throw new Error(`TikTok image request failed with status ${response?.status ?? 'unknown'}.`);
  }
  const contentType = String(response.headers?.get?.('content-type') ?? '');
  return {
    data: Buffer.from(await response.arrayBuffer()),
    extension: extensionFromContentType(contentType) || extensionFromUrl(response.url || url) || 'jpg',
  };
}

function extensionFromContentType(contentType) {
  if (/png/i.test(contentType)) return 'png';
  if (/webp/i.test(contentType)) return 'webp';
  if (/gif/i.test(contentType)) return 'gif';
  if (/heic|heif/i.test(contentType)) return 'heic';
  if (/jpe?g/i.test(contentType)) return 'jpg';
  return '';
}

function extensionFromVideoContentType(contentType) {
  if (/mp4|mpeg4/i.test(contentType)) return 'mp4';
  if (/webm/i.test(contentType)) return 'webm';
  if (/quicktime|mov/i.test(contentType)) return 'mov';
  if (/matroska|mkv/i.test(contentType)) return 'mkv';
  return '';
}

function extensionFromUrl(url) {
  const pathname = new URL(String(url)).pathname;
  const extension = path.extname(pathname).replace(/^\./, '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(extension)) {
    return extension === 'jpeg' ? 'jpg' : extension;
  }
  return '';
}

function extensionFromVideoUrl(url) {
  try {
    const pathname = new URL(String(url)).pathname;
    const extension = path.extname(pathname).replace(/^\./, '').toLowerCase();
    if (['mp4', 'webm', 'mov', 'mkv', 'm4v'].includes(extension)) return extension;
  } catch {
    return '';
  }
  return '';
}

function makePhotoUrl(username, id) {
  return username && id ? `https://www.tiktok.com/@${username}/photo/${id}` : '';
}

async function createZipFile(zipPath, entries) {
  const now = new Date();
  const centralDirectory = [];
  const chunks = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const name = Buffer.from(entry.name);
    const crc = crc32(data);
    const localHeader = makeZipLocalHeader({ name, data, crc, date: now });
    chunks.push(localHeader, data);
    centralDirectory.push(makeZipCentralDirectoryHeader({ name, data, crc, date: now, offset }));
    offset += localHeader.length + data.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectoryBuffer = Buffer.concat(centralDirectory);
  const endRecord = makeZipEndRecord(entries.length, centralDirectoryBuffer.length, centralDirectoryOffset);
  await writeFile(zipPath, Buffer.concat([...chunks, centralDirectoryBuffer, endRecord]));
}

function makeZipLocalHeader({ name, data, crc, date }) {
  const buffer = Buffer.alloc(30 + name.length);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(0x0800, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(zipTime(date), 10);
  buffer.writeUInt16LE(zipDate(date), 12);
  buffer.writeUInt32LE(crc, 14);
  buffer.writeUInt32LE(data.length, 18);
  buffer.writeUInt32LE(data.length, 22);
  buffer.writeUInt16LE(name.length, 26);
  buffer.writeUInt16LE(0, 28);
  name.copy(buffer, 30);
  return buffer;
}

function makeZipCentralDirectoryHeader({ name, data, crc, date, offset }) {
  const buffer = Buffer.alloc(46 + name.length);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(20, 6);
  buffer.writeUInt16LE(0x0800, 8);
  buffer.writeUInt16LE(0, 10);
  buffer.writeUInt16LE(zipTime(date), 12);
  buffer.writeUInt16LE(zipDate(date), 14);
  buffer.writeUInt32LE(crc, 16);
  buffer.writeUInt32LE(data.length, 20);
  buffer.writeUInt32LE(data.length, 24);
  buffer.writeUInt16LE(name.length, 28);
  buffer.writeUInt16LE(0, 30);
  buffer.writeUInt16LE(0, 32);
  buffer.writeUInt16LE(0, 34);
  buffer.writeUInt16LE(0, 36);
  buffer.writeUInt32LE(0, 38);
  buffer.writeUInt32LE(offset, 42);
  name.copy(buffer, 46);
  return buffer;
}

function makeZipEndRecord(entryCount, centralDirectorySize, centralDirectoryOffset) {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x06054b50, 0);
  buffer.writeUInt16LE(0, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(entryCount, 8);
  buffer.writeUInt16LE(entryCount, 10);
  buffer.writeUInt32LE(centralDirectorySize, 12);
  buffer.writeUInt32LE(centralDirectoryOffset, 16);
  buffer.writeUInt16LE(0, 20);
  return buffer;
}

function zipDate(date) {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

function zipTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});
