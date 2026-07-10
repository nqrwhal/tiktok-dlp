import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readAutoplayPreference,
  readDefaultFeed,
  readMutedPreference,
  readRememberSound,
  writeAutoplayPreference,
  writeDefaultFeed,
  writeMutedPreference,
  writeRememberSound,
} from '../web/lib/playback-preferences.ts';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('playback preferences persist real feed behavior and keep safe defaults', () => {
  const storage = memoryStorage();
  assert.equal(readAutoplayPreference(storage), true);
  assert.equal(readRememberSound(storage), true);
  assert.equal(readMutedPreference(storage), true);
  assert.equal(readDefaultFeed(storage), 'all');

  writeAutoplayPreference(storage, false);
  writeMutedPreference(storage, false);
  writeDefaultFeed(storage, 'bookmarks');
  assert.equal(readAutoplayPreference(storage), false);
  assert.equal(readMutedPreference(storage), false);
  assert.equal(readDefaultFeed(storage), 'bookmarks');

  writeRememberSound(storage, false);
  assert.equal(readRememberSound(storage), false);
  assert.equal(readMutedPreference(storage), true);
});
