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
import { rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { extractTikTokUrls, normalizeUsername, shouldUploadToDiscord, makePublicFileUrl, randomToken } from '../util/files.js';

const LINK_BUTTON_PREFIX = 'link:';
const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

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
        await handleLinkButton({ interaction, config, store });
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      await handleInteraction({ interaction, config, store, monitor, downloadOne });
    } catch (error) {
      console.error('[discord] Interaction failed:', error);
      const message = `Something went wrong: ${error.message ?? error}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: message }).catch(() => {});
      } else {
        await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
      }
    }
  });

  client.on('messageCreate', async (message) => {
    try {
      await handleMessageCreate({ message, config, downloadOne });
    } catch (error) {
      console.error('[discord] Message handling failed:', error);
      await message.reply(`Something went wrong: ${error.message ?? error}`).catch(() => {});
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
      await interaction.reply({ content: `Watching @${watch.username}. Alerts will post in this channel.`, ephemeral: true });
      return;
    }
    if (subcommand === 'remove') {
      const username = normalizeUsername(interaction.options.getString('username', true));
      const removed = store.removeWatch(username);
      await interaction.reply({ content: removed ? `Stopped watching @${username}.` : `@${username} was not watched.`, ephemeral: true });
      return;
    }
    if (subcommand === 'list') {
      const watches = store.listWatches();
      await interaction.reply({ content: formatWatchList(watches), ephemeral: true });
      return;
    }
    if (subcommand === 'run') {
      await interaction.deferReply({ ephemeral: true });
      const username = normalizeUsername(interaction.options.getString('username', true));
      const result = await monitor.pollUsername(username, { force: true });
      await interaction.editReply(`Checked @${username}: ${result.newVideos ?? 0} new video(s), ${result.skipped ?? 0} already seen.`);
      return;
    }
  }

  if (command === 'status') {
    await interaction.reply({ embeds: [buildStatusEmbed(store.stats(), monitor.status())], ephemeral: true });
    return;
  }

  if (command === 'history') {
    await interaction.reply({ content: formatHistory(store.listJobs(10)), ephemeral: true });
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

  const status = await message.reply(
    urls.length === 1
      ? 'Downloading TikTok link...'
      : `Downloading ${urls.length} TikTok links...`,
  );

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
        await status.edit(`Downloaded ${index + 1}/${urls.length} TikTok links.`);
        await message.reply(payload);
      }
    } catch (error) {
      const content = `Could not download ${url}: ${error.message ?? error}`;
      if (urls.length === 1) {
        await status.edit({ content, embeds: [], components: [], files: [] });
      } else {
        await message.reply(content);
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
  return [
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
  ].join('\n');
}

export async function handleDownloadsInteraction({ interaction, config, store }) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'list') {
    const limit = interaction.options.getInteger('limit') ?? 10;
    const userId = interaction.user?.id ?? '';
    const links = store.listDownloadLinksByRequester(userId, { limit, activeOnly: true, includeMonitored: true });
    const total = store.countDownloadLinksByRequester(userId, { activeOnly: true, includeMonitored: true });
    await interaction.reply({
      content: formatUserDownloadLinks(links, {
        config,
        total,
        limit,
      }),
      ephemeral: true,
    });
    return;
  }

  if (subcommand === 'purge') {
    const scope = interaction.options.getString('scope') ?? 'mine';
    const confirm = interaction.options.getString('confirm', true);

    if (confirm !== 'PURGE') {
      await interaction.reply({ content: 'Purge cancelled. Run it again with `confirm:PURGE`.', ephemeral: true });
      return;
    }

    if (scope === 'all' && !canPurgeAll(interaction)) {
      await interaction.reply({ content: 'Only members with Manage Server can purge all downloads.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const requestedBy = scope === 'mine' ? interaction.user?.id ?? '' : '';
    const files = store.listFilesForPurge({ requestedBy });
    const counts = store.purgeDownloads({ requestedBy });
    const removal = await removeStoredFiles(files, config);
    await interaction.editReply(formatPurgeResult({ scope, counts, removal }));
  }
}

export async function sendVideoAlert({ client, config, store, result, video, watch }) {
  const channelId = watch?.channel_id || config.discordChannelId;
  const channel = await client.channels.fetch(channelId);
  const delivery = 'auto';
  const payload = await buildDeliveryPayload(result, config, delivery, {
    contentPrefix: pingPrefix(config),
    alert: true,
    video,
  });
  await channel.send(payload);
  if (video?.id) {
    store.markVideoSeen({
      videoId: video.id,
      username: watch?.username || video.username || result.username,
      sourceUrl: video.url || result.sourceUrl,
      title: video.title || result.title,
      alertedAt: Date.now(),
    });
  }
}

export async function buildDeliveryPayload(result, config, requestedDelivery = 'auto', options = {}) {
  const canUpload = shouldUploadToDiscord(result.sizeBytes, config);
  const wantsFile = requestedDelivery === 'file' || (requestedDelivery === 'auto' && canUpload);
  const embed = buildVideoEmbed(result, options.video);
  const contentPrefix = options.contentPrefix ?? '';

  if (wantsFile && canUpload) {
    const attachment = new AttachmentBuilder(result.filePath, { name: result.filename || path.basename(result.filePath) });
    const link = result.publicUrl || (result.token ? makePublicFileUrl(config, result.token) : '');
    return {
      content: `${contentPrefix}${options.alert ? 'New TikTok video downloaded.' : 'Download ready.'}${link ? `\n15-day link: ${link}` : ''}`.trim(),
      embeds: [embed],
      files: [attachment],
      components: buildLinkManagementRows(result.token),
    };
  }

  if (requestedDelivery === 'file' && !canUpload) {
    return {
      content: `File is too large for Discord upload (${formatBytes(result.sizeBytes)}). Use delivery:link or auto.`,
      embeds: [embed],
    };
  }

  const link = result.publicUrl || (result.token ? makePublicFileUrl(config, result.token) : '');
  return {
    content: `${contentPrefix}${link ? `Download ready: ${link}` : 'Download ready, but PUBLIC_BASE_URL is not configured for links.'}\nKeep the link longer? Use the buttons below.`.trim(),
    embeds: [embed],
    components: buildLinkManagementRows(result.token),
  };
}

export async function handleLinkButton({ interaction, config, store }) {
  const customId = String(interaction.customId ?? '');
  if (!customId.startsWith(LINK_BUTTON_PREFIX)) return false;

  const [, action, token] = customId.split(':');
  if (!token) {
    await interaction.reply({ content: 'That link action is missing its token.', ephemeral: true });
    return true;
  }

  const record = store.getToken(token);
  if (!record) {
    await interaction.reply({ content: 'I cannot find that download anymore.', ephemeral: true });
    return true;
  }

  if (action === 'new') {
    const newToken = randomToken();
    const expiresAt = Date.now() + FIFTEEN_DAYS_MS;
    store.createLinkToken({ token: newToken, fileId: record.id, expiresAt });
    await interaction.reply({
      content: `New 15-day link: ${makePublicFileUrl(config, newToken)}`,
      ephemeral: true,
    });
    return true;
  }

  if (action === 'extend') {
    const updated = store.extendLinkToken(token, FIFTEEN_DAYS_MS);
    await interaction.reply({
      content: updated?.expires_at === 0
        ? `This link is already permanent: ${makePublicFileUrl(config, token)}`
        : `Extended by 15 days. New expiry: ${formatExpiry(updated?.expires_at)}\n${makePublicFileUrl(config, token)}`,
      ephemeral: true,
    });
    return true;
  }

  if (action === 'permanent') {
    store.setLinkTokenPermanent(token);
    await interaction.reply({
      content: `Permanent link kept: ${makePublicFileUrl(config, token)}`,
      ephemeral: true,
    });
    return true;
  }

  await interaction.reply({ content: 'Unknown link action.', ephemeral: true });
  return true;
}

function buildLinkManagementRows(token) {
  if (!token) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${LINK_BUTTON_PREFIX}new:${token}`)
        .setLabel('New 15-day link')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${LINK_BUTTON_PREFIX}extend:${token}`)
        .setLabel('Extend 15d')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${LINK_BUTTON_PREFIX}permanent:${token}`)
        .setLabel('Keep permanently')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

