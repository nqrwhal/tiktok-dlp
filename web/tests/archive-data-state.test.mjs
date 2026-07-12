import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_VIDEO_PAGE_SIZE,
  bookmarkedVideoPageParams,
  boundedVideoPageLimit,
  mergeVideoPage,
  mergeVideos,
  reconcileVersionedIds,
} from "../lib/archive-data-state.mjs";

test("paginated video requests stay bounded while legacy requests keep their explicit limit", () => {
  assert.equal(boundedVideoPageLimit(undefined, true), MAX_VIDEO_PAGE_SIZE);
  assert.equal(boundedVideoPageLimit(60, true), 60);
  assert.equal(boundedVideoPageLimit(2_000, true), MAX_VIDEO_PAGE_SIZE);
  assert.equal(boundedVideoPageLimit(5_000, true), MAX_VIDEO_PAGE_SIZE);
  assert.equal(boundedVideoPageLimit(5_000, false), 5_000);
});

test("loading a cursor page appends older videos without duplicating an overlapping row", () => {
  const newestPage = [
    { id: "5", title: "five" },
    { id: "4", title: "four" },
    { id: "3", title: "stale three" },
  ];
  const olderPage = [
    { id: "3", title: "fresh three" },
    { id: "2", title: "two" },
    { id: "1", title: "one" },
  ];

  const loaded = mergeVideos(newestPage, olderPage);

  assert.deepEqual(loaded.map(({ id }) => id), ["5", "4", "3", "2", "1"]);
  assert.equal(loaded.find(({ id }) => id === "3").title, "fresh three");
});

test("initial bookmark sync cannot overwrite mutations made while it was in flight", () => {
  const versionsAtRequest = new Map();
  const currentVersions = new Map([
    ["removed-during-sync", 1],
    ["added-during-sync", 1],
  ]);
  const currentBookmarks = new Set(["unchanged-local", "added-during-sync"]);
  const staleServerResponse = ["unchanged-server", "removed-during-sync"];

  const reconciled = reconcileVersionedIds(
    staleServerResponse,
    currentBookmarks,
    versionsAtRequest,
    currentVersions,
  );

  assert.deepEqual(
    [...reconciled].sort(),
    ["added-during-sync", "unchanged-server"],
  );
});

test("bookmark pages retain their cursor and make older records reachable", () => {
  const firstQuery = bookmarkedVideoPageParams();
  assert.equal(firstQuery.get("bookmarked"), "1");
  assert.equal(firstQuery.get("page"), "1");
  assert.equal(firstQuery.get("limit"), String(MAX_VIDEO_PAGE_SIZE));
  assert.equal(firstQuery.has("cursor"), false);

  const firstState = mergeVideoPage([], {
    items: [{ id: "newer" }],
    nextCursor: "older-page",
  });
  assert.equal(firstState.nextCursor, "older-page");

  const nextQuery = bookmarkedVideoPageParams(firstState.nextCursor);
  assert.equal(nextQuery.get("cursor"), "older-page");
  const finalState = mergeVideoPage(firstState.videos, {
    items: [{ id: "older" }],
    nextCursor: null,
  });
  assert.deepEqual(finalState.videos.map(({ id }) => id), ["newer", "older"]);
  assert.equal(finalState.nextCursor, null);
});
