import { SlashCommandBuilder } from 'discord.js';

const downloadCommand = new SlashCommandBuilder()
  .setName('download')
  .setDescription('Download a TikTok video.')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('TikTok video URL.')
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName('delivery')
      .setDescription('Delivery mode.')
      .setRequired(false)
      .addChoices(
        { name: 'auto', value: 'auto' },
        { name: 'file', value: 'file' },
        { name: 'link', value: 'link' },
      ),
  );

const watchCommand = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Manage watched TikTok usernames.')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a username to the watch list.')
      .addStringOption((option) =>
        option
          .setName('username')
          .setDescription('TikTok username.')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove a username from the watch list.')
      .addStringOption((option) =>
        option
          .setName('username')
          .setDescription('TikTok username.')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('List watched usernames.'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('run')
      .setDescription('Run a watch check for a username.')
      .addStringOption((option) =>
        option
          .setName('username')
          .setDescription('TikTok username.')
          .setRequired(true),
      ),
  );

const statusCommand = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show bot and queue status.');

const historyCommand = new SlashCommandBuilder()
  .setName('history')
  .setDescription('Show recent download history.');

export const commandBuilders = [
  downloadCommand,
  watchCommand,
  statusCommand,
  historyCommand,
];

export const commandJson = commandBuilders.map((builder) => builder.toJSON());
