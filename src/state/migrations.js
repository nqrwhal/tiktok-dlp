const MIGRATIONS_TABLE = 'schema_migrations';

export function runMigrations(db, migrations, { now = () => Date.now() } = {}) {
  if (!db?.exec || !db?.prepare) throw new Error('A SQLite database connection is required.');
  const ordered = normalizeMigrations(migrations);
  const currentVersion = ordered.at(-1)?.version ?? 0;
  const initialPragmaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (!Number.isSafeInteger(initialPragmaVersion) || initialPragmaVersion < 0) {
    throw new Error('SQLite user_version must be a non-negative safe integer.');
  }
  if (initialPragmaVersion > currentVersion) {
    throw new Error(`SQLite schema version ${initialPragmaVersion} is newer than this application supports.`);
  }
  ensureMigrationLedger(db);

  const appliedRows = db.prepare(`
    SELECT version, name, applied_at
    FROM ${MIGRATIONS_TABLE}
    ORDER BY version
  `).all();
  validateAppliedMigrations(appliedRows, ordered);
  const appliedVersions = new Set(appliedRows.map((row) => Number(row.version)));
  const newlyApplied = [];

  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) continue;
    const appliedAt = normalizeTimestamp(now());
    let transactionStarted = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = migration.up(db, {
        version: migration.version,
        name: migration.name,
        appliedAt,
      });
      if (result && typeof result.then === 'function') {
        throw new Error(`SQLite migration ${migration.version} (${migration.name}) returned a Promise; migrations must be synchronous.`);
      }
      db.prepare(`
        INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.name, appliedAt);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      transactionStarted = false;
      newlyApplied.push({
        version: migration.version,
        name: migration.name,
        appliedAt,
      });
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Keep the original migration error when SQLite already ended the transaction.
        }
      }
      throw new Error(
        `SQLite migration ${migration.version} (${migration.name}) failed: ${error?.message ?? error}`,
        { cause: error },
      );
    }
  }

  const pragmaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (pragmaVersion !== currentVersion) {
    db.exec(`PRAGMA user_version = ${currentVersion}`);
  }
  return {
    currentVersion,
    applied: newlyApplied,
  };
}

export function listAppliedMigrations(db) {
  ensureMigrationLedger(db);
  return db.prepare(`
    SELECT version, name, applied_at
    FROM ${MIGRATIONS_TABLE}
    ORDER BY version
  `).all().map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    applied_at: Number(row.applied_at),
  }));
}

function ensureMigrationLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);
}

function normalizeMigrations(migrations) {
  if (!Array.isArray(migrations)) throw new Error('SQLite migrations must be an ordered array.');
  const names = new Set();
  return migrations.map((migration, index) => {
    const expectedVersion = index + 1;
    const version = Number(migration?.version);
    const name = String(migration?.name ?? '').trim();
    if (!Number.isInteger(version) || version !== expectedVersion) {
      throw new Error(`SQLite migrations must use consecutive versions starting at 1; expected version ${expectedVersion}.`);
    }
    if (!name) throw new Error(`SQLite migration ${version} requires a name.`);
    if (names.has(name)) throw new Error(`SQLite migration name ${name} is duplicated.`);
    if (typeof migration?.up !== 'function') throw new Error(`SQLite migration ${version} (${name}) requires an up function.`);
    names.add(name);
    return { version, name, up: migration.up };
  });
}

function validateAppliedMigrations(appliedRows, migrations) {
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  let expectedAppliedVersion = 1;
  for (const row of appliedRows) {
    const version = Number(row.version);
    if (version !== expectedAppliedVersion) {
      throw new Error(`SQLite migration ledger has a gap before version ${version}.`);
    }
    const migration = known.get(version);
    if (!migration) {
      throw new Error(`SQLite schema version ${version} is newer than this application supports.`);
    }
    if (String(row.name) !== migration.name) {
      throw new Error(
        `SQLite migration ${version} was recorded as ${row.name}, but this application expects ${migration.name}.`,
      );
    }
    expectedAppliedVersion += 1;
  }
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error('SQLite migration timestamps must be non-negative numbers.');
  }
  return Math.trunc(timestamp);
}
