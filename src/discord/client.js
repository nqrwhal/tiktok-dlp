import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { removeStoredFiles } from '../cleanup/downloads.js';
import { resolveDownloadSource } from '../download/service.js';
import {
  extractSupportedPlatformUrls,
  parseProfileReference,
  profileReferenceKey,
} from '../platforms/index.js';
import { normalizeUsername, shouldUploadToDiscord, makePublicFileUrl, randomToken } from '../util/files.js';
import {
  UI_COLORS,
  buildErrorPayload,
  buildNoticePayload,
  formatBytes,
  formatDate,
  formatExpiry,
  formatLinkState,
  truncateText,
} from './ui.js';

const LINK_BUTTON_PREFIX = 'link:';
const DOWNLOADS_BUTTON_PREFIX = 'downloads:list:';
const MONITOR_BUTTON_PREFIX = 'monitor:';
const MAX_MESSAGE_DOWNLOAD_URLS = 3;
const MAX_MESSAGE_URL_CANDIDATES = 25;
const DISCORD_MESSAGE_ATTACHMENT_BUDGET_BYTES = 24 * 1024 * 1024;
const INSTAGRAM_TRAY_RE = /^\/stories\/([A-Za-z0-9._]{1,30})\/?$/i;
const INSTAGRAM_TRAY_URL_RE = /^https:\/\/www\.instagram\.com\/stories\/([A-Za-z0-9._]{1,30})\/?$/i;
function isInstagramStoryTrayUrl(url) {
  try {
    const u = new URL(String(url));
    return /(^|\.)instagram\.com$/i.test(u.hostname) && INSTAGRAM_TRAY_RE.test(u.pathname) && !u.search && !u.hash;
  } catch { return false; }
}
function trayHandleFromUrl(url) {
  const m = String(url).match(INSTAGRAM_TRAY_URL_RE);
  return m ? m[1].toLowerCase() : '';
}
async function expandTrayUrls(urls, config) {
  const expanded = [];
  for (const url of urls) {
    if (isInstagramStoryTrayUrl(url)) {
      const handle = trayHandleFromUrl(url);
      try {
        const adapter = (await import('../platforms/index.js')).getPlatformAdapter('instagram');
        if (typeof adapter?.listCreatorStories === 'function') {
          const listing = await adapter.listCreatorStories(handle, { ...config, limit: 10 });
          const entries = Array.isArray(listing?.entries) ? listing.entries : [];
          if (entries.length) {
            for (const entry of entries) {
              const storyUrl = entry.webpage_url || entry.url || entry.source_url;
              if (storyUrl) expanded.push(storyUrl);
            }
            continue;
          }
        }
      } catch (e) {
        // fall through to treat tray as single URL (will error clearly)
      }
    }
    expanded.push(url);
  }
  return expanded;
}

