const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, PermissionsBitField } = require('discord.js');

const DASHBOARD_STATE_ID = 'dashboard_message';
const DEFAULT_DASHBOARD_LIMIT = 20;
const MAX_UPDATE_LINES = 20;

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^true$/i.test(String(value));
}

function safeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toUnixSeconds(value) {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function discordTime(value, style = 'f') {
  const seconds = toUnixSeconds(value);
  if (!seconds) return 'unknown';
  return `<t:${seconds}:${style}>`;
}

function buildDashboardEmbed(snapshot, options = {}) {
  const limit = Math.max(1, Math.min(25, Number(options.limit) || DEFAULT_DASHBOARD_LIMIT));
  const mobs = Array.isArray(snapshot?.mobs) ? snapshot.mobs : [];

  const inWindow = mobs
    .filter((mob) => mob.inWindow)
    .sort((a, b) => (a.secondsUntilClose || 0) - (b.secondsUntilClose || 0));

  const upcoming = mobs
    .filter((mob) => !mob.inWindow && mob.windowOpensAt && mob.secondsUntilOpen > 0)
    .sort((a, b) => (a.secondsUntilOpen || 0) - (b.secondsUntilOpen || 0));

  const unknown = mobs.filter((mob) => !mob.lastKillAt).length;

  const selected = [];
  inWindow.forEach((mob) => {
    if (selected.length < limit) selected.push({ mob, status: 'OPEN' });
  });
  upcoming.forEach((mob) => {
    if (selected.length < limit) selected.push({ mob, status: 'NEXT' });
  });

  const lines = selected.map(({ mob, status }) => {
    const zone = mob.zone ? ` (${mob.zone})` : '';
    if (status === 'OPEN') {
      return `**${mob.name}**${zone} — OPEN until ${discordTime(mob.windowClosesAt, 't')} (${discordTime(mob.windowClosesAt, 'R')})`;
    }
    return `**${mob.name}**${zone} — opens ${discordTime(mob.windowOpensAt, 't')} (${discordTime(mob.windowOpensAt, 'R')})`;
  });

  const summary = `In window: ${inWindow.length} | Next: ${upcoming.length} | Unknown: ${unknown}`;

  const embed = new EmbedBuilder()
    .setTitle('Mob Timers')
    .setDescription(summary)
    .setColor(0x2f3136)
    .setTimestamp(new Date(snapshot?.generatedAt || Date.now()));

  if (lines.length > 0) {
    embed.addFields({ name: 'Status', value: lines.join('\n').slice(0, 1024) });
  } else {
    embed.addFields({ name: 'Status', value: 'No timers available yet.' });
  }

  return embed;
}

function formatUpdateLines({ snapshot, updatedMobIds = [], clearedMobIds = [] }) {
  const mobList = Array.isArray(snapshot?.mobs) ? snapshot.mobs : [];
  const byId = new Map(mobList.map((mob) => [mob.id, mob]));
  const lines = [];

  updatedMobIds.forEach((mobId) => {
    const mob = byId.get(mobId);
    if (!mob) return;
    if (clearedMobIds.includes(mobId) || !mob.lastKillAt) {
      lines.push(`**${mob.name}** — cleared`);
      return;
    }
    lines.push(`**${mob.name}** — ToD ${discordTime(mob.lastKillAt, 'f')} (${discordTime(mob.lastKillAt, 'R')})`);
  });

  if (lines.length > MAX_UPDATE_LINES) {
    const extra = lines.length - MAX_UPDATE_LINES;
    return [...lines.slice(0, MAX_UPDATE_LINES), `...and ${extra} more`];
  }

  return lines;
}

async function registerCommands(token, clientId, guildId) {
  const rest = new REST({ version: '10' }).setToken(token);

  const commands = [
    {
      name: 'mob',
      description: 'Manage mob timers',
      options: [
        {
          type: 1,
          name: 'set',
          description: 'Set a mob ToD',
          options: [
            { type: 3, name: 'mob', description: 'Mob name or alias', required: true },
            { type: 3, name: 'time', description: 'Time (e.g. "now", "2:30pm", "2025-01-02 18:00")', required: false },
          ],
        },
        {
          type: 1,
          name: 'now',
          description: 'Set a mob ToD to now',
          options: [
            { type: 3, name: 'mob', description: 'Mob name or alias', required: true },
          ],
        },
        {
          type: 1,
          name: 'clear',
          description: 'Clear a mob ToD',
          options: [
            { type: 3, name: 'mob', description: 'Mob name or alias', required: true },
          ],
        },
        {
          type: 1,
          name: 'quake',
          description: 'Apply a quake ToD to all mobs',
          options: [
            { type: 3, name: 'time', description: 'Time (default: now)', required: false },
          ],
        },
        {
          type: 1,
          name: 'dashboard',
          description: 'Refresh the dashboard embed',
        },
      ],
    },
  ];

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }
}

