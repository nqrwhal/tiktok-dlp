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
        creator_id TEXT,
        sec_uid TEXT,
        author_id TEXT,
        has_story INTEGER,
        story_status_checked_at INTEGER,
        previous_username TEXT,
        username_changed_at INTEGER,
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
        alerted_at INTEGER,
        last_available_at INTEGER,
        last_deletion_checked_at INTEGER,
        next_deletion_check_at INTEGER,
        deletion_check_count INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        deletion_alerted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS watch_username_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creator_id TEXT,
        previous_username TEXT NOT NULL,
        new_username TEXT NOT NULL,
        detected_at INTEGER NOT NULL
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
    this.ensureColumn('watched_users', 'creator_id', 'TEXT');
    this.ensureColumn('watched_users', 'sec_uid', 'TEXT');
    this.ensureColumn('watched_users', 'author_id', 'TEXT');
    this.ensureColumn('watched_users', 'has_story', 'INTEGER');
    this.ensureColumn('watched_users', 'story_status_checked_at', 'INTEGER');
    this.ensureColumn('watched_users', 'previous_username', 'TEXT');
    this.ensureColumn('watched_users', 'username_changed_at', 'INTEGER');
    this.ensureColumn('seen_videos', 'last_available_at', 'INTEGER');
    this.ensureColumn('seen_videos', 'last_deletion_checked_at', 'INTEGER');
    this.ensureColumn('seen_videos', 'next_deletion_check_at', 'INTEGER');
    this.ensureColumn('seen_videos', 'deletion_check_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('seen_videos', 'deleted_at', 'INTEGER');
    this.ensureColumn('seen_videos', 'deletion_alerted_at', 'INTEGER');
    this.ensureColumn('jobs', 'requested_by', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('files', 'requested_by', "TEXT NOT NULL DEFAULT ''");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_requested_by ON jobs(requested_by);
      CREATE INDEX IF NOT EXISTS idx_files_requested_by ON files(requested_by);
      CREATE INDEX IF NOT EXISTS idx_seen_videos_next_deletion_check_at ON seen_videos(next_deletion_check_at);
      CREATE INDEX IF NOT EXISTS idx_watched_users_next_check_at ON watched_users(next_check_at);
      CREATE INDEX IF NOT EXISTS idx_watch_username_history_detected_at ON watch_username_history(detected_at DESC);
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
    return this.db.prepare(`
      SELECT *
      FROM watched_users
      ORDER BY COALESCE(next_check_at, 0), username
    `).all();
  }

  recordWatchIdentity(username, {
    creatorId = '',
    currentUsername = '',
    secUid = '',
    authorId = '',
    hasStory = null,
    storyStatusCheckedAt = null,
  } = {}, now = Date.now()) {
    const previousUsername = String(username ?? '');
    const nextUsername = String(currentUsername || previousUsername);
    const id = String(creatorId ?? '');
    const nextSecUid = String(secUid ?? '');
    const nextAuthorId = String(authorId ?? '');
    const nextHasStory = normalizeNullableBoolean(hasStory);
    const nextStoryStatusCheckedAt = nextHasStory === null
      ? null
      : normalizeNullableInteger(storyStatusCheckedAt) ?? now;
    const existing = this.getWatch(previousUsername);
    if (!existing) return { changed: false, username: nextUsername, previousUsername, creatorId: id, secUid: nextSecUid, authorId: nextAuthorId };

    if (id || nextSecUid || nextAuthorId || nextHasStory !== null) {
      this.db.prepare(`
        UPDATE watched_users
        SET
          creator_id = COALESCE(NULLIF(?, ''), creator_id),
          sec_uid = COALESCE(NULLIF(?, ''), sec_uid),
          author_id = COALESCE(NULLIF(?, ''), author_id),
          has_story = COALESCE(?, has_story),
          story_status_checked_at = COALESCE(?, story_status_checked_at)
        WHERE username = ?
      `).run(id, nextSecUid, nextAuthorId, nextHasStory, nextStoryStatusCheckedAt, previousUsername);
    }

    if (!nextUsername || nextUsername.toLowerCase() === previousUsername.toLowerCase()) {
      return {
        changed: false,
        username: previousUsername,
        previousUsername,
        creatorId: id || existing.creator_id || '',
        secUid: nextSecUid || existing.sec_uid || '',
        authorId: nextAuthorId || existing.author_id || '',
      };
    }

    this.db.prepare(`
      INSERT INTO watch_username_history (creator_id, previous_username, new_username, detected_at)
      VALUES (?, ?, ?, ?)
    `).run(id || existing.creator_id || '', previousUsername, nextUsername, now);

    const conflict = this.getWatch(nextUsername);
    if (conflict) {
      this.db.prepare(`
        UPDATE watched_users
        SET
          creator_id = COALESCE(NULLIF(?, ''), creator_id),
          sec_uid = COALESCE(NULLIF(?, ''), sec_uid),
          author_id = COALESCE(NULLIF(?, ''), author_id),
          has_story = COALESCE(?, has_story),
          story_status_checked_at = COALESCE(?, story_status_checked_at),
          previous_username = ?,
          username_changed_at = ?,
          last_checked_at = COALESCE(last_checked_at, ?),
          last_success_at = COALESCE(last_success_at, ?)
        WHERE username = ?
      `).run(
        id,
        nextSecUid,
        nextAuthorId,
        nextHasStory,
        nextStoryStatusCheckedAt,
        previousUsername,
        now,
        existing.last_checked_at,
        existing.last_success_at,
        nextUsername,
      );
      this.db.prepare('DELETE FROM watched_users WHERE username = ?').run(previousUsername);
    } else {
      this.db.prepare(`
        UPDATE watched_users
        SET
          username = ?,
          creator_id = COALESCE(NULLIF(?, ''), creator_id),
          sec_uid = COALESCE(NULLIF(?, ''), sec_uid),
          author_id = COALESCE(NULLIF(?, ''), author_id),
          has_story = COALESCE(?, has_story),
          story_status_checked_at = COALESCE(?, story_status_checked_at),
          previous_username = ?,
          username_changed_at = ?
        WHERE username = ?
      `).run(nextUsername, id, nextSecUid, nextAuthorId, nextHasStory, nextStoryStatusCheckedAt, previousUsername, now, previousUsername);
    }

    return {
      changed: true,
      username: nextUsername,
      previousUsername,
      creatorId: id || existing.creator_id || '',
      secUid: nextSecUid || existing.sec_uid || '',
      authorId: nextAuthorId || existing.author_id || '',
    };
  }

  listWatchUsernameHistory(limit = 25) {
    return this.db.prepare(`
      SELECT *
      FROM watch_username_history
      ORDER BY detected_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(100, Number(limit) || 25)));
  }

  markWatchSuccess(username, now = Date.now(), nextCheckAt = null) {
    this.db.prepare(`
      UPDATE watched_users
      SET last_checked_at = ?, last_success_at = ?, failure_count = 0, last_error = NULL, next_check_at = ?
      WHERE username = ?
    `).run(now, now, nextCheckAt, username);
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

  scheduleVideoDeletionCheck(videoId, nextCheckAt) {
    this.db.prepare(`
      UPDATE seen_videos
      SET next_deletion_check_at = ?, last_available_at = COALESCE(last_available_at, alerted_at, seen_at)
      WHERE video_id = ?
    `).run(nextCheckAt, String(videoId));
  }

  listVideosDueForDeletionCheck(now = Date.now(), limit = 25) {
    return this.db.prepare(`
      SELECT
        seen_videos.*,
        (
          SELECT link_tokens.token
          FROM files
          JOIN link_tokens ON link_tokens.file_id = files.id
          WHERE files.video_id = seen_videos.video_id
            AND link_tokens.expires_at = 0
          ORDER BY link_tokens.created_at DESC
          LIMIT 1
        ) AS permanent_token,
        (
          SELECT files.filename
          FROM files
          WHERE files.video_id = seen_videos.video_id
          ORDER BY files.created_at DESC
          LIMIT 1
        ) AS filename
      FROM seen_videos
      WHERE alerted_at IS NOT NULL
        AND deleted_at IS NULL
        AND next_deletion_check_at IS NOT NULL
        AND next_deletion_check_at <= ?
      ORDER BY next_deletion_check_at ASC
      LIMIT ?
    `).all(now, Math.max(1, Math.min(100, Number(limit) || 25)));
  }

  markVideoStillAvailable(videoId, nextCheckAt, now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET
        last_available_at = ?,
        last_deletion_checked_at = ?,
        next_deletion_check_at = ?,
        deletion_check_count = deletion_check_count + 1
      WHERE video_id = ?
    `).run(now, now, nextCheckAt, String(videoId));
  }

  postponeVideoDeletionCheck(videoId, nextCheckAt, now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET last_deletion_checked_at = ?, next_deletion_check_at = ?
      WHERE video_id = ?
    `).run(now, nextCheckAt, String(videoId));
  }

  markVideoDeleted(videoId, now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET deleted_at = ?, deletion_alerted_at = ?, last_deletion_checked_at = ?, next_deletion_check_at = NULL
      WHERE video_id = ?
    `).run(now, now, now, String(videoId));
    return this.db.prepare('SELECT * FROM seen_videos WHERE video_id = ?').get(String(videoId)) ?? null;
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

  buildRequesterClause(includeMonitored) {
    return includeMonitored
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
  }

  getToken(token) {
    return this.db.prepare(`
      SELECT link_tokens.token, link_tokens.expires_at, link_tokens.created_at AS token_created_at, files.*
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE link_tokens.token = ?
    `).get(token) ?? null;
  }

  getMonitorFileByToken(token) {
    return this.db.prepare(`
      SELECT
        link_tokens.token,
        link_tokens.expires_at,
        link_tokens.created_at AS token_created_at,
        files.*,
        files.id AS file_id
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE link_tokens.token = ?
        AND EXISTS (
          SELECT 1
          FROM jobs
          WHERE jobs.file_id = files.id
            AND jobs.type = 'monitor'
        )
    `).get(String(token ?? '')) ?? null;
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

  setMonitorLinkTokensPermanent() {
    return this.db.prepare(`
      UPDATE link_tokens
      SET expires_at = 0
      WHERE expires_at <> 0
        AND EXISTS (
          SELECT 1
          FROM jobs
          WHERE jobs.file_id = link_tokens.file_id
            AND jobs.type = 'monitor'
        )
    `).run().changes;
  }

  capTemporaryLinkTokenTtl(ttlMs) {
    const ttl = Math.max(1, Number(ttlMs) || 1);
    return this.db.prepare(`
      UPDATE link_tokens
      SET expires_at = created_at + ?
      WHERE expires_at <> 0
        AND expires_at > created_at + ?
    `).run(ttl, ttl).changes;
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

  deleteMonitorDownloadByFileId(fileId) {
    const id = Number(fileId);
    if (!Number.isFinite(id)) return { files: 0, links: 0, jobs: 0 };
    const file = this.db.prepare('SELECT id, video_id FROM files WHERE id = ?').get(id);
    if (!file) return { files: 0, links: 0, jobs: 0 };
    const monitorJob = this.db.prepare("SELECT 1 FROM jobs WHERE file_id = ? AND type = 'monitor'").get(id);
    if (!monitorJob) return { files: 0, links: 0, jobs: 0 };

    const counts = {
      files: 1,
      links: this.db.prepare('SELECT COUNT(*) AS count FROM link_tokens WHERE file_id = ?').get(id).count,
      jobs: this.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE file_id = ?').get(id).count,
    };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM link_tokens WHERE file_id = ?').run(id);
      this.db.prepare('DELETE FROM jobs WHERE file_id = ?').run(id);
      this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
      if (file.video_id) {
        this.db.prepare('UPDATE seen_videos SET next_deletion_check_at = NULL WHERE video_id = ?').run(file.video_id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return counts;
  }

  listDownloadLinksByRequester(requestedBy, { limit = 25, offset = 0, activeOnly = true, includeMonitored = false, username = '', now = Date.now() } = {}) {
    const clauses = [this.buildRequesterClause(includeMonitored)];
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
          ORDER BY jobs.created_at DESC, jobs.id DESC
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
    const clauses = [this.buildRequesterClause(includeMonitored)];
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

  listPermanentDownloadsByRequester(requestedBy, { limit = 25, offset = 0, includeMonitored = false, username = '' } = {}) {
    const clauses = [this.buildRequesterClause(includeMonitored), 'link_tokens.expires_at = 0'];
    const params = [String(requestedBy ?? '')];
    if (username) {
      clauses.push('lower(files.username) = lower(?)');
      params.push(String(username));
    }
    const sql = `
      WITH ranked_links AS (
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
            ORDER BY jobs.created_at DESC, jobs.id DESC
            LIMIT 1
          ) AS title,
          ROW_NUMBER() OVER (
            PARTITION BY files.id
            ORDER BY link_tokens.created_at DESC, link_tokens.token DESC
          ) AS row_number
        FROM link_tokens
        JOIN files ON files.id = link_tokens.file_id
        WHERE ${clauses.join('\n          AND ')}
      )
      SELECT
        token,
        expires_at,
        token_created_at,
        file_id,
        video_id,
        username,
        source_url,
        requested_by,
        filename,
        size_bytes,
        file_created_at,
        title
      FROM ranked_links
      WHERE row_number = 1
      ORDER BY token_created_at DESC, file_id DESC
      LIMIT ?
      OFFSET ?
    `;
    params.push(Math.max(1, Math.min(50, Number(limit) || 25)));
    params.push(Math.max(0, Number(offset) || 0));
    return this.db.prepare(sql).all(...params);
  }

  countPermanentDownloadsByRequester(requestedBy, { includeMonitored = false, username = '' } = {}) {
    const clauses = [this.buildRequesterClause(includeMonitored), 'link_tokens.expires_at = 0'];
    const params = [String(requestedBy ?? '')];
    if (username) {
      clauses.push('lower(files.username) = lower(?)');
      params.push(String(username));
    }
    const sql = `
      WITH ranked_links AS (
        SELECT
          files.id AS file_id,
          ROW_NUMBER() OVER (
            PARTITION BY files.id
            ORDER BY link_tokens.created_at DESC, link_tokens.token DESC
          ) AS row_number
        FROM link_tokens
        JOIN files ON files.id = link_tokens.file_id
        WHERE ${clauses.join('\n          AND ')}
      )
      SELECT COUNT(*) AS count
      FROM ranked_links
      WHERE row_number = 1
    `;
    return this.db.prepare(sql).get(...params).count;
  }

  listLinkHistoryByRequester(requestedBy, { limit = 10, offset = 0, includeMonitored = false, username = '' } = {}) {
    const clauses = [this.buildRequesterClause(includeMonitored)];
    const params = [String(requestedBy ?? '')];
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
          ORDER BY jobs.created_at DESC, jobs.id DESC
          LIMIT 1
        ) AS title,
        (
          SELECT jobs.status
          FROM jobs
          WHERE jobs.file_id = files.id
          ORDER BY jobs.created_at DESC, jobs.id DESC
          LIMIT 1
        ) AS job_status,
        (
          SELECT jobs.error
          FROM jobs
          WHERE jobs.file_id = files.id
          ORDER BY jobs.created_at DESC, jobs.id DESC
          LIMIT 1
        ) AS job_error
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE ${clauses.join('\n        AND ')}
      ORDER BY link_tokens.created_at DESC, link_tokens.token DESC
      LIMIT ?
      OFFSET ?
    `;
    params.push(Math.max(1, Math.min(50, Number(limit) || 10)));
    params.push(Math.max(0, Number(offset) || 0));
    return this.db.prepare(sql).all(...params);
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

function normalizeNullableBoolean(value) {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return null;
}

function normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

export function createStore(dbPath) {
  return new Store(path.resolve(dbPath));
}
