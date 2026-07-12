export const MAX_VIDEO_PAGE_SIZE = 100;

export function boundedVideoPageLimit(requestedLimit, paginated) {
  const fallback = paginated ? MAX_VIDEO_PAGE_SIZE : 500;
  const requested = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : fallback;
  return paginated ? Math.min(requested, MAX_VIDEO_PAGE_SIZE) : requested;
}

export function mergeVideos(current, additions) {
  const byId = new Map(current.map((video) => [video.id, video]));
  for (const video of additions) byId.set(video.id, video);
  return [...byId.values()];
}

export function mergeVideoPage(current, page) {
  return {
    videos: mergeVideos(current, page.items),
    nextCursor: page.nextCursor || null,
  };
}

export function reconcileVersionedIds(
  serverIds,
  currentIds,
  versionsAtRequest,
  currentVersions,
) {
  const server = new Set(serverIds);
  const reconciled = new Set();
  for (const id of new Set([...server, ...currentIds])) {
    const versionAtRequest = versionsAtRequest.get(id) || 0;
    const currentVersion = currentVersions.get(id) || 0;
    if (currentVersion === versionAtRequest ? server.has(id) : currentIds.has(id)) {
      reconciled.add(id);
    }
  }
  return reconciled;
}

export function bookmarkedVideoPageParams(cursor = "") {
  const params = new URLSearchParams({ bookmarked: "1", page: "1", limit: String(MAX_VIDEO_PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  return params;
}
