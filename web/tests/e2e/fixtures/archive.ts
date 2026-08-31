import {
  expect,
  test as base,
  type BrowserContext,
  type ConsoleMessage,
  type Request,
  type Route,
} from "@playwright/test";
import type { SavedMediaAsset, SavedPost } from "../../../lib/types";

const E2E_ORIGIN = "http://127.0.0.1:3100";
const API_PATH = /^\/(?:api(?:\/|$)|media\/|thumbnail\/|post-media\/|post-download\/)/;
const INLINE_MP4 = Buffer.from(
  "AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tAAAACGZyZWU=",
  "base64",
);

export interface FixtureCreator {
  id: string;
  username: string;
  displayName: string;
  initials: string;
  accent: string;
  videoCount: number;
  storageLabel: string;
  lastSynced: string;
  status: "healthy" | "syncing" | "attention";
  enabled: boolean;
}

export interface FixtureVideo {
  id: string;
  creatorId: string;
  username: string;
  displayName: string;
  title: string;
  description: string;
  tags: string[];
  mediaType: "video";
  videoUrl: string;
  thumbnailUrl: string;
  accent: string;
  savedAt: string;
  savedAtLabel: string;
  duration: string;
  sizeBytes: number;
  sizeLabel: string;
  sourceUrl: string;
}

export interface FixtureTrashVideo {
  fileId: number;
  videoId: string;
  username: string;
  sourceUrl: string;
  filename: string;
  sizeBytes: number;
  createdAt: number;
  trashedAt: number;
  purgeAt: number | null;
}

export interface FixtureImport {
  id: number;
  username: string;
  status: "queued" | "running" | "canceling" | "completed" | "failed" | "canceled";
  maxDurationSeconds: number;
  discoveredCount: number;
  processedCount: number;
  downloadedCount: number;
  skippedExistingCount: number;
  skippedDurationCount: number;
  skippedUnknownDurationCount: number;
  failedCount: number;
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  discoveryCompletedAt: number | null;
  cancelRequestedAt: number | null;
  canceledAt: number | null;
  retryCount: number;
  resumeCount: number;
  lastResumedAt: number | null;
  updatedAt: number;
  items?: Array<Record<string, unknown>>;
}

export interface FixturePlatformProfile {
  id: number;
  platform: "tiktok" | "instagram" | "x";
  remoteId: string | null;
  handle: string;
  displayName: string;
  profileUrl: string;
  groupId: number | null;
  linkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface FixtureProfileGroup {
  id: number;
  name: string;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
  members: FixturePlatformProfile[];
}

export interface ArchiveRequestRecord {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
}

type RequestMatcher = (request: Request, url: URL) => boolean;

class RequestGate {
  claimed = false;
  private signalRequested!: () => void;
  private signalReleased!: () => void;
  private readonly requestedPromise: Promise<void>;
  private readonly releasedPromise: Promise<void>;

  constructor(readonly matches: RequestMatcher) {
    this.requestedPromise = new Promise((resolve) => {
      this.signalRequested = resolve;
    });
    this.releasedPromise = new Promise((resolve) => {
      this.signalReleased = resolve;
    });
  }

  async hold() {
    this.claimed = true;
    this.signalRequested();
    await this.releasedPromise;
  }

  async waitUntilRequested() {
    await this.requestedPromise;
  }

  release() {
    this.signalReleased();
  }
}

interface FailureRule {
  matches: RequestMatcher;
  remaining: number;
  status: number;
  message: string;
}

export class InMemoryArchive {
  readonly origin = E2E_ORIGIN;
  readonly creators = createCreators();
  readonly videos = createVideos(this.creators);
  readonly posts = createPosts();
  readonly bookmarks = new Set<string>();
  readonly trash = new Map<string, FixtureTrashVideo>();
  readonly imports: FixtureImport[] = [];
  readonly profileGroups: FixtureProfileGroup[] = [];
  readonly unlinkedProfiles: FixturePlatformProfile[] = [];
  readonly requests: ArchiveRequestRecord[] = [];
  readonly unhandled: ArchiveRequestRecord[] = [];
  private readonly gates: RequestGate[] = [];
  private readonly failures: FailureRule[] = [];
  private nextImportId = 1;
  private nextProfileId = 1;
  private nextProfileGroupId = 1;

  seedBookmarks(ids: Iterable<string | number>) {
    this.bookmarks.clear();
    const validIds = new Set(this.videos.map((video) => video.id));
    for (const id of ids) {
      const normalized = String(id);
      if (validIds.has(normalized)) this.bookmarks.add(normalized);
    }
  }

  seedTrash(ids: Iterable<string | number>) {
    for (const id of ids) {
      const video = this.videos.find((candidate) => candidate.id === String(id));
      if (video) this.moveVideoToTrash(video);
    }
  }

  seedImport(overrides: Partial<FixtureImport> = {}) {
    const entry = this.makeImport({ username: "fixture.import", maxDurationSeconds: 120 });
    Object.assign(entry, overrides);
    this.imports.unshift(entry);
    return entry;
  }

  requestLog(input: { method?: string; pathname?: string; includes?: string } = {}) {
    return this.requests.filter((entry) => (
      (!input.method || entry.method === input.method.toUpperCase())
      && (!input.pathname || entry.pathname === input.pathname)
      && (!input.includes || `${entry.pathname}${entry.search}`.includes(input.includes))
    ));
  }

  delayNextBookmarkMutation(input: { fileId?: string; method?: "PUT" | "DELETE" } = {}) {
    return this.delayNextRequest((request, url) => (
      /^(?:PUT|DELETE)$/.test(request.method())
      && url.pathname.startsWith("/api/bookmarks/")
      && (!input.method || request.method() === input.method)
      && (!input.fileId || decodeURIComponent(url.pathname.split("/").at(-1) || "") === input.fileId)
    ));
  }

