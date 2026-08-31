import { SlashCommandBuilder } from 'discord.js';

const downloadCommand = new SlashCommandBuilder()
  .setName('download')
  .setDescription('Save media from a supported social post.')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('TikTok, Instagram, or X post URL.')
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
  .setDescription('Manage watched TikTok usernames (TikTok only for now).')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a TikTok username to the watch list.')
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
      .setDescription('Remove a TikTok username from the watch list.')
      .addStringOption((option) =>
        option
          .setName('username')
          .setDescription('TikTok username.')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('List watched TikTok usernames.'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('run')
      .setDescription('Run a TikTok watch check for a username.')
      .addStringOption((option) =>
        option
          .setName('username')
          .setDescription('TikTok username.')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('failures')
      .setDescription('List monitored posts awaiting manual download retry.')
      .addStringOption((option) =>
        option
          .setName('username')
          .setDescription('Optional TikTok username filter.')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('retry')
      .setDescription('Retry one dead-lettered monitored post.')
      .addStringOption((option) =>
        option
          .setName('post_id')
          .setDescription('TikTok post ID from /watch failures.')
          .setRequired(true),
      ),
  );

const profilesCommand = new SlashCommandBuilder()
  .setName('profiles')
  .setDescription('Link profiles that belong to the same creator.')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('link')
      .setDescription('Explicitly link two creator profiles.')
      .addStringOption((option) =>
        option
          .setName('primary')
          .setDescription('First TikTok, Instagram, or X profile URL.')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('secondary')
          .setDescription('Second TikTok, Instagram, or X profile URL.')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Optional shared creator name.')
          .setRequired(false)
          .setMaxLength(100),
      )
      .addBooleanOption((option) =>
        option
          .setName('merge')
          .setDescription('Confirm merging both profiles’ existing creator groups.')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('show')
      .setDescription('Show the profiles linked to a creator profile.')
      .addStringOption((option) =>
        option
          .setName('profile')
          .setDescription('TikTok, Instagram, or X profile URL.')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('unlink')
      .setDescription('Remove a profile from its creator group.')
      .addStringOption((option) =>
        option
          .setName('profile')
          .setDescription('TikTok, Instagram, or X profile URL.')
          .setRequired(true),
      ),
  );

const statusCommand = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show media downloads, queues, and TikTok monitor status.');

const historyCommand = new SlashCommandBuilder()
  .setName('history')
  .setDescription('Show recent generated download links.');

const downloadsCommand = new SlashCommandBuilder()
  .setName('downloads')
  .setDescription('Manage saved download links and files.')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('List your saved permanent downloads.')
      .addIntegerOption((option) =>
        option
          .setName('limit')
          .setDescription('Number of links to show.')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(25),
      )
      .addStringOption((option) =>
        option
          .setName('username')
          .setDescription('Filter by creator username.')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('purge')
      .setDescription('Delete saved download files, links, and download history.')
      .addStringOption((option) =>
        option
          .setName('confirm')
          .setDescription('Type PURGE to confirm.')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('scope')
          .setDescription('What to purge.')
          .setRequired(false)
          .addChoices(
            { name: 'mine', value: 'mine' },
            { name: 'all', value: 'all' },
          ),
      ),
  );

export const commandBuilders = [
  downloadCommand,
  watchCommand,
  profilesCommand,
  statusCommand,
  historyCommand,
  downloadsCommand,
];

export const commandJson = commandBuilders.map((builder) => builder.toJSON());
