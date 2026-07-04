import { spawn as defaultSpawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileSize, makeDownloadLayout, moveDirectoryContents, pickPrimaryVideo, profileUrl as makeProfileUrl } from '../util/files.js';

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

export function buildMetadataArgs(sourceUrl, options = {}) {
  const args = [...METADATA_BASE_ARGS];
  if (options.flatPlaylist) args.push('--flat-playlist');
  if (options.playlist === true || options.flatPlaylist) args.push('--yes-playlist');
  else args.push('--no-playlist');
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
  const { stdout } = await runYtDlp(options.ytdlpPath ?? 'yt-dlp', buildMetadataArgs(sourceUrl, options), options);
  return parseJsonOutput(stdout, 'metadata');
}

export async function listProfileVideos(usernameOrUrl, options = {}) {
  const sourceUrl = String(usernameOrUrl).startsWith('http') ? String(usernameOrUrl) : makeProfileUrl(usernameOrUrl);
  const raw = await fetchVideoMetadata(sourceUrl, {
    ...options,
    playlist: true,
    flatPlaylist: true,
  });

  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((entry, index) => normalizePlaylistEntry(entry, sourceUrl, index))
    : [];

  return {
    sourceUrl: String(sourceUrl),
    count: entries.length,
    metadata: normalizeMetadata(raw, sourceUrl),
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

  const { stdout, stderr } = await runYtDlp(ytdlpPath, buildDownloadArgs(sourceUrl, {
    ...options,
    outputDir: tempDir,
  }), options);

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
    stdout,
    stderr,
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
  return {
    ...raw,
    sourceUrl: String(sourceUrl),
    webpageUrl,
    videoId,
    uploader: String(raw.uploader ?? raw.channel ?? raw.creator ?? ''),
    title: String(raw.title ?? ''),
  };
}

function normalizePlaylistEntry(entry, sourceUrl, index) {
  const raw = entry && typeof entry === 'object' ? entry : {};
  const videoUrl = String(raw.webpage_url ?? raw.original_url ?? raw.url ?? sourceUrl ?? '');
  return {
    ...raw,
    id: String(raw.id ?? ''),
    position: index + 1,
    sourceUrl: String(sourceUrl),
    url: videoUrl,
    webpage_url: videoUrl,
    videoUrl,
    videoId: String(raw.id ?? ''),
    title: String(raw.title ?? ''),
    uploader: String(raw.uploader ?? raw.channel ?? raw.creator ?? ''),
  };
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
