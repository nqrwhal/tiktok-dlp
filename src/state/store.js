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
        guild_id TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL DEFAULT '',
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
        created_at INTEGER NOT NULL,
        trashed_at INTEGER,
        delete_requested_at INTEGER,
        delete_attempts INTEGER NOT NULL DEFAULT 0,
        delete_error TEXT
      );

      CREATE TABLE IF NOT EXISTS link_tokens (
        token TEXT PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        scope_id TEXT NOT NULL DEFAULT '',
        delivery_type TEXT NOT NULL DEFAULT 'manual',
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watch_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        guild_id TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(username, guild_id)
      );

      CREATE TABLE IF NOT EXISTS creator_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        status TEXT NOT NULL,
        max_duration_seconds INTEGER NOT NULL,
        discovered_count INTEGER NOT NULL DEFAULT 0,
        processed_count INTEGER NOT NULL DEFAULT 0,
        downloaded_count INTEGER NOT NULL DEFAULT 0,
        skipped_existing_count INTEGER NOT NULL DEFAULT 0,
        skipped_duration_count INTEGER NOT NULL DEFAULT 0,
        skipped_unknown_duration_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        discovery_completed_at INTEGER,
        cancel_requested_at INTEGER,
        canceled_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        resume_count INTEGER NOT NULL DEFAULT 0,
        last_resumed_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creator_import_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        import_id INTEGER NOT NULL REFERENCES creator_imports(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL,
        position INTEGER NOT NULL,
        video_id TEXT,
        source_url TEXT NOT NULL,
        title TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        duration_seconds REAL,
        file_id INTEGER,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(import_id, item_key)
      );

      CREATE TABLE IF NOT EXISTS bookmarks (
        file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
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
    this.ensureColumn('jobs', 'guild_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('jobs', 'channel_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('files', 'requested_by', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('files', 'trashed_at', 'INTEGER');
    this.ensureColumn('files', 'delete_requested_at', 'INTEGER');
    this.ensureColumn('files', 'delete_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('files', 'delete_error', 'TEXT');
    this.ensureColumn('link_tokens', 'job_id', 'INTEGER');
    this.ensureColumn('link_tokens', 'owner_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('link_tokens', 'scope_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('link_tokens', 'delivery_type', "TEXT NOT NULL DEFAULT 'manual'");
    this.ensureColumn('seen_videos', 'deletion_check_claimed_at', 'INTEGER');
    this.ensureColumn('creator_imports', 'skipped_unknown_duration_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('creator_imports', 'discovery_completed_at', 'INTEGER');
    this.ensureColumn('creator_imports', 'cancel_requested_at', 'INTEGER');
    this.ensureColumn('creator_imports', 'canceled_at', 'INTEGER');
    this.ensureColumn('creator_imports', 'retry_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('creator_imports', 'resume_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('creator_imports', 'last_resumed_at', 'INTEGER');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_requested_by ON jobs(requested_by);
      CREATE INDEX IF NOT EXISTS idx_jobs_file_id ON jobs(file_id);
      CREATE INDEX IF NOT EXISTS idx_files_requested_by ON files(requested_by);
      CREATE INDEX IF NOT EXISTS idx_files_trashed_at ON files(trashed_at);
      CREATE INDEX IF NOT EXISTS idx_files_delete_requested_at ON files(delete_requested_at);
      CREATE INDEX IF NOT EXISTS idx_files_username_created_at ON files(username COLLATE NOCASE, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_file_id_expires_at ON link_tokens(file_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_owner_id_created_at ON link_tokens(owner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_scope_id_created_at ON link_tokens(scope_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_job_id ON link_tokens(job_id);
      CREATE INDEX IF NOT EXISTS idx_seen_videos_next_deletion_check_at ON seen_videos(next_deletion_check_at);
      CREATE INDEX IF NOT EXISTS idx_watched_users_next_check_at ON watched_users(next_check_at);
      CREATE INDEX IF NOT EXISTS idx_watch_username_history_detected_at ON watch_username_history(detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_watch_subscriptions_guild_id_username ON watch_subscriptions(guild_id, username);
      CREATE INDEX IF NOT EXISTS idx_creator_imports_created_at ON creator_imports(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_creator_imports_username_status ON creator_imports(username, status);
      CREATE INDEX IF NOT EXISTS idx_creator_import_items_import_status_position
        ON creator_import_items(import_id, status, position, id);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks(created_at DESC);
    `);
    this.migrateLegacyDeliveryOwnership();
    this.migrateLegacyWatchSubscriptions();
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  migrateLegacyDeliveryOwnership() {
    // Older versions attached the requester and monitor state to the shared
    // asset row. Preserve unambiguous ownership only; ambiguous legacy links
    // intentionally remain ownerless rather than granting another requester
    // control over them.
    this.db.exec(`
      UPDATE link_tokens
      SET job_id = (
        SELECT jobs.id
        FROM jobs
        WHERE jobs.file_id = link_tokens.file_id
        ORDER BY jobs.created_at DESC, jobs.id DESC
        LIMIT 1
      )
      WHERE job_id IS NULL;

      UPDATE link_tokens
      SET owner_id = COALESCE((
        SELECT CASE
          WHEN COUNT(*) = 1 THEN MAX(COALESCE(jobs.requested_by, ''))
          ELSE ''
        END
        FROM jobs
        WHERE jobs.file_id = link_tokens.file_id
      ), '')
      WHERE owner_id = '';

      UPDATE link_tokens
      SET delivery_type = CASE
        WHEN (
          SELECT COUNT(*)
          FROM jobs
          WHERE jobs.file_id = link_tokens.file_id
        ) = 1
          AND EXISTS (
            SELECT 1
            FROM jobs
            WHERE jobs.file_id = link_tokens.file_id
              AND jobs.type = 'monitor'
          )
        THEN 'monitor'
        ELSE delivery_type
      END
      WHERE delivery_type = '' OR delivery_type = 'manual';
    `);
  }

  migrateLegacyWatchSubscriptions() {
    this.db.exec(`
      INSERT OR IGNORE INTO watch_subscriptions (username, guild_id, channel_id, created_by, created_at)
      SELECT username, '', channel_id, '', created_at
      FROM watched_users
      WHERE channel_id <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM watch_subscriptions
          WHERE watch_subscriptions.username = watched_users.username
        );
    `);
  }

  addWatch(username, channelOrOptions, now = Date.now()) {
    const options = typeof channelOrOptions === 'object' && channelOrOptions !== null
      ? channelOrOptions
      : { channelId: channelOrOptions };
    const channelId = String(options.channelId ?? options.channel_id ?? '');
    const guildId = String(options.guildId ?? options.guild_id ?? '');
    const createdBy = String(options.createdBy ?? options.created_by ?? '');
    if (!channelId) throw new Error('A watch subscription requires a Discord channel.');
    this.db.prepare(`
      INSERT INTO watched_users (username, channel_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO NOTHING
    `).run(username, channelId, now);
    this.db.prepare(`
      INSERT INTO watch_subscriptions (username, guild_id, channel_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(username, guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        created_by = excluded.created_by
    `).run(username, guildId, channelId, createdBy, now);
    return this.getWatch(username);
  }

  removeWatch(username, scope = null) {
    if (!scope || typeof scope !== 'object') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM watch_subscriptions WHERE username = ?').run(username);
        const result = this.db.prepare('DELETE FROM watched_users WHERE username = ?').run(username);
        this.db.exec('COMMIT');
        return result.changes > 0;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    const guildId = String(scope.guildId ?? scope.guild_id ?? '');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('DELETE FROM watch_subscriptions WHERE username = ? AND guild_id = ?').run(username, guildId);
      const remaining = this.db.prepare('SELECT 1 FROM watch_subscriptions WHERE username = ? LIMIT 1').get(username);
      if (!remaining) this.db.prepare('DELETE FROM watched_users WHERE username = ?').run(username);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  listWatchesForScope({ guildId = '', channelId = '' } = {}) {
    return this.db.prepare(`
      WITH ranked_subscriptions AS (
        SELECT watch_subscriptions.*,
          ROW_NUMBER() OVER (
            PARTITION BY watch_subscriptions.username
            ORDER BY CASE WHEN watch_subscriptions.guild_id = ? THEN 0 ELSE 1 END,
              watch_subscriptions.id
          ) AS scope_rank
        FROM watch_subscriptions
        WHERE watch_subscriptions.guild_id = ?
          OR (
            watch_subscriptions.guild_id = ''
            AND watch_subscriptions.channel_id = ?
          )
      )
      SELECT watched_users.*, ranked_subscriptions.channel_id AS subscription_channel_id,
        ranked_subscriptions.created_by AS subscription_created_by
      FROM ranked_subscriptions
      JOIN watched_users ON watched_users.username = ranked_subscriptions.username
      WHERE ranked_subscriptions.scope_rank = 1
      ORDER BY watched_users.username
    `).all(String(guildId ?? ''), String(guildId ?? ''), String(channelId ?? ''));
  }

  getWatchSubscription(username, { guildId = '' } = {}) {
    return this.db.prepare(`
      SELECT *
      FROM watch_subscriptions
      WHERE username = ? AND guild_id = ?
    `).get(String(username), String(guildId ?? '')) ?? null;
  }

  hasWatchSubscription(username, scope = {}) {
    return Boolean(this.getWatchSubscription(username, scope));
  }

  listWatchSubscriptions(username) {
    return this.db.prepare(`
      SELECT *
      FROM watch_subscriptions
      WHERE username = ?
      ORDER BY guild_id, created_at, id
    `).all(String(username));
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

    this.moveWatchSubscriptions(previousUsername, nextUsername);

    return {
      changed: true,
      username: nextUsername,
      previousUsername,
      creatorId: id || existing.creator_id || '',
      secUid: nextSecUid || existing.sec_uid || '',
      authorId: nextAuthorId || existing.author_id || '',
    };
  }

  moveWatchSubscriptions(previousUsername, nextUsername) {
    if (!previousUsername || !nextUsername || previousUsername === nextUsername) return;
    this.db.prepare(`
      INSERT OR IGNORE INTO watch_subscriptions (username, guild_id, channel_id, created_by, created_at)
      SELECT ?, guild_id, channel_id, created_by, created_at
      FROM watch_subscriptions
      WHERE username = ?
    `).run(nextUsername, previousUsername);
    this.db.prepare('DELETE FROM watch_subscriptions WHERE username = ?').run(previousUsername);
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
      SET
        next_deletion_check_at = ?,
        deletion_check_claimed_at = NULL,
        last_available_at = COALESCE(last_available_at, alerted_at, seen_at)
      WHERE video_id = ?
    `).run(nextCheckAt, String(videoId));
  }

  listVideosDueForDeletionCheck(now = Date.now(), limit = 25, leaseMs = 10 * 60 * 1000) {
    return this.db.prepare(`
      SELECT
        seen_videos.*,
        (
          SELECT link_tokens.token
          FROM files
          JOIN link_tokens ON link_tokens.file_id = files.id
          WHERE files.video_id = seen_videos.video_id
            AND files.trashed_at IS NULL
            AND link_tokens.expires_at = 0
          ORDER BY link_tokens.created_at DESC
          LIMIT 1
        ) AS permanent_token,
        (
          SELECT files.filename
          FROM files
          WHERE files.video_id = seen_videos.video_id
            AND files.trashed_at IS NULL
          ORDER BY files.created_at DESC
          LIMIT 1
        ) AS filename
      FROM seen_videos
      WHERE alerted_at IS NOT NULL
        AND deleted_at IS NULL
        AND next_deletion_check_at IS NOT NULL
        AND next_deletion_check_at <= ?
        AND (deletion_check_claimed_at IS NULL OR deletion_check_claimed_at <= ?)
      ORDER BY next_deletion_check_at ASC
      LIMIT ?
    `).all(now, now - Math.max(1, Number(leaseMs) || 1), Math.max(1, Math.min(100, Number(limit) || 25)));
  }

  claimVideosDueForDeletionCheck(now = Date.now(), limit = 25, leaseMs = 10 * 60 * 1000) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const due = this.listVideosDueForDeletionCheck(now, limit, leaseMs);
      const claimAt = Math.max(0, Number(now) || 0);
      for (const video of due) {
        this.db.prepare(`
          UPDATE seen_videos
          SET deletion_check_claimed_at = ?
          WHERE video_id = ?
            AND (deletion_check_claimed_at IS NULL OR deletion_check_claimed_at <= ?)
        `).run(claimAt, String(video.video_id), claimAt - Math.max(1, Number(leaseMs) || 1));
      }
      this.db.exec('COMMIT');
      return due;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markVideoStillAvailable(videoId, nextCheckAt, now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET
        last_available_at = ?,
        last_deletion_checked_at = ?,
        next_deletion_check_at = ?,
        deletion_check_claimed_at = NULL,
        deletion_check_count = deletion_check_count + 1
      WHERE video_id = ?
    `).run(now, now, nextCheckAt, String(videoId));
  }

  postponeVideoDeletionCheck(videoId, nextCheckAt, now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET last_deletion_checked_at = ?, next_deletion_check_at = ?, deletion_check_claimed_at = NULL
      WHERE video_id = ?
    `).run(now, nextCheckAt, String(videoId));
  }

  markVideoDeleted(videoId, now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET
        deleted_at = ?,
        deletion_alerted_at = ?,
        last_deletion_checked_at = ?,
        next_deletion_check_at = NULL,
        deletion_check_claimed_at = NULL
      WHERE video_id = ?
    `).run(now, now, now, String(videoId));
    return this.db.prepare('SELECT * FROM seen_videos WHERE video_id = ?').get(String(videoId)) ?? null;
  }

  createJob({
    type,
    status = 'queued',
    requestedBy = '',
    guildId = '',
    channelId = '',
    username = '',
    sourceUrl,
    videoId = '',
    title = '',
  }, now = Date.now()) {
    const result = this.db.prepare(`
      INSERT INTO jobs (type, status, requested_by, guild_id, channel_id, username, source_url, video_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      type,
      status,
      String(requestedBy ?? ''),
      String(guildId ?? ''),
      String(channelId ?? ''),
      username,
      sourceUrl,
      videoId,
      title,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  updateJob(id, changes, now = Date.now()) {
    const allowed = ['status', 'requested_by', 'guild_id', 'channel_id', 'username', 'source_url', 'video_id', 'title', 'file_id', 'error'];
    const entries = Object.entries(changes).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE jobs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value), now, id);
  }

  listJobs(limit = 10) {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  createCreatorImport({ username, maxDurationSeconds }, now = Date.now()) {
    const result = this.db.prepare(`
      INSERT INTO creator_imports (
        username,
        status,
        max_duration_seconds,
        created_at,
        updated_at
      ) VALUES (?, 'queued', ?, ?, ?)
    `).run(String(username), Number(maxDurationSeconds), now, now);
    return Number(result.lastInsertRowid);
  }

  updateCreatorImport(id, changes, now = Date.now()) {
    const allowed = [
      'status',
      'max_duration_seconds',
      'discovered_count',
      'processed_count',
      'downloaded_count',
      'skipped_existing_count',
      'skipped_duration_count',
      'skipped_unknown_duration_count',
      'failed_count',
      'last_error',
      'started_at',
      'completed_at',
      'discovery_completed_at',
      'cancel_requested_at',
      'canceled_at',
      'retry_count',
      'resume_count',
      'last_resumed_at',
    ];
    const entries = Object.entries(changes).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE creator_imports SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value), now, Number(id));
  }

  getCreatorImport(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    return this.db.prepare('SELECT * FROM creator_imports WHERE id = ?').get(numericId) ?? null;
  }

  listCreatorImports(limit = 20) {
    return this.db.prepare(`
      SELECT *
      FROM creator_imports
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  findActiveCreatorImport(username) {
    return this.db.prepare(`
      SELECT *
      FROM creator_imports
      WHERE lower(username) = lower(?)
        AND status IN ('queued', 'running')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(String(username)) ?? null;
  }

  beginCreatorImport(id, now = Date.now()) {
    const result = this.db.prepare(`
      UPDATE creator_imports
      SET
        status = 'running',
        started_at = COALESCE(started_at, ?),
        completed_at = NULL,
        canceled_at = NULL,
        updated_at = ?
      WHERE id = ?
        AND status = 'queued'
        AND cancel_requested_at IS NULL
    `).run(now, now, Number(id));
    return result.changes > 0 ? this.getCreatorImport(id) : null;
  }

  checkpointCreatorImportDiscovery(importId, items = [], now = Date.now()) {
    const numericId = Number(importId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.getCreatorImport(numericId);
      if (!record || !['queued', 'running'].includes(record.status)) {
        throw new Error('Creator import is not active.');
      }
      const insert = this.db.prepare(`
        INSERT INTO creator_import_items (
          import_id,
          item_key,
          position,
          video_id,
          source_url,
          title,
          metadata_json,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        ON CONFLICT(import_id, item_key) DO UPDATE SET
          position = excluded.position,
          video_id = COALESCE(NULLIF(excluded.video_id, ''), creator_import_items.video_id),
          source_url = excluded.source_url,
          title = excluded.title,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `);
      for (const item of items) {
        insert.run(
          numericId,
          String(item.itemKey),
          Number(item.position),
          String(item.videoId ?? ''),
          String(item.sourceUrl ?? ''),
          String(item.title ?? ''),
          String(item.metadataJson ?? '{}'),
          now,
          now,
        );
      }
      const discoveredCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM creator_import_items
        WHERE import_id = ?
      `).get(numericId).count);
      this.db.prepare(`
        UPDATE creator_imports
        SET
          discovered_count = ?,
          discovery_completed_at = COALESCE(discovery_completed_at, ?),
          updated_at = ?
        WHERE id = ?
      `).run(discoveredCount, now, now, numericId);
      this.db.exec('COMMIT');
      return this.getCreatorImport(numericId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listCreatorImportItems(importId, limit = 1_000) {
    return this.db.prepare(`
      SELECT *
      FROM creator_import_items
      WHERE import_id = ?
      ORDER BY position ASC, id ASC
      LIMIT ?
    `).all(Number(importId), Math.max(1, Math.min(10_000, Number(limit) || 1_000)));
  }

  claimNextCreatorImportItem(importId, now = Date.now()) {
    const numericId = Number(importId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare(`
        SELECT id
        FROM creator_imports
        WHERE id = ?
          AND status = 'running'
          AND cancel_requested_at IS NULL
      `).get(numericId);
      if (!active) {
        this.db.exec('COMMIT');
        return null;
      }
      const item = this.db.prepare(`
        SELECT *
        FROM creator_import_items
        WHERE import_id = ?
          AND status = 'queued'
        ORDER BY position ASC, id ASC
        LIMIT 1
      `).get(numericId) ?? null;
      if (item) {
        this.db.prepare(`
          UPDATE creator_import_items
          SET
            status = 'running',
            attempt_count = attempt_count + 1,
            error = NULL,
            completed_at = NULL,
            updated_at = ?
          WHERE id = ?
            AND status = 'queued'
        `).run(now, Number(item.id));
      }
      this.db.exec('COMMIT');
      return item ? this.db.prepare('SELECT * FROM creator_import_items WHERE id = ?').get(Number(item.id)) : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completeCreatorImportItem(itemId, {
    status,
    videoId = '',
    durationSeconds = null,
    fileId = null,
    error = null,
  } = {}, now = Date.now()) {
    const terminalStatuses = new Set([
      'downloaded',
      'skipped_existing',
      'skipped_duration',
      'skipped_unknown_duration',
      'failed',
    ]);
    if (!terminalStatuses.has(status)) throw new Error(`Invalid creator import item status: ${status}`);
    const numericItemId = Number(itemId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const item = this.db.prepare('SELECT import_id FROM creator_import_items WHERE id = ?').get(numericItemId);
      if (!item) throw new Error('Creator import item was not found.');
      this.db.prepare(`
        UPDATE creator_import_items
        SET
          status = ?,
          video_id = COALESCE(NULLIF(?, ''), video_id),
          duration_seconds = ?,
          file_id = ?,
          error = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        status,
        String(videoId ?? ''),
        durationSeconds == null ? null : Number(durationSeconds),
        fileId == null ? null : Number(fileId),
        error == null ? null : String(error).slice(0, 1_000),
        now,
        now,
        numericItemId,
      );
      this.#refreshCreatorImportCounts(Number(item.import_id), now);
      this.db.exec('COMMIT');
      return this.db.prepare('SELECT * FROM creator_import_items WHERE id = ?').get(numericItemId);
    } catch (caught) {
      this.db.exec('ROLLBACK');
      throw caught;
    }
  }

  requestCreatorImportCancel(id, now = Date.now()) {
    const numericId = Number(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.getCreatorImport(numericId);
      if (!record) {
        this.db.exec('COMMIT');
        return { accepted: false, reason: 'not_found', import: null };
      }
      if (!['queued', 'running'].includes(record.status)) {
        this.db.exec('COMMIT');
        return { accepted: false, reason: 'not_active', import: record };
      }
      if (record.status === 'queued') {
        this.db.prepare(`
          UPDATE creator_imports
          SET
            status = 'canceled',
            cancel_requested_at = COALESCE(cancel_requested_at, ?),
            canceled_at = ?,
            completed_at = ?,
            updated_at = ?
          WHERE id = ?
        `).run(now, now, now, now, numericId);
      } else {
        this.db.prepare(`
          UPDATE creator_imports
          SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
          WHERE id = ?
        `).run(now, now, numericId);
      }
      this.db.exec('COMMIT');
      return { accepted: true, reason: null, import: this.getCreatorImport(numericId) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finalizeCanceledCreatorImport(id, now = Date.now()) {
    const numericId = Number(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.#refreshCreatorImportCounts(numericId, now);
      this.db.prepare(`
        UPDATE creator_imports
        SET
          status = 'canceled',
          cancel_requested_at = COALESCE(cancel_requested_at, ?),
          canceled_at = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
          AND status IN ('queued', 'running')
      `).run(now, now, now, now, numericId);
      this.db.exec('COMMIT');
      return this.getCreatorImport(numericId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pauseCreatorImport(id, now = Date.now()) {
    this.db.prepare(`
      UPDATE creator_imports
      SET status = 'queued', updated_at = ?
      WHERE id = ?
        AND status = 'running'
        AND cancel_requested_at IS NULL
    `).run(now, Number(id));
    return this.getCreatorImport(id);
  }

  retryCreatorImport(id, now = Date.now()) {
    const numericId = Number(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.getCreatorImport(numericId);
      if (!record) {
        this.db.exec('COMMIT');
        return { accepted: false, reason: 'not_found', import: null };
      }
      if (!['failed', 'canceled'].includes(record.status)) {
        this.db.exec('COMMIT');
        return { accepted: false, reason: 'not_retryable', import: record };
      }
      this.db.prepare(`
        UPDATE creator_import_items
        SET status = 'queued', error = NULL, completed_at = NULL, updated_at = ?
        WHERE import_id = ?
          AND status = 'running'
      `).run(now, numericId);
      this.db.prepare(`
        UPDATE creator_imports
        SET
          status = 'queued',
          last_error = NULL,
          started_at = NULL,
          completed_at = NULL,
          cancel_requested_at = NULL,
          canceled_at = NULL,
          retry_count = retry_count + 1,
          updated_at = ?
        WHERE id = ?
      `).run(now, numericId);
      this.#refreshCreatorImportCounts(numericId, now);
      this.db.exec('COMMIT');
      return { accepted: true, reason: null, import: this.getCreatorImport(numericId) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  resumeIncompleteCreatorImports(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE creator_imports
        SET
          status = 'canceled',
          canceled_at = COALESCE(canceled_at, ?),
          completed_at = COALESCE(completed_at, ?),
          updated_at = ?
        WHERE status IN ('queued', 'running')
          AND cancel_requested_at IS NOT NULL
      `).run(now, now, now);
      this.db.prepare(`
        UPDATE creator_import_items
        SET status = 'queued', error = NULL, completed_at = NULL, updated_at = ?
        WHERE status = 'running'
          AND import_id IN (
            SELECT id FROM creator_imports WHERE status IN ('queued', 'running')
          )
      `).run(now);
      this.db.prepare(`
        UPDATE creator_imports
        SET
          status = 'queued',
          resume_count = resume_count + 1,
          last_resumed_at = ?,
          updated_at = ?
        WHERE status IN ('queued', 'running')
          AND cancel_requested_at IS NULL
      `).run(now, now);
      const imports = this.db.prepare(`
        SELECT *
        FROM creator_imports
        WHERE status = 'queued'
        ORDER BY created_at ASC, id ASC
      `).all();
      this.db.exec('COMMIT');
      return imports;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  failIncompleteCreatorImports(now = Date.now()) {
    return this.resumeIncompleteCreatorImports(now).length;
  }

  #refreshCreatorImportCounts(importId, now = Date.now()) {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS discovered_count,
        SUM(CASE WHEN status IN ('downloaded', 'skipped_existing', 'skipped_duration', 'skipped_unknown_duration', 'failed') THEN 1 ELSE 0 END) AS processed_count,
        SUM(CASE WHEN status = 'downloaded' THEN 1 ELSE 0 END) AS downloaded_count,
        SUM(CASE WHEN status = 'skipped_existing' THEN 1 ELSE 0 END) AS skipped_existing_count,
        SUM(CASE WHEN status = 'skipped_duration' THEN 1 ELSE 0 END) AS skipped_duration_count,
        SUM(CASE WHEN status = 'skipped_unknown_duration' THEN 1 ELSE 0 END) AS skipped_unknown_duration_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
      FROM creator_import_items
      WHERE import_id = ?
    `).get(Number(importId));
    const latestFailure = this.db.prepare(`
      SELECT error
      FROM creator_import_items
      WHERE import_id = ?
        AND status = 'failed'
        AND error IS NOT NULL
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `).get(Number(importId));
    this.db.prepare(`
      UPDATE creator_imports
      SET
        discovered_count = ?,
        processed_count = ?,
        downloaded_count = ?,
        skipped_existing_count = ?,
        skipped_duration_count = ?,
        skipped_unknown_duration_count = ?,
        failed_count = ?,
        last_error = COALESCE(?, last_error),
        updated_at = ?
      WHERE id = ?
    `).run(
      Number(counts?.discovered_count ?? 0),
      Number(counts?.processed_count ?? 0),
      Number(counts?.downloaded_count ?? 0),
      Number(counts?.skipped_existing_count ?? 0),
      Number(counts?.skipped_duration_count ?? 0),
      Number(counts?.skipped_unknown_duration_count ?? 0),
      Number(counts?.failed_count ?? 0),
      latestFailure?.error ?? null,
      now,
      Number(importId),
    );
  }

  createFileRecord({ videoId = '', username = '', requestedBy = '', sourceUrl, filePath, filename, sizeBytes }, now = Date.now()) {
    const result = this.db.prepare(`
      INSERT INTO files (video_id, username, requested_by, source_url, path, filename, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(videoId, username, String(requestedBy ?? ''), sourceUrl, filePath, filename, sizeBytes, now);
    return Number(result.lastInsertRowid);
  }

  getLatestFileByVideoId(videoId, { includeTrashed = false } = {}) {
    if (!videoId) return null;
    return this.db.prepare(`
      SELECT *
      FROM files
      WHERE video_id = ?
        ${includeTrashed ? '' : 'AND trashed_at IS NULL AND delete_requested_at IS NULL'}
      ORDER BY created_at DESC
      LIMIT 1
    `).get(String(videoId)) ?? null;
  }

  createLinkToken({
    token,
    fileId,
    jobId = null,
    ownerId = '',
    scopeId = '',
    deliveryType = 'manual',
    expiresAt,
  }, now = Date.now()) {
    const fileRecord = this.db.prepare('SELECT requested_by, trashed_at FROM files WHERE id = ?').get(fileId);
    if (!fileRecord || fileRecord.trashed_at != null) {
      throw new Error('Cannot create a delivery for a missing or trashed archive file.');
    }
    let resolvedJobId = jobId == null ? null : Number(jobId);
    let linkedJob = null;
    if (resolvedJobId == null) {
      linkedJob = this.db.prepare(`
        SELECT id, type, requested_by
        FROM jobs
        WHERE file_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(fileId) ?? null;
      resolvedJobId = linkedJob ? Number(linkedJob.id) : null;
    } else {
      linkedJob = this.db.prepare('SELECT id, type, requested_by FROM jobs WHERE id = ?').get(resolvedJobId) ?? null;
    }
    const legacyOwner = fileRecord.requested_by ?? '';
    const resolvedOwnerId = String(ownerId || linkedJob?.requested_by || legacyOwner || '');
    const resolvedDeliveryType = deliveryType === 'manual' && linkedJob?.type === 'monitor'
      ? 'monitor'
      : String(deliveryType ?? 'manual');
    this.db.prepare(`
      INSERT INTO link_tokens (token, file_id, job_id, owner_id, scope_id, delivery_type, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token,
      fileId,
      resolvedJobId,
      resolvedOwnerId,
      String(scopeId ?? ''),
      resolvedDeliveryType,
      expiresAt,
      now,
    );
    // A new delivery revives an asset that an earlier cleanup pass had marked
    // for deletion. Its historical attempt count remains useful for diagnosis.
    this.db.prepare(`
      UPDATE files
      SET delete_requested_at = NULL, delete_error = NULL
      WHERE id = ?
    `).run(fileId);
  }

  buildRequesterClause(includeMonitored, scopeId = '') {
    return includeMonitored
      ? `(
          link_tokens.owner_id = ?
          OR (link_tokens.delivery_type = 'monitor' AND link_tokens.scope_id = ?)
        )`
      : 'link_tokens.owner_id = ?';
  }

  buildRequesterParams(requestedBy, includeMonitored, scopeId = '') {
    const ownerId = String(requestedBy ?? '');
    return includeMonitored ? [ownerId, String(scopeId ?? '')] : [ownerId];
  }

  getToken(token) {
    return this.db.prepare(`
      SELECT
        link_tokens.token,
        link_tokens.job_id,
        link_tokens.owner_id,
        link_tokens.scope_id,
        link_tokens.delivery_type,
        link_tokens.expires_at,
        link_tokens.created_at AS token_created_at,
        files.*
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE link_tokens.token = ?
        AND files.trashed_at IS NULL
    `).get(token) ?? null;
  }

  getMonitorFileByToken(token) {
    return this.db.prepare(`
      SELECT
        link_tokens.token,
        link_tokens.job_id,
        link_tokens.owner_id,
        link_tokens.scope_id,
        link_tokens.delivery_type,
        link_tokens.expires_at,
        link_tokens.created_at AS token_created_at,
        files.*,
        files.id AS file_id
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE link_tokens.token = ?
        AND files.trashed_at IS NULL
        AND link_tokens.delivery_type = 'monitor'
    `).get(String(token ?? '')) ?? null;
  }

  getLatestPermanentTokenForVideo(videoId, { scopeId = '' } = {}) {
    if (!videoId) return '';
    const row = this.db.prepare(`
      SELECT link_tokens.token
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE files.video_id = ?
        AND files.trashed_at IS NULL
        AND link_tokens.delivery_type = 'monitor'
        AND link_tokens.expires_at = 0
        AND link_tokens.scope_id = ?
      ORDER BY link_tokens.created_at DESC, link_tokens.token DESC
      LIMIT 1
    `).get(String(videoId), String(scopeId ?? ''));
    return String(row?.token ?? '');
  }

  getValidToken(token, now = Date.now()) {
    return this.db.prepare(`
      SELECT
        link_tokens.token,
        link_tokens.job_id,
        link_tokens.owner_id,
        link_tokens.scope_id,
        link_tokens.delivery_type,
        link_tokens.expires_at,
        link_tokens.created_at AS token_created_at,
        files.*
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE link_tokens.token = ?
        AND files.trashed_at IS NULL
        AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
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
        AND file_id IN (SELECT id FROM files WHERE trashed_at IS NULL)
    `).run(now, additionalMs, newExpiry, token);
    return result.changes > 0 ? this.getToken(token) : null;
  }

  setLinkTokenPermanent(token) {
    const result = this.db.prepare(`
      UPDATE link_tokens
      SET expires_at = 0
      WHERE token = ?
        AND file_id IN (SELECT id FROM files WHERE trashed_at IS NULL)
    `).run(token);
    return result.changes > 0 ? this.getToken(token) : null;
  }

  deleteExpiredTokens(now = Date.now()) {
    return this.db.prepare('DELETE FROM link_tokens WHERE expires_at > 0 AND expires_at <= ?').run(now).changes;
  }

  listFilesWithoutActiveLinks(now = Date.now(), limit = 100, createdBefore = now) {
    return this.db.prepare(`
      SELECT files.id, files.path, files.filename, files.video_id
      FROM files
      WHERE files.trashed_at IS NULL
        AND (files.delete_requested_at IS NOT NULL OR files.created_at <= ?)
        AND NOT EXISTS (
          SELECT 1
          FROM link_tokens
          WHERE link_tokens.file_id = files.id
            AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM files AS shared_files
          JOIN link_tokens AS shared_links ON shared_links.file_id = shared_files.id
          WHERE shared_files.path = files.path
            AND shared_files.id <> files.id
            AND (shared_links.expires_at = 0 OR shared_links.expires_at > ?)
        )
      ORDER BY files.created_at ASC
      LIMIT ?
    `).all(createdBefore, now, now, Math.max(1, Math.min(1_000, Number(limit) || 100)));
  }

  claimFilesForDeletion(now = Date.now(), limit = 100, createdBefore = now) {
    const boundedLimit = Math.max(1, Math.min(1_000, Number(limit) || 100));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const files = this.db.prepare(`
        SELECT files.id, files.path, files.filename, files.video_id
        FROM files
        WHERE files.trashed_at IS NULL
          AND (files.delete_requested_at IS NOT NULL OR files.created_at <= ?)
          AND NOT EXISTS (
            SELECT 1
            FROM link_tokens
            WHERE link_tokens.file_id = files.id
              AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM files AS shared_files
            JOIN link_tokens AS shared_links ON shared_links.file_id = shared_files.id
            WHERE shared_files.path = files.path
              AND shared_files.id <> files.id
              AND (shared_links.expires_at = 0 OR shared_links.expires_at > ?)
          )
        ORDER BY
          CASE WHEN files.delete_requested_at IS NULL THEN 0 ELSE 1 END,
          files.created_at ASC,
          files.id ASC
        LIMIT ?
      `).all(createdBefore, now, now, boundedLimit);
      if (files.length) {
        const ids = files.map((file) => Number(file.id));
        const placeholders = ids.map(() => '?').join(', ');
        this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = ?,
            delete_attempts = delete_attempts + 1,
            delete_error = NULL
          WHERE id IN (${placeholders})
        `).run(now, ...ids);
      }
      this.db.exec('COMMIT');
      return files;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markFileDeletionFailed(fileId, error, now = Date.now()) {
    const message = String(error?.message ?? error ?? 'Unknown disk deletion failure').slice(0, 500);
    const result = this.db.prepare(`
      UPDATE files
      SET
        delete_requested_at = COALESCE(delete_requested_at, ?),
        delete_attempts = delete_attempts + CASE WHEN delete_requested_at IS NULL THEN 1 ELSE 0 END,
        delete_error = ?
      WHERE id = ?
    `).run(now, message, Number(fileId));
    return result.changes > 0;
  }

  listBookmarkedFileIds() {
    return this.db.prepare(`
      SELECT bookmarks.file_id
      FROM bookmarks
      JOIN files ON files.id = bookmarks.file_id
      WHERE files.trashed_at IS NULL
        AND lower(files.filename) LIKE '%.mp4'
      ORDER BY bookmarks.created_at DESC, bookmarks.file_id DESC
    `).all().map((row) => Number(row.file_id));
  }

  setFileBookmark(fileId, bookmarked, now = Date.now()) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return false;
    if (!bookmarked) {
      this.db.prepare('DELETE FROM bookmarks WHERE file_id = ?').run(numericId);
      return true;
    }
    const result = this.db.prepare(`
      INSERT INTO bookmarks (file_id, created_at)
      SELECT id, ?
      FROM files
      WHERE id = ?
        AND trashed_at IS NULL
        AND lower(filename) LIKE '%.mp4'
      ON CONFLICT(file_id) DO NOTHING
    `).run(now, numericId);
    if (result.changes > 0) return true;
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM bookmarks
      JOIN files ON files.id = bookmarks.file_id
      WHERE bookmarks.file_id = ?
        AND files.trashed_at IS NULL
    `).get(numericId));
  }

  addFileBookmarks(fileIds, now = Date.now()) {
    const ids = normalizeIds(fileIds).slice(0, 5_000);
    if (!ids.length) return this.listBookmarkedFileIds();
    const insert = this.db.prepare(`
      INSERT INTO bookmarks (file_id, created_at)
      SELECT id, ?
      FROM files
      WHERE id = ?
        AND trashed_at IS NULL
        AND lower(filename) LIKE '%.mp4'
      ON CONFLICT(file_id) DO NOTHING
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) insert.run(now, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listBookmarkedFileIds();
  }

  trashFile(fileId, now = Date.now()) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const result = this.db.prepare(`
      UPDATE files
      SET
        trashed_at = ?,
        delete_requested_at = NULL,
        delete_error = NULL
      WHERE id = ?
        AND trashed_at IS NULL
    `).run(now, numericId);
    if (!result.changes) return null;
    return this.getTrashedFile(numericId);
  }

  trashCreatorVideoFiles(username, now = Date.now()) {
    const normalized = String(username ?? '').trim().replace(/^@/, '');
    if (!normalized) return [];
    const files = this.db.prepare(`
      SELECT id
      FROM files
      WHERE lower(username) = lower(?)
        AND lower(filename) LIKE '%.mp4'
        AND trashed_at IS NULL
      ORDER BY created_at ASC, id ASC
    `).all(normalized);
    if (!files.length) return [];
    const ids = files.map((file) => Number(file.id));
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`
      UPDATE files
      SET
        trashed_at = ?,
        delete_requested_at = NULL,
        delete_error = NULL
      WHERE id IN (${placeholders})
    `).run(now, ...ids);
    return ids;
  }

  getTrashedFile(fileId) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    return this.db.prepare(`
      SELECT *
      FROM files
      WHERE id = ?
        AND trashed_at IS NOT NULL
    `).get(numericId) ?? null;
  }

  listTrashedFiles(limit = 100) {
    return this.db.prepare(`
      SELECT id, video_id, username, source_url, path, filename, size_bytes, created_at, trashed_at
      FROM files
      WHERE trashed_at IS NOT NULL
      ORDER BY trashed_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(1_000, Number(limit) || 100)));
  }

  restoreTrashedFile(fileId) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const result = this.db.prepare(`
      UPDATE files
      SET
        trashed_at = NULL,
        delete_requested_at = NULL,
        delete_error = NULL
      WHERE id = ?
        AND trashed_at IS NOT NULL
        AND (delete_requested_at IS NULL OR delete_error IS NOT NULL)
    `).run(numericId);
    return result.changes > 0 ? this.db.prepare('SELECT * FROM files WHERE id = ?').get(numericId) : null;
  }

  claimTrashedFilesForDeletion(trashedBefore, now = Date.now(), limit = 100) {
    const boundedLimit = Math.max(1, Math.min(1_000, Number(limit) || 100));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const files = this.db.prepare(`
        SELECT id, path, filename, video_id, username, trashed_at
        FROM files
        WHERE trashed_at IS NOT NULL
          AND trashed_at <= ?
        ORDER BY
          CASE WHEN delete_requested_at IS NULL THEN 0 ELSE 1 END,
          trashed_at ASC,
          id ASC
        LIMIT ?
      `).all(Number(trashedBefore), boundedLimit);
      if (files.length) {
        const ids = files.map((file) => Number(file.id));
        const placeholders = ids.map(() => '?').join(', ');
        this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = ?,
            delete_attempts = delete_attempts + 1,
            delete_error = NULL
          WHERE id IN (${placeholders})
            AND trashed_at IS NOT NULL
        `).run(now, ...ids);
      }
      this.db.exec('COMMIT');
      return files;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listFilePathsReferencedOutside(fileIds = []) {
    const ids = normalizeIds(fileIds);
    if (!ids.length) return this.db.prepare('SELECT DISTINCT path FROM files').all().map((row) => row.path);
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT DISTINCT path
      FROM files
      WHERE id NOT IN (${placeholders})
    `).all(...ids).map((row) => row.path);
  }

  deleteFileRecords(ids = []) {
    const uniqueIds = normalizeIds(ids);
    if (!uniqueIds.length) return 0;
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const files = this.db.prepare(`SELECT id, video_id FROM files WHERE id IN (${placeholders})`).all(...uniqueIds);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`DELETE FROM jobs WHERE file_id IN (${placeholders})`).run(...uniqueIds);
      const deleted = this.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...uniqueIds).changes;
      for (const file of files) {
        if (file.video_id) {
          this.db.prepare('UPDATE seen_videos SET next_deletion_check_at = NULL WHERE video_id = ?').run(file.video_id);
        }
      }
      this.db.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  planDeliveryDeletion(token, now = Date.now()) {
    const record = this.getToken(token);
    if (!record) return null;
    const hasOtherActiveLinks = Boolean(this.db.prepare(`
      SELECT 1
      FROM files AS shared_files
      JOIN link_tokens AS shared_links ON shared_links.file_id = shared_files.id
      WHERE shared_files.path = ?
        AND (
          shared_files.id <> ?
          OR shared_links.token <> ?
        )
        AND (shared_links.expires_at = 0 OR shared_links.expires_at > ?)
      LIMIT 1
    `).get(record.path, record.id, String(token), now));
    return {
      record,
      file: hasOtherActiveLinks ? null : {
        id: record.id,
        path: record.path,
        filename: record.filename,
        video_id: record.video_id,
      },
    };
  }

  deleteDeliveryToken(token, { deleteFile = false, now = Date.now() } = {}) {
    const record = this.getToken(token);
    if (!record) return { files: 0, links: 0, jobs: 0 };
    const fileId = Number(record.id);
    const jobId = Number(record.job_id);
    let files = 0;
    let jobs = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let links = this.db.prepare('DELETE FROM link_tokens WHERE token = ?').run(String(token)).changes;
      if (Number.isFinite(jobId)) {
        const remainingJobLinks = this.db.prepare('SELECT 1 FROM link_tokens WHERE job_id = ? LIMIT 1').get(jobId);
        if (!remainingJobLinks) {
          jobs = this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId).changes;
        }
      }
      if (deleteFile) {
        links += this.db.prepare(`
          DELETE FROM link_tokens
          WHERE file_id = ?
            AND expires_at > 0
            AND expires_at <= ?
        `).run(fileId, now).changes;
      }
      if (deleteFile && !this.db.prepare('SELECT 1 FROM link_tokens WHERE file_id = ? LIMIT 1').get(fileId)) {
        const file = this.db.prepare('SELECT video_id FROM files WHERE id = ?').get(fileId);
        jobs += this.db.prepare('DELETE FROM jobs WHERE file_id = ?').run(fileId).changes;
        files = this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId).changes;
        if (file?.video_id) {
          this.db.prepare('UPDATE seen_videos SET next_deletion_check_at = NULL WHERE video_id = ?').run(file.video_id);
        }
      }
      this.db.exec('COMMIT');
      return { files, links, jobs };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listDownloadLinksByRequester(requestedBy, {
    limit = 25,
    offset = 0,
    activeOnly = true,
    includeMonitored = false,
    scopeId = '',
    username = '',
    now = Date.now(),
  } = {}) {
    const clauses = [this.buildRequesterClause(includeMonitored, scopeId), 'files.trashed_at IS NULL'];
    const params = this.buildRequesterParams(requestedBy, includeMonitored, scopeId);
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
        link_tokens.owner_id,
        link_tokens.scope_id,
        link_tokens.delivery_type,
        link_tokens.job_id,
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
          SELECT jobs.title FROM jobs WHERE jobs.id = link_tokens.job_id
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

  countDownloadLinksByRequester(requestedBy, {
    activeOnly = true,
    includeMonitored = false,
    scopeId = '',
    username = '',
    now = Date.now(),
  } = {}) {
    const clauses = [this.buildRequesterClause(includeMonitored, scopeId), 'files.trashed_at IS NULL'];
    const params = this.buildRequesterParams(requestedBy, includeMonitored, scopeId);
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

  listPermanentDownloadsByRequester(requestedBy, {
    limit = 25,
    offset = 0,
    includeMonitored = false,
    scopeId = '',
    username = '',
  } = {}) {
    const clauses = [this.buildRequesterClause(includeMonitored, scopeId), 'link_tokens.expires_at = 0', 'files.trashed_at IS NULL'];
    const params = this.buildRequesterParams(requestedBy, includeMonitored, scopeId);
    if (username) {
      clauses.push('lower(files.username) = lower(?)');
      params.push(String(username));
    }
    const sql = `
      WITH ranked_links AS (
        SELECT
          link_tokens.token,
          link_tokens.owner_id,
          link_tokens.scope_id,
          link_tokens.delivery_type,
          link_tokens.job_id,
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
          (SELECT jobs.title FROM jobs WHERE jobs.id = link_tokens.job_id) AS title,
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
        owner_id,
        scope_id,
        delivery_type,
        job_id,
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

  countPermanentDownloadsByRequester(requestedBy, { includeMonitored = false, scopeId = '', username = '' } = {}) {
    const clauses = [this.buildRequesterClause(includeMonitored, scopeId), 'link_tokens.expires_at = 0', 'files.trashed_at IS NULL'];
    const params = this.buildRequesterParams(requestedBy, includeMonitored, scopeId);
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

  listLinkHistoryByRequester(requestedBy, {
    limit = 10,
    offset = 0,
    includeMonitored = false,
    scopeId = '',
    username = '',
  } = {}) {
    const clauses = [this.buildRequesterClause(includeMonitored, scopeId), 'files.trashed_at IS NULL'];
    const params = this.buildRequesterParams(requestedBy, includeMonitored, scopeId);
    if (username) {
      clauses.push('lower(files.username) = lower(?)');
      params.push(String(username));
    }
    const sql = `
      SELECT
        link_tokens.token,
        link_tokens.owner_id,
        link_tokens.scope_id,
        link_tokens.delivery_type,
        link_tokens.job_id,
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
        (SELECT jobs.title FROM jobs WHERE jobs.id = link_tokens.job_id) AS title,
        (SELECT jobs.status FROM jobs WHERE jobs.id = link_tokens.job_id) AS job_status,
        (SELECT jobs.error FROM jobs WHERE jobs.id = link_tokens.job_id) AS job_error
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

  listPurgePlan({ requestedBy = '', now = Date.now() } = {}) {
    if (!requestedBy) {
      return this.db.prepare(`
        SELECT id, path, filename, video_id
        FROM files
        WHERE trashed_at IS NULL
        ORDER BY created_at ASC
      `).all();
    }
    return this.db.prepare(`
      SELECT files.id, files.path, files.filename, files.video_id
      FROM files
      WHERE files.trashed_at IS NULL
        AND EXISTS (
        SELECT 1
        FROM link_tokens
        WHERE link_tokens.file_id = files.id
          AND link_tokens.owner_id = ?
      )
        AND NOT EXISTS (
          SELECT 1
          FROM link_tokens
          WHERE link_tokens.file_id = files.id
            AND link_tokens.owner_id <> ?
            AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM files AS shared_files
          JOIN link_tokens AS shared_links ON shared_links.file_id = shared_files.id
          WHERE shared_files.path = files.path
            AND shared_files.id <> files.id
            AND (shared_links.expires_at = 0 OR shared_links.expires_at > ?)
        )
      ORDER BY files.created_at ASC
    `).all(String(requestedBy), String(requestedBy), now, now);
  }

  // Kept as a compatibility alias for callers that need to remove bytes before
  // committing a purge. New callers should use listPurgePlan() explicitly.
  listFilesForPurge(options = {}) {
    return this.listPurgePlan(options);
  }

  listCreatorVideoPurgePlan(username) {
    const normalized = String(username ?? '').trim().replace(/^@/, '');
    if (!normalized) return [];
    return this.db.prepare(`
      SELECT
        files.id,
        files.path,
        files.filename,
        files.video_id,
        EXISTS (
          SELECT 1
          FROM files AS shared_files
          WHERE shared_files.path = files.path
            AND shared_files.id <> files.id
            AND (
              lower(COALESCE(shared_files.username, '')) <> lower(?)
              OR lower(shared_files.filename) NOT LIKE '%.mp4'
            )
        ) AS has_external_path_ref
      FROM files
      WHERE lower(files.username) = lower(?)
        AND lower(files.filename) LIKE '%.mp4'
        AND files.trashed_at IS NULL
      ORDER BY files.created_at ASC, files.id ASC
    `).all(normalized, normalized);
  }

  getVideoFilePurgePlan(fileId) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    return this.db.prepare(`
      SELECT
        files.id,
        files.path,
        files.filename,
        files.video_id,
        files.username,
        EXISTS (
          SELECT 1
          FROM files AS shared_files
          WHERE shared_files.path = files.path
            AND shared_files.id <> files.id
        ) AS has_other_path_ref
      FROM files
      WHERE files.id = ?
        AND lower(files.filename) LIKE '%.mp4'
        AND files.trashed_at IS NULL
    `).get(numericId) ?? null;
  }

  purgeDownloads({ requestedBy = '', removeFileIds = null, now = Date.now() } = {}) {
    const scoped = Boolean(requestedBy);
    const requestedIds = normalizeIds(removeFileIds ?? this.listPurgePlan({ requestedBy, now }).map((file) => file.id));
    const removableIds = scoped
      ? this.filterRemovablePurgeFileIds(requestedIds, String(requestedBy), now)
      : requestedIds;
    const counts = { files: 0, links: 0, jobs: 0 };
    const placeholders = removableIds.map(() => '?').join(', ');
    const files = removableIds.length
      ? this.db.prepare(`SELECT id, video_id FROM files WHERE id IN (${placeholders})`).all(...removableIds)
      : [];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (scoped) {
        counts.links += this.db.prepare(`
          DELETE FROM link_tokens
          WHERE owner_id = ?
            AND file_id IN (SELECT id FROM files WHERE trashed_at IS NULL)
        `).run(String(requestedBy)).changes;
        counts.jobs += this.db.prepare(`
          DELETE FROM jobs
          WHERE requested_by = ?
            AND (
              file_id IS NULL
              OR file_id IN (SELECT id FROM files WHERE trashed_at IS NULL)
            )
        `).run(String(requestedBy)).changes;
      } else {
        counts.jobs += this.db.prepare('DELETE FROM jobs WHERE file_id IS NULL').run().changes;
      }

      if (removableIds.length) {
        counts.links += this.db.prepare(`DELETE FROM link_tokens WHERE file_id IN (${placeholders})`).run(...removableIds).changes;
        counts.jobs += this.db.prepare(`DELETE FROM jobs WHERE file_id IN (${placeholders})`).run(...removableIds).changes;
        counts.files = this.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...removableIds).changes;
        for (const file of files) {
          if (file.video_id) {
            this.db.prepare('UPDATE seen_videos SET next_deletion_check_at = NULL WHERE video_id = ?').run(file.video_id);
          }
        }
      }

      this.db.exec('COMMIT');
      return counts;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  filterRemovablePurgeFileIds(ids, requestedBy, now = Date.now()) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT files.id
      FROM files
      WHERE files.id IN (${placeholders})
        AND files.trashed_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM link_tokens
          WHERE link_tokens.file_id = files.id
            AND link_tokens.owner_id = ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM link_tokens
          WHERE link_tokens.file_id = files.id
            AND link_tokens.owner_id <> ?
            AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM files AS shared_files
          JOIN link_tokens AS shared_links ON shared_links.file_id = shared_files.id
          WHERE shared_files.path = files.path
            AND shared_files.id <> files.id
            AND (shared_links.expires_at = 0 OR shared_links.expires_at > ?)
        )
    `).all(...ids, requestedBy, requestedBy, now, now).map((row) => Number(row.id));
  }

  pruneOldJobs(before = Date.now(), limit = 100) {
    const ids = this.db.prepare(`
      SELECT jobs.id
      FROM jobs
      WHERE jobs.updated_at < ?
        AND NOT EXISTS (
          SELECT 1
          FROM link_tokens
          WHERE link_tokens.job_id = jobs.id
            AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
        )
      ORDER BY jobs.updated_at ASC, jobs.id ASC
      LIMIT ?
    `).all(before, Date.now(), Math.max(1, Math.min(1_000, Number(limit) || 100))).map((row) => Number(row.id));
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...ids).changes;
  }

  stats() {
    const watchCount = this.db.prepare('SELECT COUNT(*) AS count FROM watched_users').get().count;
    const videoCount = this.db.prepare('SELECT COUNT(*) AS count FROM seen_videos').get().count;
    const fileCount = this.db.prepare('SELECT COUNT(*) AS count FROM files WHERE trashed_at IS NULL').get().count;
    const trashCount = this.db.prepare('SELECT COUNT(*) AS count FROM files WHERE trashed_at IS NOT NULL').get().count;
    const latestJob = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1').get() ?? null;
    return { watchCount, videoCount, fileCount, trashCount, latestJob };
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

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];
}

export function createStore(dbPath) {
  return new Store(path.resolve(dbPath));
}
