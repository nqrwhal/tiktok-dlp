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
import path from 'node:path';
import { removeStoredFiles } from '../cleanup/downloads.js';
import { extractTikTokUrls, normalizeUsername, shouldUploadToDiscord, makePublicFileUrl, randomToken } from '../util/files.js';
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

export async function startDiscordBot({ config, store, monitor, downloadOne, registerCommands }) {
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
      await handleInteraction({ interaction, config, store, monitor, downloadOne });
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

export async function handleInteraction({ interaction, config, store, monitor, downloadOne }) {
  const command = interaction.commandName;

  if (command === 'download') {
    await interaction.deferReply({ ephemeral: true });
    const url = interaction.options.getString('url', true);
    const delivery = interaction.options.getString('delivery') ?? 'auto';
    const result = await downloadOne(url, {
      delivery,
      type: 'manual',
      requestedBy: interaction.user?.id ?? '',
    });
    await interaction.editReply(await buildDeliveryPayload(result, config, delivery));
    return;
  }

  if (command === 'watch') {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'add') {
      const username = normalizeUsername(interaction.options.getString('username', true));
      const channelId = interaction.channelId || config.discordChannelId;
      const watch = store.addWatch(username, channelId);
      await interaction.reply(buildNoticePayload({
        title: 'Watch Added',
        description: `Watching @${watch.username}. Alerts will post in this channel.`,
      }));
      return;
    }
    if (subcommand === 'remove') {
      const username = normalizeUsername(interaction.options.getString('username', true));
      const removed = store.removeWatch(username);
      await interaction.reply(buildNoticePayload({
        title: removed ? 'Watch Removed' : 'Watch Not Found',
        description: removed ? `Stopped watching @${username}.` : `@${username} was not watched.`,
      }));
      return;
    }
    if (subcommand === 'list') {
      const watches = store.listWatches();
      await interaction.reply(buildNoticePayload({
        title: 'Watched Usernames',
        description: formatWatchList(watches),
      }));
      return;
    }
    if (subcommand === 'run') {
      await interaction.deferReply({ ephemeral: true });
      const username = normalizeUsername(interaction.options.getString('username', true));
      const result = await monitor.pollUsername(username, { force: true });
      await interaction.editReply(buildNoticePayload({
        title: 'Watch Check Complete',
        description: `Checked @${username}: ${result.newVideos ?? 0} new video(s), ${result.skipped ?? 0} already seen.`,
        ephemeral: false,
      }));
      return;
    }
  }

  if (command === 'status') {
    await interaction.reply({ embeds: [buildStatusEmbed(store.stats(), monitor.status())], ephemeral: true });
    return;
  }

  if (command === 'history') {
    const history = store.listLinkHistoryByRequester(interaction.user?.id ?? '', {
      limit: 10,
      includeMonitored: true,
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

  const urls = extractTikTokUrls(message.content, 3);
  if (!urls.length) return false;

  const status = await message.reply(buildNoticePayload({
    title: 'Downloading',
    description: urls.length === 1
      ? 'Downloading TikTok link...'
      : `Downloading ${urls.length} TikTok links...`,
    color: UI_COLORS.warning,
    ephemeral: false,
  }));

  for (const [index, url] of urls.entries()) {
    try {
      const result = await downloadOne(url, {
        delivery: 'auto',
        type: 'message',
        requestedBy: message.author?.id ?? '',
      });
      const payload = await buildDeliveryPayload(result, config, 'auto');

      if (urls.length === 1) {
        await status.edit(payload);
      } else {
        await status.edit(buildNoticePayload({
          title: 'Downloading',
          description: `Downloaded ${index + 1}/${urls.length} TikTok links.`,
          color: UI_COLORS.warning,
          ephemeral: false,
        }));
        await message.reply(payload);
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
  const directHelp = ['help', 'commands', 'tiktok help', '!tiktok help', 'tt help', '!tt help'].includes(normalized);
  const inGuild = message?.inGuild?.() ?? Boolean(message?.guildId);
  if (!inGuild) return directHelp;
  if (/^!?(tiktok|tt)\s+help$/i.test(content)) return true;

  const botId = message?.client?.user?.id;
  if (!botId) return false;
  const mentionPattern = new RegExp(`^<@!?${botId}>\\s+help$`, 'i');
  return mentionPattern.test(content);
}

export function buildHelpMessage() {
  return buildNoticePayload({
    title: 'TikTok Downloader Help',
    description: [
      'Post a TikTok URL in any channel I can read, or DM it to me, and I will download it.',
      '',
      'Slash commands:',
      '`/download url:<tiktok-url> delivery:auto|file|link`',
      '`/downloads list`',
      '`/downloads purge scope:mine confirm:PURGE`',
      '`/watch add|remove|list|run`',
      '`/status` and `/history`',
      '',
      'Help keywords: `tiktok help`, `!tiktok help`, or DM me `help`.',
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
      limit,
      page: 0,
      username,
    }));
    return;
  }

  if (subcommand === 'purge') {
    const scope = interaction.options.getString('scope') ?? 'mine';
    const confirm = interaction.options.getString('confirm', true);

    if (confirm !== 'PURGE') {
      await interaction.reply(buildNoticePayload({
        title: 'Purge Cancelled',
        description: 'Run it again with `confirm:PURGE`.',
      }));
      return;
    }

    if (scope === 'all' && !canPurgeAll(interaction)) {
      await interaction.reply(buildNoticePayload({
        title: 'Permission Required',
        description: 'Only members with Manage Server can purge all downloads.',
        color: UI_COLORS.error,
      }));
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const requestedBy = scope === 'mine' ? interaction.user?.id ?? '' : '';
    const files = store.listFilesForPurge({ requestedBy });
    const counts = store.purgeDownloads({ requestedBy });
    const removal = await removeStoredFiles(files, config);
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

export async function sendVideoAlert({ client, config, store, result, video, watch }) {
  const channelId = watch?.channel_id || config.discordChannelId;
  const channel = await client.channels.fetch(channelId);
  const now = Date.now();
  const payload = await buildMonitorAlertPayload(result, config, {
    video,
    watch,
    now,
  });
  await channel.send(payload);
  if (video?.id) {
    store.markVideoSeen({
      videoId: video.id,
      username: watch?.username || video.username || result.username,
      sourceUrl: video.url || result.sourceUrl,
      title: video.title || result.title,
      alertedAt: now,
    });
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
  const link = result?.publicUrl || (result?.token ? makePublicFileUrl(config, result.token) : '');
  const attachments = buildMonitorAlertAttachments(result, config);
  const fields = [
    {
      name: 'Saved Copy',
      value: link ? `[Permanent server copy](${link})` : 'Saved permanently on the server.',
      inline: false,
    },
  ];

  if (result?.reused) {
    fields.push({ name: 'Cache', value: 'Delivered from cache.', inline: true });
  }

  if (result?.mediaType === 'slideshow') {
    fields.push({
      name: 'Slideshow',
      value: formatSlideshowAlertNote(result, attachments.mode),
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
  const canUpload = shouldUploadToDiscord(result.sizeBytes, config);
  const wantsFile = requestedDelivery === 'file' || (requestedDelivery === 'auto' && canUpload && !result.reused);
  const embed = buildVideoEmbed(result, options.video);
  const contentPrefix = options.contentPrefix ?? '';
  const linkPermanent = Boolean(result.linkPermanent);
  const readyText = result.reused ? 'Download ready (cache hit).' : 'Download ready.';
  const readyLinkText = result.reused ? 'Download ready (cache hit)' : 'Download ready';

  if (wantsFile && canUpload) {
    const attachment = new AttachmentBuilder(result.filePath, { name: result.filename || path.basename(result.filePath) });
    const link = result.publicUrl || (result.token ? makePublicFileUrl(config, result.token) : '');
    const serverCopy = link
      ? linkPermanent
        ? `\nPermanent server copy: ${link}`
        : `\nServer copy expires in ${formatTtlLong(config)}: ${link}`
      : '';
    return {
      content: `${contentPrefix}${options.alert ? alertReadyText(result) : readyText}${serverCopy}`.trim(),
      embeds: [embed],
      files: [attachment],
      components: buildLinkManagementRows(result.token, config),
    };
  }

  if (requestedDelivery === 'file' && !canUpload) {
    return {
      embeds: [
        embed,
        buildNoticePayload({
          title: 'File Too Large',
          description: `File is too large for Discord upload (${formatBytes(result.sizeBytes)}). Use delivery:link or auto.`,
          color: UI_COLORS.warning,
          ephemeral: false,
        }).embeds[0],
      ],
    };
  }

  const link = result.publicUrl || (result.token ? makePublicFileUrl(config, result.token) : '');
  const retention = linkPermanent
    ? 'This server copy is permanent.'
    : `Temporary links expire after ${formatTtlLong(config)}. Use the buttons below to save or renew the server copy.`;
  return {
    content: `${contentPrefix}${link ? `${readyLinkText}: ${link}` : `${readyText} PUBLIC_BASE_URL is not configured for links.`}\n${retention}`.trim(),
    embeds: [embed],
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

  const removal = await removeStoredFiles([{ id: record.id, path: record.path, filename: record.filename }], config);
  if (removal.failed.length) {
    await interaction.reply(buildNoticePayload({
      title: 'Delete Failed',
      description: 'The saved file could not be removed from disk, so I left its database records intact.',
      color: UI_COLORS.error,
    }));
    return true;
  }

  const counts = store.deleteMonitorDownloadByFileId?.(record.file_id ?? record.id) ?? { files: 0, links: 0, jobs: 0 };
  await acknowledgeMonitorDelete(interaction, buildNoticePayload({
    title: counts.files ? 'Saved Post Deleted' : 'Saved Post Not Found',
    description: counts.files
      ? `Deleted ${record.filename || 'the saved post'} from this server.`
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

  if (action === 'new') {
    const newToken = randomToken();
    const expiresAt = Date.now() + downloadLinkTtlMs(config);
    store.createLinkToken({ token: newToken, fileId: record.id, expiresAt });
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
    limit: parsed.limit,
    page: parsed.page,
    username: parsed.username,
  });
  delete payload.ephemeral;
  await interaction.update(payload);
  return true;
}

export function buildDownloadsListPayload({ config, store, userId, limit = 10, page = 0, username = '' }) {
  const pageSize = Math.max(1, Math.min(25, Number(limit) || 10));
  const currentPage = Math.max(0, Number(page) || 0);
  const listOptions = {
    limit: pageSize,
    offset: currentPage * pageSize,
    includeMonitored: true,
    username,
  };
  const links = store.listPermanentDownloadsByRequester(userId, listOptions);
  const total = store.countPermanentDownloadsByRequester(userId, listOptions);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(currentPage, pageCount - 1);

  if (clampedPage !== currentPage) {
    return buildDownloadsListPayload({ config, store, userId, limit: pageSize, page: clampedPage, username });
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
    const url = makePublicFileUrl(config, link.token) || 'PUBLIC_BASE_URL is not configured.';
    const postId = link.video_id ? `post: ${truncateText(link.video_id, 64)}` : '';
    return {
      name: truncateText(`${ordinal}. ${user} - ${title}`, 256),
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
    const url = makePublicFileUrl(config, entry.token) || 'PUBLIC_BASE_URL is not configured.';
    const status = entry.job_status ? `job: ${entry.job_status}` : '';
    const postId = entry.video_id ? `post: ${truncateText(entry.video_id, 64)}` : '';
    return {
      name: truncateText(`${index + 1}. ${user} - ${title}`, 256),
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
  const title = result.title || video.title || `TikTok ${mediaLabel(result)}`;
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

function buildMonitorActionRows(result, config = {}) {
  const link = result?.publicUrl || (result?.token ? makePublicFileUrl(config, result.token) : '');
  const components = [];
  if (link) {
    components.push(
      new ButtonBuilder()
        .setLabel(result?.mediaType === 'slideshow' ? 'Download ZIP' : 'Download video')
        .setStyle(ButtonStyle.Link)
        .setURL(link),
    );
  }
  if (result?.token) {
    components.push(
      new ButtonBuilder()
        .setCustomId(`${MONITOR_BUTTON_PREFIX}delete:${result.token}`)
        .setLabel('Delete post')
        .setStyle(ButtonStyle.Danger),
    );
  }
  return components.length ? [new ActionRowBuilder().addComponents(...components)] : [];
}

function buildMonitorAlertAttachments(result, config = {}) {
  if (!result?.filePath) return { files: [], mode: 'link' };

  if (result?.mediaType === 'slideshow') {
    const imageCount = Number(result.imageCount ?? 0);
    const imagePaths = Array.isArray(result.slideshowImagePaths)
      ? result.slideshowImagePaths.filter(Boolean).slice(0, 10)
      : [];
    const hasCompleteGallery = imagePaths.length > 0 && (!imageCount || imagePaths.length >= imageCount);
    if (imageCount <= 10 && hasCompleteGallery) {
      return {
        mode: 'gallery',
        files: imagePaths.map((filePath) => new AttachmentBuilder(filePath, { name: path.basename(filePath) })),
      };
    }
    if (shouldUploadToDiscord(result.sizeBytes, config)) {
      return {
        mode: 'zip',
        files: [new AttachmentBuilder(result.filePath, { name: result.filename || path.basename(result.filePath) })],
      };
    }
    return { files: [], mode: 'link' };
  }

  if (!shouldUploadToDiscord(result.sizeBytes, config)) return { files: [], mode: 'link' };
  return {
    mode: 'video',
    files: [new AttachmentBuilder(result.filePath, { name: result.filename || path.basename(result.filePath) })],
  };
}

function formatSlideshowAlertNote(result, attachmentMode) {
  const imageCount = Number(result?.imageCount ?? 0);
  if (imageCount > 10) {
    return `${imageCount} images. Using the ZIP because Discord galleries support up to 10 attachments.`;
  }
  if (attachmentMode === 'gallery') {
    return `${imageCount || result?.slideshowImagePaths?.length || 'Multiple'} images attached below. The ZIP is saved permanently.`;
  }
  if (attachmentMode === 'zip') {
    return 'Gallery images were not available, so the ZIP is attached below.';
  }
  return 'Use the Download ZIP button for the saved slideshow.';
}

function buildMonitorAlertTitle(username, result, video, now) {
  const uploadAt = resolveUploadTimestampMs(result, video);
  const age = uploadAt ? ` - ${formatCompactDuration(Math.max(0, now - uploadAt))} old` : '';
  return truncateText(`New post by @${username}${age}`, 256);
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

  for (const value of [result.created_at, video.created_at, result.uploadDate, video.uploadDate]) {
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

function canDeleteMonitorPost(interaction) {
  const inGuild = interaction?.inGuild?.() ?? Boolean(interaction?.guildId);
  if (!inGuild) return true;
  return Boolean(
    interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageMessages)
      || interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild),
  );
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
  if (!watches.length) return 'No watched usernames yet.';
  return watches.map((watch) => {
    const last = watch.last_success_at ? new Date(watch.last_success_at).toISOString() : 'never';
    const suffix = watch.last_error ? `, last error: ${watch.last_error}` : '';
    return `@${watch.username} — last success: ${last}${suffix}`;
  }).join('\n');
}

function formatPurgeResult({ scope, counts, removal }) {
  const target = scope === 'all' ? 'all downloads' : 'your downloads';
  const failed = removal.failed.length
    ? ` ${removal.failed.length} file(s) could not be removed from disk.`
    : '';
  return `Purged ${target}: ${counts.files} file record(s), ${counts.links} link(s), ${counts.jobs} job(s). Removed ${removal.deleted} file(s) from disk.${failed}`;
}

function canPurgeAll(interaction) {
  return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
}

function buildStatusEmbed(stats, monitorStatus) {
  return new EmbedBuilder()
    .setColor(UI_COLORS.success)
    .setTitle('TikTok downloader status')
    .addFields(
      { name: 'Watched users', value: String(stats.watchCount), inline: true },
      { name: 'Seen videos', value: String(stats.videoCount), inline: true },
      { name: 'Files', value: String(stats.fileCount), inline: true },
      { name: 'Monitor', value: monitorStatus.running ? 'running' : 'stopped', inline: true },
      { name: 'Last poll', value: monitorStatus.lastPollAt ? new Date(monitorStatus.lastPollAt).toISOString() : 'never', inline: true },
    )
    .setTimestamp(new Date());
}

function pingPrefix(config) {
  if (config.pingMode === 'here') return '@here ';
  if (config.pingMode === 'everyone') return '@everyone ';
  if (config.pingMode === 'role' && config.pingRoleId) return `<@&${config.pingRoleId}> `;
  return '';
}

function mediaLabel(result) {
  return result?.mediaType === 'slideshow' ? 'slideshow' : 'post';
}

function alertReadyText(result) {
  return result.reused
    ? `New TikTok ${mediaLabel(result)} delivered from cache.`
    : `New TikTok ${mediaLabel(result)} downloaded.`;
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