export function buildVideoEmbed(result, video = {}) {
  const title = result.title || video.title || 'TikTok video';
  const sourceUrl = result.sourceUrl || video.url;
  const embed = new EmbedBuilder()
    .setColor(0x00f2ea)
    .setTitle(title.slice(0, 256))
    .setTimestamp(new Date())
    .setFooter({ text: `${result.videoId || video.id || 'unknown'} • ${formatBytes(result.sizeBytes || 0)}` });
  if (sourceUrl) embed.setURL(sourceUrl);
  if (result.username || video.username) embed.setAuthor({ name: `@${result.username || video.username}` });
  if (result.description) embed.setDescription(String(result.description).slice(0, 4000));
  if (result.thumbnailUrl || video.thumbnail) embed.setThumbnail(result.thumbnailUrl || video.thumbnail);
  return embed;
}

function formatWatchList(watches) {
  if (!watches.length) return 'No watched usernames yet.';
  return watches.map((watch) => {
    const last = watch.last_success_at ? new Date(watch.last_success_at).toISOString() : 'never';
    const suffix = watch.last_error ? `, last error: ${watch.last_error}` : '';
    return `@${watch.username} — last success: ${last}${suffix}`;
  }).join('\n');
}

function formatHistory(jobs) {
  if (!jobs.length) return 'No download jobs yet.';
  return jobs.map((job) => {
    const when = new Date(job.created_at).toISOString();
    const target = job.username ? `@${job.username}` : job.source_url;
    return `#${job.id} ${job.status} ${target} ${when}${job.error ? ` — ${job.error}` : ''}`;
  }).join('\n').slice(0, 1900);
}