  delayNextBookmarkedPage(input: { creatorId?: string; cursor?: string } = {}) {
    return this.delayNextRequest((request, url) => (
      request.method() === "GET"
      && url.pathname === "/api/videos"
      && url.searchParams.get("bookmarked") === "1"
      && (input.creatorId === undefined || url.searchParams.get("creatorId") === input.creatorId)
      && (input.cursor === undefined || url.searchParams.get("cursor") === input.cursor)
    ));
  }

  delayNextRequest(matches: RequestMatcher) {
    const gate = new RequestGate(matches);
    this.gates.push(gate);
    return gate;
  }

  failNextBookmarkMutations(count = 1, status = 503, message = "Bookmark service unavailable") {
    this.failNextRequests(
      (request, url) => /^(?:PUT|DELETE)$/.test(request.method()) && url.pathname.startsWith("/api/bookmarks/"),
      count,
      status,
      message,
    );
  }

  failNextRequests(matches: RequestMatcher, count = 1, status = 503, message = "Fixture request failed") {
    this.failures.push({ matches, remaining: count, status, message });
  }

  async install(context: BrowserContext) {
    await installDeterministicBrowserState(context);
    await context.route(/\/(?:api|media|thumbnail|post-media|post-download)(?:\/|$)/, async (route) => {
      await this.handle(route);
    });
  }

  private async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== E2E_ORIGIN || !API_PATH.test(url.pathname)) {
      await route.fallback();
      return;
    }

    const record: ArchiveRequestRecord = {
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
      body: parseRequestBody(request),
    };
    this.requests.push(record);

    const gate = this.gates.find((candidate) => !candidate.claimed && candidate.matches(request, url));
    if (gate) await gate.hold();

    const failure = this.failures.find((candidate) => candidate.remaining > 0 && candidate.matches(request, url));
    if (failure) {
      failure.remaining -= 1;
      await json(route, failure.status, { error: failure.message });
      return;
    }

