export const FEED_MUTED_STORAGE_KEY = "rewind-feed-muted";
export const REMEMBER_SOUND_STORAGE_KEY = "rewind-remember-sound";

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
