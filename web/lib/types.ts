export type CreatorStatus = "healthy" | "syncing" | "attention";
export type MediaType = "video" | "slideshow" | "story";
export type VideoStatus = "ready" | "processing" | "archived";

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
  status: VideoStatus;
  videoUrl: string;
  accent: string;
  savedAt: string;
  savedAtLabel: string;
  duration: string;
  sizeLabel: string;
  sourceUrl: string;
  likes: number;
  bookmarks: number;
}

export interface ArchiveStats {
  creatorCount: number;
  videoCount: number;
  storageUsed: string;
  storagePercent: number;
  newThisWeek: number;
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
