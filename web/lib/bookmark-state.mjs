export const BOOKMARK_STORAGE_KEY = "rewind-bookmarks";
export const BOOKMARK_MIGRATION_STORAGE_KEY = "rewind-bookmarks-server-migrated-v1";
export const BOOKMARK_SYNC_STORAGE_KEY = "rewind-bookmarks-server-sync-v1";
export const BOOKMARK_MIGRATION_BATCH_SIZE = 500;
export const BOOKMARK_RETRY_DELAYS_MS = Object.freeze([250, 750, 2_000]);

export function chunkBookmarkIds(ids, batchSize = BOOKMARK_MIGRATION_BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < ids.length; index += batchSize) {
    chunks.push(ids.slice(index, index + batchSize));
  }
  return chunks;
}

export function reconcileBookmarkState({
  serverIds,
  confirmedIds,
  desiredIds,
  versionsAtRequest,
  currentVersions,
  pendingAtRequest = new Set(),
}) {
  const server = new Set(serverIds.map(String));
  const confirmed = new Set(confirmedIds);
  const desired = new Set(desiredIds);
  const ids = new Set([...server, ...confirmed, ...desired]);

  for (const id of ids) {
    const changedDuringRequest = (versionsAtRequest.get(id) || 0) !== (currentVersions.get(id) || 0);
    if (changedDuringRequest || pendingAtRequest.has(id)) continue;
    if (server.has(id)) {
      confirmed.add(id);
      desired.add(id);
    } else {
      confirmed.delete(id);
      desired.delete(id);
    }
  }

  return { confirmedIds: confirmed, desiredIds: desired };
}

export function reconcileHydratedBookmarkState({
  serverIds,
  desiredIds,
  touchedIds = new Set(),
}) {
  const confirmed = new Set(serverIds.map(String));
  const desired = new Set(desiredIds);
  const ids = new Set([...confirmed, ...desired]);

  for (const id of ids) {
    if (touchedIds.has(id)) continue;
    if (confirmed.has(id)) desired.add(id);
    else desired.delete(id);
  }

  return { confirmedIds: confirmed, desiredIds: desired };
}

export function createBookmarkControllerLifecycle(schedule = queueMicrotask) {
  const pending = new Map();
  return Object.freeze({
    activate(controller) {
      const ticket = pending.get(controller);
      if (!ticket) return;
      ticket.cancelled = true;
      pending.delete(controller);
    },
    deactivate(controller) {
      const ticket = { cancelled: false };
      pending.set(controller, ticket);
      schedule(() => {
        if (ticket.cancelled || pending.get(controller) !== ticket) return;
        pending.delete(controller);
        controller.dispose();
      });
    },
  });
}

export class BookmarkController {
  #base;
  #fetch;
  #sleep;
  #storage = null;
  #confirmed = new Set();
  #desired = new Set();
  #pending = new Set();
  #failedTargets = new Map();
  #versions = new Map();
  #hydrationTouched = new Set();
  #workers = new Map();
  #listeners = new Set();
  #lifetime = new AbortController();
  #hydrationPromise = null;
  #revalidationPromise = null;
  #revalidationQueued = false;
  #cacheSeeded = false;
  #ready = false;
  #syncing = false;
  #syncError = "";
  #serverRevision = 0;
  #mutationRevision = 0;
  #snapshot;

  constructor({ base = "", fetchImpl = globalThis.fetch, sleepImpl = abortableSleep } = {}) {
    this.#base = base.replace(/\/+$/, "");
    this.#fetch = fetchImpl.bind(globalThis);
    this.#sleep = sleepImpl;
    this.#snapshot = this.#makeSnapshot();
  }

