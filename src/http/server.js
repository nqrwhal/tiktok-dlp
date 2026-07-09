import http from 'node:http';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

export function createHttpHandler({ config, store }) {
  assertServerDeps(config, store);

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
        return sendJson(res, 200, buildHealthPayload(config, store), { head: req.method === 'HEAD' });
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const token = matchFileToken(url.pathname);
        if (token) {
          return handleFileRequest(req, res, { config, store, token });
        }
      }

      return sendJson(res, 404, { error: 'Not found' }, { head: req.method === 'HEAD' });
    } catch (error) {
      return sendJson(res, 500, {
        error: 'Internal server error',
      }, { head: req.method === 'HEAD' });
    }
  };
}

export async function startHttpServer({ config, store, host = '0.0.0.0', port = config?.httpPort } = {}) {
  assertServerDeps(config, store);

  const server = http.createServer(createHttpHandler({ config, store }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    address: server.address(),
  };
}

export async function handleFileRequest(req, res, { config, store, token, now = Date.now() }) {
  const record = store.getValidToken(token, now);
  if (!record) {
    return sendJson(res, 404, { error: 'File not found' });
  }

  const filePath = resolveDownloadPath(config.downloadDir, record.path);
  if (!filePath) {
    return sendJson(res, 404, { error: 'File not found' });
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      return sendJson(res, 404, { error: 'File not found' });
    }

    const filename = record.filename || path.basename(filePath);
    const range = parseRangeHeader(req.headers.range, fileStats.size);
    if (range?.invalid) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileStats.size}`,
      });
      res.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? fileStats.size - 1;
    const contentLength = end - start + 1;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(contentLength),
      'Content-Disposition': `attachment; filename="${escapeContentDisposition(filename)}"`,
      'Accept-Ranges': 'bytes',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${fileStats.size}`;
    res.writeHead(range ? 206 : 200, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    await pipeline(createReadStream(filePath, { start, end }), res);
  } catch (error) {
    if (!res.headersSent) {
      return sendJson(res, error?.code === 'ENOENT' ? 404 : 500, {
        error: error?.code === 'ENOENT' ? 'File not found' : 'Internal server error',
      }, { head: req.method === 'HEAD' });
    }
    res.destroy(error);
  }
}

export function resolveDownloadPath(downloadDir, filePath) {
  const resolvedDownloadDir = path.resolve(downloadDir);
  const resolvedFilePath = path.resolve(resolvedDownloadDir, String(filePath ?? ''));
  const relative = path.relative(resolvedDownloadDir, resolvedFilePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolvedFilePath;
}

export function buildHealthPayload(config, store) {
  return {
    status: 'ok',
  };
}

export function parseRangeHeader(header, size) {
  const value = String(header ?? '').trim();
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || !size) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { invalid: true };
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return { invalid: true };
  }
  return { start, end: Math.min(size - 1, requestedEnd) };
}

export function matchFileToken(pathname) {
  const match = pathname.match(/^\/files\/([^/]+)$/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

export function sendJson(res, statusCode, payload, { head = false } = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

function escapeContentDisposition(filename) {
  return String(filename).replace(/["\\\r\n]/g, '_');
}

function assertServerDeps(config, store) {
  if (!config?.downloadDir) {
    throw new Error('config.downloadDir is required');
  }
  if (!store || typeof store.getValidToken !== 'function') {
    throw new Error('store must provide getValidToken()');
  }
}
