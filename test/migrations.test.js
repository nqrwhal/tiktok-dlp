import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { listAppliedMigrations, runMigrations } from '../src/state/migrations.js';

test('SQLite migrations apply once in order and record the current schema version', () => {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const migrations = [
    {
      version: 1,
      name: 'create-items',
      up(connection) {
        calls.push(1);
        connection.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      },
    },
    {
      version: 2,
      name: 'add-item-created-at',
      up(connection) {
        calls.push(2);
        connection.exec('ALTER TABLE items ADD COLUMN created_at INTEGER');
      },
    },
  ];

  try {
    const first = runMigrations(db, migrations, { now: () => 1_000 });
    assert.equal(first.currentVersion, 2);
    assert.deepEqual(first.applied.map((migration) => migration.version), [1, 2]);
    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(listAppliedMigrations(db), [
      { version: 1, name: 'create-items', applied_at: 1_000 },
      { version: 2, name: 'add-item-created-at', applied_at: 1_000 },
    ]);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);

    const second = runMigrations(db, migrations, { now: () => 2_000 });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(calls, [1, 2]);
  } finally {
    db.close();
  }
});

test('a failed SQLite migration rolls back its schema and ledger row, then remains retryable', () => {
  const db = new DatabaseSync(':memory:');
  const firstMigration = {
    version: 1,
    name: 'create-stable-table',
    up(connection) {
      connection.exec('CREATE TABLE stable_table (id INTEGER PRIMARY KEY)');
    },
  };
  try {
    assert.throws(
      () => runMigrations(db, [
        firstMigration,
        {
          version: 2,
          name: 'failing-change',
          up(connection) {
            connection.exec('CREATE TABLE rolled_back_table (id INTEGER PRIMARY KEY)');
            throw new Error('simulated migration failure');
          },
        },
      ], { now: () => 3_000 }),
      /SQLite migration 2 \(failing-change\) failed: simulated migration failure/,
    );
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stable_table'").get());
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back_table'").get(), undefined);
    assert.deepEqual(listAppliedMigrations(db).map((migration) => migration.version), [1]);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);

    const recovered = runMigrations(db, [
      firstMigration,
      {
        version: 2,
        name: 'failing-change',
        up(connection) {
          connection.exec('CREATE TABLE recovered_table (id INTEGER PRIMARY KEY)');
        },
      },
    ], { now: () => 4_000 });
    assert.deepEqual(recovered.applied.map((migration) => migration.version), [2]);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recovered_table'").get());
  } finally {
    db.close();
  }
});

test('SQLite migration history rejects renamed, missing, and asynchronous migrations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    runMigrations(db, [{
      version: 1,
      name: 'immutable-name',
      up(connection) {
        connection.exec('CREATE TABLE original_table (id INTEGER PRIMARY KEY)');
      },
    }], { now: () => 5_000 });

    assert.throws(
      () => runMigrations(db, [{ version: 1, name: 'renamed', up() {} }]),
      /recorded as immutable-name, but this application expects renamed/,
    );
    db.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (2, 'future-change', 6000)
    `).run();
    assert.throws(
      () => runMigrations(db, [{ version: 1, name: 'immutable-name', up() {} }]),
      /schema version 2 is newer than this application supports/,
    );
  } finally {
    db.close();
  }

  const asyncDb = new DatabaseSync(':memory:');
  try {
    assert.throws(
      () => runMigrations(asyncDb, [{
        version: 1,
        name: 'async-change',
        up: async () => {},
      }]),
      /migrations must be synchronous/,
    );
    assert.deepEqual(listAppliedMigrations(asyncDb), []);
    assert.equal(asyncDb.prepare('PRAGMA user_version').get().user_version, 0);
  } finally {
    asyncDb.close();
  }
});

test('a future SQLite user_version fails before migration state is changed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA user_version = 9');
    assert.throws(
      () => runMigrations(db, [{ version: 1, name: 'known-change', up() {} }]),
      /schema version 9 is newer than this application supports/,
    );
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(),
      undefined,
    );
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
  } finally {
    db.close();
  }
});
