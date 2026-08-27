#!/usr/bin/env node
// Resolve a TikTok photo/slideshow post (including follower-only posts the
// cookie account can open) into downloadable image URLs.
//
//   node src/tiktok/photo-resolve-cli.js --cookies /app/data/tiktok-cookies.txt \
//     --proxy http://gluetun:8888 --id 7636317293982649631
//   node src/tiktok/photo-resolve-cli.js --cookies ... --url https://www.tiktok.com/@user/photo/123
//
// Prints the resolver contract JSON on stdout. Exits 0 when ok is true.
// Never logs or echoes cookie values.
import { resolvePhotoPost } from './photoResolver.js';

function usage(error = '') {
  const lines = [
    'Usage: tiktok-photo-resolve [--cookies FILE] [--proxy URL] (--id ID | --url URL)',
    '',
    'Options:',
    '  --cookies FILE   Netscape cookie jar for the TikTok session (default: YTDLP_COOKIES_FILE)',
    '  --proxy URL      HTTP proxy for TikTok requests (default: YTDLP_PROXY)',
    '  --id ID          TikTok aweme id',
    '  --url URL        TikTok post URL (/video/{id} or /photo/{id})',
    '  --username NAME  Optional handle hint when only an id is known',
    '  --timeout SECS   Per-request timeout (default 30)',
    '  --max-images N   Cap the images array at N entries (default: all)',
    '  --pretty         Pretty-print the JSON output',
  ];
  if (error) lines.unshift(`Error: ${error}`, '');
  return lines.join('\n');
}

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex >= 0) {
      flags.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) flags.set(name, 'true');
    else {
      flags.set(name, next);
      index += 1;
    }
  }
  return { flags, positional };
}

const { flags } = parseArgs(process.argv.slice(2));
const cookiesFile = String(flags.get('cookies') ?? flags.get('cookies-file') ?? process.env.YTDLP_COOKIES_FILE ?? '');
const proxy = String(flags.get('proxy') ?? process.env.YTDLP_PROXY ?? '');
const awemeId = String(flags.get('id') ?? '');
const url = String(flags.get('url') ?? '');
const usernameHint = String(flags.get('username') ?? '');
const timeoutSeconds = Number(flags.get('timeout') ?? 0);
const maxImages = Number(flags.get('max-images') ?? 0);

if (flags.has('help') || flags.has('h')) {
  console.log(usage());
  process.exit(0);
}
if (!awemeId && !url) {
  console.error(usage('Either --id or --url is required.'));
  process.exit(2);
}

try {
  const result = await resolvePhotoPost(
    { url, awemeId, username: usernameHint },
    {
      ...(cookiesFile ? { cookiesFile } : {}),
      ...(proxy ? { proxy } : {}),
      ...(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? { fetchTimeoutSeconds: timeoutSeconds } : {}),
    },
  );
  if (result.ok && Number.isFinite(maxImages) && maxImages > 0 && result.images.length > maxImages) {
    result.images = result.images.slice(0, maxImages);
  }
  const output = flags.has('pretty')
    ? JSON.stringify(result, null, 2)
    : JSON.stringify(result);
  console.log(output);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: 'resolver_error',
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