    if (url.pathname === "/api/health" && request.method() === "GET") {
      await json(route, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/creators" && request.method() === "GET") {
      await json(route, 200, this.activeCreators());
      return;
    }
    if (url.pathname === "/api/videos" && request.method() === "GET") {
      await this.listVideos(route, url);
      return;
    }
    if (url.pathname === "/api/posts" && request.method() === "GET") {
      await this.listPosts(route, url);
      return;
    }
    if (url.pathname === "/api/stats" && request.method() === "GET") {
      const activeVideos = this.activeVideos();
      await json(route, 200, {
        creatorCount: this.activeCreators().length,
        videoCount: activeVideos.length,
        storageUsed: "6.4 GB",
        storagePercent: 64,
        newThisWeek: 18,
        addedToday: 4,
      });
      return;
    }
    if (url.pathname === "/api/bookmarks") {
      if (request.method() === "GET") {
        await json(route, 200, { fileIds: this.visibleBookmarkIds() });
        return;
      }
      if (request.method() === "POST") {
        const body = parseRequestBody(request) as { fileIds?: unknown };
        if (!Array.isArray(body?.fileIds)) {
          await json(route, 400, { error: "fileIds must be an array" });
          return;
        }
        const activeIds = new Set(this.activeVideos().map((video) => video.id));
        for (const id of body.fileIds) {
          if (typeof id !== "string" && typeof id !== "number") continue;
          const normalized = String(id);
          if (activeIds.has(normalized)) this.bookmarks.add(normalized);
        }
        await json(route, 200, { fileIds: this.visibleBookmarkIds() });
        return;
      }
    }

    const bookmarkMatch = url.pathname.match(/^\/api\/bookmarks\/([^/]+)$/);
    if (bookmarkMatch && (request.method() === "PUT" || request.method() === "DELETE")) {
      const id = decodeURIComponent(bookmarkMatch[1]);
      if (request.method() === "PUT") {
        if (!this.activeVideos().some((video) => video.id === id)) {
          await json(route, 404, { error: "Video not found" });
          return;
        }
        this.bookmarks.add(id);
      } else {
        this.bookmarks.delete(id);
      }
      await json(route, 200, { fileId: Number(id), bookmarked: request.method() === "PUT" });
      return;
    }

    const postBookmarkMatch = url.pathname.match(/^\/api\/post-bookmarks\/([^/]+)$/);
    if (postBookmarkMatch && (request.method() === "PUT" || request.method() === "DELETE")) {
      const id = decodeURIComponent(postBookmarkMatch[1]);
      const post = this.posts.find((candidate) => candidate.id === id && !candidate.trashedAt);
      if (!post) {
        await json(route, 404, { error: "Post not found" });
        return;
      }
      post.bookmarked = request.method() === "PUT";
      await json(route, 200, { fileId: Number(id), bookmarked: post.bookmarked });
      return;
    }

    const mediaPostRestoreMatch = url.pathname.match(/^\/api\/media-posts\/([^/]+)\/restore$/);
    if (mediaPostRestoreMatch && request.method() === "POST") {
      const id = decodeURIComponent(mediaPostRestoreMatch[1]);
      const post = this.posts.find((candidate) => candidate.id === id && Boolean(candidate.trashedAt));
      const body = parseRequestBody(request) as { confirmFileId?: unknown };
      if (!post || Number(body?.confirmFileId) !== Number(id)) {
        await json(route, 404, { error: "Trashed post not found" });
        return;
      }
      post.trashedAt = "";
      post.retentionStatus = "active";
      await json(route, 200, { fileId: Number(id), restoredPost: true });
      return;
    }

    const mediaPostMatch = url.pathname.match(/^\/api\/media-posts\/([^/]+)$/);
    if (mediaPostMatch && request.method() === "DELETE") {
      const id = decodeURIComponent(mediaPostMatch[1]);
      const post = this.posts.find((candidate) => candidate.id === id && !candidate.trashedAt);
      const body = parseRequestBody(request) as { confirmFileId?: unknown };
      if (!post || Number(body?.confirmFileId) !== Number(id)) {
        await json(route, 404, { error: "Post not found" });
        return;
      }
      post.trashedAt = new Date(Date.UTC(2026, 6, 20, 12, 30)).toISOString();
      post.retentionStatus = "trashed";
      await json(route, 200, { fileId: Number(id), trashedPost: true });
      return;
    }

    if (url.pathname === "/api/trash" && request.method() === "GET") {
      await json(route, 200, { videos: [...this.trash.values()], retentionDays: 7 });
      return;
    }

    if (url.pathname === "/api/trash" && request.method() === "DELETE") {
      const ids = [...this.trash.keys()];
      for (const id of ids) {
        this.trash.delete(id);
        this.bookmarks.delete(id);
        const videoIndex = this.videos.findIndex((video) => video.id === id);
        if (videoIndex >= 0) this.videos.splice(videoIndex, 1);
      }
      await json(route, 200, {
        permanentlyDeletedVideos: ids.length,
        deletedStoredFiles: ids.length,
        failedVideos: 0,
      });
      return;
    }

    const trashVideoMatch = url.pathname.match(/^\/api\/trash\/([^/]+)$/);
    if (trashVideoMatch && request.method() === "DELETE") {
      const id = decodeURIComponent(trashVideoMatch[1]);
      if (!this.trash.delete(id)) {
        await json(route, 404, { error: "Trashed video not found" });
        return;
      }
      this.bookmarks.delete(id);
      const videoIndex = this.videos.findIndex((video) => video.id === id);
      if (videoIndex >= 0) this.videos.splice(videoIndex, 1);
      await json(route, 200, { permanentlyDeleted: true, fileId: Number(id) });
      return;
    }

    const videoMatch = url.pathname.match(/^\/api\/videos\/([^/]+)$/);
    if (videoMatch && request.method() === "DELETE") {
      const id = decodeURIComponent(videoMatch[1]);
      const video = this.videos.find((candidate) => candidate.id === id);
      if (!video) {
        await json(route, 404, { error: "Video not found" });
        return;
      }
      this.moveVideoToTrash(video);
      await json(route, 200, { ok: true, fileId: Number(id) });
      return;
    }

    const restoreMatch = url.pathname.match(/^\/api\/videos\/([^/]+)\/restore$/);
    if (restoreMatch && request.method() === "POST") {
      const id = decodeURIComponent(restoreMatch[1]);
      if (!this.trash.delete(id)) {
        await json(route, 404, { error: "Trashed video not found" });
        return;
      }
      await json(route, 200, { ok: true, fileId: Number(id) });
      return;
    }

    const creatorTrashMatch = url.pathname.match(/^\/api\/creators\/([^/]+)\/videos$/);
    if (creatorTrashMatch && request.method() === "DELETE") {
      const username = decodeURIComponent(creatorTrashMatch[1]);
      const candidates = this.activeVideos().filter((video) => video.username === username);
      for (const video of candidates) this.moveVideoToTrash(video);
      await json(route, 200, { trashedVideos: candidates.length, failedVideos: 0 });
      return;
    }

    const creatorMonitoringMatch = url.pathname.match(/^\/api\/creators\/([^/]+)\/monitoring$/);
    if (creatorMonitoringMatch && request.method() === "DELETE") {
      const username = decodeURIComponent(creatorMonitoringMatch[1]);
      const creator = this.creators.find((candidate) => (
        candidate.username.toLowerCase() === username.toLowerCase()
      ));
      if (!creator) {
        await json(route, 404, { error: "Creator not found" });
        return;
      }
      const removed = creator.enabled;
      creator.enabled = false;
      await json(route, 200, {
        username: creator.username,
        monitoring: false,
        removed,
        removedSubscriptions: removed ? 2 : 0,
      });
      return;
    }

    if (await this.handleProfileGroups(route, request, url)) return;

    if (url.pathname === "/api/imports") {
      if (request.method() === "GET") {
        const limit = positiveInteger(url.searchParams.get("limit"), 8, 100);
        await json(route, 200, { imports: this.imports.slice(0, limit) });
        return;
      }
      if (request.method() === "POST") {
        const body = parseRequestBody(request) as { username?: unknown; maxDurationSeconds?: unknown };
        if (typeof body?.username !== "string" || !body.username.trim()) {
          await json(route, 400, { error: "A creator username is required" });
          return;
        }
        const entry = this.makeImport({
          username: normalizeUsername(body.username),
          maxDurationSeconds: Number(body.maxDurationSeconds) || 120,
        });
        this.imports.unshift(entry);
        await json(route, 201, { import: entry });
        return;
      }
    }

    const importMatch = url.pathname.match(/^\/api\/imports\/(\d+)$/);
    if (importMatch && request.method() === "GET") {
      const entry = this.imports.find((candidate) => candidate.id === Number(importMatch[1]));
      await json(route, entry ? 200 : 404, entry ? { import: entry } : { error: "Import not found" });
      return;
    }

    const importActionMatch = url.pathname.match(/^\/api\/imports\/(\d+)\/(cancel|retry)$/);
    if (importActionMatch && request.method() === "POST") {
      const entry = this.imports.find((candidate) => candidate.id === Number(importActionMatch[1]));
      if (!entry) {
        await json(route, 404, { error: "Import not found" });
        return;
      }
      if (importActionMatch[2] === "cancel") {
        entry.status = "canceled";
        entry.cancelRequestedAt = Date.now();
        entry.canceledAt = Date.now();
        entry.completedAt = Date.now();
      } else {
        entry.status = "queued";
        entry.retryCount += 1;
        entry.lastError = null;
        entry.completedAt = null;
      }
      entry.updatedAt = Date.now();
      await json(route, 200, { import: entry });
      return;
    }

    if (url.pathname.startsWith("/thumbnail/") && /^(?:GET|HEAD)$/.test(request.method())) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)?.replace(/\.jpg$/, "") || "video");
      const body = thumbnailSvg(id);
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        headers: { "cache-control": "public, max-age=31536000, immutable" },
        body: request.method() === "HEAD" ? "" : body,
      });
      return;
    }

    if (url.pathname.startsWith("/media/") && /^(?:GET|HEAD)$/.test(request.method())) {
      const wantsRange = Boolean(request.headers().range);
      await route.fulfill({
        status: wantsRange ? 206 : 200,
        contentType: "video/mp4",
        headers: {
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=31536000, immutable",
          ...(wantsRange ? { "content-range": `bytes 0-${INLINE_MP4.length - 1}/${INLINE_MP4.length}` } : {}),
        },
        body: request.method() === "HEAD" ? Buffer.alloc(0) : INLINE_MP4,
      });
      return;
    }

    const postMediaMatch = url.pathname.match(/^\/post-media\/([^/]+)\/(\d+)$/);
    if (postMediaMatch && /^(?:GET|HEAD)$/.test(request.method())) {
      const post = this.posts.find((candidate) => (
        candidate.id === decodeURIComponent(postMediaMatch[1]) && !candidate.trashedAt
      ));
      const asset = post?.assets[Number(postMediaMatch[2])];
      if (!post || !asset) {
        await json(route, 404, { error: "Post asset not found" });
        return;
      }
      await fulfillPostAsset(route, request, post, asset);
      return;
    }

    const postDownloadMatch = url.pathname.match(/^\/post-download\/([^/]+)$/);
    if (postDownloadMatch && /^(?:GET|HEAD)$/.test(request.method())) {
      const post = this.posts.find((candidate) => (
        candidate.id === decodeURIComponent(postDownloadMatch[1]) && !candidate.trashedAt
      ));
      if (!post) {
        await json(route, 404, { error: "Post download not found" });
        return;
      }
      const filename = post.assets.length > 1
        ? `${post.platform}-${post.username}-${post.id}.zip`
        : post.assets[0]?.filename || `${post.id}.bin`;
      const body = Buffer.from(`PK fixture package for ${post.id}`);
      await route.fulfill({
        status: 200,
        contentType: post.assets.length > 1 ? "application/zip" : post.assets[0]?.mimeType,
        headers: {
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "private, max-age=604800, immutable",
        },
        body: request.method() === "HEAD" ? Buffer.alloc(0) : body,
      });
      return;
    }

    this.unhandled.push(record);
    await json(route, 501, { error: `Unhandled E2E request: ${record.method} ${record.pathname}${record.search}` });
  }

  private async listVideos(route: Route, url: URL) {
    let candidates = this.activeVideos();
    const creatorId = url.searchParams.get("creatorId") || "";
    const username = url.searchParams.get("username") || "";
    const fileId = url.searchParams.get("fileId") || "";
    if (creatorId) candidates = candidates.filter((video) => video.creatorId === creatorId);
    if (username) candidates = candidates.filter((video) => video.username === username);
    if (fileId && !url.searchParams.get("cursor")) candidates = candidates.filter((video) => video.id === fileId);
    if (url.searchParams.get("bookmarked") === "1") {
      candidates = candidates.filter((video) => this.bookmarks.has(video.id));
    }

    const limit = positiveInteger(url.searchParams.get("limit"), 100, 100);
    const offset = decodeCursor(url.searchParams.get("cursor"));
    const items = candidates.slice(offset, offset + limit);
    const nextCursor = offset + items.length < candidates.length
      ? `fixture:${offset + items.length}`
      : null;
    const paginated = url.searchParams.get("page") === "1" || url.searchParams.has("cursor");
    await json(route, 200, paginated ? { items, nextCursor } : items);
  }

  private async listPosts(route: Route, url: URL) {
    let candidates = [...this.posts];
    const trashedOnly = url.searchParams.get("trashed") === "1";
    candidates = candidates.filter((post) => Boolean(post.trashedAt) === trashedOnly);
    const platform = url.searchParams.get("platform") || "";
    const username = url.searchParams.get("username") || "";
    const profileId = url.searchParams.get("profileId") || "";
    const groupId = url.searchParams.get("groupId") || "";
    const fileId = url.searchParams.get("fileId") || "";
    if (platform) candidates = candidates.filter((post) => post.platform === platform);
    if (username) candidates = candidates.filter((post) => post.username === username);
    if (profileId) candidates = candidates.filter((post) => String(post.profileId || "") === profileId);
    if (groupId) candidates = candidates.filter((post) => String(post.creatorGroupId || "") === groupId);
    if (fileId && !url.searchParams.get("cursor")) {
      candidates = candidates.filter((post) => post.id === fileId);
    }
    if (url.searchParams.get("bookmarked") === "1") {
      candidates = candidates.filter((post) => post.bookmarked);
    }

    const limit = positiveInteger(url.searchParams.get("limit"), 24, 100);
    const offset = decodeCursor(url.searchParams.get("cursor"));
    const items = candidates.slice(offset, offset + limit);
    const nextCursor = offset + items.length < candidates.length
      ? `fixture:${offset + items.length}`
      : null;
    await json(route, 200, { items, nextCursor });
  }

  private activeVideos() {
    return this.videos.filter((video) => !this.trash.has(video.id));
  }

  private visibleBookmarkIds() {
    const activeIds = new Set(this.activeVideos().map((video) => video.id));
    return [...this.bookmarks].filter((id) => activeIds.has(id));
  }

  private activeCreators() {
    return this.creators.map((creator) => ({
      ...creator,
      videoCount: this.activeVideos().filter((video) => video.creatorId === creator.id).length,
    }));
  }

  private async handleProfileGroups(route: Route, request: Request, url: URL) {
    if (!url.pathname.startsWith("/api/profile-groups")) return false;

    if (url.pathname === "/api/profile-groups" && request.method() === "GET") {
      await json(route, 200, {
        groups: this.profileGroups.filter((group) => group.members.length > 0),
        unlinkedProfiles: this.unlinkedProfiles,
      });
      return true;
    }

    if (url.pathname === "/api/profile-groups" && request.method() === "POST") {
      const body = parseRequestBody(request) as {
        profiles?: unknown;
        groupId?: unknown;
        name?: unknown;
        mergeGroups?: unknown;
      };
      if (!Array.isArray(body?.profiles)) {
        await json(route, 400, { error: "profiles must be an array" });
        return true;
      }
      try {
        const requestedProfiles = [...new Map(
          body.profiles.map((value) => {
            const profile = this.resolveFixtureProfile(value);
            return [profile.id, profile] as const;
          }),
        ).values()];
        const requestedGroupId = body.groupId == null || body.groupId === ""
          ? null
          : Number(body.groupId);
        if (!requestedGroupId && requestedProfiles.length < 2) {
          await json(route, 400, { error: "Choose two different profiles when creating a creator group" });
          return true;
        }

        const currentGroups = this.profileGroups.filter((group) => (
          group.members.some((member) => requestedProfiles.some((profile) => profile.id === member.id))
        ));
        let target = requestedGroupId == null
          ? currentGroups[0]
          : this.profileGroups.find((group) => group.id === requestedGroupId);
        if (requestedGroupId != null && !target) {
          await json(route, 404, { error: "Creator group not found" });
          return true;
        }
        const sourceGroups = currentGroups.filter((group) => group.id !== target?.id);
        if (sourceGroups.length && body.mergeGroups !== true) {
          await json(route, 409, { error: "A selected profile already belongs to another creator group" });
          return true;
        }

        const now = fixtureProfileTime(this.nextProfileId + this.nextProfileGroupId);
        if (!target) {
          target = {
            id: this.nextProfileGroupId++,
            name: typeof body.name === "string" ? body.name.trim() : "",
            memberCount: 0,
            createdAt: now,
            updatedAt: now,
            members: [],
          };
          this.profileGroups.push(target);
        }

        for (const source of sourceGroups) {
          for (const member of source.members) {
            if (!target.members.some((candidate) => candidate.id === member.id)) target.members.push(member);
          }
          this.profileGroups.splice(this.profileGroups.indexOf(source), 1);
        }
        for (const profile of requestedProfiles) {
          this.removeFixtureProfileMembership(profile.id);
          if (!target.members.some((member) => member.id === profile.id)) target.members.push(profile);
        }
        if (Object.hasOwn(body, "name") && typeof body.name === "string") target.name = body.name.trim();
        this.updateFixtureGroup(target, now);
        await json(route, 200, { group: target });
      } catch (error) {
        await json(route, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    const groupMatch = url.pathname.match(/^\/api\/profile-groups\/(\d+)$/);
    if (groupMatch && request.method() === "PATCH") {
      const group = this.profileGroups.find((candidate) => candidate.id === Number(groupMatch[1]));
      if (!group) {
        await json(route, 404, { error: "Creator group not found" });
        return true;
      }
      const body = parseRequestBody(request) as { name?: unknown };
      if (typeof body?.name !== "string" || !body.name.trim()) {
        await json(route, 400, { error: "name must be a non-empty string" });
        return true;
      }
      group.name = body.name.trim();
      group.updatedAt = fixtureProfileTime(group.id + this.nextProfileId);
      await json(route, 200, { group });
      return true;
    }

    const memberMatch = url.pathname.match(/^\/api\/profile-groups\/(\d+)\/profiles\/(\d+)$/);
    if (memberMatch && request.method() === "DELETE") {
      const group = this.profileGroups.find((candidate) => candidate.id === Number(memberMatch[1]));
      const profile = group?.members.find((candidate) => candidate.id === Number(memberMatch[2]));
      if (!group || !profile) {
        await json(route, 404, { error: "Linked profile not found" });
        return true;
      }
      group.members = group.members.filter((member) => member.id !== profile.id);
      profile.groupId = null;
      profile.linkedAt = null;
      if (!this.unlinkedProfiles.some((candidate) => candidate.id === profile.id)) {
        this.unlinkedProfiles.push(profile);
      }
      this.updateFixtureGroup(group, fixtureProfileTime(profile.id + this.nextProfileGroupId));
      await json(route, 200, {
        unlinkedProfile: profile,
        group: group.members.length ? group : null,
      });
      return true;
    }

    await json(route, 405, { error: "Method not allowed" });
    return true;
  }

  private resolveFixtureProfile(value: unknown) {
    if (Number.isInteger(value) && Number(value) > 0) {
      const existing = this.fixtureProfiles().find((profile) => profile.id === Number(value));
      if (!existing) throw new Error(`Platform profile ${value} was not found`);
      return existing;
    }
    if (typeof value !== "string") throw new Error("A supported profile URL is required");
    const reference = parseFixtureProfileUrl(value);
    const existing = this.fixtureProfiles().find((profile) => (
      profile.platform === reference.platform
      && profile.handle.toLowerCase() === reference.handle.toLowerCase()
    ));
    if (existing) return existing;
    const now = fixtureProfileTime(this.nextProfileId);
    const profile: FixturePlatformProfile = {
      id: this.nextProfileId++,
      platform: reference.platform,
      remoteId: null,
      handle: reference.handle,
      displayName: "",
      profileUrl: reference.profileUrl,
      groupId: null,
      linkedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.unlinkedProfiles.push(profile);
    return profile;
  }

  private fixtureProfiles() {
    return [
      ...this.profileGroups.flatMap((group) => group.members),
      ...this.unlinkedProfiles,
    ];
  }

  private removeFixtureProfileMembership(profileId: number) {
    const unlinkedIndex = this.unlinkedProfiles.findIndex((profile) => profile.id === profileId);
    if (unlinkedIndex >= 0) this.unlinkedProfiles.splice(unlinkedIndex, 1);
    for (const group of this.profileGroups) {
      group.members = group.members.filter((profile) => profile.id !== profileId);
      group.memberCount = group.members.length;
    }
  }

  private updateFixtureGroup(group: FixtureProfileGroup, now: number) {
    group.memberCount = group.members.length;
    group.updatedAt = now;
    for (const member of group.members) {
      member.groupId = group.id;
      member.linkedAt ??= now;
    }
  }

  private moveVideoToTrash(video: FixtureVideo) {
    const baseTime = Date.UTC(2026, 6, 20, 12, 0, 0);
    this.trash.set(video.id, {
      fileId: Number(video.id),
      videoId: `tiktok-${video.id}`,
      username: video.username,
      sourceUrl: video.sourceUrl,
      filename: `${video.savedAt.slice(0, 10).replaceAll("-", "")}__${video.username}__${video.id}.mp4`,
      sizeBytes: 8_388_608,
      createdAt: new Date(video.savedAt).getTime(),
      trashedAt: baseTime,
      purgeAt: baseTime + 7 * 86_400_000,
    });
  }

  private makeImport(input: { username: string; maxDurationSeconds: number }): FixtureImport {
    const timestamp = Date.UTC(2026, 6, 20, 12, this.nextImportId);
    return {
      id: this.nextImportId++,
      username: input.username,
      status: "queued",
      maxDurationSeconds: input.maxDurationSeconds,
      discoveredCount: 0,
      processedCount: 0,
      downloadedCount: 0,
      skippedExistingCount: 0,
      skippedDurationCount: 0,
      skippedUnknownDurationCount: 0,
      failedCount: 0,
      lastError: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      discoveryCompletedAt: null,
      cancelRequestedAt: null,
      canceledAt: null,
      retryCount: 0,
      resumeCount: 0,
      lastResumedAt: null,
      updatedAt: timestamp,
      items: [],
    };
  }
}

export interface BrowserDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  reset(): void;
}

interface E2EFixtures {
  archive: InMemoryArchive;
  diagnostics: BrowserDiagnostics;
  archiveRouting: void;
}

interface E2EWorkerFixtures {
  loopbackWarmup: void;
}

export const test = base.extend<E2EFixtures, E2EWorkerFixtures>({
  loopbackWarmup: [async ({ browser }, provide) => {
    // This host can report a one-time Chromium network transition while the
    // first loopback page is loading. Warm and reload once per worker so a
    // dropped module request cannot leave the first real test unhydrated.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${E2E_ORIGIN}/dashboard/settings`);
    await page.waitForTimeout(100);
    await page.reload();
    await context.close();
    await provide();
  }, { auto: true, scope: "worker" }],

  archive: async ({}, provide) => {
    await provide(new InMemoryArchive());
  },

  archiveRouting: [async ({ context, archive }, provide) => {
    await archive.install(context);
    await provide();
    expect(archive.unhandled, "Every archive API/media request must be explicitly handled by the E2E fixture").toEqual([]);
  }, { auto: true }],

  diagnostics: [async ({ page }, provide) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const handleConsole = (message: ConsoleMessage) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    };
    page.on("console", handleConsole);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await provide({
      consoleErrors,
      pageErrors,
      reset() {
        consoleErrors.length = 0;
        pageErrors.length = 0;
      },
    });
  }, { auto: true }],
});

