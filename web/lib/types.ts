export type CreatorStatus = "healthy" | "syncing" | "attention";
export type MediaType = "video" | "slideshow" | "story" | "image" | "animated" | "gallery" | "mixed" | "archive";

export interface Creator {
  id: string;
  username: string;
  displayName: string;
  initials: string;
  accent: string;
  videoCount: number;
  storageLabel: string;
  lastSynced: string;
  status: CreatorStatus;
  enabled: boolean;
}

export interface SavedVideo {
  id: string;
  creatorId: string;
  username: string;
  displayName: string;
  title: string;
  description: string;
  tags: string[];
  mediaType: MediaType;
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

export interface ArchiveStats {
  creatorCount: number;
  videoCount: number;
  storageUsed: string;
  storagePercent: number;
  newThisWeek: number;
  addedToday?: number;
}

export interface CreatorImport {
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
  items?: CreatorImportItem[];
}

export interface CreatorImportItem {
  id: number;
  position: number;
  videoId: string;
  sourceUrl: string;
  title: string;
  status: "queued" | "running" | "downloaded" | "skipped_existing" | "skipped_duration" | "skipped_unknown_duration" | "failed";
  durationSeconds: number | null;
  fileId: number | null;
  error: string | null;
  attemptCount: number;
  completedAt: number | null;
  updatedAt: number;
}

export interface FeedPage {
  items: SavedVideo[];
  nextCursor: string | null;
}

export interface SavedMediaAsset {
  id: string;
  position: number;
  kind: "video" | "image" | "animated" | "archive";
  mimeType: string;
  mediaUrl: string;
  filename: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

export interface SavedPost {
  id: string;
  platform: ProfilePlatform;
  remoteId: string;
  creatorId: string;
  profileId: number | null;
  creatorGroupId: number | null;
  creatorGroupName: string;
  username: string;
  displayName: string;
  creatorProfileUrl: string;
  title: string;
  description: string;
  tags: string[];
  mediaType: MediaType;
  assets: SavedMediaAsset[];
  assetCount: number;
  thumbnailUrl: string;
  downloadUrl: string;
  accent: string;
  savedAt: string;
  savedAtLabel: string;
  publishedAt: string;
  trashedAt: string;
  retentionStatus: string;
  duration: string;
  durationSeconds: number;
  sizeBytes: number;
  sizeLabel: string;
  sourceUrl: string;
  bookmarked: boolean;
}

export interface PostPage {
  items: SavedPost[];
  nextCursor: string | null;
}

export interface TrashedVideo {
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

export type ProfilePlatform = "tiktok" | "instagram" | "x";

export interface PlatformProfile {
  id: number;
  platform: ProfilePlatform;
  remoteId: string | null;
  handle: string;
  displayName: string;
  profileUrl: string;
  groupId: number | null;
  linkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreatorProfileGroup {
  id: number;
  name: string;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
  members: PlatformProfile[];
}

export interface ProfileGroupsPayload {
  groups: CreatorProfileGroup[];
  unlinkedProfiles: PlatformProfile[];
}

export interface ArchiveApi {
  listCreators(): Promise<Creator[]>;
  listVideos(input?: {
    creatorId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<FeedPage>;
}
