import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createProfileReference, normalizePlatform } from '../platforms/references.js';
import { listAppliedMigrations, runMigrations } from './migrations.js';
import {
  getMediaPost as findMediaPost,
  listMediaAssetPathsForFiles as findMediaAssetPathsForFiles,
  listMediaAssetsForFile as findMediaAssetsForFile,
  migrateMediaSchema,
  recordMediaDownload as persistMediaDownload,
} from './media.js';

const DEFAULT_DELETION_CLAIM_LEASE_MS = 10 * 60 * 1000;

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
    this.migrationState = runMigrations(this.db, [
      {
        version: 1,
        name: 'legacy-schema-bootstrap',
        up: () => this.migrateLegacySchema(),
      },
      {
        version: 2,
        name: 'monitor-download-dead-letters',
        up: () => this.migrateMonitorDownloadFailuresSchema(),
      },
      {
        version: 3,
        name: 'rewind-read-indexes',
        up: () => this.migrateRewindReadIndexes(),
      },
      {
        version: 4,
        name: 'rewind-media-read-indexes',
        up: () => this.migrateRewindMediaReadIndexes(),
      },
      {
        version: 5,
        name: 'platform-aware-watches',
        up: () => this.migratePlatformAwareWatches(),
      },
      {
        version: 6,
        name: 'highlight-check-schedule',
        up: () => this.migrateHighlightCheckSchedule(),
      },
    ]);
    this.recoverInterruptedMonitorDownloadRetries();
  }
  migrateLegacySchema() {
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
        deletion_missing_since INTEGER,
        deletion_missing_count INTEGER NOT NULL DEFAULT 0,
        deletion_reason TEXT,
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
        platform TEXT NOT NULL DEFAULT 'tiktok',
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
        platform TEXT NOT NULL DEFAULT 'tiktok',
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
        delete_error TEXT,
        retention_status TEXT NOT NULL DEFAULT 'active'
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

      CREATE TABLE IF NOT EXISTS alert_deliveries (
        video_id TEXT NOT NULL,
        subscription_id INTEGER NOT NULL REFERENCES watch_subscriptions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER NOT NULL,
        delivered_at INTEGER,
        last_error TEXT,
        PRIMARY KEY(video_id, subscription_id, event_type)
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

      CREATE TABLE IF NOT EXISTS platform_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        remote_id TEXT,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        profile_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creator_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creator_group_memberships (
        profile_id INTEGER PRIMARY KEY REFERENCES platform_profiles(id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL REFERENCES creator_groups(id) ON DELETE CASCADE,
        linked_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bookmarks (
        file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_files_video_id ON files(video_id);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_expires_at ON link_tokens(expires_at);
    `);
    migrateMediaSchema(this.db);
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
    this.ensureColumn('seen_videos', 'deletion_missing_since', 'INTEGER');
    this.ensureColumn('seen_videos', 'deletion_missing_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('seen_videos', 'deletion_reason', 'TEXT');
    this.ensureColumn('seen_videos', 'deleted_at', 'INTEGER');
    this.ensureColumn('seen_videos', 'deletion_alerted_at', 'INTEGER');
    this.ensureColumn('jobs', 'requested_by', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('jobs', 'guild_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('jobs', 'channel_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('jobs', 'platform', "TEXT NOT NULL DEFAULT 'tiktok'");
    this.ensureColumn('files', 'requested_by', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('files', 'platform', "TEXT NOT NULL DEFAULT 'tiktok'");
    this.ensureColumn('files', 'trashed_at', 'INTEGER');
    this.ensureColumn('files', 'delete_requested_at', 'INTEGER');
    this.ensureColumn('files', 'delete_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('files', 'delete_error', 'TEXT');
    this.ensureColumn('files', 'retention_status', "TEXT NOT NULL DEFAULT 'active'");
    this.db.prepare(`
      UPDATE files
      SET retention_status = CASE
        WHEN trashed_at IS NOT NULL AND delete_requested_at IS NOT NULL AND delete_error IS NULL THEN 'trash_claimed'
        WHEN trashed_at IS NOT NULL AND delete_requested_at IS NOT NULL AND delete_error IS NOT NULL THEN 'trash_failed'
        WHEN trashed_at IS NOT NULL THEN 'trashed'
        WHEN delete_requested_at IS NOT NULL AND delete_error IS NULL THEN 'expiry_claimed'
        WHEN delete_requested_at IS NOT NULL AND delete_error IS NOT NULL THEN 'expiry_failed'
        ELSE 'active'
      END
    `).run();
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
    this.db.prepare(`
      UPDATE creator_imports
      SET status = 'canceling'
      WHERE cancel_requested_at IS NOT NULL
        AND status IN ('queued', 'running')
    `).run();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_requested_by ON jobs(requested_by);
      CREATE INDEX IF NOT EXISTS idx_jobs_file_id ON jobs(file_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_updated_at_id ON jobs(updated_at, id);
      CREATE INDEX IF NOT EXISTS idx_files_requested_by ON files(requested_by);
      CREATE INDEX IF NOT EXISTS idx_files_platform_video_id ON files(platform, video_id);
      CREATE INDEX IF NOT EXISTS idx_files_trashed_at ON files(trashed_at);
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_files_delete_requested_at ON files(delete_requested_at);
      CREATE INDEX IF NOT EXISTS idx_files_retention_status ON files(retention_status);
      CREATE INDEX IF NOT EXISTS idx_files_username_created_at ON files(username COLLATE NOCASE, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_file_id_expires_at ON link_tokens(file_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_owner_id_created_at ON link_tokens(owner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_scope_id_created_at ON link_tokens(scope_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_job_id ON link_tokens(job_id);
      CREATE INDEX IF NOT EXISTS idx_link_tokens_monitor_file_scope_created_at
        ON link_tokens(file_id, scope_id, created_at DESC)
        WHERE delivery_type = 'monitor' AND expires_at = 0;
      CREATE INDEX IF NOT EXISTS idx_seen_videos_next_deletion_check_at ON seen_videos(next_deletion_check_at);
      CREATE INDEX IF NOT EXISTS idx_watched_users_next_check_at ON watched_users(next_check_at);
      CREATE INDEX IF NOT EXISTS idx_watch_username_history_detected_at ON watch_username_history(detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_watch_subscriptions_guild_id_username ON watch_subscriptions(guild_id, username);
      CREATE INDEX IF NOT EXISTS idx_alert_deliveries_subscription_event
        ON alert_deliveries(subscription_id, event_type, status);
      CREATE INDEX IF NOT EXISTS idx_creator_imports_created_at ON creator_imports(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_creator_imports_username_status ON creator_imports(username, status);
      CREATE INDEX IF NOT EXISTS idx_creator_import_items_import_status_position
        ON creator_import_items(import_id, status, position, id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_profiles_platform_remote_id
        ON platform_profiles(platform, remote_id)
        WHERE remote_id IS NOT NULL AND remote_id <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_profiles_platform_handle
        ON platform_profiles(platform, handle COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_platform_profiles_updated_at
        ON platform_profiles(updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_creator_group_memberships_group_id
        ON creator_group_memberships(group_id, linked_at, profile_id);
      CREATE INDEX IF NOT EXISTS idx_creator_groups_updated_at
        ON creator_groups(updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks(created_at DESC);
    `);
    this.migrateLegacyDeliveryOwnership();
    this.migrateLegacyWatchSubscriptions();
  }

  migrateRewindReadIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_rewind_active_created
      ON files(created_at DESC, id DESC)
      WHERE platform = 'tiktok' AND trashed_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_files_rewind_active_username_created
      ON files(username COLLATE NOCASE, created_at DESC, id DESC)
      WHERE platform = 'tiktok' AND trashed_at IS NULL;
    `);
  }

  migrateRewindMediaReadIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_rewind_media_active_created
      ON files(created_at DESC, id DESC)
      WHERE trashed_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_files_rewind_media_platform_username_created
      ON files(platform, username COLLATE NOCASE, created_at DESC, id DESC)
      WHERE trashed_at IS NULL;
    `);
  }

  migrateMonitorDownloadFailuresSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_download_failures (
        video_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        source_url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        media_type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'retryable',
        failure_count INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        first_failed_at INTEGER NOT NULL,
        last_failed_at INTEGER NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        dead_lettered_at INTEGER,
        last_retry_at INTEGER,
        resolved_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_monitor_download_failures_status_updated
        ON monitor_download_failures(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_monitor_download_failures_username_status
        ON monitor_download_failures(username COLLATE NOCASE, status, updated_at DESC);
    `);
  }

  migratePlatformAwareWatches() {
    const hasWatchedPlatform = this.db.prepare(
      `SELECT COUNT(*) AS c FROM pragma_table_info('watched_users') WHERE name='platform'`
    ).get()?.c > 0;
    if (!hasWatchedPlatform) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS watched_users_new (
          platform TEXT NOT NULL DEFAULT 'tiktok',
          username TEXT NOT NULL,
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
          next_check_at INTEGER,
          PRIMARY KEY (platform, username)
        );
        INSERT OR IGNORE INTO watched_users_new (
          platform, username, channel_id, created_at, creator_id, sec_uid, author_id,
          has_story, story_status_checked_at, previous_username, username_changed_at,
          last_checked_at, last_success_at, failure_count, last_error, next_check_at
        )
        SELECT 'tiktok', username, channel_id, created_at, creator_id, sec_uid, author_id,
          has_story, story_status_checked_at, previous_username, username_changed_at,
          last_checked_at, last_success_at, failure_count, last_error, next_check_at
        FROM watched_users;
        DROP TABLE watched_users;
        ALTER TABLE watched_users_new RENAME TO watched_users;
        CREATE INDEX IF NOT EXISTS idx_watched_users_next_check_at ON watched_users(next_check_at);
        CREATE INDEX IF NOT EXISTS idx_watched_users_platform_username ON watched_users(platform, username);
      `);
    }
    const hasSubscriptionPlatform = this.db.prepare(
      `SELECT COUNT(*) AS c FROM pragma_table_info('watch_subscriptions') WHERE name='platform'`
    ).get()?.c > 0;
    if (!hasSubscriptionPlatform) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS watch_subscriptions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          platform TEXT NOT NULL DEFAULT 'tiktok',
          username TEXT NOT NULL,
          guild_id TEXT NOT NULL DEFAULT '',
          channel_id TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          UNIQUE(platform, username, guild_id)
        );
        INSERT OR IGNORE INTO watch_subscriptions_new (id, platform, username, guild_id, channel_id, created_by, created_at)
          SELECT id, 'tiktok', username, guild_id, channel_id, created_by, created_at FROM watch_subscriptions;
        DROP TABLE watch_subscriptions;
        ALTER TABLE watch_subscriptions_new RENAME TO watch_subscriptions;
        CREATE INDEX IF NOT EXISTS idx_watch_subscriptions_platform_username ON watch_subscriptions(platform, username);
        CREATE INDEX IF NOT EXISTS idx_watch_subscriptions_guild ON watch_subscriptions(guild_id);
      `);
    }
    this.ensureColumn('seen_videos', 'platform', "TEXT NOT NULL DEFAULT 'tiktok'");
    this.ensureColumn('monitor_download_failures', 'platform', "TEXT NOT NULL DEFAULT 'tiktok'");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_seen_videos_platform_next_deletion ON seen_videos(platform, next_deletion_check_at);
      CREATE INDEX IF NOT EXISTS idx_monitor_download_failures_platform_status ON monitor_download_failures(platform, status, updated_at DESC);
    `);
  }
  migrateHighlightCheckSchedule() {
    this.ensureColumn('watched_users', 'next_highlight_check_at', 'INTEGER');
    this.ensureColumn('watched_users', 'last_highlight_check_at', 'INTEGER');
    this.ensureColumn('watched_users', 'highlight_failure_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('watched_users', 'highlight_last_error', 'TEXT');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_watched_users_next_highlight_check_at ON watched_users(next_highlight_check_at);
    `);
  }


  recoverInterruptedMonitorDownloadRetries(now = Date.now()) {
    return this.db.prepare(`
      UPDATE monitor_download_failures
      SET
        status = 'dead_letter',
        updated_at = ?,
        dead_lettered_at = COALESCE(dead_lettered_at, updated_at)
      WHERE status = 'retrying'
    `).run(now).changes;
  }

  listSchemaMigrations() {
    return listAppliedMigrations(this.db);
  }

  getSchemaVersion() {
    return Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
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

  upsertPlatformProfile(input = {}, now = Date.now()) {
    const normalized = normalizeStoredPlatformProfile(input);
    const hasDisplayName = hasOwn(input, 'displayName') || hasOwn(input, 'display_name');
    const displayName = hasDisplayName
      ? String(input.displayName ?? input.display_name ?? '').trim().slice(0, 200)
      : '';
    const timestamp = normalizeStoreTimestamp(now);
    let profileId;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const byRemoteId = normalized.remoteId
        ? this.db.prepare(`
          SELECT * FROM platform_profiles WHERE platform = ? AND remote_id = ?
        `).get(normalized.platform, normalized.remoteId) ?? null
        : null;
      const byHandle = this.db.prepare(`
        SELECT *
        FROM platform_profiles
        WHERE platform = ? AND handle = ? COLLATE NOCASE
      `).get(normalized.platform, normalized.handle) ?? null;

      if (byRemoteId && byHandle && byRemoteId.id !== byHandle.id) {
        if (byHandle.remote_id && byHandle.remote_id !== normalized.remoteId) {
          throw new Error('That handle belongs to a different stable platform profile.');
        }
        this.reconcilePlatformProfiles(byRemoteId.id, byHandle.id, timestamp);
      }
      if (
        !byRemoteId
        && byHandle?.remote_id
        && normalized.remoteId
        && byHandle.remote_id !== normalized.remoteId
      ) {
        throw new Error('That handle belongs to a different stable platform profile.');
      }

      const existing = byRemoteId ?? byHandle;
      if (existing) {
        profileId = Number(existing.id);
        this.db.prepare(`
          UPDATE platform_profiles
          SET
            remote_id = COALESCE(?, remote_id),
            handle = ?,
            display_name = CASE WHEN ? = 1 THEN ? ELSE display_name END,
            profile_url = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          normalized.remoteId,
          normalized.handle,
          hasDisplayName ? 1 : 0,
          displayName,
          normalized.profileUrl,
          timestamp,
          profileId,
        );
      } else {
        const result = this.db.prepare(`
          INSERT INTO platform_profiles (
            platform, remote_id, handle, display_name, profile_url, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalized.platform,
          normalized.remoteId,
          normalized.handle,
          displayName,
          normalized.profileUrl,
          timestamp,
          timestamp,
        );
        profileId = Number(result.lastInsertRowid);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getPlatformProfile(profileId);
  }

  reconcilePlatformProfiles(survivorProfileId, duplicateProfileId, now = Date.now()) {
    const survivorId = normalizePositiveId(survivorProfileId, 'platform profile');
    const duplicateId = normalizePositiveId(duplicateProfileId, 'platform profile');
    if (survivorId === duplicateId) return;
    const timestamp = normalizeStoreTimestamp(now);

    const survivorMembership = this.db.prepare(`
      SELECT group_id FROM creator_group_memberships WHERE profile_id = ?
    `).get(survivorId) ?? null;
    const duplicateMembership = this.db.prepare(`
      SELECT group_id FROM creator_group_memberships WHERE profile_id = ?
    `).get(duplicateId) ?? null;

    if (!survivorMembership && duplicateMembership) {
      this.db.prepare(`
        UPDATE creator_group_memberships
        SET profile_id = ?, linked_at = ?
        WHERE profile_id = ?
      `).run(survivorId, timestamp, duplicateId);
      this.db.prepare('UPDATE creator_groups SET updated_at = ? WHERE id = ?')
        .run(timestamp, duplicateMembership.group_id);
    } else if (
      survivorMembership
      && duplicateMembership
      && survivorMembership.group_id !== duplicateMembership.group_id
    ) {
      const targetGroupId = Number(survivorMembership.group_id);
      const sourceGroupId = Number(duplicateMembership.group_id);
      this.db.prepare(`
        UPDATE creator_group_memberships
        SET group_id = ?, linked_at = ?
        WHERE group_id = ?
      `).run(targetGroupId, timestamp, sourceGroupId);
      this.db.prepare('DELETE FROM creator_groups WHERE id = ?').run(sourceGroupId);
      this.db.prepare('UPDATE creator_groups SET updated_at = ? WHERE id = ?')
        .run(timestamp, targetGroupId);
    } else if (survivorMembership && duplicateMembership) {
      this.db.prepare('UPDATE creator_groups SET updated_at = ? WHERE id = ?')
        .run(timestamp, survivorMembership.group_id);
    }

    this.db.prepare(`
      UPDATE platform_profiles
      SET display_name = CASE
        WHEN display_name = '' THEN COALESCE((
          SELECT display_name FROM platform_profiles WHERE id = ?
        ), '')
        ELSE display_name
      END
      WHERE id = ?
    `).run(duplicateId, survivorId);
    this.db.prepare('UPDATE media_posts SET profile_id = ? WHERE profile_id = ?')
      .run(survivorId, duplicateId);
    this.db.prepare('DELETE FROM platform_profiles WHERE id = ?').run(duplicateId);
  }

  getPlatformProfile(reference, remoteId = undefined) {
    const lookup = normalizePlatformProfileLookup(reference, remoteId);
    if (!lookup) return null;
    const select = `
      SELECT platform_profiles.*, creator_group_memberships.group_id,
        creator_group_memberships.linked_at
      FROM platform_profiles
      LEFT JOIN creator_group_memberships
        ON creator_group_memberships.profile_id = platform_profiles.id
    `;
    if (lookup.id) {
      return this.db.prepare(`${select} WHERE platform_profiles.id = ?`).get(lookup.id) ?? null;
    }
    if (lookup.remoteId) {
      return this.db.prepare(`
        ${select}
        WHERE platform_profiles.platform = ? AND platform_profiles.remote_id = ?
      `).get(lookup.platform, lookup.remoteId) ?? null;
    }
    return this.db.prepare(`
      ${select}
      WHERE platform_profiles.platform = ?
        AND platform_profiles.handle = ? COLLATE NOCASE
      ORDER BY platform_profiles.updated_at DESC, platform_profiles.id DESC
      LIMIT 1
    `).get(lookup.platform, lookup.handle) ?? null;
  }

  listPlatformProfiles({ platform = '', groupId = null, unlinkedOnly = false } = {}) {
    const clauses = [];
    const params = [];
    if (platform) {
      clauses.push('platform_profiles.platform = ?');
      params.push(normalizePlatform(platform));
    }
    if (groupId != null && groupId !== '') {
      const normalizedGroupId = normalizePositiveId(groupId, 'creator group');
      clauses.push('creator_group_memberships.group_id = ?');
      params.push(normalizedGroupId);
    }
    if (unlinkedOnly) clauses.push('creator_group_memberships.group_id IS NULL');

    return this.db.prepare(`
      SELECT platform_profiles.*, creator_group_memberships.group_id,
        creator_group_memberships.linked_at
      FROM platform_profiles
      LEFT JOIN creator_group_memberships
        ON creator_group_memberships.profile_id = platform_profiles.id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY platform_profiles.platform, platform_profiles.handle COLLATE NOCASE,
        platform_profiles.id
    `).all(...params);
  }

  createCreatorGroup(options = {}, now = Date.now()) {
    const name = normalizeCreatorGroupName(typeof options === 'string' ? options : options?.name);
    const timestamp = normalizeStoreTimestamp(now);
    const result = this.db.prepare(`
      INSERT INTO creator_groups (name, created_at, updated_at)
      VALUES (?, ?, ?)
    `).run(name, timestamp, timestamp);
    return this.getCreatorGroup(Number(result.lastInsertRowid));
  }

  getCreatorGroup(groupId) {
    const id = normalizePositiveId(groupId, 'creator group', false);
    if (!id) return null;
    return this.db.prepare(`
      SELECT creator_groups.*, COUNT(creator_group_memberships.profile_id) AS member_count
      FROM creator_groups
      LEFT JOIN creator_group_memberships
        ON creator_group_memberships.group_id = creator_groups.id
      WHERE creator_groups.id = ?
      GROUP BY creator_groups.id
    `).get(id) ?? null;
  }

  listCreatorGroups({ includeEmpty = true } = {}) {
    return this.db.prepare(`
      SELECT creator_groups.*, COUNT(creator_group_memberships.profile_id) AS member_count
      FROM creator_groups
      LEFT JOIN creator_group_memberships
        ON creator_group_memberships.group_id = creator_groups.id
      GROUP BY creator_groups.id
      ${includeEmpty ? '' : 'HAVING COUNT(creator_group_memberships.profile_id) > 0'}
      ORDER BY creator_groups.updated_at DESC, creator_groups.id DESC
    `).all();
  }

  renameCreatorGroup(groupId, name, now = Date.now()) {
    const id = normalizePositiveId(groupId, 'creator group');
    const groupName = normalizeCreatorGroupName(name);
    const timestamp = normalizeStoreTimestamp(now);
    const result = this.db.prepare(`
      UPDATE creator_groups
      SET name = ?, updated_at = ?
      WHERE id = ?
    `).run(groupName, timestamp, id);
    if (!result.changes) return null;
    return {
      ...this.getCreatorGroup(id),
      members: this.listCreatorGroupMembers(id),
    };
  }

  getCreatorGroupForProfile(profile) {
    const profileId = this.resolvePlatformProfileId(profile);
    if (!profileId) return null;
    return this.db.prepare(`
      SELECT creator_groups.*, creator_group_memberships.linked_at,
        (SELECT COUNT(*) FROM creator_group_memberships AS members
          WHERE members.group_id = creator_groups.id) AS member_count
      FROM creator_group_memberships
      JOIN creator_groups ON creator_groups.id = creator_group_memberships.group_id
      WHERE creator_group_memberships.profile_id = ?
    `).get(profileId) ?? null;
  }

  getCreatorGroupMember(groupId, profile) {
    const id = normalizePositiveId(groupId, 'creator group', false);
    const profileId = this.resolvePlatformProfileId(profile);
    if (!id || !profileId) return null;
    return this.db.prepare(`
      SELECT platform_profiles.*, creator_group_memberships.group_id,
        creator_group_memberships.linked_at
      FROM creator_group_memberships
      JOIN platform_profiles ON platform_profiles.id = creator_group_memberships.profile_id
      WHERE creator_group_memberships.group_id = ?
        AND creator_group_memberships.profile_id = ?
    `).get(id, profileId) ?? null;
  }

  listCreatorGroupMembers(groupId) {
    const id = normalizePositiveId(groupId, 'creator group', false);
    if (!id) return [];
    return this.db.prepare(`
      SELECT platform_profiles.*, creator_group_memberships.group_id,
        creator_group_memberships.linked_at
      FROM creator_group_memberships
      JOIN platform_profiles ON platform_profiles.id = creator_group_memberships.profile_id
      WHERE creator_group_memberships.group_id = ?
      ORDER BY platform_profiles.platform, platform_profiles.handle COLLATE NOCASE,
        platform_profiles.id
    `).all(id);
  }

  getCreatorGroupMembers(groupId) {
    return this.listCreatorGroupMembers(groupId);
  }

  linkCreatorProfiles(profiles, options = {}, now = Date.now()) {
    const requestedProfiles = Array.isArray(profiles) ? profiles : [profiles];
    const profileIds = [...new Set(requestedProfiles.map((profile) => {
      const id = this.resolvePlatformProfileId(profile);
      if (!id) throw new Error('Every linked profile must already exist.');
      return id;
    }))];
    if (!profileIds.length) throw new Error('At least one platform profile is required.');

    const requestedGroupId = options?.groupId ?? options?.group_id ?? null;
    const mergeGroups = options?.mergeGroups === true || options?.merge === true;
    const hasGroupName = hasOwn(options, 'groupName') || hasOwn(options, 'name');
    const groupName = normalizeCreatorGroupName(options?.groupName ?? options?.name);
    const timestamp = normalizeStoreTimestamp(now);
    let targetGroupId = requestedGroupId == null || requestedGroupId === ''
      ? null
      : normalizePositiveId(requestedGroupId, 'creator group');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (targetGroupId && !this.db.prepare('SELECT 1 FROM creator_groups WHERE id = ?').get(targetGroupId)) {
        throw new Error(`Creator group ${targetGroupId} does not exist.`);
      }

      const placeholders = profileIds.map(() => '?').join(', ');
      const currentGroupIds = this.db.prepare(`
        SELECT DISTINCT group_id
        FROM creator_group_memberships
        WHERE profile_id IN (${placeholders})
        ORDER BY group_id
      `).all(...profileIds).map((row) => Number(row.group_id));

      if (!targetGroupId) {
        if (currentGroupIds.length > 1 && !mergeGroups) {
          throw new Error('The selected profiles belong to different creator groups; set mergeGroups to merge them explicitly.');
        }
        targetGroupId = currentGroupIds[0] ?? null;
      }

      if (!targetGroupId) {
        const created = this.db.prepare(`
          INSERT INTO creator_groups (name, created_at, updated_at)
          VALUES (?, ?, ?)
        `).run(groupName, timestamp, timestamp);
        targetGroupId = Number(created.lastInsertRowid);
      }

      const sourceGroupIds = currentGroupIds.filter((id) => id !== targetGroupId);
      if (sourceGroupIds.length && !mergeGroups) {
        throw new Error('A selected profile already belongs to another creator group; set mergeGroups to merge it explicitly.');
      }

      if (sourceGroupIds.length) {
        const sourcePlaceholders = sourceGroupIds.map(() => '?').join(', ');
        this.db.prepare(`
          UPDATE creator_group_memberships
          SET group_id = ?, linked_at = ?
          WHERE group_id IN (${sourcePlaceholders})
        `).run(targetGroupId, timestamp, ...sourceGroupIds);
        this.db.prepare(`DELETE FROM creator_groups WHERE id IN (${sourcePlaceholders})`).run(...sourceGroupIds);
      }

      const link = this.db.prepare(`
        INSERT INTO creator_group_memberships (profile_id, group_id, linked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
          group_id = excluded.group_id,
          linked_at = CASE
            WHEN creator_group_memberships.group_id = excluded.group_id
              THEN creator_group_memberships.linked_at
            ELSE excluded.linked_at
          END
      `);
      for (const profileId of profileIds) link.run(profileId, targetGroupId, timestamp);
      this.db.prepare(`
        UPDATE creator_groups
        SET name = CASE WHEN ? = 1 THEN ? ELSE name END, updated_at = ?
        WHERE id = ?
      `).run(hasGroupName ? 1 : 0, groupName, timestamp, targetGroupId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return {
      ...this.getCreatorGroup(targetGroupId),
      members: this.listCreatorGroupMembers(targetGroupId),
    };
  }

  linkProfileToCreatorGroup(profile, groupId, options = {}, now = Date.now()) {
    return this.linkCreatorProfiles([profile], { ...options, groupId }, now);
  }

  unlinkProfileFromCreatorGroup(profile, now = Date.now()) {
    const profileId = this.resolvePlatformProfileId(profile);
    if (!profileId) return false;
    const membership = this.db.prepare(`
      SELECT group_id FROM creator_group_memberships WHERE profile_id = ?
    `).get(profileId);
    if (!membership) return false;

    const timestamp = normalizeStoreTimestamp(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('DELETE FROM creator_group_memberships WHERE profile_id = ?').run(profileId);
      this.db.prepare('UPDATE creator_groups SET updated_at = ? WHERE id = ?').run(timestamp, membership.group_id);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  unlinkProfile(profile, now = Date.now()) {
    return this.unlinkProfileFromCreatorGroup(profile, now);
  }

  resolvePlatformProfileId(reference) {
    if (Number.isInteger(reference) && reference > 0) {
      return this.db.prepare('SELECT id FROM platform_profiles WHERE id = ?').get(reference)?.id ?? null;
    }
    const profile = this.getPlatformProfile(reference);
    return profile?.id ?? null;
  }

  recordMediaDownload(input = {}, now = Date.now()) {
    return persistMediaDownload(this.db, input, now);
  }

  createFileWithMedia({ file = {}, media = {} } = {}, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const fileId = this.createFileRecord(file, now);
      const persisted = persistMediaDownload(this.db, {
        ...media,
        fileId,
        platform: media.platform ?? file.platform ?? 'tiktok',
        remoteId: media.remoteId ?? media.videoId ?? file.videoId,
        filePath: media.filePath ?? file.filePath,
        filename: media.filename ?? file.filename,
        sizeBytes: media.sizeBytes ?? file.sizeBytes,
      }, now, { manageTransaction: false });
      this.db.exec('COMMIT');
      return { fileId, ...persisted };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getMediaPost(platform, remoteId) {
    return findMediaPost(this.db, platform, remoteId);
  }

  listMediaAssetsForFile(fileId) {
    return findMediaAssetsForFile(this.db, fileId);
  }

  listMediaAssetPathsForFiles(fileIds) {
    return findMediaAssetPathsForFiles(this.db, fileIds);
  }

  withMediaAssetPaths(records = []) {
    const files = Array.isArray(records) ? records : [];
    if (!files.length) return [];
    const byFile = new Map();
    for (const asset of this.listMediaAssetPathsForFiles(files.map((file) => file.id))) {
      const fileId = Number(asset.file_id);
      const paths = byFile.get(fileId) ?? [];
      paths.push(asset.path);
      byFile.set(fileId, paths);
    }
    return files.map((file) => ({
      ...file,
      asset_paths: byFile.get(Number(file.id)) ?? [],
    }));
  }

  addWatch(username, channelOrOptions, now = Date.now()) {
    const options = typeof channelOrOptions === 'object' && channelOrOptions !== null
      ? channelOrOptions
      : { channelId: channelOrOptions };
    const platform = normalizePlatform(options.platform ?? options.platformName ?? 'tiktok');
    const channelId = String(options.channelId ?? options.channel_id ?? '');
    const guildId = String(options.guildId ?? options.guild_id ?? '');
    const createdBy = String(options.createdBy ?? options.created_by ?? '');
    if (!channelId) throw new Error('A watch subscription requires a Discord channel.');
    const normalizedUsername = String(username ?? '').trim();
    if (!normalizedUsername) throw new Error('Username is required.');
    this.db.prepare(`
      INSERT INTO watched_users (platform, username, channel_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, username) DO NOTHING
    `).run(platform, normalizedUsername, channelId, now);
    this.db.prepare(`
      INSERT INTO watch_subscriptions (platform, username, guild_id, channel_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, username, guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        created_by = excluded.created_by
    `).run(platform, normalizedUsername, guildId, channelId, createdBy, now);
    return this.getWatch(normalizedUsername, platform);
  }

  removeWatch(username, scope = null) {
    const normalizedUsername = String(username ?? '').trim();
    const platform = normalizePlatform(scope?.platform ?? 'tiktok');
    if (!scope || typeof scope !== 'object') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (scope && typeof scope === 'object' && scope.platform) {
          this.db.prepare('DELETE FROM watch_subscriptions WHERE platform = ? AND username = ?').run(platform, normalizedUsername);
          const result = this.db.prepare('DELETE FROM watched_users WHERE platform = ? AND username = ?').run(platform, normalizedUsername);
          this.clearDeletionChecksForUsername(normalizedUsername, platform);
          this.db.exec('COMMIT');
          return result.changes > 0;
        }
        this.db.prepare('DELETE FROM watch_subscriptions WHERE username = ?').run(normalizedUsername);
        const result = this.db.prepare('DELETE FROM watched_users WHERE username = ?').run(normalizedUsername);
        this.clearDeletionChecksForUsername(normalizedUsername);
        this.db.exec('COMMIT');
        return result.changes > 0;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    const guildId = String(scope.guildId ?? scope.guild_id ?? '');
    const scopePlatform = normalizePlatform(scope.platform ?? platform);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('DELETE FROM watch_subscriptions WHERE platform = ? AND username = ? AND guild_id = ?').run(scopePlatform, normalizedUsername, guildId);
      const remaining = this.db.prepare('SELECT 1 FROM watch_subscriptions WHERE platform = ? AND username = ? LIMIT 1').get(scopePlatform, normalizedUsername);
      if (!remaining) {
        this.db.prepare('DELETE FROM watched_users WHERE platform = ? AND username = ?').run(scopePlatform, normalizedUsername);
        this.clearDeletionChecksForUsername(normalizedUsername, scopePlatform);
      }
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getWatch(username, platform = 'tiktok') {
    const normalizedUsername = String(username ?? '').trim();
    if (!normalizedUsername) return null;
    // Allow calling with object like { platform, username } or platform string
    if (typeof platform === 'object' && platform !== null && platform.platform) {
      const p = normalizePlatform(platform.platform);
      try {
        return this.db.prepare('SELECT * FROM watched_users WHERE platform = ? AND username = ?').get(p, normalizedUsername) ?? null;
      } catch {
        return this.db.prepare('SELECT * FROM watched_users WHERE username = ?').get(normalizedUsername) ?? null;
      }
    }
    const normalizedPlatform = normalizePlatform(platform ?? 'tiktok');
    try {
      return this.db.prepare('SELECT * FROM watched_users WHERE platform = ? AND username = ?').get(normalizedPlatform, normalizedUsername) ?? null;
    } catch {
      return this.db.prepare('SELECT * FROM watched_users WHERE username = ?').get(normalizedUsername) ?? null;
    }
  }

  listWatches(filter = null) {
    if (filter && typeof filter === 'object' && filter.platform) {
      const platform = normalizePlatform(filter.platform);
      try {
        return this.db.prepare(`
          SELECT *
          FROM watched_users
          WHERE platform = ?
          ORDER BY COALESCE(next_check_at, 0), username
        `).all(platform);
      } catch {
        return this.db.prepare(`SELECT * FROM watched_users ORDER BY COALESCE(next_check_at, 0), username`).all().filter((r) => (r.platform ?? 'tiktok') === platform);
      }
    }
    if (typeof filter === 'string' && filter) {
      const platform = normalizePlatform(filter);
      try {
        return this.db.prepare(`
          SELECT *
          FROM watched_users
          WHERE platform = ?
          ORDER BY COALESCE(next_check_at, 0), username
        `).all(platform);
      } catch {
        return this.db.prepare(`SELECT * FROM watched_users ORDER BY COALESCE(next_check_at, 0), username`).all().filter((r) => (r.platform ?? 'tiktok') === platform);
      }
    }
    try {
      return this.db.prepare(`
        SELECT *
        FROM watched_users
        ORDER BY platform, COALESCE(next_check_at, 0), username
      `).all();
    } catch {
      return this.db.prepare(`SELECT * FROM watched_users ORDER BY COALESCE(next_check_at, 0), username`).all();
    }
  }

  listWatchesForScope({ guildId = '', channelId = '', platform = '' } = {}) {
    const normalizedPlatform = platform ? normalizePlatform(platform) : '';
    if (normalizedPlatform) {
      try {
        return this.db.prepare(`
          WITH ranked_subscriptions AS (
            SELECT watch_subscriptions.*,
              ROW_NUMBER() OVER (
                PARTITION BY watch_subscriptions.platform, watch_subscriptions.username
                ORDER BY CASE WHEN watch_subscriptions.guild_id = ? THEN 0 ELSE 1 END,
                  watch_subscriptions.id
              ) AS scope_rank
            FROM watch_subscriptions
            WHERE platform = ?
              AND (
                watch_subscriptions.guild_id = ?
                OR (
                  watch_subscriptions.guild_id = ''
                  AND watch_subscriptions.channel_id = ?
                )
              )
          )
          SELECT watched_users.*, ranked_subscriptions.channel_id AS subscription_channel_id,
            ranked_subscriptions.created_by AS subscription_created_by
          FROM ranked_subscriptions
          JOIN watched_users ON watched_users.platform = ranked_subscriptions.platform AND watched_users.username = ranked_subscriptions.username
          WHERE ranked_subscriptions.scope_rank = 1
          ORDER BY watched_users.username
        `).all(String(guildId ?? ''), normalizedPlatform, String(guildId ?? ''), String(channelId ?? ''));
      } catch {
        return [];
      }
    }
    try {
      return this.db.prepare(`
        WITH ranked_subscriptions AS (
          SELECT watch_subscriptions.*,
            ROW_NUMBER() OVER (
              PARTITION BY watch_subscriptions.platform, watch_subscriptions.username
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
        JOIN watched_users ON watched_users.platform = ranked_subscriptions.platform AND watched_users.username = ranked_subscriptions.username
        WHERE ranked_subscriptions.scope_rank = 1
        ORDER BY watched_users.platform, watched_users.username
      `).all(String(guildId ?? ''), String(guildId ?? ''), String(channelId ?? ''));
    } catch {
      // Fallback for legacy DB without platform column
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
  }

  getWatchSubscription(username, { guildId = '', platform = 'tiktok' } = {}) {
    const normalizedUsername = String(username ?? '').trim();
    const normalizedGuildId = String(guildId ?? '');
    const normalizedPlatform = normalizePlatform(platform ?? 'tiktok');
    try {
      return this.db.prepare(`
        SELECT *
        FROM watch_subscriptions
        WHERE platform = ? AND username = ? AND guild_id = ?
      `).get(normalizedPlatform, normalizedUsername, normalizedGuildId) ?? null;
    } catch {
      return this.db.prepare(`
        SELECT *
        FROM watch_subscriptions
        WHERE username = ? AND guild_id = ?
      `).get(normalizedUsername, normalizedGuildId) ?? null;
    }
  }

  hasWatchSubscription(username, scope = {}) {
    const platform = normalizePlatform(scope?.platform ?? scope?.platformName ?? 'tiktok');
    return Boolean(this.getWatchSubscription(username, { guildId: String(scope.guildId ?? scope.guild_id ?? ''), platform }));
  }

  listWatchSubscriptions(username, platform = null) {
    const normalizedUsername = String(username ?? '').trim();
    if (platform) {
      const normalizedPlatform = normalizePlatform(platform);
      try {
        return this.db.prepare(`
          SELECT *
          FROM watch_subscriptions
          WHERE platform = ? AND username = ?
          ORDER BY guild_id, created_at, id
        `).all(normalizedPlatform, normalizedUsername);
      } catch {
        return this.db.prepare(`
          SELECT *
          FROM watch_subscriptions
          WHERE username = ?
          ORDER BY guild_id, created_at, id
        `).all(normalizedUsername).filter((r) => (r.platform ?? 'tiktok') === normalizedPlatform);
      }
    }
    try {
      return this.db.prepare(`
        SELECT *
        FROM watch_subscriptions
        WHERE username = ?
        ORDER BY platform, guild_id, created_at, id
      `).all(normalizedUsername);
    } catch {
      return this.db.prepare(`
        SELECT *
        FROM watch_subscriptions
        WHERE username = ?
        ORDER BY guild_id, created_at, id
      `).all(normalizedUsername);
    }
  }

  getAlertDelivery({ videoId, subscriptionId, eventType = 'new_post' } = {}) {
    const key = normalizeAlertDeliveryKey({ videoId, subscriptionId, eventType });
    if (!key) return null;
    return this.db.prepare(`
      SELECT *
      FROM alert_deliveries
      WHERE video_id = ? AND subscription_id = ? AND event_type = ?
    `).get(key.videoId, key.subscriptionId, key.eventType) ?? null;
  }

  isAlertDelivered(options = {}) {
    return this.getAlertDelivery(options)?.status === 'delivered';
  }

  markAlertDelivered(options = {}, now = Date.now()) {
    const key = normalizeAlertDeliveryKey(options);
    if (!key) throw new Error('An alert delivery requires a video, subscription, and event type.');
    this.db.prepare(`
      INSERT INTO alert_deliveries (
        video_id, subscription_id, event_type, status, attempt_count,
        last_attempt_at, delivered_at, last_error
      )
      VALUES (?, ?, ?, 'delivered', 1, ?, ?, NULL)
      ON CONFLICT(video_id, subscription_id, event_type) DO UPDATE SET
        status = 'delivered',
        attempt_count = alert_deliveries.attempt_count + 1,
        last_attempt_at = excluded.last_attempt_at,
        delivered_at = COALESCE(alert_deliveries.delivered_at, excluded.delivered_at),
        last_error = NULL
    `).run(key.videoId, key.subscriptionId, key.eventType, now, now);
    return this.getAlertDelivery(key);
  }

  markAlertDeliveryFailed({ error = '', ...options } = {}, now = Date.now()) {
    const key = normalizeAlertDeliveryKey(options);
    if (!key) throw new Error('An alert delivery requires a video, subscription, and event type.');
    const lastError = String(error?.message ?? error ?? '').slice(0, 500);
    this.db.prepare(`
      INSERT INTO alert_deliveries (
        video_id, subscription_id, event_type, status, attempt_count,
        last_attempt_at, delivered_at, last_error
      )
      VALUES (?, ?, ?, 'failed', 1, ?, NULL, ?)
      ON CONFLICT(video_id, subscription_id, event_type) DO UPDATE SET
        status = CASE
          WHEN alert_deliveries.status = 'delivered' THEN 'delivered'
          ELSE 'failed'
        END,
        attempt_count = alert_deliveries.attempt_count + 1,
        last_attempt_at = excluded.last_attempt_at,
        last_error = CASE
          WHEN alert_deliveries.status = 'delivered' THEN alert_deliveries.last_error
          ELSE excluded.last_error
        END
    `).run(key.videoId, key.subscriptionId, key.eventType, now, lastError);
    return this.getAlertDelivery(key);
  }

  getMonitorDownloadFailure(videoId) {
    const id = String(videoId ?? '').trim();
    if (!id) return null;
    return this.db.prepare(`
      SELECT *
      FROM monitor_download_failures
      WHERE video_id = ?
    `).get(id) ?? null;
  }

  isMonitorDownloadDeadLettered(videoId) {
    return this.getMonitorDownloadFailure(videoId)?.status === 'dead_letter';
  }

  recordMonitorDownloadFailure({
    videoId,
    username = '',
    sourceUrl = '',
    title = '',
    mediaType = '',
    error = '',
  } = {}, deadLetterAfter = 5, now = Date.now()) {
    const id = String(videoId ?? '').trim();
    if (!id) throw new Error('A monitor download failure requires a post ID.');
    const threshold = Math.max(1, Number(deadLetterAfter) || 1);
    const lastError = String(error?.message ?? error ?? '').slice(0, 500);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getMonitorDownloadFailure(id);
      if (existing?.status === 'dead_letter') {
        this.db.exec('COMMIT');
        return existing;
      }

      const failureCount = Number(existing?.failure_count ?? 0) + 1;
      const status = failureCount >= threshold ? 'dead_letter' : 'retryable';
      const deadLetteredAt = status === 'dead_letter'
        ? Number(existing?.dead_lettered_at ?? 0) || now
        : null;
      this.db.prepare(`
        INSERT INTO monitor_download_failures (
          video_id, username, source_url, title, media_type, status,
          failure_count, retry_count, first_failed_at, last_failed_at,
          last_error, dead_lettered_at, last_retry_at, resolved_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          username = excluded.username,
          source_url = excluded.source_url,
          title = excluded.title,
          media_type = excluded.media_type,
          status = excluded.status,
          failure_count = excluded.failure_count,
          last_failed_at = excluded.last_failed_at,
          last_error = excluded.last_error,
          dead_lettered_at = excluded.dead_lettered_at,
          resolved_at = NULL,
          updated_at = excluded.updated_at
      `).run(
        id,
        String(username || existing?.username || ''),
        String(sourceUrl || existing?.source_url || ''),
        String(title || existing?.title || ''),
        String(mediaType || existing?.media_type || ''),
        status,
        failureCount,
        Number(existing?.retry_count ?? 0),
        Number(existing?.first_failed_at ?? 0) || now,
        now,
        lastError,
        deadLetteredAt,
        existing?.last_retry_at ?? null,
        now,
      );
      const failure = this.getMonitorDownloadFailure(id);
      this.db.exec('COMMIT');
      return failure;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markMonitorDownloadFailureResolved(videoId, now = Date.now()) {
    const id = String(videoId ?? '').trim();
    if (!id) return null;
    this.db.prepare(`
      UPDATE monitor_download_failures
      SET
        status = 'resolved',
        failure_count = 0,
        resolved_at = ?,
        dead_lettered_at = NULL,
        updated_at = ?
      WHERE video_id = ? AND status <> 'resolved'
    `).run(now, now, id);
    return this.getMonitorDownloadFailure(id);
  }

  retryMonitorDownloadFailure(videoId, now = Date.now()) {
    const id = String(videoId ?? '').trim();
    if (!id) return { accepted: false, reason: 'not_found', failure: null };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const failure = this.getMonitorDownloadFailure(id);
      if (!failure) {
        this.db.exec('COMMIT');
        return { accepted: false, reason: 'not_found', failure: null };
      }
      if (failure.status !== 'dead_letter') {
        this.db.exec('COMMIT');
        return { accepted: false, reason: 'not_retryable', failure };
      }
      this.db.prepare(`
        UPDATE monitor_download_failures
        SET
          status = 'retrying',
          retry_count = retry_count + 1,
          last_retry_at = ?,
          resolved_at = NULL,
          updated_at = ?
        WHERE video_id = ? AND status = 'dead_letter'
      `).run(now, now, id);
      const claimed = this.getMonitorDownloadFailure(id);
      this.db.exec('COMMIT');
      return { accepted: true, failure: claimed };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  releaseMonitorDownloadRetry(videoId, now = Date.now()) {
    const id = String(videoId ?? '').trim();
    if (!id) return null;
    this.db.prepare(`
      UPDATE monitor_download_failures
      SET
        status = 'dead_letter',
        dead_lettered_at = COALESCE(dead_lettered_at, ?),
        updated_at = ?
      WHERE video_id = ? AND status = 'retrying'
    `).run(now, now, id);
    return this.getMonitorDownloadFailure(id);
  }

  listMonitorDownloadFailures({ username = '', statuses = ['dead_letter', 'retrying'], limit = 25 } = {}) {
    const allowedStatuses = new Set(['retryable', 'dead_letter', 'retrying', 'resolved']);
    const normalizedStatuses = [...new Set((Array.isArray(statuses) ? statuses : [statuses])
      .map((status) => String(status ?? '').trim())
      .filter((status) => allowedStatuses.has(status)))];
    if (!normalizedStatuses.length) return [];
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    const placeholders = normalizedStatuses.map(() => '?').join(', ');
    const normalizedUsername = String(username ?? '').trim();
    return this.db.prepare(`
      SELECT *
      FROM monitor_download_failures
      WHERE status IN (${placeholders})
        AND (? = '' OR username = ? COLLATE NOCASE)
      ORDER BY updated_at DESC, video_id
      LIMIT ?
    `).all(...normalizedStatuses, normalizedUsername, normalizedUsername, boundedLimit);
  }

  listMonitorDownloadFailuresForScope({
    guildId = '',
    channelId = '',
    username = '',
    limit = 25,
  } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    const normalizedGuildId = String(guildId ?? '');
    const normalizedChannelId = String(channelId ?? '');
    const normalizedUsername = String(username ?? '').trim();
    return this.db.prepare(`
      SELECT monitor_download_failures.*
      FROM monitor_download_failures
      WHERE monitor_download_failures.status IN ('dead_letter', 'retrying')
        AND (? = '' OR monitor_download_failures.username = ? COLLATE NOCASE)
        AND EXISTS (
          SELECT 1
          FROM watch_subscriptions
          WHERE watch_subscriptions.username = monitor_download_failures.username
            AND (
              watch_subscriptions.guild_id = ?
              OR (
                watch_subscriptions.guild_id = ''
                AND watch_subscriptions.channel_id = ?
              )
            )
        )
      ORDER BY monitor_download_failures.updated_at DESC, monitor_download_failures.video_id
      LIMIT ?
    `).all(
      normalizedUsername,
      normalizedUsername,
      normalizedGuildId,
      normalizedChannelId,
      boundedLimit,
    );
  }

  recordWatchIdentity(username, {
    creatorId = '',
    currentUsername = '',
    secUid = '',
    authorId = '',
    hasStory = null,
    storyStatusCheckedAt = null,
    platform = '',
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
    let inferredPlatform = platform ? normalizePlatform(platform) : '';
    if (!inferredPlatform) {
      const existingFallback = this.getWatch(previousUsername) ?? this.db.prepare('SELECT * FROM watched_users WHERE username = ? LIMIT 1').get(previousUsername) ?? null;
      inferredPlatform = normalizePlatform(existingFallback?.platform ?? 'tiktok');
    } else {
      inferredPlatform = normalizePlatform(inferredPlatform);
    }
    let existing;
    try {
      existing = this.db.prepare('SELECT * FROM watched_users WHERE platform = ? AND username = ?').get(inferredPlatform, previousUsername) ?? null;
    } catch {
      existing = this.db.prepare('SELECT * FROM watched_users WHERE username = ?').get(previousUsername) ?? null;
      inferredPlatform = normalizePlatform(existing?.platform ?? inferredPlatform);
    }
    if (!existing) return { changed: false, username: nextUsername, previousUsername, creatorId: id, secUid: nextSecUid, authorId: nextAuthorId };

    if (id || nextSecUid || nextAuthorId || nextHasStory !== null) {
      try {
        this.db.prepare(`
          UPDATE watched_users
          SET
            creator_id = COALESCE(NULLIF(?, ''), creator_id),
            sec_uid = COALESCE(NULLIF(?, ''), sec_uid),
            author_id = COALESCE(NULLIF(?, ''), author_id),
            has_story = COALESCE(?, has_story),
            story_status_checked_at = COALESCE(?, story_status_checked_at)
          WHERE platform = ? AND username = ?
        `).run(id, nextSecUid, nextAuthorId, nextHasStory, nextStoryStatusCheckedAt, inferredPlatform, previousUsername);
      } catch {
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
    }

    if (!nextUsername || nextUsername.toLowerCase() === previousUsername.toLowerCase()) {
      return {
        changed: false,
        username: previousUsername,
        previousUsername,
        creatorId: id || existing.creator_id || '',
        secUid: nextSecUid || existing.sec_uid || '',
        authorId: nextAuthorId || existing.author_id || '',
        platform: inferredPlatform,
      };
    }

    this.db.prepare(`
      INSERT INTO watch_username_history (creator_id, previous_username, new_username, detected_at)
      VALUES (?, ?, ?, ?)
    `).run(id || existing.creator_id || '', previousUsername, nextUsername, now);

    let conflict;
    try {
      conflict = this.db.prepare('SELECT * FROM watched_users WHERE platform = ? AND username = ?').get(inferredPlatform, nextUsername) ?? null;
    } catch {
      conflict = this.db.prepare('SELECT * FROM watched_users WHERE username = ?').get(nextUsername) ?? null;
    }
    if (conflict) {
      try {
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
          WHERE platform = ? AND username = ?
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
          inferredPlatform,
          nextUsername,
        );
        this.db.prepare('DELETE FROM watched_users WHERE platform = ? AND username = ?').run(inferredPlatform, previousUsername);
      } catch {
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
      }
    } else {
      try {
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
          WHERE platform = ? AND username = ?
        `).run(nextUsername, id, nextSecUid, nextAuthorId, nextHasStory, nextStoryStatusCheckedAt, previousUsername, now, inferredPlatform, previousUsername);
      } catch {
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
    }

    this.moveWatchSubscriptions(previousUsername, nextUsername, inferredPlatform);
    try {
      this.db.prepare(`
        UPDATE monitor_download_failures
        SET username = ?, updated_at = ?
        WHERE platform = ? AND username = ? COLLATE NOCASE
      `).run(nextUsername, now, inferredPlatform, previousUsername);
    } catch {
      this.db.prepare(`
        UPDATE monitor_download_failures
        SET username = ?, updated_at = ?
        WHERE username = ? COLLATE NOCASE
      `).run(nextUsername, now, previousUsername);
    }

    return {
      changed: true,
      username: nextUsername,
      previousUsername,
      creatorId: id || existing.creator_id || '',
      secUid: nextSecUid || existing.sec_uid || '',
      authorId: nextAuthorId || existing.author_id || '',
      platform: inferredPlatform,
    };
  }

  moveWatchSubscriptions(previousUsername, nextUsername, platform = '') {
    if (!previousUsername || !nextUsername || previousUsername === nextUsername) return;
    const normalizedPlatform = platform ? normalizePlatform(platform) : '';
    if (normalizedPlatform) {
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO watch_subscriptions (platform, username, guild_id, channel_id, created_by, created_at)
          SELECT platform, ?, guild_id, channel_id, created_by, created_at
          FROM watch_subscriptions
          WHERE platform = ? AND username = ?
        `).run(nextUsername, normalizedPlatform, previousUsername);
        this.db.prepare('DELETE FROM watch_subscriptions WHERE platform = ? AND username = ?').run(normalizedPlatform, previousUsername);
        return;
      } catch {}
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO watch_subscriptions (username, guild_id, channel_id, created_by, created_at)
      SELECT ?, guild_id, channel_id, created_by, created_at
      FROM watch_subscriptions
      WHERE username = ?
    `).run(nextUsername, previousUsername);
    this.db.prepare('DELETE FROM watch_subscriptions WHERE username = ?').run(previousUsername);
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO watch_subscriptions (platform, username, guild_id, channel_id, created_by, created_at)
        SELECT platform, ?, guild_id, channel_id, created_by, created_at
        FROM watch_subscriptions
        WHERE username = ?
      `).run(nextUsername, previousUsername);
      this.db.prepare('DELETE FROM watch_subscriptions WHERE username = ? AND platform IS NOT NULL').run(previousUsername);
    } catch {}
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
    const normalizedUsername = String(username ?? '').trim();
    try {
      const watch = this.db.prepare('SELECT platform FROM watched_users WHERE username = ? LIMIT 1').get(normalizedUsername);
      if (watch?.platform) {
        this.db.prepare(`
          UPDATE watched_users
          SET last_checked_at = ?, last_success_at = ?, failure_count = 0, last_error = NULL, next_check_at = ?
          WHERE platform = ? AND username = ?
        `).run(now, now, nextCheckAt, watch.platform, normalizedUsername);
        return;
      }
    } catch {}

    this.db.prepare(`
      UPDATE watched_users
      SET last_checked_at = ?, last_success_at = ?, failure_count = 0, last_error = NULL, next_check_at = ?
      WHERE username = ?
    `).run(now, now, nextCheckAt, username);
  }

  markWatchFailure(username, error, nextCheckAt, now = Date.now()) {
    const normalizedUsername = String(username ?? '').trim();
    try {
      const watch = this.db.prepare('SELECT platform FROM watched_users WHERE username = ? LIMIT 1').get(normalizedUsername);
      if (watch?.platform) {
        this.db.prepare(`
          UPDATE watched_users
          SET last_checked_at = ?, failure_count = failure_count + 1, last_error = ?, next_check_at = ?
          WHERE platform = ? AND username = ?
        `).run(now, String(error).slice(0, 500), nextCheckAt, watch.platform, normalizedUsername);
        return;
      }
    } catch {}

    this.db.prepare(`
      UPDATE watched_users
      SET last_checked_at = ?, failure_count = failure_count + 1, last_error = ?, next_check_at = ?
      WHERE username = ?
    `).run(now, String(error).slice(0, 500), nextCheckAt, username);
  }
  markHighlightCheckSuccess(username, platform = 'instagram', now = Date.now(), nextCheckAt = null) {
    const normalizedUsername = String(username ?? '').trim();
    const normalizedPlatform = normalizePlatform(platform ?? 'instagram');
    try {
      this.db.prepare(`
        UPDATE watched_users
        SET last_highlight_check_at = ?, highlight_failure_count = 0, highlight_last_error = NULL, next_highlight_check_at = ?
        WHERE platform = ? AND username = ?
      `).run(now, nextCheckAt, normalizedPlatform, normalizedUsername);
    } catch {
      this.db.prepare(`
        UPDATE watched_users
        SET last_highlight_check_at = ?, highlight_failure_count = 0, highlight_last_error = NULL, next_highlight_check_at = ?
        WHERE username = ?
      `).run(now, nextCheckAt, normalizedUsername);
    }
  }

  markHighlightCheckFailure(username, platform = 'instagram', error = '', nextCheckAt = null, now = Date.now()) {
    const normalizedUsername = String(username ?? '').trim();
    const normalizedPlatform = normalizePlatform(platform ?? 'instagram');
    const lastError = String(error?.message ?? error ?? '').slice(0, 500);
    try {
      this.db.prepare(`
        UPDATE watched_users
        SET last_highlight_check_at = ?, highlight_failure_count = highlight_failure_count + 1, highlight_last_error = ?, next_highlight_check_at = ?
        WHERE platform = ? AND username = ?
      `).run(now, lastError, nextCheckAt, normalizedPlatform, normalizedUsername);
    } catch {
      this.db.prepare(`
        UPDATE watched_users
        SET last_highlight_check_at = ?, highlight_failure_count = highlight_failure_count + 1, highlight_last_error = ?, next_highlight_check_at = ?
        WHERE username = ?
      `).run(now, lastError, nextCheckAt, normalizedUsername);
    }
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

  clearDeletionChecksForUsername(username, platform = '') {
    const normalizedUsername = String(username ?? '').trim();
    if (platform) {
      const normalizedPlatform = normalizePlatform(platform);
      try {
        return this.db.prepare(`
          UPDATE seen_videos
          SET next_deletion_check_at = NULL, deletion_check_claimed_at = NULL
          WHERE platform = ? AND username = ? COLLATE NOCASE
        `).run(normalizedPlatform, normalizedUsername).changes;
      } catch {}
    }

    return this.db.prepare(`
      UPDATE seen_videos
      SET next_deletion_check_at = NULL, deletion_check_claimed_at = NULL
      WHERE username = ? COLLATE NOCASE
    `).run(String(username)).changes;
  }

  backfillDeletionChecks(now = Date.now()) {
    return this.db.prepare(`
      UPDATE seen_videos
      SET
        next_deletion_check_at = ?,
        deletion_check_claimed_at = NULL,
        last_available_at = COALESCE(last_available_at, alerted_at, seen_at)
      WHERE alerted_at IS NOT NULL
        AND deleted_at IS NULL
        AND next_deletion_check_at IS NULL
        AND source_url NOT LIKE '%/story/%'
        AND EXISTS (
          SELECT 1
          FROM watch_subscriptions
          WHERE watch_subscriptions.username = seen_videos.username COLLATE NOCASE
        )
        AND EXISTS (
          SELECT 1
          FROM files
          JOIN link_tokens ON link_tokens.file_id = files.id
          WHERE files.platform = 'tiktok'
            AND files.video_id = seen_videos.video_id
            AND files.trashed_at IS NULL
            AND link_tokens.expires_at = 0
        )
    `).run(now).changes;
  }

  listVideosDueForDeletionCheck(now = Date.now(), limit = 25, leaseMs = 10 * 60 * 1000) {
    return this.db.prepare(`
      SELECT
        seen_videos.*,
        (
          SELECT link_tokens.token
          FROM files
          JOIN link_tokens ON link_tokens.file_id = files.id
          WHERE files.platform = 'tiktok'
            AND files.video_id = seen_videos.video_id
            AND files.trashed_at IS NULL
            AND link_tokens.expires_at = 0
          ORDER BY link_tokens.created_at DESC
          LIMIT 1
        ) AS permanent_token,
        (
          SELECT files.filename
          FROM files
          WHERE files.platform = 'tiktok'
            AND files.video_id = seen_videos.video_id
            AND files.trashed_at IS NULL
          ORDER BY files.created_at DESC
          LIMIT 1
        ) AS filename
      FROM seen_videos
      WHERE alerted_at IS NOT NULL
        AND (deleted_at IS NULL OR deletion_alerted_at IS NULL)
        AND next_deletion_check_at IS NOT NULL
        AND next_deletion_check_at <= ?
        AND EXISTS (
          SELECT 1
          FROM watch_subscriptions
          WHERE watch_subscriptions.username = seen_videos.username COLLATE NOCASE
        )
        AND EXISTS (
          SELECT 1
          FROM files
          JOIN link_tokens ON link_tokens.file_id = files.id
          WHERE files.platform = 'tiktok'
            AND files.video_id = seen_videos.video_id
            AND files.trashed_at IS NULL
            AND link_tokens.expires_at = 0
        )
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
        deletion_check_count = deletion_check_count + 1,
        deletion_missing_since = NULL,
        deletion_missing_count = 0,
        deletion_reason = NULL
      WHERE video_id = ?
    `).run(now, now, nextCheckAt, String(videoId));
  }

  recordVideoMissing(videoId, nextCheckAt, reason = '', now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET
        last_deletion_checked_at = ?,
        next_deletion_check_at = ?,
        deletion_check_claimed_at = NULL,
        deletion_check_count = deletion_check_count + 1,
        deletion_missing_since = COALESCE(deletion_missing_since, ?),
        deletion_missing_count = deletion_missing_count + 1,
        deletion_reason = ?
      WHERE video_id = ?
        AND deleted_at IS NULL
    `).run(now, nextCheckAt, now, String(reason).slice(0, 500), String(videoId));
    return this.db.prepare('SELECT * FROM seen_videos WHERE video_id = ?').get(String(videoId)) ?? null;
  }

  postponeVideoDeletionCheck(videoId, nextCheckAt, now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET last_deletion_checked_at = ?, next_deletion_check_at = ?, deletion_check_claimed_at = NULL
      WHERE video_id = ?
    `).run(now, nextCheckAt, String(videoId));
  }

  markVideoDeleted(videoId, reason = '', now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET
        deleted_at = ?,
        deletion_reason = ?,
        last_deletion_checked_at = ?,
        next_deletion_check_at = ?,
        deletion_check_claimed_at = NULL
      WHERE video_id = ?
    `).run(now, String(reason).slice(0, 500), now, now, String(videoId));
    return this.db.prepare('SELECT * FROM seen_videos WHERE video_id = ?').get(String(videoId)) ?? null;
  }

  markVideoDeletionAlerted(videoId, now = Date.now()) {
    this.db.prepare(`
      UPDATE seen_videos
      SET deletion_alerted_at = ?, next_deletion_check_at = NULL, deletion_check_claimed_at = NULL
      WHERE video_id = ?
        AND deleted_at IS NOT NULL
    `).run(now, String(videoId));
    return this.db.prepare('SELECT * FROM seen_videos WHERE video_id = ?').get(String(videoId)) ?? null;
  }

  createJob({
    platform = 'tiktok',
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
      INSERT INTO jobs (platform, type, status, requested_by, guild_id, channel_id, username, source_url, video_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizePlatform(platform),
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
    const allowed = ['platform', 'status', 'requested_by', 'guild_id', 'channel_id', 'username', 'source_url', 'video_id', 'title', 'file_id', 'error'];
    const entries = Object.entries(changes)
      .filter(([key]) => allowed.includes(key))
      .map(([key, value]) => [key, key === 'platform' ? normalizePlatform(value) : value]);
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
      if (!['queued', 'running', 'canceling'].includes(record.status)) {
        this.db.exec('COMMIT');
        return { accepted: false, reason: 'not_active', import: record };
      }
      if (record.status === 'canceling') {
        this.db.exec('COMMIT');
        return { accepted: true, reason: null, import: record };
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
          SET
            status = 'canceling',
            cancel_requested_at = COALESCE(cancel_requested_at, ?),
            updated_at = ?
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
          AND status IN ('queued', 'running', 'canceling')
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
        WHERE status = 'canceling'
           OR (
             status IN ('queued', 'running')
             AND cancel_requested_at IS NOT NULL
           )
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

  createFileRecord({ platform = 'tiktok', videoId = '', username = '', requestedBy = '', sourceUrl, filePath, filename, sizeBytes }, now = Date.now()) {
    const result = this.db.prepare(`
      INSERT INTO files (platform, video_id, username, requested_by, source_url, path, filename, size_bytes, created_at, retention_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(normalizePlatform(platform), videoId, username, String(requestedBy ?? ''), sourceUrl, filePath, filename, sizeBytes, now);
    return Number(result.lastInsertRowid);
  }

  getLatestFileByVideoId(videoId, { includeTrashed = false } = {}) {
    return this.getLatestFileByPost('tiktok', videoId, { includeTrashed });
  }

  getLatestFileByPost(platform, postId, { includeTrashed = false } = {}) {
    if (!postId) return null;
    return this.db.prepare(`
      SELECT *
      FROM files
      WHERE platform = ?
        AND video_id = ?
        ${includeTrashed ? '' : "AND retention_status = 'active'"}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(normalizePlatform(platform), String(postId)) ?? null;
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const fileRecord = this.db.prepare(`
        SELECT requested_by, trashed_at, retention_status
        FROM files
        WHERE id = ?
      `).get(fileId);
      if (
        !fileRecord
        || fileRecord.trashed_at != null
        || ['trashed', 'trash_claimed', 'trash_failed'].includes(fileRecord.retention_status)
      ) {
        throw new Error('Cannot create a delivery for a missing or trashed archive file.');
      }
      if (!['active', 'expiry_failed'].includes(fileRecord.retention_status)) {
        throw new Error('Cannot create a delivery while the archive file is claimed for deletion.');
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
      // A failed deletion remains retryable until a new delivery revives it.
      // Claimed files are deliberately excluded so cleanup owns the bytes until
      // it either finalizes the deletion or records a failure.
      this.db.prepare(`
        UPDATE files
        SET delete_requested_at = NULL, delete_error = NULL, retention_status = 'active'
        WHERE id = ?
          AND retention_status IN ('active', 'expiry_failed')
      `).run(fileId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  getPermanentMonitorDeliveryForFile(fileId, { scopeId = '' } = {}) {
    const numericFileId = Number(fileId);
    if (!Number.isInteger(numericFileId) || numericFileId <= 0) return null;
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
      WHERE link_tokens.file_id = ?
        AND files.trashed_at IS NULL
        AND link_tokens.delivery_type = 'monitor'
        AND link_tokens.expires_at = 0
        AND link_tokens.scope_id = ?
      ORDER BY link_tokens.created_at DESC, link_tokens.token DESC
      LIMIT 1
    `).get(numericFileId, String(scopeId ?? '')) ?? null;
  }

  getLatestPermanentTokenForVideo(videoId, { scopeId = '' } = {}) {
    if (!videoId) return '';
    const row = this.db.prepare(`
      SELECT link_tokens.token
      FROM link_tokens
      JOIN files ON files.id = link_tokens.file_id
      WHERE files.platform = 'tiktok'
        AND files.video_id = ?
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        UPDATE link_tokens
        SET expires_at = CASE
          WHEN expires_at = 0 THEN 0
          WHEN expires_at > ? THEN expires_at + ?
          ELSE ?
        END
        WHERE token = ?
          AND file_id IN (
            SELECT id
            FROM files
            WHERE trashed_at IS NULL
              AND retention_status IN ('active', 'expiry_failed')
          )
      `).run(now, additionalMs, newExpiry, token);
      if (result.changes > 0) {
        this.db.prepare(`
          UPDATE files
          SET delete_requested_at = NULL, delete_error = NULL, retention_status = 'active'
          WHERE id = (SELECT file_id FROM link_tokens WHERE token = ?)
            AND retention_status = 'expiry_failed'
        `).run(token);
      }
      this.db.exec('COMMIT');
      return result.changes > 0 ? this.getToken(token) : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setLinkTokenPermanent(token) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        UPDATE link_tokens
        SET expires_at = 0
        WHERE token = ?
          AND file_id IN (
            SELECT id
            FROM files
            WHERE trashed_at IS NULL
              AND retention_status IN ('active', 'expiry_failed')
          )
      `).run(token);
      if (result.changes > 0) {
        this.db.prepare(`
          UPDATE files
          SET delete_requested_at = NULL, delete_error = NULL, retention_status = 'active'
          WHERE id = (SELECT file_id FROM link_tokens WHERE token = ?)
            AND retention_status = 'expiry_failed'
        `).run(token);
      }
      this.db.exec('COMMIT');
      return result.changes > 0 ? this.getToken(token) : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteExpiredTokens(now = Date.now()) {
    return this.db.prepare('DELETE FROM link_tokens WHERE expires_at > 0 AND expires_at <= ?').run(now).changes;
  }

  listFilesWithoutActiveLinks(now = Date.now(), limit = 100, createdBefore = now) {
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
      ORDER BY files.created_at ASC
      LIMIT ?
    `).all(createdBefore, now, now, Math.max(1, Math.min(1_000, Number(limit) || 100)));
    return this.withMediaAssetPaths(files);
  }

  claimFilesForDeletion(
    now = Date.now(),
    limit = 100,
    createdBefore = now,
    leaseMs = DEFAULT_DELETION_CLAIM_LEASE_MS,
  ) {
    const boundedLimit = Math.max(1, Math.min(1_000, Number(limit) || 100));
    const claimAt = Math.max(0, Number(now) || 0);
    const staleClaimBefore = claimAt - Math.max(1, Number(leaseMs) || DEFAULT_DELETION_CLAIM_LEASE_MS);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const files = this.db.prepare(`
        SELECT files.id, files.path, files.filename, files.video_id
        FROM files
        WHERE files.trashed_at IS NULL
          AND (
            files.retention_status IN ('active', 'expiry_failed')
            OR (
              files.retention_status = 'expiry_claimed'
              AND files.delete_requested_at <= ?
            )
          )
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
      `).all(staleClaimBefore, createdBefore, claimAt, claimAt, boundedLimit);
      if (files.length) {
        const ids = files.map((file) => Number(file.id));
        const placeholders = ids.map(() => '?').join(', ');
        this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = ?,
            delete_attempts = delete_attempts + 1,
            delete_error = NULL,
            retention_status = 'expiry_claimed'
          WHERE id IN (${placeholders})
            AND (
              retention_status IN ('active', 'expiry_failed')
              OR (retention_status = 'expiry_claimed' AND delete_requested_at <= ?)
            )
        `).run(claimAt, ...ids, staleClaimBefore);
      }
      this.db.exec('COMMIT');
      return this.withMediaAssetPaths(files.map((file) => ({
        ...file,
        delete_requested_at: claimAt,
        retention_status: 'expiry_claimed',
      })));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markFileDeletionFailed(fileId, error, now = Date.now(), {
    expectedRetentionStatus = '',
    expectedRequestedAt = null,
  } = {}) {
    const message = String(error?.message ?? error ?? 'Unknown disk deletion failure').slice(0, 500);
    const clauses = ['id = ?'];
    const params = [now, message, Number(fileId)];
    if (expectedRetentionStatus) {
      clauses.push('retention_status = ?');
      params.push(String(expectedRetentionStatus));
    }
    if (expectedRequestedAt != null) {
      clauses.push('delete_requested_at = ?');
      params.push(Number(expectedRequestedAt));
    }
    const result = this.db.prepare(`
      UPDATE files
      SET
        delete_requested_at = COALESCE(delete_requested_at, ?),
        delete_attempts = delete_attempts + CASE WHEN delete_requested_at IS NULL THEN 1 ELSE 0 END,
        delete_error = ?,
        retention_status = CASE
          WHEN trashed_at IS NOT NULL OR retention_status IN ('trashed', 'trash_claimed', 'trash_failed') THEN 'trash_failed'
          ELSE 'expiry_failed'
        END
      WHERE ${clauses.join(' AND ')}
    `).run(...params);
    return result.changes > 0;
  }

  listRewindCreators() {
    return this.db.prepare(`
      WITH saved AS (
        SELECT
          lower(username) AS username_key,
          username,
          COUNT(*) AS video_count,
          SUM(size_bytes) AS size_bytes,
          MAX(created_at) AS latest_created_at
        FROM files
        WHERE files.platform = 'tiktok'
          AND username IS NOT NULL
          AND username <> ''
          AND lower(filename) LIKE '%.mp4'
          AND trashed_at IS NULL
        GROUP BY lower(username)
      )
      SELECT
        watched_users.username,
        COALESCE(saved.video_count, 0) AS video_count,
        COALESCE(saved.size_bytes, 0) AS size_bytes,
        COALESCE(saved.latest_created_at, watched_users.last_success_at, watched_users.created_at) AS latest_at,
        watched_users.failure_count,
        1 AS enabled
      FROM watched_users
      LEFT JOIN saved ON saved.username_key = lower(watched_users.username)
      UNION ALL
      SELECT
        saved.username,
        saved.video_count,
        saved.size_bytes,
        saved.latest_created_at AS latest_at,
        0 AS failure_count,
        0 AS enabled
      FROM saved
      WHERE NOT EXISTS (
        SELECT 1 FROM watched_users WHERE lower(watched_users.username) = saved.username_key
      )
      ORDER BY video_count DESC, username ASC
    `).all();
  }

  listRewindVideos({
    username = '',
    fileId = null,
    limit = 500,
    cursor = null,
    bookmarkedOnly = false,
  } = {}) {
    const clauses = [
      "files.platform = 'tiktok'",
      "lower(files.filename) LIKE '%.mp4'",
      'files.trashed_at IS NULL',
    ];
    const params = [];
    const normalizedUsername = String(username ?? '').trim();
    if (normalizedUsername) {
      clauses.push('files.username = ? COLLATE NOCASE');
      params.push(normalizedUsername);
    }
    if (fileId != null && fileId !== '') {
      clauses.push('files.id = ?');
      params.push(normalizePositiveId(fileId, 'file'));
    }
    if (cursor != null) {
      const createdAt = Number(cursor?.createdAt ?? cursor?.created_at);
      const cursorFileId = Number(cursor?.fileId ?? cursor?.file_id);
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new Error('A valid Rewind cursor timestamp is required.');
      }
      if (!Number.isSafeInteger(cursorFileId) || cursorFileId <= 0) {
        throw new Error('A valid Rewind cursor file ID is required.');
      }
      clauses.push('(files.created_at < ? OR (files.created_at = ? AND files.id < ?))');
      params.push(createdAt, createdAt, cursorFileId);
    }
    if (bookmarkedOnly) {
      clauses.push(`EXISTS (
        SELECT 1 FROM bookmarks WHERE bookmarks.file_id = files.id
      )`);
    }
    const boundedLimit = Math.max(1, Math.min(5_001, Math.trunc(Number(limit) || 500)));
    params.push(boundedLimit);

    return this.db.prepare(`
      SELECT
        files.id,
        files.video_id,
        files.username,
        files.source_url,
        files.path,
        files.filename,
        files.size_bytes,
        files.created_at,
        COALESCE(
          (
            SELECT jobs.title
            FROM jobs
            WHERE jobs.file_id = files.id
              AND jobs.title IS NOT NULL
              AND jobs.title <> ''
            ORDER BY jobs.created_at DESC, jobs.id DESC
            LIMIT 1
          ),
          files.filename
        ) AS title
      FROM files
      WHERE ${clauses.join('\n        AND ')}
      ORDER BY files.created_at DESC, files.id DESC
      LIMIT ?
    `).all(...params);
  }

  listRewindMediaPosts({
    platform = '',
    username = '',
    profileId = null,
    groupId = null,
    fileId = null,
    limit = 100,
    cursor = null,
    bookmarkedOnly = false,
    trashedOnly = false,
  } = {}) {
    const clauses = [trashedOnly
      ? "files.retention_status IN ('trashed', 'trash_claimed', 'trash_failed')"
      : 'files.trashed_at IS NULL'];
    const params = [];
    const normalizedPlatform = String(platform ?? '').trim();
    if (normalizedPlatform) {
      clauses.push('files.platform = ?');
      params.push(normalizePlatform(normalizedPlatform));
    }
    const normalizedUsername = String(username ?? '').trim().replace(/^@/, '');
    if (normalizedUsername) {
      clauses.push(`COALESCE(NULLIF(media_posts.creator_handle, ''), files.username, '') = ? COLLATE NOCASE`);
      params.push(normalizedUsername);
    }
    if (profileId != null && profileId !== '') {
      clauses.push('media_posts.profile_id = ?');
      params.push(normalizePositiveId(profileId, 'profile'));
    }
    if (groupId != null && groupId !== '') {
      clauses.push('creator_group_memberships.group_id = ?');
      params.push(normalizePositiveId(groupId, 'creator group'));
    }
    if (fileId != null && fileId !== '') {
      clauses.push('files.id = ?');
      params.push(normalizePositiveId(fileId, 'file'));
    }
    if (cursor != null) {
      const createdAt = Number(cursor?.createdAt ?? cursor?.created_at);
      const cursorFileId = Number(cursor?.fileId ?? cursor?.file_id);
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new Error('A valid Rewind media cursor timestamp is required.');
      }
      if (!Number.isSafeInteger(cursorFileId) || cursorFileId <= 0) {
        throw new Error('A valid Rewind media cursor file ID is required.');
      }
      clauses.push('(files.created_at < ? OR (files.created_at = ? AND files.id < ?))');
      params.push(createdAt, createdAt, cursorFileId);
    }
    if (bookmarkedOnly) {
      clauses.push('EXISTS (SELECT 1 FROM bookmarks WHERE bookmarks.file_id = files.id)');
    }
    const boundedLimit = Math.max(1, Math.min(501, Math.trunc(Number(limit) || 100)));
    params.push(boundedLimit);

    const rows = this.db.prepare(`
      SELECT
        files.id,
        files.platform,
        files.video_id AS remote_id,
        files.username,
        files.source_url,
        files.path,
        files.filename,
        files.size_bytes,
        files.created_at,
        files.trashed_at,
        files.retention_status,
        media_posts.id AS post_id,
        media_posts.profile_id,
        COALESCE(NULLIF(media_posts.creator_handle, ''), files.username, '') AS creator_handle,
        COALESCE(media_posts.creator_remote_id, '') AS creator_remote_id,
        COALESCE(NULLIF(platform_profiles.display_name, ''), '') AS creator_display_name,
        COALESCE(platform_profiles.profile_url, '') AS creator_profile_url,
        creator_group_memberships.group_id AS creator_group_id,
        COALESCE(creator_groups.name, '') AS creator_group_name,
        COALESCE(NULLIF(media_posts.canonical_url, ''), files.source_url) AS canonical_url,
        COALESCE(NULLIF(media_posts.title, ''), (
          SELECT jobs.title
          FROM jobs
          WHERE jobs.file_id = files.id
            AND jobs.title IS NOT NULL
            AND jobs.title <> ''
          ORDER BY jobs.created_at DESC, jobs.id DESC
          LIMIT 1
        ), files.filename) AS title,
        COALESCE(media_posts.description, '') AS description,
        COALESCE(NULLIF(media_posts.media_type, ''), '') AS media_type,
        media_posts.published_at,
        media_posts.duration_seconds,
        CASE WHEN EXISTS (
          SELECT 1 FROM bookmarks WHERE bookmarks.file_id = files.id
        ) THEN 1 ELSE 0 END AS bookmarked
      FROM files
      LEFT JOIN media_posts
        ON media_posts.platform = files.platform
       AND media_posts.remote_id = files.video_id
      LEFT JOIN platform_profiles ON platform_profiles.id = media_posts.profile_id
      LEFT JOIN creator_group_memberships
        ON creator_group_memberships.profile_id = media_posts.profile_id
      LEFT JOIN creator_groups ON creator_groups.id = creator_group_memberships.group_id
      WHERE ${clauses.join('\n        AND ')}
      ORDER BY files.created_at DESC, files.id DESC
      LIMIT ?
    `).all(...params);
    if (!rows.length) return [];

    const fileIds = rows.map((row) => Number(row.id));
    const placeholders = fileIds.map(() => '?').join(', ');
    const storedAssets = this.db.prepare(`
      SELECT
        id,
        post_id,
        file_id,
        position,
        role,
        remote_id,
        kind,
        mime_type,
        path,
        filename,
        size_bytes,
        width,
        height,
        duration_seconds
      FROM media_assets
      WHERE file_id IN (${placeholders})
      ORDER BY file_id,
        CASE role WHEN 'content' THEN 0 WHEN 'primary' THEN 1 WHEN 'package' THEN 2 ELSE 3 END,
        position,
        id
    `).all(...fileIds);
    const assetsByFile = new Map();
    for (const asset of storedAssets) {
      const assets = assetsByFile.get(Number(asset.file_id)) ?? [];
      assets.push(asset);
      assetsByFile.set(Number(asset.file_id), assets);
    }
    return rows.map((row) => {
      const assets = assetsByFile.get(Number(row.id)) ?? [rewindFallbackAsset(row)];
      return {
        ...row,
        asset_count: assets.filter((asset) => asset.role === 'content' || asset.role === 'primary').length,
        assets,
      };
    });
  }

  getRewindStats(now = Date.now()) {
    const timestamp = Math.max(0, Math.trunc(Number(now) || 0));
    const current = new Date(timestamp);
    const startOfUtcDay = Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate(),
    );
    return this.db.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM (
            SELECT lower(username) AS username_key FROM watched_users
            UNION
            SELECT lower(username) AS username_key
            FROM files
            WHERE files.platform = 'tiktok'
              AND username <> ''
              AND lower(filename) LIKE '%.mp4'
              AND trashed_at IS NULL
          )
        ) AS creator_count,
        (
          SELECT COUNT(*) FROM files
          WHERE files.platform = 'tiktok'
            AND lower(filename) LIKE '%.mp4' AND trashed_at IS NULL
        ) AS video_count,
        (
          SELECT COALESCE(SUM(size_bytes), 0) FROM files
          WHERE files.platform = 'tiktok'
            AND lower(filename) LIKE '%.mp4' AND trashed_at IS NULL
        ) AS size_bytes,
        (
          SELECT COUNT(*)
          FROM files
          WHERE files.platform = 'tiktok'
            AND lower(filename) LIKE '%.mp4'
            AND trashed_at IS NULL
            AND created_at >= ?
        ) AS new_this_week,
        (
          SELECT COUNT(*)
          FROM files
          WHERE files.platform = 'tiktok'
            AND lower(filename) LIKE '%.mp4'
            AND trashed_at IS NULL
            AND created_at >= ?
        ) AS added_today
    `).get(timestamp - 7 * 24 * 60 * 60 * 1_000, startOfUtcDay);
  }

  listBookmarkedFileIds() {
    return this.db.prepare(`
      SELECT bookmarks.file_id
      FROM bookmarks
      JOIN files ON files.id = bookmarks.file_id
      WHERE files.platform = 'tiktok'
        AND files.trashed_at IS NULL
        AND lower(files.filename) LIKE '%.mp4'
      ORDER BY bookmarks.created_at DESC, bookmarks.file_id DESC
    `).all().map((row) => Number(row.file_id));
  }

  setFileBookmark(fileId, bookmarked, now = Date.now()) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return false;
    if (!bookmarked) {
      this.db.prepare(`
        DELETE FROM bookmarks
        WHERE file_id = ?
          AND EXISTS (
            SELECT 1
            FROM files
            WHERE files.id = bookmarks.file_id
              AND files.platform = 'tiktok'
          )
      `).run(numericId);
      return true;
    }
    const result = this.db.prepare(`
      INSERT INTO bookmarks (file_id, created_at)
      SELECT id, ?
      FROM files
      WHERE id = ?
        AND platform = 'tiktok'
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
        AND files.platform = 'tiktok'
        AND files.trashed_at IS NULL
    `).get(numericId));
  }

  setMediaFileBookmark(fileId, bookmarked, now = Date.now()) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return false;
    const active = this.db.prepare(`
      SELECT 1
      FROM files
      WHERE id = ?
        AND trashed_at IS NULL
    `).get(numericId);
    if (!active) return false;
    if (!bookmarked) {
      this.db.prepare('DELETE FROM bookmarks WHERE file_id = ?').run(numericId);
      return true;
    }
    this.db.prepare(`
      INSERT INTO bookmarks (file_id, created_at)
      VALUES (?, ?)
      ON CONFLICT(file_id) DO NOTHING
    `).run(numericId, now);
    return true;
  }

  trashMediaFile(fileId, now = Date.now()) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const result = this.db.prepare(`
      UPDATE files
      SET
        trashed_at = ?,
        delete_requested_at = NULL,
        delete_error = NULL,
        retention_status = 'trashed'
      WHERE id = ?
        AND trashed_at IS NULL
        AND retention_status IN ('active', 'expiry_failed')
    `).run(now, numericId);
    if (!result.changes) return null;
    return this.getTrashedMediaFile(numericId);
  }

  getTrashedMediaFile(fileId) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const file = this.db.prepare(`
      SELECT *
      FROM files
      WHERE id = ?
        AND retention_status IN ('trashed', 'trash_claimed', 'trash_failed')
    `).get(numericId);
    return file ? this.withMediaAssetPaths([file])[0] : null;
  }

  restoreTrashedMediaFile(fileId) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const result = this.db.prepare(`
      UPDATE files
      SET
        trashed_at = NULL,
        delete_requested_at = NULL,
        delete_error = NULL,
        retention_status = 'active'
      WHERE id = ?
        AND retention_status IN ('trashed', 'trash_failed')
    `).run(numericId);
    return result.changes > 0 ? this.db.prepare('SELECT * FROM files WHERE id = ?').get(numericId) : null;
  }

  addFileBookmarks(fileIds, now = Date.now()) {
    const ids = normalizeIds(fileIds).slice(0, 5_000);
    if (!ids.length) return this.listBookmarkedFileIds();
    const insert = this.db.prepare(`
      INSERT INTO bookmarks (file_id, created_at)
      SELECT id, ?
      FROM files
      WHERE id = ?
        AND platform = 'tiktok'
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
        delete_error = NULL,
        retention_status = 'trashed'
      WHERE id = ?
        AND platform = 'tiktok'
        AND retention_status IN ('active', 'expiry_failed')
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
      WHERE platform = 'tiktok'
        AND lower(username) = lower(?)
        AND lower(filename) LIKE '%.mp4'
        AND trashed_at IS NULL
        AND retention_status IN ('active', 'expiry_failed')
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
        delete_error = NULL,
        retention_status = 'trashed'
      WHERE id IN (${placeholders})
        AND retention_status IN ('active', 'expiry_failed')
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
        AND platform = 'tiktok'
        AND retention_status IN ('trashed', 'trash_claimed', 'trash_failed')
    `).get(numericId) ?? null;
  }

  listTrashedFiles(limit = 100) {
    return this.db.prepare(`
      SELECT id, platform, video_id, username, source_url, path, filename, size_bytes, created_at, trashed_at, retention_status
      FROM files
      WHERE platform = 'tiktok'
        AND retention_status IN ('trashed', 'trash_claimed', 'trash_failed')
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
        delete_error = NULL,
        retention_status = 'active'
      WHERE id = ?
        AND platform = 'tiktok'
        AND retention_status IN ('trashed', 'trash_failed')
    `).run(numericId);
    return result.changes > 0 ? this.db.prepare('SELECT * FROM files WHERE id = ?').get(numericId) : null;
  }

  claimTrashedFilesForDeletion(
    trashedBefore,
    now = Date.now(),
    limit = 100,
    leaseMs = DEFAULT_DELETION_CLAIM_LEASE_MS,
  ) {
    const boundedLimit = Math.max(1, Math.min(1_000, Number(limit) || 100));
    const claimAt = Math.max(0, Number(now) || 0);
    const staleClaimBefore = claimAt - Math.max(1, Number(leaseMs) || DEFAULT_DELETION_CLAIM_LEASE_MS);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const files = this.db.prepare(`
        SELECT id, path, filename, video_id, username, trashed_at
        FROM files
        WHERE trashed_at IS NOT NULL
          AND trashed_at <= ?
          AND (
            retention_status IN ('trashed', 'trash_failed')
            OR (retention_status = 'trash_claimed' AND delete_requested_at <= ?)
          )
        ORDER BY
          CASE WHEN delete_requested_at IS NULL THEN 0 ELSE 1 END,
          trashed_at ASC,
          id ASC
        LIMIT ?
      `).all(Number(trashedBefore), staleClaimBefore, boundedLimit);
      if (files.length) {
        const ids = files.map((file) => Number(file.id));
        const placeholders = ids.map(() => '?').join(', ');
        this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = ?,
            delete_attempts = delete_attempts + 1,
            delete_error = NULL,
            retention_status = 'trash_claimed'
          WHERE id IN (${placeholders})
            AND (
              retention_status IN ('trashed', 'trash_failed')
              OR (retention_status = 'trash_claimed' AND delete_requested_at <= ?)
            )
        `).run(claimAt, ...ids, staleClaimBefore);
      }
      this.db.exec('COMMIT');
      return this.withMediaAssetPaths(files.map((file) => ({
        ...file,
        delete_requested_at: claimAt,
        retention_status: 'trash_claimed',
      })));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimTrashedFileForDeletion(fileId, now = Date.now()) {
    const numericId = Number(fileId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const claimAt = Math.max(0, Number(now) || 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const file = this.db.prepare(`
        SELECT id, path, filename, video_id, username, trashed_at
        FROM files
        WHERE id = ?
          AND platform = 'tiktok'
          AND retention_status IN ('trashed', 'trash_failed')
      `).get(numericId);
      if (!file) {
        this.db.exec('COMMIT');
        return null;
      }
      const claimed = this.db.prepare(`
        UPDATE files
        SET
          delete_requested_at = ?,
          delete_attempts = delete_attempts + 1,
          delete_error = NULL,
          retention_status = 'trash_claimed'
        WHERE id = ?
          AND retention_status IN ('trashed', 'trash_failed')
      `).run(claimAt, numericId);
      this.db.exec('COMMIT');
      return claimed.changes > 0 ? this.withMediaAssetPaths([{
        ...file,
        delete_requested_at: claimAt,
        retention_status: 'trash_claimed',
      }])[0] : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimAllTrashedFilesForDeletion(now = Date.now()) {
    const claimAt = Math.max(0, Number(now) || 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const files = this.db.prepare(`
        SELECT id, path, filename, video_id, username, trashed_at
        FROM files
        WHERE platform = 'tiktok'
          AND retention_status IN ('trashed', 'trash_failed')
        ORDER BY trashed_at ASC, id ASC
      `).all();
      if (files.length) {
        const ids = files.map((file) => Number(file.id));
        const placeholders = ids.map(() => '?').join(', ');
        this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = ?,
            delete_attempts = delete_attempts + 1,
            delete_error = NULL,
            retention_status = 'trash_claimed'
          WHERE id IN (${placeholders})
            AND retention_status IN ('trashed', 'trash_failed')
        `).run(claimAt, ...ids);
      }
      this.db.exec('COMMIT');
      return this.withMediaAssetPaths(files.map((file) => ({
        ...file,
        delete_requested_at: claimAt,
        retention_status: 'trash_claimed',
      })));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listFilePathsReferencedOutside(fileIds = []) {
    const ids = normalizeIds(fileIds);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(`
      WITH selected_paths(path) AS (
        SELECT path FROM files WHERE id IN (${placeholders})
        UNION
        SELECT path FROM media_assets WHERE file_id IN (${placeholders})
      ),
      outside_paths(path) AS (
        SELECT path FROM files WHERE id NOT IN (${placeholders})
        UNION
        SELECT path FROM media_assets WHERE file_id NOT IN (${placeholders})
      )
      SELECT DISTINCT outside_paths.path
      FROM outside_paths
      JOIN selected_paths ON selected_paths.path = outside_paths.path
    `).all(...ids, ...ids, ...ids, ...ids).map((row) => row.path);
  }

  deleteFileRecords(ids = [], {
    requiredRetentionStatus = '',
    claimRequestedAt = null,
    requireNoActiveLinks = false,
    now = Date.now(),
  } = {}) {
    const uniqueIds = normalizeIds(ids);
    if (!uniqueIds.length) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const idPlaceholders = uniqueIds.map(() => '?').join(', ');
      const clauses = [`files.id IN (${idPlaceholders})`];
      const params = [...uniqueIds];
      const requiredStatuses = (Array.isArray(requiredRetentionStatus)
        ? requiredRetentionStatus
        : [requiredRetentionStatus])
        .map((status) => String(status ?? '').trim())
        .filter(Boolean);
      if (requiredStatuses.length) {
        clauses.push(`files.retention_status IN (${requiredStatuses.map(() => '?').join(', ')})`);
        params.push(...requiredStatuses);
      }
      if (claimRequestedAt != null) {
        clauses.push('files.delete_requested_at = ?');
        params.push(Number(claimRequestedAt));
      }
      if (requireNoActiveLinks) {
        clauses.push(`NOT EXISTS (
          SELECT 1
          FROM link_tokens
          WHERE link_tokens.file_id = files.id
            AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
        )`);
        params.push(Number(now));
      }
      const files = this.db.prepare(`
        SELECT files.id, files.platform, files.video_id
        FROM files
        WHERE ${clauses.join('\n          AND ')}
      `).all(...params);
      if (!files.length) {
        this.db.exec('COMMIT');
        return 0;
      }
      const removableIds = files.map((file) => Number(file.id));
      const placeholders = removableIds.map(() => '?').join(', ');
      const mediaPostIds = this.db.prepare(`
        SELECT DISTINCT post_id
        FROM media_assets
        WHERE file_id IN (${placeholders})
      `).all(...removableIds).map((row) => Number(row.post_id));
      this.db.prepare(`DELETE FROM jobs WHERE file_id IN (${placeholders})`).run(...removableIds);
      const deleted = this.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...removableIds).changes;
      this.pruneMediaPostsWithoutAssets(mediaPostIds);
      for (const file of files) {
        if (file.platform === 'tiktok' && file.video_id) {
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

  pruneMediaPostsWithoutAssets(postIds = []) {
    const ids = normalizeIds(postIds);
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(`
      DELETE FROM media_posts
      WHERE id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1
          FROM media_assets
          WHERE media_assets.post_id = media_posts.id
        )
    `).run(...ids).changes;
  }

  planDeliveryDeletion(token, now = Date.now()) {
    const claimAt = Math.max(0, Number(now) || 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.getToken(token);
      if (!record) {
        this.db.exec('COMMIT');
        return null;
      }
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
      `).get(record.path, record.id, String(token), claimAt));
      let deletionFile = null;
      if (!hasOtherActiveLinks) {
        const claimed = this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = ?,
            delete_attempts = delete_attempts + 1,
            delete_error = NULL,
            retention_status = 'expiry_claimed'
          WHERE id = ?
            AND trashed_at IS NULL
            AND retention_status IN ('active', 'expiry_failed')
        `).run(claimAt, record.id);
        if (claimed.changes > 0) {
          deletionFile = this.withMediaAssetPaths([{
            id: record.id,
            path: record.path,
            filename: record.filename,
            video_id: record.video_id,
            delete_requested_at: claimAt,
            retention_status: 'expiry_claimed',
          }])[0];
        }
      }
      this.db.exec('COMMIT');
      return { record, file: deletionFile };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteDeliveryToken(token, { deleteFile = false, now = Date.now() } = {}) {
    const timestamp = Math.max(0, Number(now) || 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.getToken(token);
      if (!record) {
        this.db.exec('COMMIT');
        return { files: 0, links: 0, jobs: 0 };
      }
      const fileId = Number(record.id);
      const jobId = Number(record.job_id);
      let files = 0;
      let jobs = 0;
      if (deleteFile) {
        this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = ?,
            delete_attempts = delete_attempts + 1,
            delete_error = NULL,
            retention_status = 'expiry_claimed'
          WHERE id = ?
            AND trashed_at IS NULL
            AND retention_status IN ('active', 'expiry_failed')
            AND NOT EXISTS (
              SELECT 1
              FROM link_tokens
              WHERE link_tokens.file_id = files.id
                AND link_tokens.token <> ?
                AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
            )
        `).run(timestamp, fileId, String(token), timestamp);
      }
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
        `).run(fileId, timestamp).changes;
      }
      const hasActiveLinks = Boolean(this.db.prepare(`
        SELECT 1
        FROM link_tokens
        WHERE file_id = ?
          AND (expires_at = 0 OR expires_at > ?)
        LIMIT 1
      `).get(fileId, timestamp));
      const file = deleteFile
        ? this.db.prepare('SELECT platform, video_id, retention_status FROM files WHERE id = ?').get(fileId)
        : null;
      if (deleteFile && file?.retention_status === 'expiry_claimed' && !hasActiveLinks) {
        const mediaPostIds = this.db.prepare(`
          SELECT DISTINCT post_id FROM media_assets WHERE file_id = ?
        `).all(fileId).map((row) => Number(row.post_id));
        jobs += this.db.prepare('DELETE FROM jobs WHERE file_id = ?').run(fileId).changes;
        files = this.db.prepare(`
          DELETE FROM files
          WHERE id = ?
            AND retention_status = 'expiry_claimed'
            AND NOT EXISTS (
              SELECT 1
              FROM link_tokens
              WHERE link_tokens.file_id = files.id
                AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
            )
        `).run(fileId, timestamp).changes;
        this.pruneMediaPostsWithoutAssets(mediaPostIds);
        if (file?.platform === 'tiktok' && file.video_id) {
          this.db.prepare('UPDATE seen_videos SET next_deletion_check_at = NULL WHERE video_id = ?').run(file.video_id);
        }
      } else if (deleteFile && file?.retention_status === 'expiry_claimed' && hasActiveLinks) {
        this.db.prepare(`
          UPDATE files
          SET delete_requested_at = NULL, delete_error = NULL, retention_status = 'active'
          WHERE id = ? AND retention_status = 'expiry_claimed'
        `).run(fileId);
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
        files.platform,
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
          files.platform,
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
        platform,
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
        files.platform,
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
    const claimAt = Math.max(0, Number(now) || 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const files = this.queryPurgePlan({ requestedBy, now: claimAt });
      if (files.length) {
        const ids = files.map((file) => Number(file.id));
        const placeholders = ids.map(() => '?').join(', ');
        this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = ?,
            delete_attempts = delete_attempts + 1,
            delete_error = NULL,
            retention_status = 'expiry_claimed'
          WHERE id IN (${placeholders})
            AND retention_status IN ('active', 'expiry_failed')
        `).run(claimAt, ...ids);
      }
      this.db.exec('COMMIT');
      return this.withMediaAssetPaths(files.map((file) => ({
        ...file,
        delete_requested_at: claimAt,
        retention_status: 'expiry_claimed',
      })));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  queryPurgePlan({ requestedBy = '', now = Date.now() } = {}) {
    if (!requestedBy) {
      return this.db.prepare(`
        SELECT id, path, filename, video_id
        FROM files
        WHERE trashed_at IS NULL
          AND retention_status IN ('active', 'expiry_failed')
        ORDER BY created_at ASC
      `).all();
    }
    return this.db.prepare(`
      SELECT files.id, files.path, files.filename, files.video_id
      FROM files
      WHERE files.trashed_at IS NULL
        AND files.retention_status IN ('active', 'expiry_failed')
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

  // Compatibility callers can inspect candidates without acquiring the
  // deletion claim. Destructive callers must use listPurgePlan().
  listFilesForPurge(options = {}) {
    return this.withMediaAssetPaths(this.queryPurgePlan(options));
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
              OR shared_files.platform <> 'tiktok'
              OR lower(shared_files.filename) NOT LIKE '%.mp4'
            )
        ) AS has_external_path_ref
      FROM files
      WHERE files.platform = 'tiktok'
        AND lower(files.username) = lower(?)
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
        AND files.platform = 'tiktok'
        AND lower(files.filename) LIKE '%.mp4'
        AND files.trashed_at IS NULL
    `).get(numericId) ?? null;
  }

  purgeDownloads({ requestedBy = '', removeFileIds = null, now = Date.now() } = {}) {
    const scoped = Boolean(requestedBy);
    const requestedIds = normalizeIds(removeFileIds ?? this.listPurgePlan({ requestedBy, now }).map((file) => file.id));
    const counts = { files: 0, links: 0, jobs: 0 };
    const timestamp = Math.max(0, Number(now) || 0);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (requestedIds.length) {
        const requestedPlaceholders = requestedIds.map(() => '?').join(', ');
        this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = ?,
            delete_attempts = delete_attempts + 1,
            delete_error = NULL,
            retention_status = 'expiry_claimed'
          WHERE id IN (${requestedPlaceholders})
            AND trashed_at IS NULL
            AND retention_status IN ('active', 'expiry_failed')
        `).run(timestamp, ...requestedIds);
      }
      const removableIds = scoped
        ? this.filterRemovablePurgeFileIds(requestedIds, String(requestedBy), timestamp)
        : requestedIds;
      const claimedIds = removableIds.length
        ? this.db.prepare(`
          SELECT id
          FROM files
          WHERE id IN (${removableIds.map(() => '?').join(', ')})
            AND trashed_at IS NULL
            AND retention_status = 'expiry_claimed'
        `).all(...removableIds).map((file) => Number(file.id))
        : [];
      const claimedPlaceholders = claimedIds.map(() => '?').join(', ');

      if (scoped) {
        if (claimedIds.length) {
          counts.links += this.db.prepare(`
            DELETE FROM link_tokens
            WHERE owner_id = ?
              AND file_id IN (
                SELECT id
                FROM files
                WHERE trashed_at IS NULL
                  AND retention_status IN ('active', 'expiry_failed')
              )
              AND file_id NOT IN (${claimedPlaceholders})
          `).run(String(requestedBy), ...claimedIds).changes;
        } else {
          counts.links += this.db.prepare(`
            DELETE FROM link_tokens
            WHERE owner_id = ?
              AND file_id IN (
                SELECT id
                FROM files
                WHERE trashed_at IS NULL
                  AND retention_status IN ('active', 'expiry_failed')
              )
          `).run(String(requestedBy)).changes;
        }
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

      if (claimedIds.length) {
        // Only deliveries that existed when each file was claimed belong to
        // this purge. A newer active delivery blocks finalization instead of
        // being silently cascaded by the file deletion.
        counts.links += this.db.prepare(`
          DELETE FROM link_tokens
          WHERE file_id IN (${claimedPlaceholders})
            AND created_at <= (
              SELECT delete_requested_at
              FROM files
              WHERE files.id = link_tokens.file_id
            )
        `).run(...claimedIds).changes;
        const files = this.db.prepare(`
          SELECT id, platform, video_id
          FROM files
          WHERE id IN (${claimedPlaceholders})
            AND retention_status = 'expiry_claimed'
            AND NOT EXISTS (
              SELECT 1
              FROM link_tokens
              WHERE link_tokens.file_id = files.id
                AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
            )
        `).all(...claimedIds, timestamp);
        const finalIds = files.map((file) => Number(file.id));
        if (finalIds.length) {
          const placeholders = finalIds.map(() => '?').join(', ');
          const mediaPostIds = this.db.prepare(`
            SELECT DISTINCT post_id
            FROM media_assets
            WHERE file_id IN (${placeholders})
          `).all(...finalIds).map((row) => Number(row.post_id));
          counts.jobs += this.db.prepare(`DELETE FROM jobs WHERE file_id IN (${placeholders})`).run(...finalIds).changes;
          counts.files = this.db.prepare(`
            DELETE FROM files
            WHERE id IN (${placeholders})
              AND retention_status = 'expiry_claimed'
              AND NOT EXISTS (
                SELECT 1
                FROM link_tokens
                WHERE link_tokens.file_id = files.id
                  AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
              )
          `).run(...finalIds, timestamp).changes;
          this.pruneMediaPostsWithoutAssets(mediaPostIds);
        }
        for (const file of files) {
          if (file.platform === 'tiktok' && file.video_id) {
            this.db.prepare('UPDATE seen_videos SET next_deletion_check_at = NULL WHERE video_id = ?').run(file.video_id);
          }
        }
        this.db.prepare(`
          UPDATE files
          SET
            delete_requested_at = NULL,
            delete_error = 'Deletion claim was superseded by a newer active delivery.',
            retention_status = 'expiry_failed'
          WHERE id IN (${claimedPlaceholders})
            AND retention_status = 'expiry_claimed'
            AND EXISTS (
              SELECT 1
              FROM link_tokens
              WHERE link_tokens.file_id = files.id
                AND (link_tokens.expires_at = 0 OR link_tokens.expires_at > ?)
            )
        `).run(...claimedIds, timestamp);
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

  pruneOldJobs(before = Date.now(), limit = 100, now = Date.now()) {
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
    `).all(before, now, Math.max(1, Math.min(1_000, Number(limit) || 100))).map((row) => Number(row.id));
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...ids).changes;
  }

  stats() {
    const schemaVersion = this.getSchemaVersion();
    const watchCount = this.db.prepare('SELECT COUNT(*) AS count FROM watched_users').get().count;
    const videoCount = this.db.prepare('SELECT COUNT(*) AS count FROM seen_videos').get().count;
    const fileCount = this.db.prepare('SELECT COUNT(*) AS count FROM files WHERE trashed_at IS NULL').get().count;
    const trashCount = this.db.prepare('SELECT COUNT(*) AS count FROM files WHERE trashed_at IS NOT NULL').get().count;
    const deadLetterCount = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM monitor_download_failures
      WHERE status IN ('dead_letter', 'retrying')
    `).get().count;
    const latestJob = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1').get() ?? null;
    return { schemaVersion, watchCount, videoCount, fileCount, trashCount, deadLetterCount, latestJob };
  }

  checkReadiness() {
    const probe = this.db.prepare('SELECT 1 AS ready').get();
    if (Number(probe?.ready) !== 1) throw new Error('SQLite readiness probe failed.');
    return {
      database: 'ready',
      schemaVersion: this.getSchemaVersion(),
    };
  }
}

function normalizeStoredPlatformProfile(input = {}) {
  const remoteIdValue = input.remoteId ?? input.remote_id ?? null;
  const handleValue = String(input.handle ?? '').trim();
  if (!handleValue) throw new Error('A platform profile requires a current handle.');
  const suppliedProfileUrl = input.profileUrl ?? input.profile_url ?? null;
  const reference = createProfileReference({
    platform: input.platform,
    remoteId: remoteIdValue == null || remoteIdValue === '' ? null : remoteIdValue,
    handle: handleValue,
    canonicalUrl: suppliedProfileUrl || null,
  });
  return {
    platform: reference.platform,
    remoteId: reference.remoteId,
    handle: reference.handle,
    profileUrl: reference.canonicalUrl ?? defaultPlatformProfileUrl(reference.platform, reference.handle),
  };
}

function normalizePlatformProfileLookup(reference, remoteId = undefined) {
  if (Number.isInteger(reference) && reference > 0 && remoteId === undefined) {
    return { id: reference };
  }
  let input;
  if (typeof reference === 'string' && remoteId !== undefined) {
    input = { platform: reference, remoteId };
  } else if (reference && typeof reference === 'object') {
    if (Number.isInteger(reference.id) && reference.id > 0) return { id: reference.id };
    input = reference;
  } else {
    return null;
  }

  try {
    const normalized = createProfileReference({
      platform: input.platform,
      remoteId: input.remoteId ?? input.remote_id ?? null,
      handle: input.handle ?? null,
    });
    return {
      platform: normalized.platform,
      remoteId: normalized.remoteId,
      handle: normalized.handle,
    };
  } catch {
    return null;
  }
}

function defaultPlatformProfileUrl(platform, handle) {
  if (platform === 'tiktok') return `https://www.tiktok.com/@${handle}`;
  if (platform === 'instagram') return `https://www.instagram.com/${handle}/`;
  return `https://x.com/${handle}`;
}

function normalizeCreatorGroupName(value) {
  return String(value ?? '').trim().slice(0, 200);
}

function normalizePositiveId(value, label, throwOnInvalid = true) {
  const id = Number(value);
  if (Number.isInteger(id) && id > 0) return id;
  if (!throwOnInvalid) return null;
  throw new Error(`A valid ${label} ID is required.`);
}

function normalizeStoreTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) throw new Error('A valid timestamp is required.');
  return Math.trunc(timestamp);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
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

function normalizeAlertDeliveryKey({ videoId, subscriptionId, eventType = 'new_post' } = {}) {
  const normalizedVideoId = String(videoId ?? '').trim();
  const normalizedSubscriptionId = Number(subscriptionId);
  const normalizedEventType = String(eventType ?? '').trim();
  if (
    !normalizedVideoId
    || !Number.isInteger(normalizedSubscriptionId)
    || normalizedSubscriptionId <= 0
    || !normalizedEventType
  ) {
    return null;
  }
  return {
    videoId: normalizedVideoId,
    subscriptionId: normalizedSubscriptionId,
    eventType: normalizedEventType,
  };
}

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];
}

