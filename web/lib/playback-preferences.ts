export const FEED_MUTED_STORAGE_KEY = "rewind-feed-muted";
export const REMEMBER_SOUND_STORAGE_KEY = "rewind-remember-sound";
export const AUTOPLAY_STORAGE_KEY = "rewind-feed-autoplay";
export const DEFAULT_FEED_STORAGE_KEY = "rewind-default-feed";

export type DefaultFeed = "all" | "bookmarks";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readRememberSound(storage: PreferenceStorage): boolean {
  try {
    return storage.getItem(REMEMBER_SOUND_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function readMutedPreference(storage: PreferenceStorage): boolean {
  if (!readRememberSound(storage)) return true;

  try {
    return storage.getItem(FEED_MUTED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeMutedPreference(storage: PreferenceStorage, muted: boolean): void {
  if (!readRememberSound(storage)) return;

  try {
    storage.setItem(FEED_MUTED_STORAGE_KEY, String(muted));
  } catch {
    // Playback remains usable when storage is unavailable or full.
  }
}

export function writeRememberSound(storage: PreferenceStorage, remember: boolean): void {
  try {
    storage.setItem(REMEMBER_SOUND_STORAGE_KEY, String(remember));
    if (!remember) storage.removeItem(FEED_MUTED_STORAGE_KEY);
  } catch {
    // Treat unavailable storage as the safe, muted default.
  }
}

export function readAutoplayPreference(storage: PreferenceStorage): boolean {
  try {
    return storage.getItem(AUTOPLAY_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeAutoplayPreference(storage: PreferenceStorage, autoplay: boolean): void {
  try {
    storage.setItem(AUTOPLAY_STORAGE_KEY, String(autoplay));
  } catch {
    // Keep the safe default when browser storage is unavailable.
  }
}

export function readDefaultFeed(storage: PreferenceStorage): DefaultFeed {
  try {
    return storage.getItem(DEFAULT_FEED_STORAGE_KEY) === "bookmarks" ? "bookmarks" : "all";
  } catch {
    return "all";
  }
}

export function writeDefaultFeed(storage: PreferenceStorage, feed: DefaultFeed): void {
  try {
    storage.setItem(DEFAULT_FEED_STORAGE_KEY, feed);
  } catch {
    // Keep the all-videos default when browser storage is unavailable.
  }
}
