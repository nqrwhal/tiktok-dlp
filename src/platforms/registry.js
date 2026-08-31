import { normalizePlatform } from './references.js';

const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
export const PLATFORM_ADAPTER_OPERATIONS = Object.freeze([
  'probe',
  'download',
  'listCreatorPosts',
  'listCreatorStories',
  'checkAvailability',
]);

export function parseCredentialFreeHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url;
}

export function definePlatformAdapter(spec = {}) {
  const platform = normalizePlatform(spec.platform);
  const displayName = String(spec.displayName ?? platform).trim();
  const hosts = normalizeHosts(spec.hosts);
  const canonicalHost = String(spec.canonicalHost ?? '').trim().toLowerCase();

  if (!displayName) throw new Error(`The ${platform} adapter requires a display name.`);
  if (!hosts.includes(canonicalHost)) {
    throw new Error(`The ${platform} adapter canonical host must be one of its exact hosts.`);
  }
  for (const method of ['canonicalizeUrl', 'parsePostReference', 'parseProfileReference']) {
    if (typeof spec[method] !== 'function') {
      throw new Error(`The ${platform} adapter requires ${method}().`);
    }
  }
  for (const method of PLATFORM_ADAPTER_OPERATIONS) {
    if (spec[method] != null && typeof spec[method] !== 'function') {
      throw new Error(`The ${platform} adapter ${method} operation must be a function.`);
    }
  }

  return Object.freeze({
    platform,
    displayName,
    hosts,
    canonicalHost,
    capabilities: Object.freeze({ ...(spec.capabilities ?? {}) }),
    canonicalizeUrl: spec.canonicalizeUrl,
    parsePostReference: spec.parsePostReference,
    parseProfileReference: spec.parseProfileReference,
    ...Object.fromEntries(PLATFORM_ADAPTER_OPERATIONS.map((method) => [method, spec[method] ?? null])),
  });
}

export function createPlatformRegistry(adapters = []) {
  const byPlatform = new Map();
  const byHost = new Map();

  for (const candidate of adapters) {
    const adapter = definePlatformAdapter(candidate);
    if (byPlatform.has(adapter.platform)) {
      throw new Error(`Duplicate platform adapter: ${adapter.platform}.`);
    }
    for (const host of adapter.hosts) {
      if (byHost.has(host)) {
        throw new Error(`Platform host ${host} is registered more than once.`);
      }
      byHost.set(host, adapter);
    }
    byPlatform.set(adapter.platform, adapter);
  }

  const list = Object.freeze([...byPlatform.values()]);
  const forUrl = (value) => {
    const url = parseCredentialFreeHttpsUrl(value);
    if (!url) return null;
    const adapter = byHost.get(url.hostname.toLowerCase());
    return adapter ? Object.freeze({ adapter, url }) : null;
  };

  return Object.freeze({
    list() {
      return list;
    },
    get(platform) {
      try {
        return byPlatform.get(normalizePlatform(platform)) ?? null;
      } catch {
        return null;
      }
    },
    forUrl,
    canonicalizeUrl(value) {
      const match = forUrl(value);
      if (!match) throw unsupportedUrlError();
      return match.adapter.canonicalizeUrl(match.url);
    },
    parsePostReference(value) {
      const match = forUrl(value);
      return match?.adapter.parsePostReference(match.url) ?? null;
    },
    parseProfileReference(value) {
      const match = forUrl(value);
      return match?.adapter.parseProfileReference(match.url) ?? null;
    },
  });
}

export function unsupportedUrlError() {
  return new Error('A credential-free HTTPS TikTok, Instagram, or X/Twitter URL is required.');
}

function normalizeHosts(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('A platform adapter requires at least one exact hostname.');
  }
  const hosts = [...new Set(values.map((value) => String(value ?? '').trim().toLowerCase()))];
  if (hosts.some((host) => !HOSTNAME_PATTERN.test(host))) {
    throw new Error('Platform adapter hosts must be exact DNS hostnames.');
  }
  return Object.freeze(hosts);
}
