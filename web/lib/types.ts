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
}

export interface CreatorImport {
  id: number;
  username: string;
  status: "queued" | "running" | "completed" | "failed";
  maxDurationSeconds: number;
  discoveredCount: number;
  processedCount: number;
  downloadedCount: number;
  skippedExistingCount: number;
  skippedDurationCount: number;
  failedCount: number;
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface FeedPage {
  items: SavedVideo[];
  nextCursor: string | null;
}

export interface ArchiveApi {
  listCreators(): Promise<Creator[]>;
  listVideos(input?: {
    creatorId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<FeedPage>;
}
