"use client";

import {
  ExternalLink,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Unlink,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import type {
  CreatorProfileGroup,
  PlatformProfile,
  ProfileGroupsPayload,
  ProfilePlatform,
} from "../../lib/types";
import styles from "./dashboard.module.css";

const EMPTY_PAYLOAD: ProfileGroupsPayload = { groups: [], unlinkedProfiles: [] };

export function ProfileGroupManager({ apiBase }: { apiBase: string }) {
  const [profiles, setProfiles] = useState<ProfileGroupsPayload>(EMPTY_PAYLOAD);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [firstProfileUrl, setFirstProfileUrl] = useState("");
  const [secondProfileUrl, setSecondProfileUrl] = useState("");
  const [groupName, setGroupName] = useState("");
  const [mergeGroups, setMergeGroups] = useState(false);
  const [actionKey, setActionKey] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [renamingGroupId, setRenamingGroupId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [addingGroupId, setAddingGroupId] = useState<number | null>(null);
  const [additionalProfileUrl, setAdditionalProfileUrl] = useState("");
  const [mergeAdditionalGroup, setMergeAdditionalGroup] = useState(false);
  const [unlinkedTargets, setUnlinkedTargets] = useState<Record<number, string>>({});

  const loadProfiles = useCallback(async () => {
    try {
      setProfiles(await fetchProfileGroups(apiBase));
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, [apiBase]);

  useEffect(() => {
    if (!apiBase) return;
    const controller = new AbortController();
    void fetchProfileGroups(apiBase, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setProfiles(payload);
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoaded(true);
          setRefreshing(false);
        }
      });
    return () => controller.abort();
  }, [apiBase]);

  async function sendProfileMutation(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(payload.error || `Profile link update failed (${response.status})`);
    return payload;
  }

  async function submitProfileLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionKey) return;
    setActionKey("link");
    setActionError("");
    setActionMessage("");
    try {
      const requestedName = groupName.trim();
      await sendProfileMutation("/api/profile-groups", "POST", {
        profiles: [firstProfileUrl.trim(), secondProfileUrl.trim()],
        mergeGroups,
        ...(requestedName ? { name: requestedName } : {}),
      });
      setFirstProfileUrl("");
      setSecondProfileUrl("");
      setGroupName("");
      setMergeGroups(false);
      setLinkOpen(false);
      setActionMessage("Profiles linked. Rewind will now treat them as one creator.");
      await loadProfiles();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionKey("");
    }
  }

  function beginRename(group: CreatorProfileGroup) {
    setRenamingGroupId(group.id);
    setRenameValue(group.name);
    setAddingGroupId(null);
    setActionError("");
  }

  async function renameGroup(event: FormEvent<HTMLFormElement>, groupId: number) {
    event.preventDefault();
    if (actionKey) return;
    setActionKey(`rename:${groupId}`);
    setActionError("");
    setActionMessage("");
    try {
      await sendProfileMutation(`/api/profile-groups/${groupId}`, "PATCH", { name: renameValue.trim() });
      setRenamingGroupId(null);
      setActionMessage("Creator name updated.");
      await loadProfiles();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionKey("");
    }
  }

  function beginAddProfile(groupId: number) {
    setAddingGroupId(groupId);
    setAdditionalProfileUrl("");
    setMergeAdditionalGroup(false);
    setRenamingGroupId(null);
    setActionError("");
  }

  async function addProfile(event: FormEvent<HTMLFormElement>, groupId: number) {
    event.preventDefault();
    if (actionKey) return;
    setActionKey(`add:${groupId}`);
    setActionError("");
    setActionMessage("");
    try {
      await sendProfileMutation("/api/profile-groups", "POST", {
        groupId,
        profiles: [additionalProfileUrl.trim()],
        mergeGroups: mergeAdditionalGroup,
      });
      setAddingGroupId(null);
      setAdditionalProfileUrl("");
      setMergeAdditionalGroup(false);
      setActionMessage("Profile added to the linked creator.");
      await loadProfiles();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionKey("");
    }
  }

  async function unlinkProfile(group: CreatorProfileGroup, profile: PlatformProfile) {
    if (actionKey) return;
    setActionKey(`unlink:${profile.id}`);
    setActionError("");
    setActionMessage("");
    try {
      await sendProfileMutation(
        `/api/profile-groups/${group.id}/profiles/${profile.id}`,
        "DELETE",
      );
      setActionMessage(`${platformName(profile.platform)} @${profile.handle} is no longer linked.`);
      await loadProfiles();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionKey("");
    }
  }

  async function linkExistingProfile(profile: PlatformProfile) {
    const groupId = Number(unlinkedTargets[profile.id]);
    if (!groupId || actionKey) return;
    setActionKey(`existing:${profile.id}`);
    setActionError("");
    setActionMessage("");
    try {
      await sendProfileMutation("/api/profile-groups", "POST", {
        groupId,
        profiles: [profile.id],
      });
      setUnlinkedTargets((current) => {
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
      setActionMessage(`${platformName(profile.platform)} @${profile.handle} linked.`);
      await loadProfiles();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionKey("");
    }
  }

  return (
    <section className={styles.profileGroupsPanel} aria-labelledby="profile-groups-title">
      <div className={styles.profileGroupsHeading}>
        <div className={styles.profileGroupsTitle}>
          <span><Link2 size={18} /></span>
          <div>
            <h2 id="profile-groups-title">Cross-platform profile links</h2>
            <p>Connect TikTok, Instagram, and X profiles that belong to the same person.</p>
          </div>
        </div>
        <div className={styles.profileGroupsHeaderActions}>
          <button
            className={styles.profileRefreshButton}
            type="button"
            onClick={() => {
              setRefreshing(true);
              void loadProfiles();
            }}
            disabled={refreshing || Boolean(actionKey)}
            aria-label="Refresh cross-platform profile links"
          >
            <RefreshCw className={refreshing ? styles.spinning : undefined} size={15} />
          </button>
          <button
            className={styles.profileLinkButton}
            type="button"
            onClick={() => {
              setLinkOpen((current) => !current);
              setActionError("");
            }}
            aria-expanded={linkOpen}
          >
            {linkOpen ? <X size={15} /> : <Plus size={15} />}
            {linkOpen ? "Close" : "Link profiles"}
          </button>
        </div>
      </div>

      {linkOpen ? (
        <form className={styles.profileLinkForm} onSubmit={submitProfileLink}>
          <div className={styles.profileLinkFields}>
            <label className={styles.formField}>
              <span>First profile URL</span>
              <input
                type="url"
                inputMode="url"
                value={firstProfileUrl}
                onChange={(event) => setFirstProfileUrl(event.target.value)}
                placeholder="https://www.tiktok.com/@creator"
                required
              />
            </label>
            <label className={styles.formField}>
              <span>Second profile URL</span>
              <input
                type="url"
                inputMode="url"
                value={secondProfileUrl}
                onChange={(event) => setSecondProfileUrl(event.target.value)}
                placeholder="https://www.instagram.com/creator/"
                required
              />
            </label>
            <label className={styles.formField}>
              <span>Shared name <small>optional</small></span>
              <input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="Creator display name"
                maxLength={120}
              />
            </label>
          </div>
          <label className={styles.profileMergeChoice}>
            <input
              type="checkbox"
              checked={mergeGroups}
              onChange={(event) => setMergeGroups(event.target.checked)}
            />
            <span>Merge their existing creator groups if both profiles are already linked elsewhere.</span>
          </label>
          <div className={styles.profileFormFooter}>
            <p>Profiles are linked only when you submit this form; matching handles never link automatically.</p>
            <button className={styles.profileLinkButton} type="submit" disabled={Boolean(actionKey)}>
              {actionKey === "link" ? <LoaderCircle className={styles.spinning} size={15} /> : <Link2 size={15} />}
              {actionKey === "link" ? "Linking" : "Link profiles"}
            </button>
          </div>
        </form>
      ) : null}

      {actionError ? <p className={styles.profileActionError} role="alert">{actionError}</p> : null}
      {actionMessage ? <p className={styles.profileActionMessage} role="status">{actionMessage}</p> : null}
      {loadError ? (
        <div className={styles.profileLoadError} role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              void loadProfiles();
            }}
          >Retry</button>
        </div>
      ) : null}

      {!loaded && refreshing ? (
        <div className={styles.profileGroupsEmpty} role="status">
          <LoaderCircle className={styles.spinning} size={18} />
          <span>Loading profile links…</span>
        </div>
      ) : profiles.groups.length ? (
        <div className={styles.profileGroupList}>
          {profiles.groups.map((group) => (
            <article className={styles.profileGroupCard} key={group.id}>
              <div className={styles.profileGroupCardHeading}>
                {renamingGroupId === group.id ? (
                  <form onSubmit={(event) => void renameGroup(event, group.id)}>
                    <label>
                      <span className="sr-only">Creator group name</span>
                      <input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        required
                        maxLength={120}
                        autoFocus
                      />
                    </label>
                    <button type="submit" disabled={Boolean(actionKey)}>
                      {actionKey === `rename:${group.id}` ? <LoaderCircle className={styles.spinning} size={14} /> : "Save"}
                    </button>
                    <button type="button" onClick={() => setRenamingGroupId(null)}>Cancel</button>
                  </form>
                ) : (
                  <div>
                    <h3>{group.name || `Linked creator ${group.id}`}</h3>
                    <span>{group.memberCount} {group.memberCount === 1 ? "profile" : "profiles"}</span>
                  </div>
                )}
                {renamingGroupId !== group.id ? (
                  <button type="button" onClick={() => beginRename(group)} aria-label={`Rename ${group.name || `linked creator ${group.id}`}`}>
                    <Pencil size={14} /> Rename
                  </button>
                ) : null}
              </div>

              <ul className={styles.profileMemberList}>
                {group.members.map((profile) => (
                  <li key={profile.id}>
                    <ProfileIdentity profile={profile} />
                    <button
                      type="button"
                      onClick={() => void unlinkProfile(group, profile)}
                      disabled={Boolean(actionKey)}
                      aria-label={`Unlink ${platformName(profile.platform)} @${profile.handle} from ${group.name || "this creator"}`}
                    >
                      {actionKey === `unlink:${profile.id}`
                        ? <LoaderCircle className={styles.spinning} size={14} />
                        : <Unlink size={14} />}
                      Unlink
                    </button>
                  </li>
                ))}
              </ul>

              {addingGroupId === group.id ? (
                <form className={styles.profileAddForm} onSubmit={(event) => void addProfile(event, group.id)}>
                  <label className={styles.formField}>
                    <span>Profile URL to add</span>
                    <input
                      type="url"
                      inputMode="url"
                      value={additionalProfileUrl}
                      onChange={(event) => setAdditionalProfileUrl(event.target.value)}
                      placeholder="TikTok, Instagram, or X profile URL"
                      required
                      autoFocus
                    />
                  </label>
                  <label className={styles.profileMergeChoice}>
                    <input
                      type="checkbox"
                      checked={mergeAdditionalGroup}
                      onChange={(event) => setMergeAdditionalGroup(event.target.checked)}
                    />
                    <span>Merge its current creator group if it is already linked elsewhere.</span>
                  </label>
                  <div>
                    <button className={styles.profileLinkButton} type="submit" disabled={Boolean(actionKey)}>
                      {actionKey === `add:${group.id}` ? <LoaderCircle className={styles.spinning} size={14} /> : <Plus size={14} />}
                      Add profile
                    </button>
                    <button type="button" onClick={() => setAddingGroupId(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <button className={styles.profileAddButton} type="button" onClick={() => beginAddProfile(group.id)}>
                  <Plus size={14} /> Add another profile
                </button>
              )}
            </article>
          ))}
        </div>
      ) : loaded && !loadError ? (
        <div className={styles.profileGroupsEmpty}>
          <Link2 size={19} />
          <div>
            <strong>No cross-platform profiles are linked yet.</strong>
            <span>Use profile URLs to tell Rewind which accounts belong to one creator.</span>
          </div>
        </div>
      ) : null}

      {profiles.unlinkedProfiles.length ? (
        <div className={styles.unlinkedProfiles}>
          <div>
            <h3>Unlinked profiles</h3>
            <p>These profiles are known to the archive but are not assigned to a shared creator.</p>
          </div>
          <ul>
            {profiles.unlinkedProfiles.map((profile) => (
              <li key={profile.id}>
                <ProfileIdentity profile={profile} />
                <div className={styles.unlinkedProfileAction}>
                  <label>
                    <span className="sr-only">Creator group for {platformName(profile.platform)} @{profile.handle}</span>
                    <select
                      value={unlinkedTargets[profile.id] || ""}
                      onChange={(event) => setUnlinkedTargets((current) => ({
                        ...current,
                        [profile.id]: event.target.value,
                      }))}
                    >
                      <option value="">Choose linked creator</option>
                      {profiles.groups.map((group) => (
                        <option value={group.id} key={group.id}>{group.name || `Linked creator ${group.id}`}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void linkExistingProfile(profile)}
                    disabled={!unlinkedTargets[profile.id] || Boolean(actionKey)}
                  >
                    {actionKey === `existing:${profile.id}`
                      ? <LoaderCircle className={styles.spinning} size={14} />
                      : <Link2 size={14} />}
                    Link
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ProfileIdentity({ profile }: { profile: PlatformProfile }) {
  return (
    <div className={styles.profileIdentity}>
      <span data-platform={profile.platform}>{platformShortName(profile.platform)}</span>
      <div>
        <strong>{profile.displayName || `@${profile.handle}`}</strong>
        <a href={profile.profileUrl} target="_blank" rel="noreferrer">
          {platformName(profile.platform)} · @{profile.handle} <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}

function platformName(platform: ProfilePlatform) {
  if (platform === "tiktok") return "TikTok";
  if (platform === "instagram") return "Instagram";
  return "X";
}

function platformShortName(platform: ProfilePlatform) {
  if (platform === "tiktok") return "TT";
  if (platform === "instagram") return "IG";
  return "X";
}

async function fetchProfileGroups(apiBase: string, signal?: AbortSignal): Promise<ProfileGroupsPayload> {
  const response = await fetch(`${apiBase}/api/profile-groups`, {
    cache: "no-store",
    signal,
  });
  const payload = await response.json().catch(() => ({})) as Partial<ProfileGroupsPayload> & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Profile links failed (${response.status})`);
  return {
    groups: Array.isArray(payload.groups) ? payload.groups : [],
    unlinkedProfiles: Array.isArray(payload.unlinkedProfiles) ? payload.unlinkedProfiles : [],
  };
}
