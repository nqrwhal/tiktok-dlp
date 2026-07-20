import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_VIDEO_PAGE_SIZE,
  bookmarkedVideoPageParams,
  boundedVideoPageLimit,
  mergeVideoPage,
  mergeVideos,
} from "../lib/archive-data-state.mjs";
import {
  BOOKMARK_MIGRATION_STORAGE_KEY,
  BOOKMARK_RETRY_DELAYS_MS,
  BOOKMARK_STORAGE_KEY,
  BookmarkController,
  chunkBookmarkIds,
  createBookmarkControllerLifecycle,
  reconcileHydratedBookmarkState,
  reconcileBookmarkState,
} from "../lib/bookmark-state.mjs";

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

test("bookmark pages retain their cursor and make older records reachable", () => {
  const firstQuery = bookmarkedVideoPageParams("", { creatorId: "creator-7", limit: 36 });
  assert.equal(firstQuery.get("bookmarked"), "1");
  assert.equal(firstQuery.get("page"), "1");
  assert.equal(firstQuery.get("limit"), "36");
  assert.equal(firstQuery.has("cursor"), false);
  assert.equal(firstQuery.get("creatorId"), "creator-7");

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

test("legacy bookmark migration is split into sequential 500-ID requests", async () => {
  const ids = Array.from({ length: 1_001 }, (_, index) => String(index + 1));
  assert.deepEqual(chunkBookmarkIds(ids).map((chunk) => chunk.length), [500, 500, 1]);
  const storage = memoryStorage({ [BOOKMARK_STORAGE_KEY]: JSON.stringify(ids) });
  const server = new Set();
  const batches = [];
  let activeRequests = 0;

  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async (_url, init) => {
      activeRequests += 1;
      assert.equal(activeRequests, 1);
      const batch = JSON.parse(init.body).fileIds;
      batches.push(batch);
      batch.forEach((id) => server.add(id));
      await Promise.resolve();
      activeRequests -= 1;
      return jsonResponse({ fileIds: [...server] });
    },
  });

  await controller.hydrate(storage);
  assert.deepEqual(batches.map((batch) => batch.length), [500, 500, 1]);
  assert.equal(storage.getItem(BOOKMARK_MIGRATION_STORAGE_KEY), "1");
  assert.equal(controller.getSnapshot().confirmedIds.size, 1_001);
  controller.dispose();
});

test("toggles during hydration survive the server snapshot and flush afterward", async () => {
  const hydration = deferred();
  const methods = [];
  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async (url, init) => {
      methods.push(init.method);
      if (url.endsWith("/api/bookmarks")) return hydration.promise;
      return jsonResponse({ fileId: 2, bookmarked: true });
    },
  });

  const hydrating = controller.hydrate(memoryStorage({
    [BOOKMARK_MIGRATION_STORAGE_KEY]: "1",
  }));
  controller.toggle("2");
  assert.deepEqual([...controller.getSnapshot().visibleIds], ["2"]);
  assert.deepEqual([...controller.getSnapshot().pendingIds], ["2"]);
  hydration.resolve(jsonResponse({ fileIds: [1] }));
  await hydrating;
  await waitFor(() => controller.getSnapshot().pendingIds.size === 0);

  assert.deepEqual(methods, ["GET", "PUT"]);
  assert.deepEqual([...controller.getSnapshot().visibleIds].sort(), ["1", "2"]);
  controller.dispose();
});

test("turning off a legacy bookmark during migration deletes the migrated server row", async () => {
  const migration = deferred();
  const methods = [];
  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async (url, init) => {
      methods.push(init.method);
      if (url.endsWith("/api/bookmarks")) return migration.promise;
      return jsonResponse({ fileId: "2", bookmarked: false });
    },
  });

  const hydrating = controller.hydrate(memoryStorage({
    [BOOKMARK_STORAGE_KEY]: JSON.stringify(["2"]),
  }));
  controller.toggle("2");
  assert.equal(controller.getSnapshot().visibleIds.has("2"), false);
  migration.resolve(jsonResponse({ fileIds: ["2"] }));
  await hydrating;
  await waitFor(() => controller.getSnapshot().pendingIds.size === 0);

  assert.deepEqual(methods, ["POST", "DELETE"]);
  assert.equal(controller.getSnapshot().confirmedIds.has("2"), false);
  assert.equal(controller.getSnapshot().visibleIds.has("2"), false);
  controller.dispose();
});

test("hydration adopts server state while preserving only locally touched intent", () => {
  const reconciled = reconcileHydratedBookmarkState({
    serverIds: ["server", "removed-locally"],
    desiredIds: new Set(["stale-cache", "added-locally"]),
    touchedIds: new Set(["removed-locally", "added-locally"]),
  });

  assert.deepEqual([...reconciled.confirmedIds].sort(), ["removed-locally", "server"]);
  assert.deepEqual([...reconciled.desiredIds].sort(), ["added-locally", "server"]);
});

