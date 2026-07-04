import { AttachmentBuilder, Client, EmbedBuilder, GatewayIntentBits } from 'discord.js';
import path from 'node:path';
import { normalizeUsername, shouldUploadToDiscord, makePublicFileUrl } from '../util/files.js';

export async function startDiscordBot({ config, store, monitor, downloadOne, registerCommands }) {
  if (config.registerCommandsOnStart) {
    await registerCommands(config);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('clientReady', () => {
    console.log(`[discord] Logged in as ${client.user.tag}`);
    monitor.start();
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
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

  await client.login(config.discordToken);
  return client;
}

export async function handleInteraction({ interaction, config, store, monitor, downloadOne }) {
  const command = interaction.commandName;

  if (command === 'download') {
    await interaction.deferReply({ ephemeral: true });
    const url = interaction.options.getString('url', true);
    const delivery = interaction.options.getString('delivery') ?? 'auto';
    const result = await downloadOne(url, { delivery, type: 'manual' });
    await interaction.editReply(await buildDeliveryPayload(result, config, delivery));
    return;
  }

  if (command === 'watch') {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'add') {
      const username = normalizeUsername(interaction.options.getString('username', true));
      const watch = store.addWatch(username, config.discordChannelId);
      await interaction.reply({ content: `Watching @${watch.username}.`, ephemeral: true });
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
    return {
      content: `${contentPrefix}${options.alert ? 'New TikTok video downloaded.' : 'Download ready.'}`.trim(),
      embeds: [embed],
      files: [attachment],
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
    content: `${contentPrefix}${link ? `Download ready: ${link}` : 'Download ready, but PUBLIC_BASE_URL is not configured for links.'}`.trim(),
    embeds: [embed],
  };
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
