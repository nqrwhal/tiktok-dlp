import { EmbedBuilder } from 'discord.js';

export const UI_COLORS = {
  info: 0x00f2ea,
  success: 0x22c55e,
  warning: 0xf59e0b,
  error: 0xef4444,
};

export function buildNoticePayload({ title, description, color = UI_COLORS.info, ephemeral = true }) {
  const payload = {
    embeds: [
      new EmbedBuilder()
        .setColor(color)
        .setTitle(truncateText(title, 256))
        .setDescription(truncateText(description, 4000))
        .setTimestamp(new Date()),
    ],
  };
  if (ephemeral) payload.ephemeral = true;
  return payload;
}

export function buildErrorPayload({ title = 'Something Went Wrong', description, ephemeral = true }) {
  return buildNoticePayload({
    title,
    description,
    color: UI_COLORS.error,
    ephemeral,
  });
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(value) {
  return value ? new Date(value).toISOString() : 'unknown';
}

export function formatExpiry(value) {
  if (Number(value) === 0) return 'never';
  return formatDate(value);
}

export function formatLinkState(expiresAt, now = Date.now()) {
  const value = Number(expiresAt);
  if (value === 0) return 'permanent';
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  return `${value <= now ? 'expired' : 'expires'} ${formatDate(value)}`;
}

export function truncateText(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}