function formatUserDownloadLinks(links, { config, total, limit }) {
  if (!links.length) return 'You do not have any active download links yet.';

  const rows = links.map((link, index) => {
    const label = link.title || link.filename || link.source_url || 'download';
    const url = makePublicFileUrl(config, link.token);
    return [
      `${index + 1}. ${label.slice(0, 90)}`,
      url,
      `expires: ${formatExpiry(link.expires_at)} • ${formatBytes(link.size_bytes)}`,
    ].join('\n');
  });
  const suffix = total > links.length ? `\n\nShowing ${links.length} of ${total} active links. Use \`limit:${Math.min(25, total)}\` to see more.` : '';
  return `${rows.join('\n\n')}${suffix}`.slice(0, 1900);
}

function formatPurgeResult({ scope, counts, removal }) {
  const target = scope === 'all' ? 'all downloads' : 'your downloads';
  const failed = removal.failed.length
    ? ` ${removal.failed.length} file(s) could not be removed from disk.`
    : '';
  return `Purged ${target}: ${counts.files} file record(s), ${counts.links} link(s), ${counts.jobs} job(s). Removed ${removal.deleted} file(s) from disk.${failed}`;
}

async function removeStoredFiles(files, config) {
  const seen = new Set();
  const failed = [];
  let deleted = 0;

  for (const file of files) {
    const filePath = resolveStoredDownloadPath(config.downloadDir, file.path);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);

    try {
      await rm(filePath, { force: true });
      deleted += 1;
      await removeEmptyParents(path.dirname(filePath), config.downloadDir);
    } catch (error) {
      failed.push({ file, error });
    }
  }

  return { deleted, failed };
}

async function removeEmptyParents(startDir, downloadDir) {
  const root = path.resolve(downloadDir);
  let current = path.resolve(startDir);

  while (current.startsWith(root) && current !== root) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function resolveStoredDownloadPath(downloadDir, filePath) {
  const root = path.resolve(downloadDir);
  const resolved = path.isAbsolute(String(filePath ?? ''))
    ? path.resolve(String(filePath))
    : path.resolve(root, String(filePath ?? ''));
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function canPurgeAll(interaction) {
  return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
}

function buildStatusEmbed(stats, monitorStatus) {
  return new EmbedBuilder()
    .setColor(0x22c55e)
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

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatExpiry(value) {
  if (Number(value) === 0) return 'never';
  return value ? new Date(value).toISOString() : 'unknown';
}