function rewindFallbackAsset(file) {
  const extension = path.extname(String(file?.filename || file?.path || '')).toLowerCase();
  const media = {
    '.avif': ['image', 'image/avif'],
    '.gif': ['animated', 'image/gif'],
    '.heic': ['image', 'image/heic'],
    '.jpeg': ['image', 'image/jpeg'],
    '.jpg': ['image', 'image/jpeg'],
    '.m4v': ['video', 'video/x-m4v'],
    '.mkv': ['video', 'video/x-matroska'],
    '.mov': ['video', 'video/quicktime'],
    '.mp4': ['video', 'video/mp4'],
    '.png': ['image', 'image/png'],
    '.webm': ['video', 'video/webm'],
    '.webp': ['image', 'image/webp'],
    '.zip': ['archive', 'application/zip'],
  }[extension] ?? ['file', 'application/octet-stream'];
  return {
    id: null,
    post_id: file?.post_id ?? null,
    file_id: Number(file?.id),
    position: 0,
    role: extension === '.zip' ? 'package' : 'primary',
    remote_id: String(file?.remote_id ?? ''),
    kind: media[0],
    mime_type: media[1],
    path: String(file?.path ?? ''),
    filename: String(file?.filename ?? ''),
    size_bytes: Number(file?.size_bytes ?? 0),
    width: null,
    height: null,
    duration_seconds: null,
  };
}

export function createStore(dbPath) {
  return new Store(path.resolve(dbPath));
}
