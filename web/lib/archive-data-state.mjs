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

export function bookmarkedVideoPageParams(
  cursor = "",
  { creatorId = "", username = "", limit = MAX_VIDEO_PAGE_SIZE } = {},
) {
  const params = new URLSearchParams({
    bookmarked: "1",
    page: "1",
    limit: String(boundedVideoPageLimit(limit, true)),
  });
  if (cursor) params.set("cursor", cursor);
  if (creatorId) params.set("creatorId", creatorId);
  if (username) params.set("username", username);
  return params;
}
