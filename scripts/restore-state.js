#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createSqliteBackup } from './backup-state.js';

export async function restoreSqliteBackup({
  backupPath,
  destinationPath = 'data/state.db',
  safetyBackupDir,
  confirmation,
  now = new Date(),
} = {}) {
  if (confirmation !== 'SERVICES_STOPPED') {
    throw new Error('Refusing to restore without --confirm SERVICES_STOPPED after stopping backend and Rewind.');
  }

  const backup = path.resolve(String(backupPath || ''));
  const destination = path.resolve(String(destinationPath || 'data/state.db'));
  if (!backupPath) throw new Error('--backup is required.');
  if (backup === destination) throw new Error('Backup and destination must be different files.');
  await assertRegularFile(backup, 'SQLite backup');
  await verifyChecksumSidecar(backup);
  const backupSchemaVersion = inspectDatabase(backup, 'backup');

  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });

  let destinationExists = false;
  try {
    await assertRegularFile(destination, 'SQLite destination');
    destinationExists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const resolvedSafetyBackupDir = path.resolve(String(
    safetyBackupDir || path.join(path.dirname(destination), 'backups'),
  ));
  // Opening the stopped destination read-write lets SQLite finish rollback
  // journal recovery before the safety snapshot is taken.
  if (destinationExists) inspectDatabase(destination, 'current destination', { readOnly: false });
  const safetyBackup = destinationExists
    ? await createSqliteBackup({
      sourcePath: destination,
      backupDir: resolvedSafetyBackupDir,
      retain: Number.MAX_SAFE_INTEGER,
      now,
    })
    : null;

  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.restore-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await copyFile(backup, temporary, fsConstants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    const copiedSchemaVersion = inspectDatabase(temporary, 'restore candidate');
    if (copiedSchemaVersion !== backupSchemaVersion) {
      throw new Error(`Restore candidate schema version mismatch (${copiedSchemaVersion}/${backupSchemaVersion}).`);
    }
    if (await sha256File(temporary) !== await sha256File(backup)) {
      throw new Error('Restore candidate checksum does not match the backup.');
    }
    await syncFile(temporary);
    // A cleanly closed WAL database can leave sidecars behind. The safety
    // backup above includes their committed pages, and the explicit CLI
    // confirmation establishes that no process can append while they are removed.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await rm(`${destination}${suffix}`, { force: true });
    }
    await rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
    return {
      destination,
      backup,
      schemaVersion: backupSchemaVersion,
      safetyBackup,
    };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function assertRegularFile(filePath, label) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
}

async function verifyChecksumSidecar(backup) {
  const checksumPath = `${backup}.sha256`;
  const checksumText = await readFile(checksumPath, 'utf8');
  const match = checksumText.trimEnd().match(/^([a-f0-9]{64})  ([^/\\\r\n]+)$/);
  if (!match || match[2] !== path.basename(backup)) {
    throw new Error(`Invalid backup checksum sidecar: ${checksumPath}`);
  }
  const actual = await sha256File(backup);
  if (actual !== match[1]) throw new Error(`Backup checksum mismatch: ${backup}`);
}

function inspectDatabase(filePath, label, { readOnly = true } = {}) {
  const db = new DatabaseSync(filePath, { readOnly });
  try {
    const results = db.prepare('PRAGMA quick_check').all()
      .flatMap((row) => Object.values(row).map(String));
    if (results.length !== 1 || results[0].toLowerCase() !== 'ok') {
      throw new Error(`${label} SQLite integrity check failed: ${results.join(', ') || 'no result'}`);
    }
    return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  } finally {
    db.close();
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
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
    if (!['--backup', '--destination', '--safety-backup-dir', '--confirm'].includes(flag) || value == null) {
      throw new Error(`Unknown or incomplete restore option: ${flag}`);
    }
    if (flag === '--backup') options.backupPath = value;
    if (flag === '--destination') options.destinationPath = value;
    if (flag === '--safety-backup-dir') options.safetyBackupDir = value;
    if (flag === '--confirm') options.confirmation = value;
    index += 1;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const restored = await restoreSqliteBackup(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Restore OK: ${restored.destination} (schema v${restored.schemaVersion})\n`);
    if (restored.safetyBackup) {
      process.stdout.write(`Previous state preserved: ${restored.safetyBackup.path}\n`);
    }
  } catch (error) {
    process.stderr.write(`restore-state: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
