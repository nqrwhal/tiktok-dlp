import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSqliteBackup } from '../scripts/backup-state.js';
import { createStore } from '../src/state/store.js';

test('online SQLite backups include WAL commits, verify checksums, and prune only old backups', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'state-backup-'));
  const sourcePath = path.join(dir, 'state.db');
  const backupDir = path.join(dir, 'backups');
  const store = createStore(sourcePath);
  try {
    store.createFileRecord({
      videoId: 'committed-in-wal',
      username: 'creator',
      sourceUrl: 'https://www.tiktok.com/@creator/video/committed-in-wal',
      filePath: path.join(dir, 'committed-in-wal.mp4'),
      filename: 'committed-in-wal.mp4',
      sizeBytes: 12,
    }, 100);

    const backups = [];
    for (const second of [1, 2, 3]) {
      backups.push(await createSqliteBackup({
        sourcePath,
        backupDir,
        retain: 2,
        now: new Date(Date.UTC(2026, 7, 30, 12, 0, second)),
      }));
    }

    const names = await readdir(backupDir);
    const databaseNames = names.filter((name) => name.endsWith('.db')).sort();
    assert.deepEqual(databaseNames, [
      'state-20260830T120002000Z.db',
      'state-20260830T120003000Z.db',
    ]);
    assert.equal(names.filter((name) => name.endsWith('.sha256')).length, 2);
    assert.equal(names.includes(path.basename(backups[0].path)), false);
    assert.equal((await stat(backupDir)).mode & 0o777, 0o700);

    const latest = backups.at(-1);
    const backupDb = new DatabaseSync(latest.path, { readOnly: true });
    try {
      assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM files').get().count, 1);
      assert.equal(backupDb.prepare('PRAGMA user_version').get().user_version, 4);
    } finally {
      backupDb.close();
    }
    assert.equal(
      await readFile(latest.checksumPath, 'utf8'),
      `${latest.checksum}  ${path.basename(latest.path)}\n`,
    );
    assert.equal((await stat(latest.path)).mode & 0o777, 0o600);
    assert.equal((await stat(latest.checksumPath)).mode & 0o777, 0o600);
    assert.match(latest.checksum, /^[a-f0-9]{64}$/);
    await assert.rejects(
      createSqliteBackup({ sourcePath, backupDir, retain: 0 }),
      /positive safe integer/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('same-millisecond backup suffixes remain monotonic under retention', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'state-backup-collision-'));
  const sourcePath = path.join(dir, 'state.db');
  const backupDir = path.join(dir, 'backups');
  const store = createStore(sourcePath);
  try {
    const timestamp = new Date(Date.UTC(2026, 7, 30, 12, 0, 1));
    for (let index = 0; index < 12; index += 1) {
      await createSqliteBackup({ sourcePath, backupDir, retain: 2, now: timestamp });
    }
    assert.deepEqual(
      (await readdir(backupDir)).filter((name) => name.endsWith('.db')).sort(),
      [
        'state-20260830T120001000Z-10.db',
        'state-20260830T120001000Z-11.db',
      ],
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
