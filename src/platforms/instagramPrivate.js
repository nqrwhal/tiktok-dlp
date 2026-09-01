import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

function galleryDlError(kind, message, details = {}) {
  return Object.assign(new Error(message), {
    kind,
    retryable: Boolean(details.retryable),
    code: details.code ?? null,
    signal: details.signal ?? null,
    stderr: String(details.stderr ?? ''),
    ...(details.cause ? { cause: details.cause } : {}),
  });
}

function classifyPrivateFailure(message, details = {}) {
  const text = String(message ?? '').toLowerCase();
  let kind = 'private_error';
  let retryable = false;
  if (/429|too many requests|rate.?limit|throttled/.test(text)) {
    kind = 'rate_limited';
    retryable = true;
  } else if (/not found|does not exist|404|user not found/.test(text)) {
    kind = 'not_found';
  } else if (/login|required|auth|cookie|private|permission|challenge|forbidden|401|403/.test(text)) {
    kind = 'access_denied';
  } else if (/timed? out|timeout/.test(text)) {
    kind = 'timeout';
    retryable = true;
  }
  return galleryDlError(kind, message || 'Instagram private API failed.', { ...details, retryable, stderr: String(message).slice(0, 4096) });
}

export async function listPrivatePosts(handle, options = {}) {
  return runPrivateList(handle, 'posts', options);
}

export async function listPrivateStories(handle, options = {}) {
  return runPrivateList(handle, 'stories', options);
}

export async function listPrivateHighlights(handle, options = {}) {
  return runPrivateList(handle, 'highlights', options);
}

async function runPrivateList(handle, type, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 5));
  const cookiesFile = String(options.instagramCookiesFile ?? options.config?.instagramCookiesFile ?? '').trim()
    || String(process.env.INSTAGRAM_COOKIES_FILE ?? '').trim()
    || '/app/cookies/instagram.txt';
  const timeoutMs = Number(options.galleryDlTimeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/instagram-private-list.py');
  const args = [
    scriptPath,
    '--handle', String(handle),
    '--type', type,
    '--limit', String(limit),
    '--cookies', cookiesFile,
  ];

  const stdout = await runPython(args, { spawnImpl, timeoutMs, signal: options.signal ?? null });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw galleryDlError('invalid_output', 'Instagram private API returned invalid JSON.', { retryable: false, cause });
  }
  if (parsed && typeof parsed.error === 'string') {
    throw classifyPrivateFailure(parsed.error, { kind: parsed.kind });
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw galleryDlError('invalid_output', 'Instagram private API returned unexpected shape.');
  }
  // Normalize to the same shape gallery-dl parsers return: { sourceUrl, count, metadata, entries }
  // The Python script already returns that shape, so just ensure fields
  return {
    sourceUrl: String(parsed.sourceUrl ?? `https://www.instagram.com/${handle}/${type}/`),
    count: Number(parsed.count ?? parsed.entries.length) || parsed.entries.length,
    metadata: parsed.metadata ?? {},
    entries: parsed.entries,
  };
}

async function runPython(args, { spawnImpl, timeoutMs, signal }) {
  if (signal?.aborted) throw galleryDlError('aborted', 'Instagram private list was aborted.');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('python3', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        shell: false,
        windowsHide: true,
      });
    } catch (cause) {
      reject(galleryDlError('spawn_failed', 'Failed to spawn Instagram private helper.', { cause }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeout = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      if (err) reject(err);
      else resolve(result);
    };
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch {}
      finish(galleryDlError('aborted', 'Instagram private list was aborted.'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => {
      const s = String(chunk);
      stdoutBytes += Buffer.byteLength(s);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        try { child.kill('SIGKILL'); } catch {}
        finish(galleryDlError('output_limit', 'Private API output exceeded limit.'));
        return;
      }
      stdout += s;
    });
    child.stderr?.on?.('data', (chunk) => {
      const s = String(chunk);
      stderrBytes += Buffer.byteLength(s);
      if (stderrBytes > 512 * 1024) {
        try { child.kill('SIGKILL'); } catch {}
        finish(galleryDlError('output_limit', 'Private API error output exceeded limit.'));
        return;
      }
      stderr += s;
    });
    child.on?.('error', (cause) => finish(galleryDlError('spawn_failed', 'Instagram private helper failed to start.', { cause })));
    child.on?.('close', (code, sig) => {
      if (stdoutBytes > MAX_STDOUT_BYTES || stderrBytes > 512 * 1024) return;
      if (code === 0) {
        finish(null, stdout);
      } else {
        const msg = stderr.trim() || `python exited with code ${code}`;
        // Try to parse JSON error from stdout even on non-zero
        try {
          const maybe = JSON.parse(stdout);
          if (maybe && typeof maybe.error === 'string') {
            finish(classifyPrivateFailure(maybe.error, { kind: maybe.kind, code, signal: sig, stderr }));
            return;
          }
        } catch {}
        finish(classifyPrivateFailure(msg, { code, signal: sig, stderr }));
      }
    });

    timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(galleryDlError('timeout', 'Instagram private list timed out.', { retryable: true }));
    }, Math.max(5000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    timeout.unref?.();
  });
}