export async function startDiscordBot({ config, store, monitor, downloadOne, registerCommands, downloadService = null }) {
  if (config.registerCommandsOnStart) {
    await registerCommands(config);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once('clientReady', () => {
    console.log(`[discord] Logged in as ${client.user.tag}`);
    monitor.start();
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isButton()) {
        const handled = await handleButtonInteraction({ interaction, config, store });
        if (!handled) {
          await interaction.reply(buildNoticePayload({
            title: 'Unknown Button',
            description: 'Unknown button action.',
            color: UI_COLORS.error,
          }));
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      await handleInteraction({ interaction, config, store, monitor, downloadOne, downloadService });
    } catch (error) {
      console.error('[discord] Interaction failed:', error);
      const payload = buildErrorPayload({
        description: `Something went wrong: ${error.message ?? error}`,
      });
      if (interaction.deferred || interaction.replied) {
        delete payload.ephemeral;
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  });

  client.on('messageCreate', async (message) => {
    try {
      await handleMessageCreate({ message, config, downloadOne });
    } catch (error) {
      console.error('[discord] Message handling failed:', error);
      await message.reply(buildErrorPayload({
        description: `Something went wrong: ${error.message ?? error}`,
        ephemeral: false,
      })).catch(() => {});
    }
  });

  await client.login(config.discordToken);
  return client;
}

export async function handleInteraction({ interaction, config, store, monitor, downloadOne, downloadService = null }) {
  const command = interaction.commandName;

  if (command === 'download') {
    await interaction.deferReply({ ephemeral: true });
    const rawUrl = interaction.options.getString('url', true);
    let url = rawUrl;
    // Tray expansion: if user pasted stories tray, expand to active stories
    if (isInstagramStoryTrayUrl(rawUrl) || isInstagramStoryTrayUrl(normalizeDownloadPostUrl(rawUrl))) {
      try {
        const canonical = normalizeDownloadPostUrl(rawUrl);
        const expanded = await expandTrayUrls([canonical], config);
        if (expanded.length > 1) {
          // Tray with multiple stories: download each sequentially
          const delivery = interaction.options.getString('delivery') ?? 'auto';
          const results = [];
          for (const storyUrl of expanded.slice(0, 5)) {
            const r = await downloadOne(storyUrl, {
              delivery,
              type: 'manual',
              requestedBy: interaction.user?.id ?? '',
              guildId: interaction.guildId ?? '',
              channelId: interaction.channelId ?? '',
            });
            results.push(r);
          }
          // Send first result via existing fallback, additional via followups
          const payload = await buildDeliveryPayload(results[0], config, delivery);
          await sendDeliveryWithLinkFallback({
            send: (candidate) => interaction.editReply(candidate),
            payload,
            result: results[0],
            config,
          });
          for (let i = 1; i < results.length; i++) {
            const p2 = await buildDeliveryPayload(results[i], config, delivery);
            await sendDeliveryWithLinkFallback({
              send: (candidate) => interaction.followUp(candidate),
              payload: p2,
              result: results[i],
              config,
            });
          }
          return;
        }
        url = expanded[0] ?? normalizeDownloadPostUrl(rawUrl);
      } catch {}
      url = normalizeDownloadPostUrl(url);
    } else {
      url = normalizeDownloadPostUrl(rawUrl);
    }
    const delivery = interaction.options.getString('delivery') ?? 'auto';
    const result = await downloadOne(url, {
      delivery,
      type: 'manual',
      requestedBy: interaction.user?.id ?? '',
      guildId: interaction.guildId ?? '',
      channelId: interaction.channelId ?? '',
    });
    const payload = await buildDeliveryPayload(result, config, delivery);
    await sendDeliveryWithLinkFallback({
      send: (candidate) => interaction.editReply(candidate),
      payload,
      result,
      config,
    });
    return;
  }

  if (command === 'watch') {
    const subcommand = interaction.options.getSubcommand();
    if (!canManageWatches(interaction, config)) {
      await interaction.reply(buildNoticePayload({
        title: 'Permission Required',
        description: 'Watch controls require Manage Server, the configured watch-manager role, or the bot owner account.',
        color: UI_COLORS.error,
      }));
      return;
    }
    const scope = watchScopeFromInteraction(interaction, config);
    if (subcommand === 'add') {
      const username = normalizeUsername(interaction.options.getString('username', true));
      const platform = normalizePlatformInput(interaction.options.getString('platform') ?? 'tiktok');
      const scopeWithPlatform = { ...scope, platform };
      const watch = store.addWatch(username, scopeWithPlatform);
      await interaction.reply(buildNoticePayload({
        title: 'Watch Added',
        description: `Watching @${watch.username} on ${formatPlatformLabel(watch.platform)}. Alerts will post in this channel.`,
      }));
      return;
    }
    if (subcommand === 'remove') {
      const username = normalizeUsername(interaction.options.getString('username', true));
      const platform = normalizePlatformInput(interaction.options.getString('platform') ?? 'tiktok');
      const scopeWithPlatform = { ...scope, platform };
      const removed = store.removeWatch(username, scopeWithPlatform);
      await interaction.reply(buildNoticePayload({
        title: removed ? 'Watch Removed' : 'Watch Not Found',
        description: removed ? `Stopped watching @${username} on ${formatPlatformLabel(platform)}.` : `@${username} on ${formatPlatformLabel(platform)} was not watched.`,
      }));
      return;
    }
    if (subcommand === 'list') {
      const platformFilter = interaction.options.getString('platform') ?? 'all';
      const watches = platformFilter && platformFilter !== 'all'
        ? (store.listWatchesForScope?.({ ...scope, platform: platformFilter }) ?? store.listWatches({ platform: platformFilter }))
        : (store.listWatchesForScope?.(scope) ?? store.listWatches());
      await interaction.reply(buildNoticePayload({
        title: platformFilter && platformFilter !== 'all' ? `Watched ${formatPlatformLabel(platformFilter)} Usernames` : 'Watched Usernames',
        description: formatWatchList(watches),
      }));
      return;
    }
    if (subcommand === 'failures') {
      const usernameInput = interaction.options.getString('username') ?? '';
      const username = usernameInput ? normalizeUsername(usernameInput) : '';
      const platformFilter = interaction.options.getString('platform') ?? '';
      const failures = store.listMonitorDownloadFailuresForScope?.({
        ...scope,
        username,
        platform: platformFilter || undefined,
        limit: 10,
      }) ?? [];
      const filtered = platformFilter && platformFilter !== 'all'
        ? failures.filter((f) => (f.platform ?? 'tiktok') === normalizePlatformInput(platformFilter))
        : failures;
      await interaction.reply(buildNoticePayload({
        title: username ? `Monitor Failures for @${username}` : `Monitor Failures${platformFilter ? ` — ${formatPlatformLabel(platformFilter)}` : ''}`,
        description: formatMonitorFailureList(filtered),
        color: filtered.length ? UI_COLORS.warning : UI_COLORS.info,
      }));
      return;
    }
    if (subcommand === 'retry') {
      const videoId = String(interaction.options.getString('post_id', true) ?? '').trim();
      const failure = store.getMonitorDownloadFailure?.(videoId) ?? null;
      if (!failure || !store.hasWatchSubscription?.(failure.username, { ...scope, platform: failure.platform ?? 'tiktok' })) {
        await interaction.reply(buildNoticePayload({
          title: 'Monitor Failure Not Found',
          description: 'That post is not awaiting retry for a watch in this server or DM.',
          color: UI_COLORS.error,
        }));
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const result = await monitor.retryFailedVideo(videoId);
      if (!result?.accepted) {
        await interaction.editReply(buildNoticePayload({
          title: 'Retry Not Available',
          description: result?.reason === 'not_retryable'
            ? `Post ${videoId} is no longer dead-lettered or another retry is already running.`
            : `Post ${videoId} could not be queued for retry.`,
          color: UI_COLORS.warning,
          ephemeral: false,
        }));
        return;
      }

      if (result.completed) {
        await interaction.editReply(buildNoticePayload({
          title: 'Monitor Retry Succeeded',
          description: `Downloaded ${formatPlatformLabel(failure.platform ?? 'tiktok')} post ${videoId} for @${failure.username} and delivered its current watch alerts.`,
          color: UI_COLORS.success,
          ephemeral: false,
        }));
        return;
      }

      const retryError = result.error || result.failure?.last_error || 'The retry did not complete.';
      await interaction.editReply(buildNoticePayload({
        title: 'Monitor Retry Failed',
        description: `${formatPlatformLabel(failure.platform ?? 'tiktok')} post ${videoId} remains available in \`/watch failures\`.\n${truncateText(retryError, 500)}`,
        color: UI_COLORS.error,
        ephemeral: false,
      }));
      return;
    }
    if (subcommand === 'run') {
      await interaction.deferReply({ ephemeral: true });
      const username = normalizeUsername(interaction.options.getString('username', true));
      const platform = normalizePlatformInput(interaction.options.getString('platform') ?? 'tiktok');
      const scopeWithPlatform = { ...scope, platform };
      if (!store.hasWatchSubscription?.(username, scopeWithPlatform)) {
        await interaction.editReply(buildNoticePayload({
          title: 'Watch Not Found',
          description: `@${username} on ${formatPlatformLabel(platform)} is not registered for this server or DM. Add the watch before running it.`,
          ephemeral: false,
        }));
        return;
      }
      const result = await monitor.pollUsername(username, { force: true, platform });
      await interaction.editReply(buildNoticePayload({
        title: 'Watch Check Complete',
        description: `Checked ${formatPlatformLabel(platform)} @${username}: ${result.newVideos ?? 0} new post(s), ${result.skipped ?? 0} already seen.`,
        ephemeral: false,
      }));
      return;
    }
  }

  if (command === 'profiles') {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== 'show' && !canManageProfiles(interaction, config)) {
      await interaction.reply(buildNoticePayload({
        title: 'Permission Required',
        description: 'Profile links are archive-wide, so only the configured bot owner can change them.',
        color: UI_COLORS.error,
      }));
      return;
    }

    if (subcommand === 'link') {
      const primary = parseSupportedProfileUrl(interaction.options.getString('primary', true));
      const secondary = parseSupportedProfileUrl(interaction.options.getString('secondary', true));
      if (profileReferenceKey(primary) === profileReferenceKey(secondary)) {
        throw new Error('Choose two different platform profiles to link.');
      }

      const profiles = [primary, secondary].map((reference) => store.upsertPlatformProfile(
        storedProfileFromReference(reference),
      ));
      const groupName = String(interaction.options.getString('name') ?? '').trim();
      const mergeGroups = interaction.options.getBoolean?.('merge') === true;
      const group = store.linkCreatorProfiles(profiles.map((profile) => profile.id), {
        mergeGroups,
        ...(groupName ? { groupName } : {}),
      });
      const members = group.members ?? store.listCreatorGroupMembers(group.id);
      await interaction.reply(buildNoticePayload({
        title: 'Profiles Linked',
        description: formatCreatorGroup(group, members),
        color: UI_COLORS.success,
      }));
      return;
    }

    const reference = parseSupportedProfileUrl(interaction.options.getString('profile', true));
    const lookup = profileLookupFromReference(reference);
    if (subcommand === 'show') {
      const group = store.getCreatorGroupForProfile(lookup);
      if (!group) {
        await interaction.reply(buildNoticePayload({
          title: 'Profile Not Linked',
          description: `${formatPlatformProfile(reference)} is not linked to a creator group. Matching handles are never linked automatically.`,
        }));
        return;
      }
      await interaction.reply(buildNoticePayload({
        title: 'Linked Profiles',
        description: formatCreatorGroup(group, store.listCreatorGroupMembers(group.id)),
      }));
      return;
    }

    if (subcommand === 'unlink') {
      const unlinked = store.unlinkProfile(lookup);
      await interaction.reply(buildNoticePayload({
        title: unlinked ? 'Profile Unlinked' : 'Profile Not Linked',
        description: unlinked
          ? `Removed ${formatPlatformProfile(reference)} from its creator group. Saved media and TikTok watches were not changed.`
          : `${formatPlatformProfile(reference)} was not linked to a creator group.`,
        color: unlinked ? UI_COLORS.success : UI_COLORS.info,
      }));
      return;
    }
  }

  if (command === 'status') {
    await interaction.reply({ embeds: [buildStatusEmbed(store.stats(), monitor.status(), downloadService?.status?.())], ephemeral: true });
    return;
  }

  if (command === 'history') {
    const history = store.listLinkHistoryByRequester(interaction.user?.id ?? '', {
      limit: 10,
      includeMonitored: true,
      scopeId: monitorScopeId(interaction),
    });
    await interaction.reply({
      embeds: [buildLinkHistoryEmbed(history, { config })],
      ephemeral: true,
    });
    return;
  }

  if (command === 'downloads') {
    await handleDownloadsInteraction({ interaction, config, store });
  }
}

export async function handleMessageCreate({ message, config, downloadOne }) {
  if (shouldIgnoreMessage(message)) return false;

  if (shouldShowHelp(message)) {
    await message.reply(buildHelpMessage());
    return true;
  }

  const rawUrls = extractDownloadPostUrls(message.content, MAX_MESSAGE_URL_CANDIDATES);
  const urls = (await expandTrayUrls(rawUrls, config)).slice(0, MAX_MESSAGE_DOWNLOAD_URLS);
  if (!urls.length) return false;

  const status = await message.reply(buildNoticePayload({
    title: 'Downloading',
    description: urls.length === 1
      ? 'Downloading media link...'
      : `Downloading ${urls.length} media links...`,
    color: UI_COLORS.warning,
    ephemeral: false,
  }));

  for (const [index, url] of urls.entries()) {
    try {
      const result = await downloadOne(url, {
        delivery: 'auto',
        type: 'message',
        requestedBy: message.author?.id ?? '',
        guildId: message.guildId ?? '',
        channelId: message.channelId ?? '',
      });
      const payload = await buildDeliveryPayload(result, config, 'auto');

      if (urls.length === 1) {
        await sendDeliveryWithLinkFallback({
          send: (candidate) => status.edit(candidate),
          payload,
          result,
          config,
        });
      } else {
        await status.edit(buildNoticePayload({
          title: 'Downloading',
          description: `Downloaded ${index + 1}/${urls.length} media links.`,
          color: UI_COLORS.warning,
          ephemeral: false,
        }));
        await sendDeliveryWithLinkFallback({
          send: (candidate) => message.reply(candidate),
          payload,
          result,
          config,
        });
      }
    } catch (error) {
      const payload = buildErrorPayload({
        title: 'Download Failed',
        description: `Could not download ${url}: ${error.message ?? error}`,
        ephemeral: false,
      });
      if (urls.length === 1) {
        await status.edit({ ...payload, components: [], files: [] });
      } else {
        await message.reply(payload);
      }
    }
  }

  return true;
}

export function normalizeDownloadPostUrl(value) {
  return resolveDownloadSource(value).canonicalUrl;
}

export function parseSupportedProfileUrl(value) {
  const reference = parseProfileReference(value);
  if (!reference) {
    throw new Error('A credential-free HTTPS TikTok, Instagram, or X profile URL is required.');
  }
  return reference;
}

export function extractDownloadPostUrls(value, limit = MAX_MESSAGE_DOWNLOAD_URLS) {
  const maximum = Math.max(0, Math.min(
    MAX_MESSAGE_URL_CANDIDATES,
    Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : MAX_MESSAGE_DOWNLOAD_URLS,
  ));
  if (maximum === 0) return [];

  const urls = [];
  const seen = new Set();
  for (const candidate of extractSupportedPlatformUrls(value, MAX_MESSAGE_URL_CANDIDATES)) {
    // Allow Instagram story tray URLs to pass through for expansion even though they are not single-post URLs
    if (isInstagramStoryTrayUrl(candidate)) {
      const canonical = candidate.replace(/\/+$/, '') + '/';
      const m = String(canonical).match(INSTAGRAM_TRAY_URL_RE);
      const trayCanonical = m ? `https://www.instagram.com/stories/${m[1].toLowerCase()}/` : canonical;
      if (seen.has(trayCanonical)) continue;
      seen.add(trayCanonical);
      urls.push(trayCanonical);
      if (urls.length >= maximum) break;
      continue;
    }
    let source;
    try {
      source = resolveDownloadSource(candidate);
    } catch {
      continue;
    }
    if (seen.has(source.canonicalUrl)) continue;
    seen.add(source.canonicalUrl);
    urls.push(source.canonicalUrl);
    if (urls.length >= maximum) break;
  }
  return urls;
}

export function shouldIgnoreMessage(message) {
  if (!message) return true;
  const authorId = message.author?.id;
  const botId = message.client?.user?.id;
  return Boolean(
    message.author?.bot
      || message.system
      || message.webhookId
      || (authorId && botId && authorId === botId),
  );
}

export function shouldShowHelp(message) {
  const content = String(message?.content ?? '').trim();
  if (!content) return false;

  const normalized = content.toLowerCase();
  const directHelp = [
    'help',
    'commands',
    'media help',
    '!media help',
    'download help',
    '!download help',
    'tiktok help',
    '!tiktok help',
    'tt help',
    '!tt help',
  ].includes(normalized);
  const inGuild = message?.inGuild?.() ?? Boolean(message?.guildId);
  if (!inGuild) return directHelp;
  if (/^!?(media|download|tiktok|tt)\s+help$/i.test(content)) return true;

  const botId = message?.client?.user?.id;
  if (!botId) return false;
  const mentionPattern = new RegExp(`^<@!?${botId}>\\s+help$`, 'i');
  return mentionPattern.test(content);
}

export function buildHelpMessage() {
  return buildNoticePayload({
    title: 'Media Downloader Help',
    description: [
      'Post a TikTok, Instagram, or X post URL, or a TikTok/Instagram Story URL, in any channel I can read or DM it to me, and I will save its media.',
      '',
      'Slash commands:',
      '`/download url:<post-or-story-url> delivery:auto|file|link`',
      '`/downloads list`',
      '`/downloads purge scope:mine confirm:PURGE`',
      '`/profiles link|show|unlink` (explicit cross-platform creator links)',
      '`/watch add|remove|list|run|failures|retry` (TikTok profiles only for now)',
      '`/status` and `/history`',
      '',
      'Help keywords: `media help`, `download help`, or DM me `help`.',
    ].join('\n'),
    ephemeral: false,
  });
}

export async function handleDownloadsInteraction({ interaction, config, store }) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'list') {
    const limit = interaction.options.getInteger('limit') ?? 10;
    const userId = interaction.user?.id ?? '';
    const usernameInput = interaction.options.getString('username') ?? '';
    const username = usernameInput ? normalizeUsername(usernameInput) : '';
    await interaction.reply(buildDownloadsListPayload({
      config,
      store,
      userId,
      scopeId: monitorScopeId(interaction),
      limit,
      page: 0,
      username,
    }));
    return;
  }

  if (subcommand === 'purge') {
    const scope = interaction.options.getString('scope') === 'all' ? 'all' : 'mine';
    const confirm = interaction.options.getString('confirm', true);

    if (confirm !== 'PURGE') {
      await interaction.reply(buildNoticePayload({
        title: 'Purge Cancelled',
        description: 'Run it again with `confirm:PURGE`.',
      }));
      return;
    }

    if (scope === 'all' && !canPurgeAll(interaction, config)) {
      await interaction.reply(buildNoticePayload({
        title: 'Permission Required',
        description: 'Only the configured bot owner can purge downloads across the entire archive.',
        color: UI_COLORS.error,
      }));
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const requestedBy = scope === 'mine' ? interaction.user?.id ?? '' : '';
    const files = store.listPurgePlan?.({ requestedBy }) ?? store.listFilesForPurge({ requestedBy });
    const protectedPaths = protectedDownloadPaths(store, files, config);
    const removal = await removeStoredFiles(files, config, { protectedPaths });
    for (const failure of removal.failed) {
      store.markFileDeletionFailed?.(failure.file.id, failure.error);
    }
    const failedIds = new Set(removal.failed.map((failure) => failure.file.id));
    const removableFileIds = files.filter((file) => !failedIds.has(file.id)).map((file) => file.id);
    const counts = store.purgeDownloads({ requestedBy, removeFileIds: removableFileIds });
    await interaction.editReply(buildNoticePayload({
      title: 'Downloads Purged',
      description: formatPurgeResult({ scope, counts, removal }),
      ephemeral: false,
    }));
  }
}

export async function handleButtonInteraction({ interaction, config, store }) {
  const customId = String(interaction.customId ?? '');
  if (customId.startsWith(LINK_BUTTON_PREFIX)) {
    return handleLinkButton({ interaction, config, store });
  }
  if (customId.startsWith(DOWNLOADS_BUTTON_PREFIX)) {
    return handleDownloadsListButton({ interaction, config, store });
  }
  if (customId.startsWith(MONITOR_BUTTON_PREFIX)) {
    return handleMonitorButton({ interaction, config, store });
  }
  return false;
}

export function isDiscordEntityTooLarge(error) {
  const code = Number(error?.code);
  const status = Number(error?.status ?? error?.statusCode);
  const message = String(error?.message ?? error ?? '');
  return code === 40005
    || code === 50045
    || status === 413
    || /entity too large|payload too large|file uploaded exceeds/i.test(message);
}

async function sendDeliveryWithLinkFallback({ send, payload, result, config }) {
  try {
    return await send(payload);
  } catch (error) {
    if (!isDiscordEntityTooLarge(error) || !payload.files?.length) throw error;
    console.warn(
      `[discord] Manual attachment payload was too large for ${result?.videoId || 'unknown'}; sending link-only.`,
    );
    return send(await buildDeliveryPayload(result, config, 'link'));
  }
}

export async function sendVideoAlert({ client, config, result, video, watch }) {
  const channelId = watch?.channel_id || config.discordChannelId;
  const channel = await client.channels.fetch(channelId);
  const payload = await buildMonitorAlertPayload(result, config, {
    video,
    watch,
    now: Date.now(),
  });
  try {
    await channel.send(payload);
  } catch (error) {
    if (!isDiscordEntityTooLarge(error) || !payload.files?.length) throw error;
    console.warn(
      `[discord] Attachment too large for ${video?.id || result?.videoId || 'unknown'} (${Number(result?.sizeBytes || 0)} bytes); sending link-only.`,
    );
    await channel.send({ ...payload, files: [] });
  }
}

export async function sendDeletionAlert({ client, config, video, watch, reason = '' }) {
  const channelId = watch?.channel_id || config.discordChannelId;
  const channel = await client.channels.fetch(channelId);
  const sourceUrl = video?.source_url || video?.sourceUrl || '';
  const savedLink = video?.permanent_token ? makePublicFileUrl(config, video.permanent_token) : '';
  const embed = new EmbedBuilder()
    .setColor(UI_COLORS.warning)
    .setTitle('Monitored Post Deleted')
    .setDescription(truncateText([
      video?.title || video?.filename || video?.video_id || 'A monitored TikTok post',
      reason ? `Reason: ${reason}` : '',
    ].filter(Boolean).join('\n'), 4000))
    .addFields(
      { name: 'Creator', value: video?.username ? `@${video.username}` : '@unknown', inline: true },
      { name: 'Post', value: video?.video_id || 'unknown', inline: true },
      { name: 'Saved Copy', value: savedLink || 'Saved locally; no permanent link was found.', inline: false },
    )
    .setTimestamp(new Date());
  if (sourceUrl) embed.setURL(sourceUrl);
  await channel.send({ embeds: [embed] });
}

export async function sendUsernameChangeAlert({ client, config, change, watch }) {
  const channelId = watch?.channel_id || config.discordChannelId;
  const channel = await client.channels.fetch(channelId);
  const embed = new EmbedBuilder()
    .setColor(UI_COLORS.info)
    .setTitle('Watched Username Changed')
    .setDescription(`@${change.previousUsername} is now @${change.username}.`)
    .setTimestamp(new Date());
  if (change.creatorId) {
    embed.addFields({ name: 'Creator ID', value: truncateText(change.creatorId, 100), inline: true });
  }
  await channel.send({ embeds: [embed] });
}

export async function buildMonitorAlertPayload(result, config, { video = {}, watch = {}, now = Date.now() } = {}) {
  const username = watch?.username || result?.username || video?.username || video?.uploader || 'unknown';
  const sourceUrl = result?.sourceUrl || video?.sourceUrl || video?.url || video?.webpage_url || '';
  const attachments = await planAttachments(result, config);
  const fields = [
    {
      name: 'Type',
      value: formatMediaTypeLabel(result, video),
      inline: true,
    },
    {
      name: 'Size',
      value: formatBytes(result?.sizeBytes || 0),
      inline: true,
    },
    {
      name: 'Duration',
      value: formatDuration(result?.duration ?? video?.duration),
      inline: true,
    },
  ];

  if (result?.reused) {
    fields.push({ name: 'Cache', value: 'Delivered from cache.', inline: true });
  }

  if (result?.mediaType === 'slideshow') {
    fields.push({
      name: 'Slideshow',
      value: formatSlideshowAlertNote(attachments),
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(UI_COLORS.success)
    .setTitle(buildMonitorAlertTitle(username, result, video, now))
    .setTimestamp(new Date(now))
    .setFooter({ text: `${result?.videoId || video?.id || 'unknown'} - ${formatBytes(result?.sizeBytes || 0)}` })
    .addFields(...fields);

  const description = truncateText(result?.title || video?.title || result?.description || '', 4000);
  if (description) embed.setDescription(description);
  if (sourceUrl) embed.setURL(sourceUrl);
  if (result?.thumbnailUrl || video?.thumbnail) embed.setThumbnail(result.thumbnailUrl || video.thumbnail);

  return {
    embeds: [embed],
    files: attachments.files,
    components: buildMonitorActionRows(result, config),
  };
}

export async function buildDeliveryPayload(result, config, requestedDelivery = 'auto', options = {}) {
  const canUpload = await canUploadResult(result, config);
  const wantsFile = requestedDelivery === 'file' || (requestedDelivery === 'auto' && canUpload && !result.reused);
  const attachments = wantsFile
    ? await planAttachments(result, config)
    : {
      kind: 'none',
      reason: result.reused ? 'reused-auto' : 'link-only',
      files: [],
      mode: 'link',
      imageCount: Number(result.imageCount ?? 0),
      assetCount: contentMediaAssets(result).length,
    };
  const embed = buildStandardDownloadEmbed(result, config, {
    video: options.video,
    attachmentPlan: attachments,
    now: options.now ?? Date.now(),
  });

  return {
    embeds: [embed],
    files: attachments.files,
    components: buildLinkManagementRows(result.token, config),
  };
}

export async function handleMonitorButton({ interaction, config, store }) {
  const customId = String(interaction.customId ?? '');
  if (!customId.startsWith(MONITOR_BUTTON_PREFIX)) return false;

  const [, action, token] = customId.split(':');
  if (action !== 'delete' || !token) {
    await interaction.reply(buildNoticePayload({
      title: 'Unknown Monitor Action',
      description: 'Unknown monitored post action.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  if (!canDeleteMonitorPost(interaction)) {
    await interaction.reply(buildNoticePayload({
      title: 'Permission Required',
      description: 'Only members with Manage Messages or Manage Server can delete monitored saved posts.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  const record = store.getMonitorFileByToken?.(token);
  if (!record) {
    await interaction.reply(buildNoticePayload({
      title: 'Saved Post Not Found',
      description: 'I cannot find a monitored saved post for that button anymore.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  if (!monitorScopeMatches(record.scope_id, interaction)) {
    await interaction.reply(buildNoticePayload({
      title: 'Wrong Watch Scope',
      description: 'This monitored delivery belongs to a different server or DM.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  const deletion = store.planDeliveryDeletion?.(token);
  const removal = deletion?.file
    ? await removeStoredFiles([deletion.file], config, {
      protectedPaths: protectedDownloadPaths(store, [deletion.file], config),
    })
    : { deleted: 0, failed: [] };
  if (removal.failed.length) {
    for (const failure of removal.failed) {
      store.markFileDeletionFailed?.(failure.file.id, failure.error);
    }
    await interaction.reply(buildNoticePayload({
      title: 'Delete Failed',
      description: 'The saved file could not be removed from disk, so I left its database records intact.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  const counts = store.deleteDeliveryToken?.(token, { deleteFile: Boolean(deletion?.file) }) ?? { files: 0, links: 0, jobs: 0 };
  await acknowledgeMonitorDelete(interaction, buildNoticePayload({
    title: counts.links ? 'Monitored Delivery Deleted' : 'Saved Post Not Found',
    description: counts.links
      ? counts.files
        ? `Deleted ${record.filename || 'the saved post'} from this server.`
        : 'Removed this monitored delivery. The shared saved asset is still retained by another active link.'
      : 'That monitored saved post had already been deleted.',
  }));
  return true;
}

export async function handleLinkButton({ interaction, config, store }) {
  const customId = String(interaction.customId ?? '');
  if (!customId.startsWith(LINK_BUTTON_PREFIX)) return false;

  const [, action, token] = customId.split(':');
  if (!token) {
    await interaction.reply(buildNoticePayload({
      title: 'Missing Token',
      description: 'That link action is missing its token.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  const record = store.getToken(token);
  if (!record) {
    await interaction.reply(buildNoticePayload({
      title: 'Download Not Found',
      description: 'I cannot find that download anymore.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  if (!canManageLink(record, interaction, config)) {
    await interaction.reply(buildNoticePayload({
      title: 'Permission Required',
      description: 'Only the person who requested this download, a server manager, or the bot owner can change its retention.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  if (action === 'new') {
    const newToken = randomToken();
    const expiresAt = Date.now() + downloadLinkTtlMs(config);
    store.createLinkToken({
      token: newToken,
      fileId: record.id,
      jobId: record.job_id,
      ownerId: record.owner_id,
      scopeId: record.scope_id,
      deliveryType: record.delivery_type,
      expiresAt,
    });
    await interaction.reply(buildNoticePayload({
      title: `New ${formatTtlLong(config)} Link`,
      description: makePublicFileUrl(config, newToken),
    }));
    return true;
  }

  if (action === 'extend') {
    const updated = store.extendLinkToken(token, downloadLinkTtlMs(config));
    await interaction.reply(buildNoticePayload({
      title: updated?.expires_at === 0 ? 'Permanent Link' : 'Link Extended',
      description: updated?.expires_at === 0
        ? `This link is already permanent: ${makePublicFileUrl(config, token)}`
        : `Extended by ${formatTtlLong(config)}. New expiry: ${formatExpiry(updated?.expires_at)}\n${makePublicFileUrl(config, token)}`,
    }));
    return true;
  }

  if (action === 'permanent') {
    store.setLinkTokenPermanent(token);
    await interaction.reply(buildNoticePayload({
      title: 'Kept On Server',
      description: `Permanent link kept: ${makePublicFileUrl(config, token)}`,
    }));
    return true;
  }

  await interaction.reply(buildNoticePayload({
    title: 'Unknown Action',
    description: 'Unknown link action.',
    color: UI_COLORS.error,
  }));
  return true;
}

async function handleDownloadsListButton({ interaction, config, store }) {
  const parsed = parseDownloadsListCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply(buildNoticePayload({
      title: 'Invalid List Action',
      description: 'That downloads list action is invalid.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  if (parsed.userId !== String(interaction.user?.id ?? '')) {
    await interaction.reply(buildNoticePayload({
      title: 'Not Your List',
      description: 'Only the user who opened this list can page through it.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  const payload = buildDownloadsListPayload({
    config,
    store,
    userId: parsed.userId,
    scopeId: monitorScopeId(interaction),
    limit: parsed.limit,
    page: parsed.page,
    username: parsed.username,
  });
  delete payload.ephemeral;
  await interaction.update(payload);
  return true;
}

export function buildDownloadsListPayload({ config, store, userId, scopeId = '', limit = 10, page = 0, username = '' }) {
  const pageSize = Math.max(1, Math.min(25, Number(limit) || 10));
  const currentPage = Math.max(0, Number(page) || 0);
  const listOptions = {
    limit: pageSize,
    offset: currentPage * pageSize,
    includeMonitored: true,
    scopeId,
    username,
  };
  const links = store.listPermanentDownloadsByRequester(userId, listOptions);
  const total = store.countPermanentDownloadsByRequester(userId, listOptions);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(currentPage, pageCount - 1);

  if (clampedPage !== currentPage) {
    return buildDownloadsListPayload({ config, store, userId, scopeId, limit: pageSize, page: clampedPage, username });
  }

  return {
    embeds: [buildDownloadsListEmbed(links, {
      config,
      total,
      page: clampedPage,
      pageSize,
      username,
    })],
    components: buildDownloadsPaginationRows({
      userId,
      limit: pageSize,
      page: clampedPage,
      pageCount,
      username,
    }),
    ephemeral: true,
  };
}

function buildLinkManagementRows(token, config = {}) {
  if (!token) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${LINK_BUTTON_PREFIX}new:${token}`)
        .setLabel(`New ${formatTtlShort(config)} link`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${LINK_BUTTON_PREFIX}extend:${token}`)
        .setLabel(`Extend ${formatTtlShort(config)}`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${LINK_BUTTON_PREFIX}permanent:${token}`)
        .setLabel('Keep on server')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

function buildDownloadsPaginationRows({ userId, limit, page, pageCount, username = '' }) {
  if (pageCount <= 1) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(makeDownloadsListCustomId({ userId, limit, page: Math.max(0, page - 1), username }))
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(makeDownloadsListCustomId({ userId, limit, page: page + 1, username }))
        .setLabel('Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page >= pageCount - 1),
    ),
  ];
}

export function buildDownloadsListEmbed(links, { config, total, page, pageSize, username = '' }) {
  const title = username ? `Saved Downloads for @${username}` : 'Saved Downloads';
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const embed = new EmbedBuilder()
    .setColor(UI_COLORS.info)
    .setTitle(title)
    .setFooter({ text: `Page ${page + 1} of ${pageCount} - ${total} saved download${total === 1 ? '' : 's'}` })
    .setTimestamp(new Date());

  if (!links.length) {
    embed.setDescription(username
      ? `No permanent downloads saved for @${username}. Use Keep on server to save one.`
      : 'No permanent downloads saved yet. Use Keep on server to save one.');
    return embed;
  }

  embed.addFields(...links.slice(0, 25).map((link, index) => {
    const ordinal = page * pageSize + index + 1;
    const title = truncateText(link.title || link.filename || link.source_url || 'download', 90);
    const user = link.username ? `@${truncateText(link.username, 32)}` : '@unknown';
    const platform = archivePlatformLabel(link.platform);
    const url = makePublicFileUrl(config, link.token) || 'PUBLIC_BASE_URL is not configured.';
    const postId = link.video_id ? `post: ${truncateText(link.video_id, 64)}` : '';
    return {
      name: truncateText(`${ordinal}. [${platform}] ${user} - ${title}`, 256),
      value: truncateText([
        url,
        [
          `saved: ${formatDate(link.token_created_at)}`,
          formatBytes(link.size_bytes),
          postId,
        ].filter(Boolean).join(' - '),
      ].join('\n'), 420),
    };
  }));

  return embed;
}

export function buildLinkHistoryEmbed(history, { config, now = Date.now() }) {
  const embed = new EmbedBuilder()
    .setColor(UI_COLORS.info)
    .setTitle('Download Link History')
    .setTimestamp(new Date());

  if (!history.length) {
    embed.setDescription('No download links found yet.');
    return embed;
  }

  embed.addFields(...history.slice(0, 10).map((entry, index) => {
    const title = truncateText(entry.title || entry.filename || entry.source_url || 'download', 90);
    const user = entry.username ? `@${truncateText(entry.username, 32)}` : '@unknown';
    const platform = archivePlatformLabel(entry.platform);
    const url = makePublicFileUrl(config, entry.token) || 'PUBLIC_BASE_URL is not configured.';
    const status = entry.job_status ? `job: ${entry.job_status}` : '';
    const postId = entry.video_id ? `post: ${truncateText(entry.video_id, 64)}` : '';
    return {
      name: truncateText(`${index + 1}. [${platform}] ${user} - ${title}`, 256),
      value: truncateText([
        url,
        [
          formatLinkState(entry.expires_at, now),
          `created: ${formatDate(entry.token_created_at)}`,
          formatBytes(entry.size_bytes),
          status,
          postId,
        ].filter(Boolean).join(' - '),
      ].join('\n'), 520),
    };
  }));

  return embed;
}

function archivePlatformLabel(value) {
  const platform = String(value || 'tiktok').toLowerCase();
  if (platform === 'instagram') return 'Instagram';
  if (platform === 'x' || platform === 'twitter') return 'X';
  if (platform === 'tiktok') return 'TikTok';
  return 'Unknown';
}

function makeDownloadsListCustomId({ userId, limit, page, username = '' }) {
  return `${DOWNLOADS_BUTTON_PREFIX}${encodeURIComponent(String(userId))}:${limit}:${page}:${encodeURIComponent(username)}`;
}

function parseDownloadsListCustomId(customId) {
  const text = String(customId ?? '');
  if (!text.startsWith(DOWNLOADS_BUTTON_PREFIX)) return null;
  const rest = text.slice(DOWNLOADS_BUTTON_PREFIX.length);
  const [encodedUserId, limit, page, encodedUsername = ''] = rest.split(':');
  if (!encodedUserId) return null;
  try {
    return {
      userId: decodeURIComponent(encodedUserId),
      limit: Math.max(1, Math.min(25, Number(limit) || 10)),
      page: Math.max(0, Number(page) || 0),
      username: decodeURIComponent(encodedUsername),
    };
  } catch {
    return null;
  }
}

export function buildVideoEmbed(result, video = {}) {
  const title = result.title || video.title || `Downloaded ${mediaLabel(result)}`;
  const sourceUrl = result.sourceUrl || video.url;
  const embed = new EmbedBuilder()
    .setColor(UI_COLORS.info)
    .setTitle(title.slice(0, 256))
    .setTimestamp(new Date())
    .setFooter({ text: `${result.videoId || video.id || 'unknown'} • ${formatBytes(result.sizeBytes || 0)}` });
  if (sourceUrl) embed.setURL(sourceUrl);
  if (result.username || video.username) embed.setAuthor({ name: `@${result.username || video.username}` });
  if (result.description) embed.setDescription(String(result.description).slice(0, 4000));
  if (result.thumbnailUrl || video.thumbnail) embed.setThumbnail(result.thumbnailUrl || video.thumbnail);
  return embed;
}

function buildStandardDownloadEmbed(result, config, { video = {}, attachmentPlan = null, attachmentMode = null, now = Date.now() } = {}) {
  const username = result?.username || video?.username || video?.uploader || 'unknown';
  const sourceUrl = result?.sourceUrl || video?.sourceUrl || video?.url || video?.webpage_url || '';
  const link = result?.publicUrl || (result?.token ? makePublicFileUrl(config, result.token) : '');
  const plan = attachmentPlan ?? { kind: 'none', reason: 'link-only', files: [], mode: attachmentMode || 'link', imageCount: Number(result?.imageCount ?? 0) };
  const fields = [
    {
      name: 'Download',
      value: link ? `[Click](${link})` : 'Unavailable',
      inline: true,
    },
    {
      name: 'Retention',
      value: result?.linkPermanent ? 'Permanent' : formatTtlShort(config),
      inline: true,
    },
    {
      name: 'Cache',
      value: result?.reused ? 'Y' : 'N',
      inline: true,
    },
  ];

  if (result?.mediaType === 'slideshow') {
    fields.push({
      name: 'Slideshow',
      value: formatStandardSlideshowNote(plan),
      inline: true,
    });
  } else if (contentMediaAssets(result).length > 1) {
    fields.push({
      name: 'Media',
      value: formatMultiAssetNote(plan),
      inline: true,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(UI_COLORS.info)
    .setTitle(buildStandardDownloadTitle(username, result, video, now))
    .setTimestamp(new Date(now))
    .setFooter({ text: `${result?.videoId || video?.id || 'unknown'} - ${formatBytes(result?.sizeBytes || 0)}` });

  const description = truncateText(result?.description || result?.title || video?.title || '', 4000);
  if (description) embed.setDescription(description);
  embed.addFields(...fields);
  if (sourceUrl) embed.setURL(sourceUrl);
  if (result?.thumbnailUrl || video?.thumbnail) embed.setThumbnail(result.thumbnailUrl || video.thumbnail);
  return embed;
}

function buildMonitorActionRows(result, config = {}) {
  const link = result?.publicUrl || (result?.token ? makePublicFileUrl(config, result.token) : '');
  const components = [];
  if (link) {
    components.push(
      new ButtonBuilder()
        .setLabel(formatDownloadButtonLabel(result))
        .setStyle(ButtonStyle.Link)
        .setURL(link),
    );
  }
  if (result?.token) {
    components.push(
      new ButtonBuilder()
        .setCustomId(`${MONITOR_BUTTON_PREFIX}delete:${result.token}`)
        .setLabel('Delete saved copy')
        .setStyle(ButtonStyle.Danger),
    );
  }
  return components.length ? [new ActionRowBuilder().addComponents(...components)] : [];
}

async function planAttachments(result, config = {}) {
  if (!result?.filePath) {
    return { kind: 'none', reason: 'no-file', files: [], mode: 'link', imageCount: Number(result?.imageCount ?? 0) };
  }

  if (result?.mediaType === 'slideshow') {
    const imageCount = Number(result.imageCount ?? 0);
    const imagePaths = Array.isArray(result.slideshowImagePaths)
      ? result.slideshowImagePaths.filter(Boolean).slice(0, 10)
      : [];
    const hasCompleteGallery = imagePaths.length > 0 && (!imageCount || imagePaths.length >= imageCount);
    const galleryAssets = attachmentAssetsForPaths(imagePaths, contentMediaAssets(result));
    if (
      imageCount <= 10
      && hasCompleteGallery
      && await attachmentSetFitsDiscord(galleryAssets, config)
    ) {
      return {
        kind: 'gallery',
        files: imagePaths.map((filePath) => new AttachmentBuilder(filePath, { name: path.basename(filePath) })),
        imageCount,
        mode: 'gallery',
      };
    }
    if (singleAttachmentFitsDiscord(result.sizeBytes, config)) {
      return {
        kind: 'upload',
        as: 'zip',
        why: imageCount > 10 ? 'over-10' : 'incomplete-gallery',
        files: [new AttachmentBuilder(result.filePath, { name: result.filename || path.basename(result.filePath) })],
        imageCount,
        mode: 'zip',
      };
    }
    return { kind: 'none', reason: 'oversize', files: [], imageCount, mode: 'link' };
  }

  const assets = contentMediaAssets(result);
  if (assets.length) {
    const expectedCount = Math.max(assets.length, Number(result.assetCount ?? 0));
    const complete = expectedCount === assets.length;
    const uploadable = await attachmentSetFitsDiscord(assets, config, {
      singleFallbackSize: result.sizeBytes,
    });
    if (complete && assets.length <= 10 && uploadable) {
      return {
        kind: assets.length > 1 ? 'gallery' : 'upload',
        as: assets.length > 1 ? 'assets' : (assets[0].kind || 'media'),
        files: assets.map((asset) => new AttachmentBuilder(asset.path, {
          name: asset.filename || path.basename(asset.path),
        })),
        mode: assets.length > 1 ? 'gallery' : 'media',
        assetCount: assets.length,
        imageCount: assets.filter((asset) => asset.kind === 'image').length,
      };
    }
    if (singleAttachmentFitsDiscord(result.sizeBytes, config)) {
      return {
        kind: 'upload',
        as: 'zip',
        why: assets.length > 10 ? 'over-10' : !complete ? 'incomplete-assets' : 'oversize-assets',
        files: [new AttachmentBuilder(result.filePath, { name: result.filename || path.basename(result.filePath) })],
        mode: 'zip',
        assetCount: expectedCount,
        imageCount: assets.filter((asset) => asset.kind === 'image').length,
      };
    }
    return {
      kind: 'none',
      reason: assets.length > 10 ? 'over-10' : 'oversize',
      files: [],
      mode: 'link',
      assetCount: expectedCount,
      imageCount: assets.filter((asset) => asset.kind === 'image').length,
    };
  }

  if (!singleAttachmentFitsDiscord(result.sizeBytes, config)) {
    return { kind: 'none', reason: 'oversize', files: [], mode: 'link', imageCount: 0 };
  }
  return {
    kind: 'upload',
    as: 'video',
    files: [new AttachmentBuilder(result.filePath, { name: result.filename || path.basename(result.filePath) })],
    mode: 'video',
    imageCount: 0,
  };
}

function contentMediaAssets(result = {}) {
  if (!Array.isArray(result.assets)) return [];
  return result.assets
    .filter((asset) => asset?.path && (!asset.role || asset.role === 'content'))
    .slice()
    .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0));
}

async function canUploadResult(result, config) {
  const assets = contentMediaAssets(result);
  if (assets.length && assets.length <= 10) {
    const expectedCount = Math.max(assets.length, Number(result.assetCount ?? 0));
    if (
      expectedCount === assets.length
      && await attachmentSetFitsDiscord(assets, config, { singleFallbackSize: result.sizeBytes })
    ) {
      return true;
    }
  }
  if (result?.mediaType === 'slideshow') {
    const imageCount = Number(result.imageCount ?? 0);
    const imagePaths = Array.isArray(result.slideshowImagePaths)
      ? result.slideshowImagePaths.filter(Boolean).slice(0, 10)
      : [];
    const hasCompleteGallery = imagePaths.length > 0 && (!imageCount || imagePaths.length >= imageCount);
    if (
      imageCount <= 10
      && hasCompleteGallery
      && await attachmentSetFitsDiscord(
        attachmentAssetsForPaths(imagePaths, assets),
        config,
      )
    ) {
      return true;
    }
  }
  return singleAttachmentFitsDiscord(result.sizeBytes, config);
}

function attachmentAssetsForPaths(paths, assets) {
  const byPath = new Map(assets.map((asset) => [path.resolve(asset.path), asset]));
  return paths.map((filePath) => ({
    ...byPath.get(path.resolve(filePath)),
    path: filePath,
  }));
}

async function attachmentSetFitsDiscord(assets, config, { singleFallbackSize = 0 } = {}) {
  if (!assets.length) return false;
  let totalBytes = 0;
  for (const asset of assets) {
    let sizeBytes = Number(asset?.sizeBytes || 0);
    if (!(sizeBytes > 0) && assets.length === 1) {
      sizeBytes = Number(singleFallbackSize || 0);
    }
    if (!(sizeBytes > 0)) {
      try {
        const fileStats = await stat(asset.path);
        if (!fileStats.isFile()) return false;
        sizeBytes = fileStats.size;
      } catch {
        return false;
      }
    }
    if (!shouldUploadToDiscord(sizeBytes, config)) return false;
    totalBytes += sizeBytes;
    if (totalBytes > discordMessageAttachmentBudget(config)) return false;
  }
  return true;
}

function singleAttachmentFitsDiscord(sizeBytes, config) {
  return shouldUploadToDiscord(sizeBytes, config)
    && Number(sizeBytes) <= discordMessageAttachmentBudget(config);
}

function discordMessageAttachmentBudget(config = {}) {
  const configuredLimit = Number(config.discordUploadLimitBytes || 0);
  if (!(configuredLimit > 0)) return 0;
  return Math.min(configuredLimit, DISCORD_MESSAGE_ATTACHMENT_BUDGET_BYTES);
}

function formatSlideshowAlertNote(plan) {
  const imageCount = Number(plan?.imageCount ?? 0);
  if (plan?.kind === 'gallery') {
    return `${imageCount || 'Multiple'} images attached below. The ZIP is saved permanently.`;
  }
  if (plan?.kind === 'upload' && plan.as === 'zip') {
    if (plan.why === 'over-10') {
      return `${imageCount} images. Using the ZIP because Discord galleries support up to 10 attachments.`;
    }
    return 'Gallery images were not available, so the ZIP is attached below.';
  }
  return 'Use the Download ZIP button for the saved slideshow.';
}

function formatStandardSlideshowNote(plan) {
  const imageCount = Number(plan?.imageCount ?? 0);
  if (plan?.kind === 'gallery') return imageCount ? `${imageCount} images` : 'Gallery';
  if (plan?.kind === 'upload' && plan.as === 'zip' && plan.why === 'over-10') {
    return `ZIP (${imageCount} images)`;
  }
  if (plan?.kind === 'none') return imageCount > 10 ? `Link (${imageCount} images)` : 'Link';
  return 'ZIP';
}

function formatMultiAssetNote(plan) {
  const assetCount = Number(plan?.assetCount ?? 0);
  if (plan?.kind === 'gallery') return `${assetCount} files attached`;
  if (plan?.kind === 'upload' && plan.as === 'zip') return `ZIP (${assetCount} files)`;
  return `Link (${assetCount} files)`;
}

function buildStandardDownloadTitle(username, result, video, now) {
  const uploadAt = resolveUploadTimestampMs(result, video);
  const age = uploadAt ? ` - ${formatCompactDuration(Math.max(0, now - uploadAt))} old` : '';
  return truncateText(`Downloaded ${mediaLabel(result, video)} by @${username}${age}`, 256);
}

function buildMonitorAlertTitle(username, result, video, now) {
  const uploadAt = resolveUploadTimestampMs(result, video);
  const age = uploadAt ? ` - ${formatCompactDuration(Math.max(0, now - uploadAt))} old` : '';
  return truncateText(`New ${mediaLabel(result, video)} by @${username}${age}`, 256);
}

function resolveUploadTimestampMs(result = {}, video = {}) {
  for (const value of [
    result.timestamp,
    video.timestamp,
    result.release_timestamp,
    video.release_timestamp,
  ]) {
    const numeric = Number(value ?? 0);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }
  }

  for (const value of [result.upload_date, video.upload_date]) {
    const parsed = parseCompactUploadDate(value);
    if (parsed) return parsed;
  }

  for (const value of [
    result.publishedAt,
    video.publishedAt,
    result.created_at,
    video.created_at,
    result.uploadDate,
    video.uploadDate,
  ]) {
    const parsed = Date.parse(String(value ?? ''));
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function parseCompactUploadDate(value) {
  const text = String(value ?? '');
  if (!/^\d{8}$/.test(text)) return null;
  const yyyy = Number(text.slice(0, 4));
  const mm = Number(text.slice(4, 6));
  const dd = Number(text.slice(6, 8));
  return Date.UTC(yyyy, mm - 1, dd);
}

function formatCompactDuration(ms) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  if (minutes < 1) return 'under 1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatDuration(value) {
  const seconds = Number(value ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'N/A';
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes <= 0) return `${remainingSeconds}s`;
  return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`;
}

function formatMediaTypeLabel(result = {}, video = {}) {
  const type = mediaLabel(result, video);
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatDownloadButtonLabel(result = {}) {
  const type = mediaLabel(result);
  if (type === 'slideshow') return 'Download ZIP';
  if (type === 'story') return 'Download story';
  return 'Download video';
}

function canDeleteMonitorPost(interaction) {
  const inGuild = interaction?.inGuild?.() ?? Boolean(interaction?.guildId);
  if (!inGuild) return true;
  return Boolean(
    interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageMessages)
      || interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild),
  );
}

export function canManageWatches(interaction, config = {}) {
  const userId = String(interaction?.user?.id ?? '');
  if (userId && userId === String(config.discordOwnerId ?? '')) return true;
  const inGuild = interaction?.inGuild?.() ?? Boolean(interaction?.guildId);
  if (!inGuild) return false;
  if (interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  const roleId = String(config.watchManagerRoleId ?? '');
  return Boolean(roleId && interaction.member?.roles?.cache?.has?.(roleId));
}

function canManageProfiles(interaction, config = {}) {
  const userId = String(interaction?.user?.id ?? '');
  const ownerId = String(config.discordOwnerId ?? '');
  return Boolean(userId && ownerId && userId === ownerId);
}

function canManageLink(record, interaction, config = {}) {
  const userId = String(interaction?.user?.id ?? '');
  if (userId && userId === String(record?.owner_id ?? '')) return true;
  if (userId && userId === String(config.discordOwnerId ?? '')) return true;
  const inGuild = interaction?.inGuild?.() ?? Boolean(interaction?.guildId);
  return Boolean(inGuild && interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
}

function watchScopeFromInteraction(interaction, config = {}) {
  const channelId = String(interaction?.channelId || config.discordChannelId || '');
  if (!channelId) throw new Error('A Discord channel is required to register a watch.');
  const scope = discordScopeFromInteraction(interaction, config);
  return {
    guildId: toWatchGuildId(scope),
    channelId: scope.channelId,
    createdBy: String(interaction?.user?.id ?? ''),
  };
}

export function discordScopeFromInteraction(interaction = {}, config = {}) {
  const channelId = String(interaction?.channelId || config.discordChannelId || '');
  const rawGuildId = String(interaction?.guildId ?? '');
  if (rawGuildId && !rawGuildId.startsWith('dm:')) {
    return { kind: 'guild', guildId: rawGuildId, channelId };
  }
  if (!channelId) throw new Error('A Discord channel is required to register a watch.');
  return { kind: 'dm', channelId };
}

export function toWatchGuildId(scope) {
  if (scope?.kind === 'guild') return String(scope.guildId);
  return `dm:${String(scope?.channelId ?? '')}`;
}

export function toLinkScopeId(scope) {
  if (scope?.kind === 'guild') return `guild:${String(scope.guildId)}`;
  return `channel:${String(scope?.channelId ?? '')}`;
}

export function matchesLinkScope(storedScopeId, scope) {
  const stored = String(storedScopeId ?? '');
  if (!stored) return true;
  const current = toLinkScopeId(scope);
  if (stored === current) return true;
  // Legacy watch subscriptions were migrated without a guild id, so their
  // monitor deliveries were scoped to the destination channel.
  return Boolean(scope?.channelId && stored === `channel:${scope.channelId}`);
}

export function monitorScopeId(interaction = {}) {
  try {
    return toLinkScopeId(discordScopeFromInteraction(interaction));
  } catch {
    return `channel:${String(interaction?.channelId ?? '')}`;
  }
}

export function monitorScopeMatches(scopeId, interaction = {}) {
  try {
    return matchesLinkScope(scopeId, discordScopeFromInteraction(interaction));
  } catch {
    const channelId = String(interaction?.channelId ?? '');
    return Boolean(channelId && String(scopeId ?? '') === `channel:${channelId}`);
  }
}

export async function resolveMonitorDeliveryScope(client, target = {}) {
  const channelId = String(target?.channelId ?? target?.channel_id ?? '');
  let guildId = String(target?.guildId ?? target?.guild_id ?? '');

  if (guildId.startsWith('dm:')) {
    const dmChannelId = channelId || guildId.slice(3);
    return {
      guildId,
      channelId: dmChannelId,
      scopeId: toLinkScopeId({ kind: 'dm', channelId: dmChannelId }),
    };
  }

  if (!guildId && channelId) {
    let channel = client?.channels?.cache?.get?.(channelId) ?? null;
    if (!channel && typeof client?.channels?.fetch === 'function') {
      try {
        channel = await client.channels.fetch(channelId);
      } catch {
        // Sending the alert will report an inaccessible channel. Falling back
        // to a channel scope keeps DM targets and legacy records safe.
      }
    }
    guildId = String(channel?.guildId ?? channel?.guild?.id ?? '');
  }

  const scope = guildId
    ? { kind: 'guild', guildId, channelId }
    : { kind: 'dm', channelId };
  return {
    guildId,
    channelId,
    scopeId: toLinkScopeId(scope),
  };
}

async function acknowledgeMonitorDelete(interaction, payload) {
  if (typeof interaction.update === 'function') {
    try {
      await interaction.update({ components: [] });
      if (typeof interaction.followUp === 'function') {
        await interaction.followUp(payload).catch(() => {});
      }
      return;
    } catch {
      // Fall back to a normal ephemeral reply.
    }
  }
  await interaction.reply(payload);
}

function formatWatchList(watches) {
  if (!watches?.length) return 'No watches configured.';
  if (!watches.length) return 'No watched usernames yet.';
  return watches.map((watch) => {
    const platformLabel = formatPlatformLabel(watch.platform ?? 'tiktok');
    const last = watch.last_success_at ? new Date(watch.last_success_at).toISOString() : 'never';
    const suffix = watch.last_error ? `, last error: ${watch.last_error}` : '';
    return `@${watch.username} (${platformLabel}) — last success: ${last}${suffix}`;
  }).join('\n');
}

function formatMonitorFailureList(failures) {
  if (!failures.length) return 'No monitored posts are awaiting manual retry in this server or DM.';
  const rows = failures.map((failure, index) => {
    const state = failure.status === 'retrying' ? 'retry running' : 'dead-lettered';
    const error = truncateText(failure.last_error || 'Unknown extractor failure', 180);
    return [
      `${index + 1}. @${failure.username} — post \`${failure.video_id}\``,
      `${state} after ${Number(failure.failure_count ?? 0)} failure(s), updated ${formatDate(failure.updated_at)}`,
      error,
    ].join('\n');
  });
  return `${rows.join('\n\n')}\n\nRetry with \`/watch retry post_id:<id>\`.`;
}

function storedProfileFromReference(reference) {
  return {
    platform: reference.platform,
    remoteId: reference.remoteId,
    handle: reference.handle,
    profileUrl: reference.canonicalUrl,
  };
}

function profileLookupFromReference(reference) {
  return {
    platform: reference.platform,
    remoteId: reference.remoteId,
    handle: reference.handle,
  };
}

function formatCreatorGroup(group, members = []) {
  const label = group?.name
    ? `Creator: ${formatInlineCode(group.name)}`
    : `Creator group #${Number(group?.id) || 'unknown'}`;
  const profiles = members.length
    ? members.map((profile) => `• ${formatPlatformProfile(profile)}`)
    : ['• No profiles linked.'];
  return [
    label,
    `Group ID: ${formatInlineCode(Number(group?.id) || 'unknown')}`,
    '',
    'Profiles:',
    ...profiles,
  ].join('\n');
}

function formatPlatformProfile(profile = {}) {
  const platform = String(profile.platform ?? '').toLowerCase();
  const displayPlatform = platform === 'x'
    ? 'X'
    : platform === 'instagram' ? 'Instagram' : 'TikTok';
  const handle = String(profile.handle ?? '').replace(/^@/, '') || 'unknown';
  const url = String(profile.profile_url ?? profile.canonicalUrl ?? '');
  return `${displayPlatform} ${formatInlineCode(`@${handle}`)}${url ? ` — <${url}>` : ''}`;
}

function normalizePlatformInput(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'all') return 'all';
  if (raw === 'instagram' || raw === 'ig') return 'instagram';
  if (raw === 'tiktok' || raw === 'tt') return 'tiktok';
  if (raw === 'x' || raw === 'twitter') return 'x';
  return raw;
}
function formatPlatformLabel(platform) {
  const p = String(platform ?? '').toLowerCase();
  if (p === 'instagram') return 'Instagram';
  if (p === 'tiktok') return 'TikTok';
  if (p === 'x') return 'X';
  return p || 'Unknown';
}

function formatInlineCode(value) {
  return `\`${String(value ?? '').replace(/[`\r\n]/g, "'")}\``;
}

function protectedDownloadPaths(store, files, config = {}) {
  const fileIds = (Array.isArray(files) ? files : [])
    .map((file) => Number(file?.id))
    .filter((fileId) => Number.isInteger(fileId) && fileId > 0);
  return new Set((store.listFilePathsReferencedOutside?.(fileIds) ?? []).map((filePath) => {
    return path.isAbsolute(String(filePath ?? ''))
      ? path.resolve(String(filePath))
      : path.resolve(config.downloadDir, String(filePath ?? ''));
  }));
}

function formatPurgeResult({ scope, counts, removal }) {
  const target = scope === 'all' ? 'all downloads' : 'your downloads';
  const failed = removal.failed.length
    ? ` ${removal.failed.length} file(s) could not be removed from disk.`
    : '';
  return `Purged ${target}: ${counts.files} file record(s), ${counts.links} link(s), ${counts.jobs} job(s). Removed ${removal.deleted} file(s) from disk.${failed}`;
}

function canPurgeAll(interaction, config = {}) {
  const userId = String(interaction?.user?.id ?? '');
  const ownerId = String(config.discordOwnerId ?? '');
  return Boolean(userId && ownerId && userId === ownerId);
}

function buildStatusEmbed(stats, monitorStatus, downloadStatus = null) {
  const metrics = monitorStatus.metrics ?? {};
  const lastSummary = metrics.lastSummary ?? {};
  const activeDownloads = downloadStatus?.active ?? monitorStatus.activeDownloads ?? 0;
  const queuedDownloads = downloadStatus?.queued ?? monitorStatus.queueLength ?? 0;
  const downloadConcurrency = downloadStatus?.concurrency ?? monitorStatus.downloadConcurrency ?? 1;
  return new EmbedBuilder()
    .setColor(UI_COLORS.success)
    .setTitle('Media downloader status')
    .addFields(
      { name: 'TikTok watches', value: String(stats.watchCount), inline: true },
      { name: 'Seen TikTok posts', value: String(stats.videoCount), inline: true },
      { name: 'Files', value: String(stats.fileCount), inline: true },
      { name: 'DB schema', value: `v${stats.schemaVersion ?? 0}`, inline: true },
      { name: 'TikTok monitor', value: monitorStatus.running ? 'running' : 'stopped', inline: true },
      { name: 'Last poll', value: monitorStatus.lastPollAt ? new Date(monitorStatus.lastPollAt).toISOString() : 'never', inline: true },
      { name: 'Interval', value: formatDurationMs(monitorStatus.pollIntervalMs), inline: true },
      { name: 'Scan window', value: `${monitorStatus.scanLimit ?? 5} / ${monitorStatus.burstScanLimit ?? 20} burst`, inline: true },
      { name: 'Check workers', value: String(monitorStatus.checkConcurrency ?? 1), inline: true },
      { name: 'Download workers', value: String(downloadConcurrency), inline: true },
      { name: 'Download queue', value: `${activeDownloads} active / ${queuedDownloads} queued`, inline: true },
      { name: 'Deletion workers', value: `${monitorStatus.activeDeletionChecks ?? 0} active / ${monitorStatus.deletionQueueLength ?? 0} queued`, inline: true },
      { name: 'Monitor dead letters', value: String(stats.deadLetterCount ?? 0), inline: true },
      { name: 'Download totals', value: `${metrics.totalCompletedDownloads ?? 0} ok / ${metrics.totalDownloadFailures ?? 0} failed`, inline: true },
      { name: 'Last cycle', value: formatMonitorCycle(metrics, lastSummary), inline: false },
    )
    .setTimestamp(new Date());
}

function formatMonitorCycle(metrics = {}, summary = {}) {
  if (!metrics.lastCycleStartedAt) return 'No monitor cycle has completed yet.';
  return [
    `duration: ${formatDurationMs(metrics.lastCycleDurationMs)}`,
    `checked: ${summary.watchedUsers ?? 0}`,
    `skipped: ${summary.skippedUsers ?? 0}`,
    `scanned: ${summary.scannedVideos ?? 0}`,
    `queued: ${summary.queuedDownloads ?? 0}`,
    `failures: ${summary.failures ?? 0}`,
    `downloads: ${summary.downloadedVideos ?? 0} ok / ${summary.alertedVideos ?? 0} alerted`,
  ].join(' - ');
}

function formatDurationMs(value) {
  const ms = Math.max(0, Number(value) || 0);
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function pingPrefix(config) {
  if (config.pingMode === 'here') return '@here ';
  if (config.pingMode === 'everyone') return '@everyone ';
  if (config.pingMode === 'role' && config.pingRoleId) return `<@&${config.pingRoleId}> `;
  return '';
}

function mediaLabel(result = {}, fallback = {}) {
  const mediaType = result?.mediaType || fallback?.mediaType;
  if (mediaType === 'story') return 'story';
  return mediaType === 'slideshow' ? 'slideshow' : 'post';
}

function alertReadyText(result) {
  return result.reused
    ? `Saved ${mediaLabel(result)} delivered from cache.`
    : `New ${mediaLabel(result)} downloaded.`;
}

function downloadLinkTtlMs(config = {}) {
  return ttlMinutes(config) * 60 * 1000;
}

function formatTtlShort(config = {}) {
  const minutes = ttlMinutes(config);
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatTtlLong(config = {}) {
  const minutes = ttlMinutes(config);
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function ttlMinutes(config = {}) {
  const minutes = Number(config.downloadLinkTtlMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return Math.round(minutes);
  return 30;
}