  getSnapshot = () => this.#snapshot;

  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** @param {Storage | null} storage */
  async hydrate(storage = null) {
    if (this.#hydrationPromise) return this.#hydrationPromise;
    if (this.#ready) return;
    this.#storage = storage;
    if (!this.#cacheSeeded) {
      this.#cacheSeeded = true;
      this.#desired = readStoredBookmarkIds(storage);
      this.#publish();
    }

    if (!this.#base) {
      this.#confirmed = new Set(this.#desired);
      this.#serverRevision += 1;
      this.#ready = true;
      this.#syncError = "";
      this.#persist();
      this.#publish();
      return;
    }

    this.#syncing = true;
    this.#syncError = "";
    this.#publish();
    const run = this.#hydrateFromServer();
    this.#hydrationPromise = run;
    try {
      await run;
    } finally {
      if (this.#hydrationPromise === run) this.#hydrationPromise = null;
    }
  }

  async #hydrateFromServer() {
    const legacyIds = [...this.#desired];
    const shouldMigrate = legacyIds.length > 0
      && safeStorageGet(this.#storage, BOOKMARK_MIGRATION_STORAGE_KEY) !== "1";
    try {
      let serverIds;
      if (shouldMigrate) {
        serverIds = [];
        for (const fileIds of chunkBookmarkIds(legacyIds)) {
          const payload = await this.#requestJson("/api/bookmarks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fileIds }),
          });
          serverIds = bookmarkIdsFromPayload(payload);
        }
      } else {
        const payload = await this.#requestJson("/api/bookmarks", {
          method: "GET",
          cache: "no-store",
        });
        serverIds = bookmarkIdsFromPayload(payload);
      }

      const reconciled = reconcileHydratedBookmarkState({
        serverIds,
        desiredIds: this.#desired,
        touchedIds: this.#hydrationTouched,
      });
      this.#confirmed = reconciled.confirmedIds;
      this.#desired = reconciled.desiredIds;
      this.#serverRevision += 1;
      if (shouldMigrate) this.#mutationRevision += 1;
      this.#ready = true;
      this.#syncing = false;
      this.#syncError = "";
      safeStorageSet(this.#storage, BOOKMARK_MIGRATION_STORAGE_KEY, "1");

      const touched = [...this.#hydrationTouched];
      this.#hydrationTouched.clear();
      for (const id of touched) {
        if (this.#confirmed.has(id) === this.#desired.has(id)) this.#pending.delete(id);
        else this.#startWorker(id);
      }
      this.#persist();
      this.#publish();
    } catch (error) {
      if (isAbortError(error)) return;
      this.#syncing = false;
      this.#syncError = errorText(error, "Bookmarks could not sync.");
      this.#publish();
    }
  }

  toggle(id) {
    const normalizedId = String(id);
    const nextValue = !this.#desired.has(normalizedId);
    this.#setDesired(normalizedId, nextValue);
    this.#failedTargets.delete(normalizedId);
    if (this.#failedTargets.size === 0 && this.#ready) this.#syncError = "";
    this.#versions.set(normalizedId, (this.#versions.get(normalizedId) || 0) + 1);

    if (!this.#base) {
      this.#setConfirmed(normalizedId, nextValue);
      this.#pending.delete(normalizedId);
    } else {
      this.#pending.add(normalizedId);
      if (this.#ready) this.#startWorker(normalizedId);
      else this.#hydrationTouched.add(normalizedId);
    }
    this.#persist();
    this.#publish();
  }

  async refresh() {
    if (!this.#base) return;
    if (!this.#ready) {
      await this.hydrate(this.#storage);
      if (!this.#ready) return;
    }
    if (this.#revalidationPromise) {
      this.#revalidationQueued = true;
      return this.#revalidationPromise;
    }

    const run = this.#runRevalidationLoop();
    this.#revalidationPromise = run;
    try {
      await run;
    } finally {
      if (this.#revalidationPromise === run) this.#revalidationPromise = null;
    }
  }

  async #runRevalidationLoop() {
    do {
      this.#revalidationQueued = false;
      const versionsAtRequest = new Map(this.#versions);
      const pendingAtRequest = new Set(this.#pending);
      this.#syncing = true;
      this.#syncError = "";
      this.#publish();
      await this.#revalidateFromServer(versionsAtRequest, pendingAtRequest);
    } while (this.#revalidationQueued && !this.#lifetime.signal.aborted);
  }

  async #revalidateFromServer(versionsAtRequest, pendingAtRequest) {
    try {
      const payload = await this.#requestJson("/api/bookmarks", {
        method: "GET",
        cache: "no-store",
      });
      const reconciled = reconcileBookmarkState({
        serverIds: bookmarkIdsFromPayload(payload),
        confirmedIds: this.#confirmed,
        desiredIds: this.#desired,
        versionsAtRequest,
        currentVersions: this.#versions,
        pendingAtRequest,
      });
      this.#confirmed = reconciled.confirmedIds;
      this.#desired = reconciled.desiredIds;
      this.#serverRevision += 1;
      for (const id of this.#failedTargets.keys()) {
        const changedDuringRequest = (versionsAtRequest.get(id) || 0) !== (this.#versions.get(id) || 0);
        if (!changedDuringRequest && !pendingAtRequest.has(id)) this.#failedTargets.delete(id);
      }
      this.#syncError = "";
      this.#persist();
    } catch (error) {
      if (!isAbortError(error)) {
        this.#syncError = errorText(error, "Bookmarks could not refresh.");
      }
    } finally {
      this.#syncing = false;
      this.#publish();
    }
  }

  retry(id) {
    if (typeof id === "string" && this.#failedTargets.has(id)) {
      const target = this.#failedTargets.get(id);
      this.#failedTargets.delete(id);
      if (this.#failedTargets.size === 0) this.#syncError = "";
      this.#setDesired(id, target);
      this.#versions.set(id, (this.#versions.get(id) || 0) + 1);
      this.#pending.add(id);
      this.#persist();
      this.#publish();
      this.#startWorker(id);
      return;
    }

    const failed = [...this.#failedTargets];
    if (failed.length) {
      for (const [failedId, target] of failed) {
        this.#failedTargets.delete(failedId);
        this.#setDesired(failedId, target);
        this.#versions.set(failedId, (this.#versions.get(failedId) || 0) + 1);
        this.#pending.add(failedId);
        this.#startWorker(failedId);
      }
      if (this.#failedTargets.size === 0) this.#syncError = "";
      this.#persist();
      this.#publish();
      return;
    }

    void this.refresh();
  }

  #startWorker(id) {
    if (!this.#ready || this.#workers.has(id) || this.#lifetime.signal.aborted) return;
    const worker = this.#runWorker(id);
    this.#workers.set(id, worker);
    void worker.finally(() => {
      if (this.#workers.get(id) !== worker) return;
      this.#workers.delete(id);
      if (this.#ready && this.#confirmed.has(id) !== this.#desired.has(id) && !this.#failedTargets.has(id)) {
        this.#startWorker(id);
      }
    });
  }

  async #runWorker(id) {
    while (!this.#lifetime.signal.aborted) {
      const target = this.#desired.has(id);
      if (this.#confirmed.has(id) === target) {
        this.#pending.delete(id);
        this.#publish();
        return;
      }

      try {
        await this.#requestJson(`/api/bookmarks/${encodeURIComponent(id)}`, {
          method: target ? "PUT" : "DELETE",
        });
        this.#setConfirmed(id, target);
        this.#serverRevision += 1;
        this.#mutationRevision += 1;
        this.#failedTargets.delete(id);
        if (this.#failedTargets.size === 0) this.#syncError = "";
      } catch (error) {
        if (isAbortError(error)) return;
        if (this.#desired.has(id) !== target) continue;
        this.#failedTargets.set(id, target);
        this.#setDesired(id, this.#confirmed.has(id));
        this.#pending.delete(id);
        this.#syncError = errorText(error, "Bookmark update failed.");
        this.#persist();
        this.#publish();
        return;
      }

      if (this.#desired.has(id) === target) {
        this.#pending.delete(id);
        this.#persist();
        this.#publish();
        return;
      }
      this.#publish();
    }
  }

  async #requestJson(path, init) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.#fetch(`${this.#base}${path}`, {
          ...init,
          signal: this.#lifetime.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const message = payload && typeof payload.error === "string"
            ? payload.error
            : `Bookmark request failed (${response.status})`;
          const error = new Error(message);
          error.status = response.status;
          throw error;
        }
        return await response.json().catch(() => ({}));
      } catch (error) {
        if (isAbortError(error)) throw error;
        const status = Number(error?.status) || 0;
        const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
        if (!retryable || attempt >= BOOKMARK_RETRY_DELAYS_MS.length) throw error;
        await this.#sleep(BOOKMARK_RETRY_DELAYS_MS[attempt], this.#lifetime.signal);
      }
    }
  }

  #setConfirmed(id, value) {
    if (value) this.#confirmed.add(id);
    else this.#confirmed.delete(id);
  }

  #setDesired(id, value) {
    if (value) this.#desired.add(id);
    else this.#desired.delete(id);
  }

  #persist() {
    const serialized = JSON.stringify([...this.#desired].sort());
    if (safeStorageGet(this.#storage, BOOKMARK_STORAGE_KEY) === serialized) return;
    safeStorageSet(this.#storage, BOOKMARK_STORAGE_KEY, serialized);
  }

  #makeSnapshot() {
    return Object.freeze({
      visibleIds: new Set(this.#desired),
      confirmedIds: new Set(this.#confirmed),
      pendingIds: new Set(this.#pending),
      failedIds: new Set(this.#failedTargets.keys()),
      serverRevision: this.#serverRevision,
      mutationRevision: this.#mutationRevision,
      ready: this.#ready,
      syncing: this.#syncing,
      error: this.#syncError,
    });
  }

  #publish() {
    this.#snapshot = this.#makeSnapshot();
    for (const listener of this.#listeners) listener();
  }

  dispose() {
    this.#lifetime.abort();
    this.#listeners.clear();
  }
}

export function readStoredBookmarkIds(storage) {
  const raw = safeStorageGet(storage, BOOKMARK_STORAGE_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id) => typeof id === "string" || typeof id === "number").map(String));
  } catch {
    safeStorageRemove(storage, BOOKMARK_STORAGE_KEY);
    return new Set();
  }
}

export function safeStorageGet(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeStorageSet(storage, key, value) {
  try {
    storage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeStorageRemove(storage, key) {
  try {
    storage?.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function bookmarkIdsFromPayload(payload) {
  if (
    !payload
    || !Array.isArray(payload.fileIds)
    || payload.fileIds.some((id) => typeof id !== "string" && typeof id !== "number")
  ) {
    throw new Error("Bookmark response was invalid.");
  }
  return payload.fileIds.map(String);
}

function errorText(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function abortableSleep(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, delay);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
