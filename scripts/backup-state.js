#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const BACKUP_NAME_PATTERN = /^state-(\d{8}T\d{9}Z)(?:-(\d+))?\.db$/;

export async function createSqliteBackup({
  sourcePath,
  backupDir,
  retain = 30,
  now = new Date(),
} = {}) {
  const source = path.resolve(String(sourcePath || 'data/state.db'));
  const destinationRoot = path.resolve(String(backupDir || path.join(path.dirname(source), 'backups')));
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile()) throw new Error(`SQLite source is not a file: ${source}`);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await chmod(destinationRoot, 0o700);
  const retainedBackupCount = normalizeRetain(retain);

  const destination = await availableBackupPath(destinationRoot, backupTimestamp(now));
  if (destination === source) throw new Error('Backup destination must differ from the source database.');
  let sourceDb;
  try {
    sourceDb = new DatabaseSync(source, { readOnly: true });
    assertDatabaseIntegrity(sourceDb, 'source');
    const schemaVersion = databaseSchemaVersion(sourceDb);
    sourceDb.exec(`VACUUM INTO '${escapeSqliteString(destination)}'`);
    sourceDb.close();
    sourceDb = null;

    const backupDb = new DatabaseSync(destination, { readOnly: true });
    try {
      assertDatabaseIntegrity(backupDb, 'backup');
      const backupSchemaVersion = databaseSchemaVersion(backupDb);
      if (backupSchemaVersion !== schemaVersion) {
        throw new Error(`Backup schema version mismatch (${backupSchemaVersion}/${schemaVersion}).`);
      }
    } finally {
      backupDb.close();
    }

    await chmod(destination, 0o600);
    await syncFile(destination);
    const checksum = await sha256File(destination);
    const checksumPath = `${destination}.sha256`;
    await writeFile(checksumPath, `${checksum}  ${path.basename(destination)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await syncFile(checksumPath);
    await pruneBackups(destinationRoot, retainedBackupCount);
    await syncDirectory(destinationRoot);
    return {
      path: destination,
      checksumPath,
      checksum,
      schemaVersion,
      sizeBytes: (await stat(destination)).size,
    };
  } catch (error) {
    sourceDb?.close();
    await rm(destination, { force: true });
    await rm(`${destination}.sha256`, { force: true });
    throw error;
  }
}

function assertDatabaseIntegrity(db, label) {
  const rows = db.prepare('PRAGMA quick_check').all();
  const results = rows.flatMap((row) => Object.values(row).map(String));
  if (results.length !== 1 || results[0].toLowerCase() !== 'ok') {
    throw new Error(`${label} SQLite integrity check failed: ${results.join(', ') || 'no result'}`);
  }
}

function databaseSchemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

async function availableBackupPath(directory, timestamp) {
  const suffixes = (await readdir(directory))
    .map((name) => name.match(BACKUP_NAME_PATTERN))
    .filter((match) => match?.[1] === timestamp)
    .map((match) => Number(match[2] ?? 0));
  const firstSuffix = suffixes.length ? Math.max(...suffixes) + 1 : 0;
  for (let suffix = firstSuffix; suffix < 1_000; suffix += 1) {
    const candidate = path.join(directory, `state-${timestamp}${suffix ? `-${suffix}` : ''}.db`);
    try {
      await stat(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error('Could not allocate a unique backup filename.');
}

function backupTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid backup timestamp is required.');
  return date.toISOString().replace(/[-:.]/g, '');
}

function escapeSqliteString(value) {
  return String(value).replaceAll("'", "''");
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function pruneBackups(directory, retain) {
  const names = (await readdir(directory))
    .filter((name) => BACKUP_NAME_PATTERN.test(name))
    .sort(compareBackupNamesNewestFirst);
  for (const name of names.slice(retain)) {
    const backupPath = path.join(directory, name);
    await rm(backupPath, { force: true });
    await rm(`${backupPath}.sha256`, { force: true });
  }
}

function compareBackupNamesNewestFirst(left, right) {
  const leftMatch = left.match(BACKUP_NAME_PATTERN);
  const rightMatch = right.match(BACKUP_NAME_PATTERN);
  const timestampOrder = String(rightMatch?.[1] ?? '').localeCompare(String(leftMatch?.[1] ?? ''));
  if (timestampOrder) return timestampOrder;
  return Number(rightMatch?.[2] ?? 0) - Number(leftMatch?.[2] ?? 0);
}

function normalizeRetain(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('Backup retention must be a positive safe integer.');
  }
  return count;
}

async function syncFile(filePath) {
  const handle = await open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--source', '--backup-dir', '--retain'].includes(flag) || value == null) {
      throw new Error(`Unknown or incomplete backup option: ${flag}`);
    }
    if (flag === '--source') options.sourcePath = value;
    if (flag === '--backup-dir') options.backupDir = value;
    if (flag === '--retain') options.retain = Number(value);
    index += 1;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const backup = await createSqliteBackup(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Backup OK: ${backup.path} (${backup.sizeBytes} bytes, schema v${backup.schemaVersion})\n`);
    process.stdout.write(`SHA-256: ${backup.checksum}\n`);
  } catch (error) {
    process.stderr.write(`backup-state: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