export { expect };

async function json(route: Route, status: number, value: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

function parseRequestBody(request: Request): unknown {
  const raw = request.postData();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function positiveInteger(raw: string | null, fallback: number, maximum: number) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function decodeCursor(raw: string | null) {
  if (!raw) return 0;
  const match = raw.match(/^fixture:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function normalizeUsername(value: string) {
  const profileMatch = value.trim().match(/(?:tiktok\.com\/)?@([^/?#]+)/i);
  return (profileMatch?.[1] || value).replace(/^@/, "").trim().toLowerCase();
}

function parseFixtureProfileUrl(value: string): {
  platform: FixturePlatformProfile["platform"];
  handle: string;
  profileUrl: string;
} {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("A TikTok, Instagram, or X profile URL is required");
  }
  if (url.protocol !== "https:") throw new Error("A TikTok, Instagram, or X profile URL is required");
  const hostname = url.hostname.toLowerCase();
  if (["tiktok.com", "www.tiktok.com"].includes(hostname)) {
    const match = url.pathname.match(/^\/@([A-Za-z0-9._]{1,32})\/?$/);
    if (match) {
      const handle = match[1].toLowerCase();
      return { platform: "tiktok", handle, profileUrl: `https://www.tiktok.com/@${handle}` };
    }
  }
  if (["instagram.com", "www.instagram.com"].includes(hostname)) {
    const match = url.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    if (match) {
      const handle = match[1].toLowerCase();
      return { platform: "instagram", handle, profileUrl: `https://www.instagram.com/${handle}/` };
    }
  }
  if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(hostname)) {
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (match) {
      const handle = match[1].toLowerCase();
      return { platform: "x", handle, profileUrl: `https://x.com/${handle}` };
    }
  }
  throw new Error("A TikTok, Instagram, or X profile URL is required");
}

function fixtureProfileTime(offset: number) {
  return Date.UTC(2026, 6, 20, 12, 0, Math.max(0, offset));
}

function createCreators(): FixtureCreator[] {
  return [
    {
      id: "creator-alice",
      username: "alice.archive",
      displayName: "Alice Archive",
      initials: "AA",
      accent: "#65d6b4",
      videoCount: 132,
      storageLabel: "4.8 GB",
      lastSynced: "2 min ago",
      status: "healthy",
      enabled: true,
    },
    {
      id: "creator-bob",
      username: "bob.builds",
      displayName: "Bob Builds",
      initials: "BB",
      accent: "#efad63",
      videoCount: 24,
      storageLabel: "1.2 GB",
      lastSynced: "18 min ago",
      status: "syncing",
      enabled: true,
    },
    {
      id: "creator-cora",
      username: "cora.cooks",
      displayName: "Cora Cooks",
      initials: "CC",
      accent: "#b49cff",
      videoCount: 6,
      storageLabel: "412 MB",
      lastSynced: "Yesterday",
      status: "attention",
      enabled: false,
    },
  ];
}

function createVideos(creators: FixtureCreator[]): FixtureVideo[] {
  const counts = [132, 24, 6];
  let fileId = 1001;
  const videos: FixtureVideo[] = [];
  creators.forEach((creator, creatorIndex) => {
    for (let index = 0; index < counts[creatorIndex]; index += 1) {
      const id = String(fileId++);
      const sequence = String(index + 1).padStart(3, "0");
      const savedAt = new Date(Date.UTC(2026, 6, 20, 11, 55) - videos.length * 3_600_000);
      videos.push({
        id,
        creatorId: creator.id,
        username: creator.username,
        displayName: creator.displayName,
        title: `${creator.displayName} archive clip ${sequence}`,
        description: `Deterministic fixture description for ${creator.username}, clip ${sequence}.`,
        tags: ["archive", creator.username.split(".")[0], `clip${sequence}`],
        mediaType: "video",
        videoUrl: `${E2E_ORIGIN}/media/${id}`,
        thumbnailUrl: `${E2E_ORIGIN}/thumbnail/${id}.jpg`,
        accent: creator.accent,
        savedAt: savedAt.toISOString(),
        savedAtLabel: index === 0 ? "5 min ago" : `${index + 1} hr ago`,
        duration: `0:${String(15 + index % 40).padStart(2, "0")}`,
        sizeBytes: Math.round((6 + index % 13) * 1024 * 1024),
        sizeLabel: `${(6 + index % 13).toFixed(1)} MB`,
        sourceUrl: `https://www.tiktok.com/@${creator.username}/video/${id}`,
      });
    }
  });
  return videos;
}

function createPosts(): SavedPost[] {
  return [
    fixturePost({
      id: "2001",
      platform: "instagram",
      username: "studio.moss",
      displayName: "Studio Moss",
      title: "Moss launch carousel",
      description: "Product stills and a short launch film kept together in source order.",
      mediaType: "mixed",
      assetKinds: ["image", "video"],
      profileId: 11,
      creatorGroupId: 7,
      creatorGroupName: "Studio Moss Everywhere",
    }),
    fixturePost({
      id: "2002",
      platform: "x",
      username: "pixelnotes",
      displayName: "Pixel Notes",
      title: "Interface motion study",
      description: "An animated design study saved from X.",
      mediaType: "animated",
      assetKinds: ["animated"],
      profileId: 12,
    }),
    fixturePost({
      id: "2003",
      platform: "tiktok",
      username: "alice.archive",
      displayName: "Alice Archive",
      title: "Workshop archive clip",
      description: "A TikTok video exposed through the platform-neutral media index.",
      mediaType: "video",
      assetKinds: ["video"],
      profileId: 13,
    }),
    fixturePost({
      id: "2004",
      platform: "instagram",
      username: "field.notes",
      displayName: "Field Notes",
      title: "Three frames from the coast",
      description: "A three-image gallery with deterministic fixture artwork.",
      mediaType: "gallery",
      assetKinds: ["image", "image", "image"],
      profileId: 14,
    }),
    fixturePost({
      id: "2005",
      platform: "x",
      username: "data_cabinet",
      displayName: "Data Cabinet",
      title: "Reference bundle",
      description: "A package-only record exercises the archive fallback card.",
      mediaType: "archive",
      assetKinds: ["archive"],
      profileId: 15,
    }),
  ];
}

function fixturePost(input: {
  id: string;
  platform: SavedPost["platform"];
  username: string;
  displayName: string;
  title: string;
  description: string;
  mediaType: SavedPost["mediaType"];
  assetKinds: SavedMediaAsset["kind"][];
  profileId: number;
  creatorGroupId?: number;
  creatorGroupName?: string;
}): SavedPost {
  const numericId = Number(input.id);
  const savedAt = new Date(Date.UTC(2026, 6, 20, 10, 0) - (numericId - 2001) * 3_600_000);
  const assets = input.assetKinds.map((kind, index) => fixturePostAsset(input.id, index, kind));
  const sizeBytes = assets.reduce((total, asset) => total + asset.sizeBytes, 0);
  const platformHost = input.platform === "tiktok"
    ? `https://www.tiktok.com/@${input.username}`
    : input.platform === "instagram"
      ? `https://www.instagram.com/${input.username}/`
      : `https://x.com/${input.username}`;
  const sourceUrl = input.platform === "tiktok"
    ? `${platformHost}/video/${input.id}`
    : input.platform === "instagram"
      ? `${platformHost}p/${input.id}/`
      : `${platformHost}/status/${input.id}`;
  return {
    id: input.id,
    platform: input.platform,
    remoteId: `remote-${input.id}`,
    creatorId: input.creatorGroupId ? `group:${input.creatorGroupId}` : `profile:${input.profileId}`,
    profileId: input.profileId,
    creatorGroupId: input.creatorGroupId || null,
    creatorGroupName: input.creatorGroupName || "",
    username: input.username,
    displayName: input.displayName,
    creatorProfileUrl: platformHost,
    title: input.title,
    description: input.description,
    tags: ["archive", input.platform, input.username.split(/[._]/)[0]],
    mediaType: input.mediaType,
    assets,
    assetCount: assets.length,
    thumbnailUrl: assets.find((asset) => asset.kind === "image" || asset.kind === "animated")?.mediaUrl || "",
    downloadUrl: `${E2E_ORIGIN}/post-download/${input.id}`,
    accent: input.platform === "instagram" ? "#d88f72" : input.platform === "x" ? "#91a8c7" : "#65d6b4",
    savedAt: savedAt.toISOString(),
    savedAtLabel: `${numericId - 2000} hr ago`,
    publishedAt: new Date(savedAt.getTime() - 86_400_000).toISOString(),
    trashedAt: "",
    retentionStatus: "active",
    duration: input.assetKinds.includes("video") ? "0:24" : "0:00",
    durationSeconds: input.assetKinds.includes("video") ? 24 : 0,
    sizeBytes,
    sizeLabel: `${Math.max(1, Math.round(sizeBytes / 1_048_576))} MB`,
    sourceUrl,
    bookmarked: false,
  };
}

function fixturePostAsset(
  postId: string,
  index: number,
  kind: SavedMediaAsset["kind"],
): SavedMediaAsset {
  const extension = kind === "video" ? "mp4" : kind === "archive" ? "zip" : "svg";
  const mimeType = kind === "video"
    ? "video/mp4"
    : kind === "archive"
      ? "application/zip"
      : "image/svg+xml";
  return {
    id: `${postId}:${index}`,
    position: index + 1,
    kind,
    mimeType,
    mediaUrl: `${E2E_ORIGIN}/post-media/${postId}/${index}`,
    filename: `${postId}-${index + 1}.${extension}`,
    sizeBytes: kind === "video" ? 8_388_608 : kind === "archive" ? 2_097_152 : 786_432,
    width: kind === "image" || kind === "animated" ? 1080 : null,
    height: kind === "image" || kind === "animated" ? 1350 : null,
    durationSeconds: kind === "video" ? 24 : null,
  };
}

async function fulfillPostAsset(
  route: Route,
  request: Request,
  post: SavedPost,
  asset: SavedMediaAsset,
) {
  if (asset.kind === "image" || asset.kind === "animated") {
    const body = thumbnailSvg(`${post.id}-${asset.position}`);
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "cache-control": "private, max-age=604800, immutable" },
      body: request.method() === "HEAD" ? "" : body,
    });
    return;
  }
  if (asset.kind === "video") {
    const wantsRange = Boolean(request.headers().range);
    await route.fulfill({
      status: wantsRange ? 206 : 200,
      contentType: "video/mp4",
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=604800, immutable",
        ...(wantsRange ? { "content-range": `bytes 0-${INLINE_MP4.length - 1}/${INLINE_MP4.length}` } : {}),
      },
      body: request.method() === "HEAD" ? Buffer.alloc(0) : INLINE_MP4,
    });
    return;
  }
  const body = Buffer.from(`PK fixture asset for ${post.id}:${asset.position}`);
  await route.fulfill({
    status: 200,
    contentType: "application/zip",
    headers: { "cache-control": "private, max-age=604800, immutable" },
    body: request.method() === "HEAD" ? Buffer.alloc(0) : body,
  });
}

function thumbnailSvg(id: string) {
  const hue = Number(id.replace(/\D/g, "")) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640"><rect width="360" height="640" fill="hsl(${hue} 24% 16%)"/><circle cx="280" cy="120" r="170" fill="hsl(${(hue + 45) % 360} 32% 24%)"/><path d="M0 450L200 250l160 180v210H0z" fill="hsl(${(hue + 90) % 360} 28% 21%)"/><text x="24" y="600" fill="#f3f5ef" font-family="sans-serif" font-size="28">${id}</text></svg>`;
}

async function installDeterministicBrowserState(context: BrowserContext) {
  await context.addInitScript(() => {
    const mediaState = new WeakMap<HTMLMediaElement, { paused: boolean; currentTime: number }>();
    const stateFor = (element: HTMLMediaElement) => {
      let state = mediaState.get(element);
      if (!state) {
        state = { paused: true, currentTime: 0 };
        mediaState.set(element, state);
      }
      return state;
    };
    const mediaPrototype = HTMLMediaElement.prototype;
    Object.defineProperties(mediaPrototype, {
      duration: { configurable: true, get: () => 30 },
      readyState: { configurable: true, get: () => 4 },
      networkState: { configurable: true, get: () => 1 },
      paused: { configurable: true, get() { return stateFor(this as HTMLMediaElement).paused; } },
      currentTime: {
        configurable: true,
        get() { return stateFor(this as HTMLMediaElement).currentTime; },
        set(value: number) { stateFor(this as HTMLMediaElement).currentTime = value; },
      },
    });
    mediaPrototype.play = function play() {
      stateFor(this).paused = false;
      queueMicrotask(() => this.dispatchEvent(new Event("playing")));
      return Promise.resolve();
    };
    mediaPrototype.pause = function pause() {
      stateFor(this).paused = true;
      this.dispatchEvent(new Event("pause"));
    };
    mediaPrototype.load = function load() {
      queueMicrotask(() => {
        this.dispatchEvent(new Event("loadeddata"));
        this.dispatchEvent(new Event("canplay"));
      });
    };
    Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
      configurable: true,
      value(callback: VideoFrameRequestCallback) {
        return window.requestAnimationFrame((now) => callback(now, {} as VideoFrameCallbackMetadata));
      },
    });
    window.addEventListener("error", (event) => {
      if (event.target instanceof HTMLMediaElement) event.stopImmediatePropagation();
    }, true);
  });
}
