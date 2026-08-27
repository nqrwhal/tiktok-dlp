import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  assertCookiesFileConfigured,
  cookieHeaderForUrl,
  parseNetscapeCookies,
  resolvedCookiesFile,
} from '../src/tiktok/cookies.js';
import { loadConfig, validateRuntimeConfig } from '../src/config.js';

const NETSCAPE = [
  '# Netscape HTTP Cookie File',
  '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\ttest-session',
  '.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsid_tt\ttest-sid',
  '.example.com\tTRUE\t/\tFALSE\t2147483647\tunrelated\tleave-me-out',
].join('\n');

test('resolvedCookiesFile prefers cookiesFile over ytdlpCookiesFile', () => {
  assert.equal(resolvedCookiesFile({}), '');
  assert.equal(resolvedCookiesFile({ ytdlpCookiesFile: '/app/cookies/tiktok.txt' }), '/app/cookies/tiktok.txt');
  assert.equal(resolvedCookiesFile({
    cookiesFile: '/tmp/override.txt',
    ytdlpCookiesFile: '/app/cookies/tiktok.txt',
  }), '/tmp/override.txt');
});

test('parseNetscapeCookies reads Netscape rows and domain-matches TikTok hosts', () => {
  const cookies = parseNetscapeCookies(`#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid_ss\thttp-only-session\n${NETSCAPE}`);
  assert.equal(cookies.find((cookie) => cookie.name === 'sessionid')?.value, 'test-session');
  assert.equal(cookies.find((cookie) => cookie.name === 'sessionid_ss')?.value, 'http-only-session');

  const header = cookieHeaderForUrl(cookies, 'https://www.tiktok.com/@creator/photo/1');
  assert.match(header, /sessionid=test-session/);
  assert.match(header, /sid_tt=test-sid/);
  assert.doesNotMatch(header, /unrelated=/);

  const cdnHeader = cookieHeaderForUrl(cookies, 'https://v16-webapp.tiktokcdn.com/story.mp4');
  assert.match(cdnHeader, /sessionid=test-session/);
  assert.doesNotMatch(cdnHeader, /unrelated=/);

  const fallbackCdn = cookieHeaderForUrl(cookies, 'https://cdn.example.test/story.mp4', { includeTikTokSession: true });
  assert.match(fallbackCdn, /sessionid=test-session/);

  assert.equal(cookieHeaderForUrl(cookies, 'https://cdn.example.test/image.jpg'), '');
});

test('assertCookiesFileConfigured fails closed when the env path is missing or empty', async () => {
  assert.throws(
    () => assertCookiesFileConfigured('/tmp/tiktok-dlp-missing-cookies.txt'),
    /missing or unreadable/,
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-cookies-empty-'));
  const emptyFile = path.join(dir, 'tiktok.txt');
  await writeFile(emptyFile, '# Netscape HTTP Cookie File\n');
  assert.throws(
    () => assertCookiesFileConfigured(emptyFile),
    /did not contain any Netscape cookies/,
  );

  const validFile = path.join(dir, 'valid.txt');
  await writeFile(validFile, NETSCAPE);
  assertCookiesFileConfigured(validFile);

  const config = loadConfig({ YTDLP_COOKIES_FILE: './missing.txt' }, dir);
  assert.throws(
    () => validateRuntimeConfig(config, { requireDiscord: false }),
    /missing or unreadable/,
  );
});
