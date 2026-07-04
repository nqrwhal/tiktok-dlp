import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export class Store {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watched_users (
        username TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_checked_at INTEGER,
        last_success_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_check_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS seen_videos (
        video_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        source_url TEXT NOT NULL,
        title TEXT,
        seen_at INTEGER NOT NULL,
        alerted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL DEFAULT '',
        username TEXT,
        source_url TEXT NOT NULL,
        video_id TEXT,
        title TEXT,
        file_id INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT,
        username TEXT,
        requested_by TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS link_tokens (
        token TEXT PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_files_video_id ON files(video_id);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_expires_at ON link_tokens(expires_at);
    `);
    this.ensureColumn('jobs', 'requested_by', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('files', 'requested_by', "TEXT NOT NULL DEFAULT ''");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_requested_by ON jobs(requested_by);
      CREATE INDEX IF NOT EXISTS idx_files_requested_by ON files(requested_by);
    `);
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  addWatch(username, channelId, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO watched_users (username, channel_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET channel_id = excluded.channel_id
    `).run(username, channelId, now);
    return this.getWatch(username);
  }

  removeWatch(username) {
    const result = this.db.prepare('DELETE FROM watched_users WHERE username = ?').run(username);
    return result.changes > 0;
  }

  getWatch(username) {
    return this.db.prepare('SELECT * FROM watched_users WHERE username = ?').get(username) ?? null;
  }

  listWatches() {
    return this.db.prepare('SELECT * FROM watched_users ORDER BY username').all();
  }

  markWatchSuccess(username, now = Date.now()) {
    this.db.prepare(`
      UPDATE watched_users
      SET last_checked_at = ?, last_success_at = ?, failure_count = 0, last_error = NULL, next_check_at = NULL
      WHERE username = ?
    `).run(now, now, username);
  }

  markWatchFailure(username, error, nextCheckAt, now = Date.now()) {
    this.db.prepare(`
      UPDATE watched_users
      SET last_checked_at = ?, failure_count = failure_count + 1, last_error = ?, next_check_at = ?
      WHERE username = ?
    `).run(now, String(error).slice(0, 500), nextCheckAt, username);
  }

  hasSeenVideo(videoId) {
    return Boolean(this.db.prepare('SELECT 1 FROM seen_videos WHERE video_id = ?').get(videoId));
  }

  markVideoSeen({ videoId, username, sourceUrl, title, alertedAt = null }, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO seen_videos (video_id, username, source_url, title, seen_at, alerted_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        username = excluded.username,
        source_url = excluded.source_url,
        title = excluded.title,
        alerted_at = COALESCE(excluded.alerted_at, seen_videos.alerted_at)
    `).run(videoId, username, sourceUrl, title ?? '', now, alertedAt);
  }

  createJob({ type, status = 'queued', requestedBy = '', username = '', sourceUrl, videoId = '', title = '' }, now = Date.now()) {
    const result = this.db.prepare(`
      INSERT INTO jobs (type, status, requested_by, username, source_url, video_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(type, status, String(requestedBy ?? ''), username, sourceUrl, videoId, title, now, now);
    return Number(result.lastInsertRowid);
  }

  updateJob(id, changes, now = Date.now()) {
    const allowed = ['status', 'requested_by', 'username', 'source_url', 'video_id', 'title', 'file_id', 'error'];
    const entries = Object.entries(changes).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE jobs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value), now, id);
  }

  listJobs(limit = 10) {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  createFileRecord({ videoId = '', username = '', requestedBy = '', sourceUrl, filePath, filename, sizeBytes }, now = Date.now()) {
    const result = this.db.prepare(`
      INSERT INTO files (video_id, username, requested_by, source_url, path, filename, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(videoId, username, String(requestedBy ?? ''), sourceUrl, filePath, filename, sizeBytes, now);
    return Number(result.lastInsertRowid);
  }

  getLatestFileByVideoId(videoId) {
    if (!videoId) return null;
    return this.db.prepare(`
      SELECT *
      FROM files
      WHERE video_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(String(videoId)) ?? null;
  }

  createLinkToken({ token, fileId, expiresAt }, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO link_tokens (token, file_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(token, fileId, expiresAt, now);
  }

  getToken(token) {
    return this.db.prepare(`
      SELECT link_tokens.token, link_tokens.expires_at, link_tokens.created_at AS token_created_at, files.*
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE link_tokens.token = ?
    `).get(token) ?? null;
  }

  getValidToken(token, now = Date.now()) {
    return this.db.prepare(`
      SELECT link_tokens.token, link_tokens.expires_at, link_tokens.created_at AS token_created_at, files.*
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE link_tokens.token = ? AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
    `).get(token, now) ?? null;
  }

  extendLinkToken(token, additionalMs, now = Date.now()) {
    const newExpiry = now + additionalMs;
    const result = this.db.prepare(`
      UPDATE link_tokens
      SET expires_at = CASE
        WHEN expires_at = 0 THEN 0
        WHEN expires_at > ? THEN expires_at + ?
        ELSE ?
      END
      WHERE token = ?
    `).run(now, additionalMs, newExpiry, token);
    return result.changes > 0 ? this.getToken(token) : null;
  }

  setLinkTokenPermanent(token) {
    const result = this.db.prepare('UPDATE link_tokens SET expires_at = 0 WHERE token = ?').run(token);
    return result.changes > 0 ? this.getToken(token) : null;
  }

  deleteExpiredTokens(now = Date.now()) {
    return this.db.prepare('DELETE FROM link_tokens WHERE expires_at > 0 AND expires_at <= ?').run(now).changes;
  }

  listFilesWithoutActiveLinks(now = Date.now()) {
    return this.db.prepare(`
      SELECT files.id, files.path, files.filename
      FROM files
      WHERE EXISTS (
          SELECT 1
          FROM link_tokens
          WHERE link_tokens.file_id = files.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM link_tokens
          WHERE link_tokens.file_id = files.id
            AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
        )
      ORDER BY files.created_at ASC
    `).all(now);
  }

  deleteFileRecords(ids = []) {
    const uniqueIds = [...new Set(ids.map((id) => Number(id)).filter(Number.isFinite))];
    if (!uniqueIds.length) return 0;
    const placeholders = uniqueIds.map(() => '?').join(', ');
    return this.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...uniqueIds).changes;
  }

  listDownloadLinksByRequester(requestedBy, { limit = 25, offset = 0, activeOnly = true, includeMonitored = false, username = '', now = Date.now() } = {}) {
    const ownerClause = includeMonitored
      ? `(
          files.requested_by = ?
          OR EXISTS (
            SELECT 1
            FROM jobs
            WHERE jobs.file_id = files.id
              AND jobs.type = 'monitor'
          )
        )`
      : 'files.requested_by = ?';
    const clauses = [ownerClause];
    const params = [String(requestedBy ?? '')];
    if (activeOnly) {
      clauses.push('(link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)');
      params.push(now);
    }
    if (username) {
      clauses.push('lower(files.username) = lower(?)');
      params.push(String(username));
    }
    const sql = `
      SELECT
        link_tokens.token,
        link_tokens.expires_at,
        link_tokens.created_at AS token_created_at,
        files.id AS file_id,
        files.video_id,
        files.username,
        files.source_url,
        files.requested_by,
        files.filename,
        files.size_bytes,
        files.created_at AS file_created_at,
        (
          SELECT jobs.title
          FROM jobs
          WHERE jobs.file_id = files.id
          ORDER BY jobs.created_at DESC
          LIMIT 1
        ) AS title
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE ${clauses.join('\n        AND ')}
      ORDER BY link_tokens.created_at DESC
      LIMIT ?
      OFFSET ?
    `;
    params.push(Math.max(1, Math.min(50, Number(limit) || 25)));
    params.push(Math.max(0, Number(offset) || 0));
    return this.db.prepare(sql).all(...params);
  }

  countDownloadLinksByRequester(requestedBy, { activeOnly = true, includeMonitored = false, username = '', now = Date.now() } = {}) {
    const ownerClause = includeMonitored
      ? `(
          files.requested_by = ?
          OR EXISTS (
            SELECT 1
            FROM jobs
            WHERE jobs.file_id = files.id
              AND jobs.type = 'monitor'
          )
        )`
      : 'files.requested_by = ?';
    const clauses = [ownerClause];
    const params = [String(requestedBy ?? '')];
    if (activeOnly) {
      clauses.push('(link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)');
      params.push(now);
    }
    if (username) {
      clauses.push('lower(files.username) = lower(?)');
      params.push(String(username));
    }
    const sql = `
      SELECT COUNT(*) AS count
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE ${clauses.join('\n        AND ')}
    `;
    return this.db.prepare(sql).get(...params).count;
  }

  listFilesForPurge({ requestedBy = '' } = {}) {
    if (requestedBy) {
      return this.db.prepare('SELECT id, path, filename FROM files WHERE requested_by = ?').all(String(requestedBy));
    }
    return this.db.prepare('SELECT id, path, filename FROM files').all();
  }

  purgeDownloads({ requestedBy = '' } = {}) {
    const scoped = Boolean(requestedBy);
    const counts = scoped
      ? {
          files: this.db.prepare('SELECT COUNT(*) AS count FROM files WHERE requested_by = ?').get(String(requestedBy)).count,
          links: this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM link_tokens
            JOIN files ON files.id = link_tokens.file_id
            WHERE files.requested_by = ?
          `).get(String(requestedBy)).count,
          jobs: this.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE requested_by = ?').get(String(requestedBy)).count,
        }
      : {
          files: this.db.prepare('SELECT COUNT(*) AS count FROM files').get().count,
          links: this.db.prepare('SELECT COUNT(*) AS count FROM link_tokens').get().count,
          jobs: this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count,
        };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (scoped) {
        this.db.prepare(`
          DELETE FROM link_tokens
          WHERE file_id IN (SELECT id FROM files WHERE requested_by = ?)
        `).run(String(requestedBy));
        this.db.prepare('DELETE FROM jobs WHERE requested_by = ?').run(String(requestedBy));
        this.db.prepare('DELETE FROM files WHERE requested_by = ?').run(String(requestedBy));
      } else {
        this.db.prepare('DELETE FROM link_tokens').run();
        this.db.prepare('DELETE FROM jobs').run();
        this.db.prepare('DELETE FROM files').run();
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return counts;
  }

  stats() {
    const watchCount = this.db.prepare('SELECT COUNT(*) AS count FROM watched_users').get().count;
    const videoCount = this.db.prepare('SELECT COUNT(*) AS count FROM seen_videos').get().count;
    const fileCount = this.db.prepare('SELECT COUNT(*) AS count FROM files').get().count;
    const latestJob = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1').get() ?? null;
    return { watchCount, videoCount, fileCount, latestJob };
  }
}

export function createStore(dbPath) {
  return new Store(path.resolve(dbPath));
}
