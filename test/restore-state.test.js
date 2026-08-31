import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createSqliteBackup } from '../scripts/backup-state.js';
import { restoreSqliteBackup } from '../scripts/restore-state.js';
import { createStore } from '../src/state/store.js';

function insertArchiveFile(store, directory, videoId, createdAt) {
  store.createFileRecord({
    videoId,
    username: 'creator',
    sourceUrl: `https://www.tiktok.com/@creator/video/${videoId}`,
    filePath: path.join(directory, `${videoId}.mp4`),
    filename: `${videoId}.mp4`,
    sizeBytes: 12,
  }, createdAt);
}

function archivedVideoIds(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare('SELECT video_id FROM files ORDER BY id').all().map((row) => row.video_id);
  } finally {
    db.close();
  }
}

test('restore verifies the backup and preserves the replaced database first', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'state-restore-'));
  const destination = path.join(directory, 'state.db');
  const backupDirectory = path.join(directory, 'backups');
  try {
    let store = createStore(destination);
    insertArchiveFile(store, directory, 'before-backup', 100);
    store.close();

    const backup = await createSqliteBackup({
      sourcePath: destination,
      backupDir: backupDirectory,
      now: new Date(Date.UTC(2026, 7, 30, 12, 0, 1)),
    });

    store = createStore(destination);
    insertArchiveFile(store, directory, 'after-backup', 200);
    store.close();

    await assert.rejects(
      restoreSqliteBackup({ backupPath: backup.path, destinationPath: destination }),
      /--confirm SERVICES_STOPPED/,
    );
    assert.deepEqual(archivedVideoIds(destination), ['before-backup', 'after-backup']);

    const restored = await restoreSqliteBackup({
      backupPath: backup.path,
      destinationPath: destination,
      confirmation: 'SERVICES_STOPPED',
      now: new Date(Date.UTC(2026, 7, 30, 12, 0, 2)),
    });

    assert.equal(restored.schemaVersion, 4);
    assert.ok(restored.safetyBackup);
    assert.deepEqual(archivedVideoIds(destination), ['before-backup']);
    assert.deepEqual(
      archivedVideoIds(restored.safetyBackup.path),
      ['before-backup', 'after-backup'],
    );
    assert.match(await readFile(restored.safetyBackup.checksumPath, 'utf8'), /^[a-f0-9]{64}  state-/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('restore rejects a bad checksum before changing the destination', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'state-restore-guard-'));
  const destination = path.join(directory, 'state.db');
  try {
    const store = createStore(destination);
    insertArchiveFile(store, directory, 'current', 100);
    store.close();
    const backup = await createSqliteBackup({
      sourcePath: destination,
      backupDir: path.join(directory, 'backups'),
      now: new Date(Date.UTC(2026, 7, 30, 12, 0, 1)),
    });

    const originalChecksum = await readFile(backup.checksumPath, 'utf8');
    await writeFile(
      backup.checksumPath,
      `${'0'.repeat(64)}  ${path.basename(backup.path)}\n`,
    );
    await assert.rejects(
      restoreSqliteBackup({
        backupPath: backup.path,
        destinationPath: destination,
        confirmation: 'SERVICES_STOPPED',
      }),
      /checksum mismatch/,
    );
    await writeFile(backup.checksumPath, originalChecksum);
    await writeFile(`${destination}-journal`, 'stale');
    await restoreSqliteBackup({
      backupPath: backup.path,
      destinationPath: destination,
      confirmation: 'SERVICES_STOPPED',
    });
    await assert.rejects(readFile(`${destination}-journal`), { code: 'ENOENT' });
    assert.deepEqual(archivedVideoIds(destination), ['current']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