function createDiscordBot(options) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID || '';
  const updatesChannelId = process.env.DISCORD_UPDATES_CHANNEL_ID || '';
  const dashboardChannelId = process.env.DISCORD_DASHBOARD_CHANNEL_ID || '';
  const updatesEnabled = envFlag(process.env.DISCORD_UPDATES_ENABLED, false);
  const commandsEnabled = envFlag(process.env.DISCORD_COMMANDS_ENABLED, true);
  const textInputEnabled = envFlag(process.env.DISCORD_TEXT_INPUT_ENABLED, false);
  const textInputChannelId = process.env.DISCORD_TEXT_INPUT_CHANNEL_ID || '';
  const refreshMs = safeInt(process.env.DISCORD_DASHBOARD_REFRESH_MS, 0);
  const officerRoleId = process.env.DISCORD_OFFICER_ROLE_ID || '';

  if (!token || !clientId) {
    return {
      enabled: false,
      start: async () => {},
      notifyMobUpdates: async () => {},
      refreshDashboard: async () => {},
    };
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  let ready = false;
  let dashboardMessageId = null;
  let refreshHandle = null;

  async function loadDashboardState() {
    if (!options?.getDb) return null;
    const db = await options.getDb();
    const doc = await db.collection('discord_state').findOne({ _id: DASHBOARD_STATE_ID });
    if (doc && doc.channelId === dashboardChannelId) {
      dashboardMessageId = doc.messageId || null;
    } else {
      dashboardMessageId = null;
    }
    return doc;
  }

  async function saveDashboardState(messageId) {
    if (!options?.getDb) return;
    const db = await options.getDb();
    await db.collection('discord_state').updateOne(
      { _id: DASHBOARD_STATE_ID },
      { $set: { messageId, channelId: dashboardChannelId, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async function fetchTextChannel(channelId) {
    if (!channelId) return null;
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;
    return channel;
  }

  async function upsertDashboard(snapshot) {
    if (!dashboardChannelId) return;
    const channel = await fetchTextChannel(dashboardChannelId);
    if (!channel) return;

    const embed = buildDashboardEmbed(snapshot, { limit: DEFAULT_DASHBOARD_LIMIT });
    if (!dashboardMessageId) {
      await loadDashboardState();
    }

    if (dashboardMessageId) {
      try {
        const message = await channel.messages.fetch(dashboardMessageId);
        await message.edit({ embeds: [embed] });
        return;
      } catch (err) {
        dashboardMessageId = null;
      }
    }

    const sent = await channel.send({ embeds: [embed] });
    dashboardMessageId = sent.id;
    await saveDashboardState(sent.id);
  }

  async function sendUpdateMessage({ snapshot, updatedMobIds, clearedMobIds }) {
    if (!updatesEnabled) return;
    if (!updatesChannelId) return;
    const channel = await fetchTextChannel(updatesChannelId);
    if (!channel) return;
    const lines = formatUpdateLines({ snapshot, updatedMobIds, clearedMobIds });
    if (lines.length === 0) return;
    const content = lines.join('\n').slice(0, 1900);
    await channel.send({ content });
  }

  function hasCommandPermission(interaction) {
    if (!interaction?.member) return false;
    if (officerRoleId && interaction.member.roles?.cache?.has(officerRoleId)) return true;
    const perms = interaction.member.permissions;
    return perms && new PermissionsBitField(perms).has(PermissionsBitField.Flags.ManageGuild);
  }

  function hasMessagePermission(message) {
    if (!message?.member) return false;
    if (officerRoleId && message.member.roles?.cache?.has(officerRoleId)) return true;
    const perms = message.member.permissions;
    return perms && new PermissionsBitField(perms).has(PermissionsBitField.Flags.ManageGuild);
  }

  async function resolveMob(text) {
    if (!text) return null;
    if (options?.mobDefinitionsById?.has(text)) {
      return { id: text, definition: options.mobDefinitionsById.get(text) };
    }
    return options?.findMobByAlias ? options.findMobByAlias(text) : null;
  }

  function isTimeish(text) {
    if (!text) return false;
    return /(\d|now|yesterday|today|tomorrow|am|pm|:|\/|-)/i.test(text);
  }

  function parseTodText(content) {
    if (!content) return null;
    const trimmed = content.trim();
    const match = trimmed.match(/^!?tod\s+(.+)/i);
    if (!match) return null;
    let remainder = match[1].trim();
    if (!remainder) return null;

    remainder = remainder.replace(/^[`"'`]+/, '').replace(/[`"'`]+$/, '').trim();

    const quakeMatch = remainder.match(/^quake\b/i);
    if (quakeMatch) {
      let timeText = remainder.slice(quakeMatch[0].length).trim();
      timeText = timeText.replace(/^[,|\-]+\s*/, '').trim();
      return { kind: 'quake', timeText: timeText || 'now' };
    }

    const sepIndex = remainder.search(/[|,]/);
    const initialTarget = sepIndex >= 0 ? remainder.slice(0, sepIndex).trim() : remainder;
    let timeText = sepIndex >= 0 ? remainder.slice(sepIndex + 1).trim() : '';
    if (!timeText) {
      const tokens = remainder.split(/\s+/);
      for (let i = 1; i < tokens.length; i += 1) {
        const candidate = tokens.slice(i).join(' ');
        if (isTimeish(candidate)) {
          timeText = candidate;
          break;
        }
      }
    }

    return { kind: 'mob', target: initialTarget, timeText: timeText || 'now' };
  }

  async function handleSet(interaction, timeText, isQuake = false) {
    const now = new Date();
    const resolvedTime = timeText
      ? options.resolveTemporalExpression?.(timeText, now, now)
      : now;

    if (!resolvedTime || Number.isNaN(resolvedTime.getTime())) {
      await interaction.reply({ content: 'Could not parse that time.', ephemeral: true });
      return;
    }

    const updates = new Map();
    if (isQuake) {
      options.mobDefinitionsById?.forEach((_def, mobId) => {
        updates.set(mobId, resolvedTime.toISOString());
      });
    } else {
      const mobName = interaction.options.getString('mob', true);
      const mob = await resolveMob(mobName);
      if (!mob) {
        await interaction.reply({ content: `Unknown mob: ${mobName}`, ephemeral: true });
        return;
      }
      updates.set(mob.id, resolvedTime.toISOString());
    }

    const db = await options.getDb();
    const result = await options.applyMobKillUpdates(db, updates);
    if (!result) {
      await interaction.reply({ content: 'No update applied.', ephemeral: true });
      return;
    }

    await interaction.reply({
      content: isQuake
        ? `Quake applied for ${updates.size} mobs at ${discordTime(resolvedTime, 'f')}.`
        : `Updated ${updates.size} mob at ${discordTime(resolvedTime, 'f')}.`,
      ephemeral: true,
    });

    await notifyMobUpdates({
      snapshot: result.snapshot,
      updatedMobIds: Array.from(updates.keys()),
      clearedMobIds: [],
    });
  }

  async function clearMob(interaction) {
    const mobName = interaction.options.getString('mob', true);
    const mob = await resolveMob(mobName);
    if (!mob) {
      await interaction.reply({ content: `Unknown mob: ${mobName}`, ephemeral: true });
      return;
    }

    const db = await options.getDb();
    const result = await options.clearMobKill(db, mob.id);
    if (!result) {
      await interaction.reply({ content: `No kill to clear for ${mob.definition?.name || mob.id}.`, ephemeral: true });
      return;
    }

    await interaction.reply({
      content: `Cleared ${mob.definition?.name || mob.id}.`,
      ephemeral: true,
    });

    await notifyMobUpdates({
      snapshot: result.snapshot,
      updatedMobIds: [mob.id],
      clearedMobIds: [mob.id],
    });
  }

  async function handleTextTod(message) {
    if (!textInputEnabled) return;
    if (message.author?.bot) return;
    if (!hasMessagePermission(message)) return;
    if (textInputChannelId && message.channelId !== textInputChannelId) return;

    const parsed = parseTodText(message.content);
    if (!parsed) return;

    const now = new Date();
    const resolvedTime = parsed.timeText
      ? options.resolveTemporalExpression?.(parsed.timeText, now, now)
      : now;

    if (!resolvedTime || Number.isNaN(resolvedTime.getTime())) {
      await message.reply('Could not parse that time.');
      return;
    }

    const updates = new Map();
    if (parsed.kind === 'quake') {
      options.mobDefinitionsById?.forEach((_def, mobId) => {
        updates.set(mobId, resolvedTime.toISOString());
      });
    } else {
      const mob = await resolveMob(parsed.target);
      if (!mob) {
        await message.reply(`Unknown mob: ${parsed.target}`);
        return;
      }
      updates.set(mob.id, resolvedTime.toISOString());
    }

    const db = await options.getDb();
    const result = await options.applyMobKillUpdates(db, updates);
    if (!result) {
      await message.reply('No update applied.');
      return;
    }

    await message.reply(
      parsed.kind === 'quake'
        ? `Quake applied for ${updates.size} mobs at ${discordTime(resolvedTime, 'f')}.`
        : `Updated ${updates.size} mob at ${discordTime(resolvedTime, 'f')}.`
    );

    await notifyMobUpdates({
      snapshot: result.snapshot,
      updatedMobIds: Array.from(updates.keys()),
      clearedMobIds: [],
    });
  }

  async function refreshDashboard() {
    if (!options?.getDb) return;
    const db = await options.getDb();
    const collection = db.collection('mob_windows');
    const doc = await collection.findOne({ _id: 'global' });
    const snapshot = options.buildSnapshotFromKills(doc?.kills || {});
    await upsertDashboard(snapshot);
  }

  async function notifyMobUpdates(payload) {
    if (!ready) return;
    if (!payload?.snapshot) return;
    await sendUpdateMessage(payload);
    await upsertDashboard(payload.snapshot);
  }

  client.on('ready', async () => {
    ready = true;
    if (commandsEnabled) {
      try {
        await registerCommands(token, clientId, guildId);
        console.log('[discord] Commands registered.');
      } catch (err) {
        console.warn('[discord] Failed to register commands:', err.message);
      }
    }
    try {
      await refreshDashboard();
    } catch (err) {
      console.warn('[discord] Failed to refresh dashboard:', err.message);
    }
    if (refreshMs > 0) {
      refreshHandle = setInterval(() => {
        refreshDashboard().catch((err) => {
          console.warn('[discord] Dashboard refresh failed:', err.message);
        });
      }, refreshMs);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'mob') return;
    if (!hasCommandPermission(interaction)) {
      await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'set') {
        const timeText = interaction.options.getString('time');
        await handleSet(interaction, timeText, false);
      } else if (sub === 'now') {
        await handleSet(interaction, 'now', false);
      } else if (sub === 'quake') {
        const timeText = interaction.options.getString('time') || 'now';
        await handleSet(interaction, timeText, true);
      } else if (sub === 'clear') {
        await clearMob(interaction);
      } else if (sub === 'dashboard') {
        await refreshDashboard();
        await interaction.reply({ content: 'Dashboard refreshed.', ephemeral: true });
      }
    } catch (err) {
      console.error('[discord] Command failed:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Command failed. Check server logs.', ephemeral: true });
      }
    }
  });

  client.on('messageCreate', async (message) => {
    try {
      await handleTextTod(message);
    } catch (err) {
      console.error('[discord] Text ToD failed:', err);
    }
  });

  async function start() {
    await client.login(token);
  }

  async function stop() {
    if (refreshHandle) {
      clearInterval(refreshHandle);
      refreshHandle = null;
    }
    await client.destroy();
  }

  return {
    enabled: true,
    start,
    stop,
    notifyMobUpdates,
    refreshDashboard,
  };
}

module.exports = createDiscordBot;
