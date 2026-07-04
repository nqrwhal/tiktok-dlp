import { REST, Routes } from 'discord.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandJson } from './commands.js';
import { loadConfig, loadEnvFile } from '../config.js';

function assertRegistrationConfig(config) {
  const missing = [];

  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.discordClientId) missing.push('DISCORD_CLIENT_ID');
  if (!config.discordGuildId) missing.push('DISCORD_GUILD_ID');

  if (missing.length) {
    throw new Error(`Missing required environment variables for command registration: ${missing.join(', ')}`);
  }
}

export async function registerCommands(config) {
  assertRegistrationConfig(config);

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const route = Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId);
  return rest.put(route, { body: commandJson });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  await loadEnvFile();
  const config = loadConfig();
  await registerCommands(config);
  console.log(`Registered ${commandJson.length} slash commands for guild ${config.discordGuildId}.`);
}
