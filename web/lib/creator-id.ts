import type { Creator } from "./types";

export function legacyCreatorId(username: string): string {
  return String(username || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

export function resolveCreatorId(requestedId: string, creators: Creator[]): string {
  const normalized = requestedId.trim().toLowerCase();
  if (!normalized || normalized === "all") return normalized || "all";

  const exact = creators.find((creator) => creator.id.toLowerCase() === normalized);
  if (exact) return exact.id;

  const legacyMatches = creators.filter((creator) => legacyCreatorId(creator.username) === normalized);
  return legacyMatches.length === 1 ? legacyMatches[0].id : requestedId;
}
