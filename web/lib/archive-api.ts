import { mockCreators, mockVideos } from "./mock-data";
import type { ArchiveApi } from "./types";

/**
 * Frontend data boundary. The backend can implement the same methods with
 * `/api/creators` and `/api/videos` without changing the feed components.
 */
export const mockArchiveApi: ArchiveApi = {
  async listCreators() {
    return mockCreators;
  },

  async listVideos({ creatorId, cursor, limit = 12 } = {}) {
    const source = creatorId
      ? mockVideos.filter((video) => video.creatorId === creatorId)
      : mockVideos;
    const start = cursor
      ? Math.max(0, source.findIndex((video) => video.id === cursor) + 1)
      : 0;
    const items = source.slice(start, start + limit);
    return {
      items,
      nextCursor:
        start + items.length < source.length ? items.at(-1)?.id ?? null : null,
    };
  },
};