test("deferred controller disposal survives StrictMode effect rehearsal", () => {
  const callbacks = [];
  const lifecycle = createBookmarkControllerLifecycle((callback) => callbacks.push(callback));
  const controller = { disposeCalls: 0, dispose() { this.disposeCalls += 1; } };

  lifecycle.activate(controller);
  lifecycle.deactivate(controller);
  lifecycle.activate(controller);
  callbacks.shift()();
  assert.equal(controller.disposeCalls, 0);

  lifecycle.deactivate(controller);
  callbacks.shift()();
  assert.equal(controller.disposeCalls, 1);
});

test("malformed successful hydration responses preserve the cache and migration marker", async () => {
  const storage = memoryStorage({ [BOOKMARK_STORAGE_KEY]: JSON.stringify(["4"]) });
  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async () => jsonResponse({}),
  });

  await controller.hydrate(storage);

  assert.deepEqual([...controller.getSnapshot().visibleIds], ["4"]);
  assert.equal(controller.getSnapshot().ready, false);
  assert.match(controller.getSnapshot().error, /invalid/i);
  assert.equal(storage.getItem(BOOKMARK_MIGRATION_STORAGE_KEY), null);
  controller.dispose();
});

test("malformed successful revalidation responses preserve confirmed bookmarks", async () => {
  let getCount = 0;
  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async () => {
      getCount += 1;
      return jsonResponse(getCount === 1 ? { fileIds: ["5"] } : {});
    },
  });
  await controller.hydrate(memoryStorage({ [BOOKMARK_MIGRATION_STORAGE_KEY]: "1" }));

  await controller.refresh();

  assert.equal(controller.getSnapshot().confirmedIds.has("5"), true);
  assert.equal(controller.getSnapshot().visibleIds.has("5"), true);
  assert.match(controller.getSnapshot().error, /invalid/i);
  controller.dispose();
});

test("rapid toggles serialize writes and leave the final intent on the server", async () => {
  const mutations = [];
  const mutationResponses = [];
  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async (url, init) => {
      if (url.endsWith("/api/bookmarks")) return jsonResponse({ fileIds: [] });
      mutations.push(init.method);
      const response = deferred();
      mutationResponses.push(response);
      return response.promise;
    },
  });
  await controller.hydrate(memoryStorage({ [BOOKMARK_MIGRATION_STORAGE_KEY]: "1" }));

  controller.toggle("7");
  controller.toggle("7");
  assert.deepEqual(mutations, ["PUT"]);
  mutationResponses[0].resolve(jsonResponse({ bookmarked: true }));
  await waitFor(() => mutations.length === 2);
  assert.deepEqual(mutations, ["PUT", "DELETE"]);
  controller.toggle("7");
  mutationResponses[1].resolve(jsonResponse({ bookmarked: false }));
  await waitFor(() => mutations.length === 3);
  assert.deepEqual(mutations, ["PUT", "DELETE", "PUT"]);
  mutationResponses[2].resolve(jsonResponse({ bookmarked: true }));
  await waitFor(() => controller.getSnapshot().pendingIds.size === 0);

  assert.deepEqual([...controller.getSnapshot().confirmedIds], ["7"]);
  assert.deepEqual([...controller.getSnapshot().visibleIds], ["7"]);
  controller.dispose();
});

test("persisted bookmark order is canonical after removing and re-adding an ID", async () => {
  const storage = memoryStorage({
    [BOOKMARK_STORAGE_KEY]: JSON.stringify(["1", "2"]),
    [BOOKMARK_MIGRATION_STORAGE_KEY]: "1",
  });
  const server = new Set(["1", "2"]);
  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async (url, init) => {
      if (url.endsWith("/api/bookmarks")) return jsonResponse({ fileIds: [...server] });
      const id = decodeURIComponent(url.split("/").at(-1));
      if (init.method === "PUT") server.add(id);
      else server.delete(id);
      return jsonResponse({ fileId: id, bookmarked: init.method === "PUT" });
    },
  });
  await controller.hydrate(storage);

  controller.toggle("1");
  await waitFor(() => controller.getSnapshot().pendingIds.size === 0);
  controller.toggle("1");
  await waitFor(() => controller.getSnapshot().pendingIds.size === 0);

  assert.equal(storage.getItem(BOOKMARK_STORAGE_KEY), JSON.stringify(["1", "2"]));
  controller.dispose();
});

