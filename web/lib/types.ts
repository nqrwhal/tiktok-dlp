export type CreatorStatus = "healthy" | "syncing" | "attention";
export type MediaType = "video" | "slideshow" | "story";

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
  status: "queued" | "running" | "completed" | "failed" | "canceled";
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

export interface ArchiveApi {
  listCreators(): Promise<Creator[]>;
  listVideos(input?: {
    creatorId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<FeedPage>;
}