test("transient bookmark failures use bounded retries and terminal failures roll back", async () => {
  const retryDelays = [];
  let mutationAttempt = 0;
  const controller = new BookmarkController({
    base: "https://archive.test",
    sleepImpl: async (delay) => retryDelays.push(delay),
    fetchImpl: async (url) => {
      if (url.endsWith("/api/bookmarks")) return jsonResponse({ fileIds: [] });
      mutationAttempt += 1;
      if (mutationAttempt <= 3) return jsonResponse({ error: "try again" }, [503, 429, 408][mutationAttempt - 1]);
      if (mutationAttempt === 4) return jsonResponse({ error: "invalid" }, 400);
      return jsonResponse({ bookmarked: true });
    },
  });
  await controller.hydrate(memoryStorage({ [BOOKMARK_MIGRATION_STORAGE_KEY]: "1" }));

  controller.toggle("9");
  assert.equal(controller.getSnapshot().visibleIds.has("9"), true);
  await waitFor(() => controller.getSnapshot().failedIds.has("9"));
  assert.deepEqual(retryDelays, BOOKMARK_RETRY_DELAYS_MS);
  assert.equal(controller.getSnapshot().visibleIds.has("9"), false);
  assert.match(controller.getSnapshot().error, /invalid/);

  controller.retry("9");
  await waitFor(() => controller.getSnapshot().pendingIds.size === 0);
  assert.equal(controller.getSnapshot().confirmedIds.has("9"), true);
  assert.equal(controller.getSnapshot().error, "");
  controller.dispose();
});

test("revalidation cannot overwrite an ID that was pending when it started", () => {
  const reconciled = reconcileBookmarkState({
    serverIds: ["stale", "server"],
    confirmedIds: new Set(["server"]),
    desiredIds: new Set(["local"]),
    versionsAtRequest: new Map([["local", 1]]),
    currentVersions: new Map([["local", 1]]),
    pendingAtRequest: new Set(["local"]),
  });
  assert.deepEqual([...reconciled.confirmedIds].sort(), ["server", "stale"]);
  assert.deepEqual([...reconciled.desiredIds].sort(), ["local", "server", "stale"]);
});

test("an in-flight stale GET cannot undo a completed bookmark mutation", async () => {
  const mutation = deferred();
  const revalidation = deferred();
  let bookmarkGetCount = 0;
  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async (url, init) => {
      if (url.endsWith("/api/bookmarks") && init.method === "GET") {
        bookmarkGetCount += 1;
        return bookmarkGetCount === 1
          ? jsonResponse({ fileIds: [] })
          : revalidation.promise;
      }
      return mutation.promise;
    },
  });
  await controller.hydrate(memoryStorage({ [BOOKMARK_MIGRATION_STORAGE_KEY]: "1" }));

  controller.toggle("11");
  const refreshing = controller.refresh();
  mutation.resolve(jsonResponse({ bookmarked: true }));
  await waitFor(() => controller.getSnapshot().pendingIds.size === 0);
  revalidation.resolve(jsonResponse({ fileIds: [] }));
  await refreshing;

  assert.equal(controller.getSnapshot().confirmedIds.has("11"), true);
  assert.equal(controller.getSnapshot().visibleIds.has("11"), true);
  controller.dispose();
});

test("a refresh requested during revalidation runs a trailing authoritative GET", async () => {
  const stale = deferred();
  let getCount = 0;
  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async () => {
      getCount += 1;
      if (getCount === 1) return jsonResponse({ fileIds: [] });
      if (getCount === 2) return stale.promise;
      return jsonResponse({ fileIds: ["21"] });
    },
  });
  await controller.hydrate(memoryStorage({ [BOOKMARK_MIGRATION_STORAGE_KEY]: "1" }));

  const firstRefresh = controller.refresh();
  await waitFor(() => getCount === 2);
  const queuedRefresh = controller.refresh();
  stale.resolve(jsonResponse({ fileIds: [] }));
  await Promise.all([firstRefresh, queuedRefresh]);

  assert.equal(getCount, 3);
  assert.equal(controller.getSnapshot().visibleIds.has("21"), true);
  controller.dispose();
});

test("a refresh requested during hydration follows it with an authoritative GET", async () => {
  const staleHydration = deferred();
  let getCount = 0;
  const controller = new BookmarkController({
    base: "https://archive.test",
    fetchImpl: async () => {
      getCount += 1;
      if (getCount === 1) return staleHydration.promise;
      return jsonResponse({ fileIds: ["22"] });
    },
  });
  const storage = memoryStorage({ [BOOKMARK_MIGRATION_STORAGE_KEY]: "1" });
  const hydration = controller.hydrate(storage);
  await waitFor(() => getCount === 1);
  const refresh = controller.refresh();
  staleHydration.resolve(jsonResponse({ fileIds: [] }));
  await Promise.all([hydration, refresh]);

  assert.equal(getCount, 2);
  assert.equal(controller.getSnapshot().visibleIds.has("22"), true);
  controller.dispose();
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for bookmark state");
}
