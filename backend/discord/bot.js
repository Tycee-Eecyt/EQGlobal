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

function formatProgressBar(progress, length = 16) {
  const filledSymbol = '🟩';
  const emptySymbol = '⬜';
  if (!Number.isFinite(progress)) {
    return `${emptySymbol.repeat(length)}`;
  }
  const clamped = Math.max(0, Math.min(1, progress));
  const filled = Math.round(clamped * length);
  return `${filledSymbol.repeat(filled)}${emptySymbol.repeat(length - filled)}`;
}

function formatRespawn(mob) {
  if (mob.respawnDisplay) {
    return ` (${mob.respawnDisplay})`;
  }
  if (Number.isFinite(mob.minRespawnMinutes) && Number.isFinite(mob.maxRespawnMinutes)) {
    const minHours = Math.round(mob.minRespawnMinutes / 60);
    const maxHours = Math.round(mob.maxRespawnMinutes / 60);
    if (minHours === maxHours) {
      return ` (${minHours} hours)`;
    }
    return ` (${minHours}-${maxHours} hours)`;
  }
  return '';
}

function formatDurationMinutes(minutes) {
  if (!Number.isFinite(minutes)) return 'Unknown';
  if (minutes === 0) return '0m';
  if (minutes < 0) return 'Unknown';
  const totalMinutes = Math.round(minutes);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && !hours && mins) parts.push(`${mins}m`);
  return parts.join(' ') || 'Unknown';
}

function buildDashboardEmbeds(snapshot, options = {}) {
  const limit = Math.max(1, Math.min(25, Number(options.limit) || DEFAULT_DASHBOARD_LIMIT));
  const mobs = Array.isArray(snapshot?.mobs) ? snapshot.mobs : [];

  const inWindow = mobs
    .filter((mob) => mob.inWindow)
    .sort((a, b) => (a.secondsUntilClose || 0) - (b.secondsUntilClose || 0));

  const upcoming = mobs
    .filter((mob) => !mob.inWindow && mob.windowOpensAt && mob.secondsUntilOpen > 0 && mob.secondsUntilOpen <= 86_400)
    .sort((a, b) => (a.secondsUntilOpen || 0) - (b.secondsUntilOpen || 0));

  const future = mobs
    .filter((mob) => !mob.inWindow && mob.windowOpensAt && mob.secondsUntilOpen > 86_400)
    .sort((a, b) => (a.secondsUntilOpen || 0) - (b.secondsUntilOpen || 0));

  const unknown = mobs.filter((mob) => !mob.lastKillAt).length;

  const windowLimit = Math.max(1, Math.min(10, Math.ceil(limit / 2)));
  const upcomingLimit = Math.max(1, Math.min(10, Math.ceil((limit - windowLimit) / 2)));
  const futureLimit = Math.max(1, Math.min(10, limit - windowLimit - upcomingLimit));

  const windowLines = inWindow.slice(0, windowLimit).map((mob) => {
    const zone = mob.zone ? ` (${mob.zone})` : '';
    const respawn = formatRespawn(mob);
    const endsAt = discordTime(mob.windowClosesAt, 't');
    const endsRelative = discordTime(mob.windowClosesAt, 'R');
    const bar = formatProgressBar(mob.windowProgress);
    return `**${mob.name}**${respawn}${zone}\nWindow ends ${endsRelative} (${endsAt})\n${bar}`;
  });

  const upcomingLines = upcoming.slice(0, upcomingLimit).map((mob) => {
    const zone = mob.zone ? ` (${mob.zone})` : '';
    const respawn = formatRespawn(mob);
    const opensAt = discordTime(mob.windowOpensAt, 't');
    const opensRelative = discordTime(mob.windowOpensAt, 'R');
    return `**${mob.name}**${respawn}${zone}\nOpens ${opensRelative} (${opensAt})`;
  });

  const futureLines = future.slice(0, futureLimit).map((mob) => {
    const zone = mob.zone ? ` (${mob.zone})` : '';
    const respawn = formatRespawn(mob);
    const opensRelative = discordTime(mob.windowOpensAt, 'R');
    return `**${mob.name}**${respawn}${zone} — ${opensRelative}`;
  });

  const summary = `In window: ${inWindow.length} | Next 24h: ${upcoming.length} | Future: ${future.length} | Unknown: ${unknown}`;
  const generatedAt = new Date(snapshot?.generatedAt || Date.now());

  const embeds = [];

  const windowEmbed = new EmbedBuilder()
    .setTitle('Mobs In Window')
    .setDescription(summary)
    .setColor(0xf0a23b)
    .setTimestamp(generatedAt)
    .setFooter({ text: 'These are currently in window. Be prepared!' });

  if (windowLines.length > 0) {
    windowEmbed.addFields({ name: 'Current', value: windowLines.join('\n\n').slice(0, 1024) });
  } else {
    windowEmbed.addFields({ name: 'Current', value: 'No mobs are currently in window.' });
  }

  embeds.push(windowEmbed);

  const upcomingEmbed = new EmbedBuilder()
    .setTitle('Mobs Entering Window In The Next 24 Hours')
    .setColor(0x5aa2d8);

  if (upcomingLines.length > 0) {
    upcomingEmbed.addFields({ name: 'Upcoming', value: upcomingLines.join('\n\n').slice(0, 1024) });
  } else {
    upcomingEmbed.addFields({ name: 'Upcoming', value: 'No upcoming windows in the next 24 hours.' });
  }

  embeds.push(upcomingEmbed);

  const futureEmbed = new EmbedBuilder()
    .setTitle('Future Windows')
    .setColor(0x4b4f56);

  if (futureLines.length > 0) {
    futureEmbed.addFields({ name: 'Later', value: futureLines.join('\n').slice(0, 1024) });
  } else {
    futureEmbed.addFields({ name: 'Later', value: 'No future windows yet.' });
  }

  embeds.push(futureEmbed);

  return embeds;
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

    const embeds = buildDashboardEmbeds(snapshot, { limit: DEFAULT_DASHBOARD_LIMIT });
    if (!dashboardMessageId) {
      await loadDashboardState();
    }

    if (dashboardMessageId) {
      try {
        const message = await channel.messages.fetch(dashboardMessageId);
        await message.edit({ embeds });
        return;
      } catch (err) {
        dashboardMessageId = null;
      }
    }

    const sent = await channel.send({ embeds });
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
      return { kind: 'quake', timeText: timeText || null };
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

  function parseHelpText(content) {
    if (!content) return null;
    const trimmed = content.trim();
    if (!/^!?help\b/i.test(trimmed)) return null;
    return { kind: 'help' };
  }

  function parseShowText(content) {
    if (!content) return null;
    const trimmed = content.trim();
    const match = trimmed.match(/^!?show(?:\s+(.+))?$/i);
    if (!match) return null;
    const target = match[1] ? match[1].trim() : '';
    return { kind: 'show', target: target || null };
  }

  function parseSkipText(content) {
    if (!content) return null;
    const trimmed = content.trim();
    const match = trimmed.match(/^!?skip\s+(.+)/i);
    if (!match) return null;
    const target = match[1].trim();
    return target ? { kind: 'skip', target } : null;
  }

  function parseUnskipText(content) {
    if (!content) return null;
    const trimmed = content.trim();
    const match = trimmed.match(/^!?unskip\s+(.+)/i);
    if (!match) return null;
    const target = match[1].trim();
    return target ? { kind: 'unskip', target } : null;
  }

  function buildQuakeHelpEmbed() {
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setDescription(
        [
          'Clears TODs for all timers with a TOD before the specified time. If no time is specified, it will clear all timers with a TOD.',
          '',
          '!quake [time]',
          '!quake predict',
          '!quake chance',
          '!quake list',
          '',
          'Examples:',
          '',
          '!quake 2 hours ago',
          '!quake last friday at 9pm',
          '!quake now',
        ].join('\n')
      );
  }

  function buildHelpEmbed() {
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Spawn Timer Bot Help Menu')
      .setDescription(
        [
          'To see how to use a specific command, run the command without any options.',
          '',
          'List of available commands:',
          '```',
          '!register       - Register a new timer that you want to start tracking.',
          '!unregister     - Removes a previously registered timer.',
          '!alias          - Adds or removes an alias on a timer.',
          '!show           - Displays configuration about a timer.',
          '!rename         - Renames an existing timer.',
          '!tod            - Record a time of death for a registered timer.',
          '!todremove      - Remove a time of death for a registered timer.',
          '!register_link  - Register/unregister a timer to automatically set TOD when another timer TOD is set.',
          "!register_clear - Register/unregister a timer to be cleared when another timer's tod is registered.",
          '!set_warn_time  - Allow to adjust when the warning alert will be sent out for timer, or at all.',
          '!todhistory     - Show last 10 TODs recorded for a registered timer.',
          '!autotod        - Enables/Disables automatic tod when a timer expires. Only works on timers with no window.',
          '!skip           - Record a skipped spawn for a registered timer.',
          '!unskip         - Removes the last skip for a registered timer.',
          '!timers         - See the list of timers that have been registered.',
          '!schedule       - Outputs a human readable schedule for the 7 days.',
          '!leaderboard    - Displays leaderboard of TOD by user',
          '!quake          - Resets the TOD for all timers. Warning!!! Know what you are doing. This will also post an QUAKE message',
          '                 to an quake alert channel, if defined',
          '```',
        ].join('\n')
      );
  }

  async function buildShowEmbed(target) {
    const mob = await resolveMob(target);
    if (!mob || !mob.definition) return null;
    const definition = mob.definition;
    const db = await options.getDb();
    const doc = await db.collection('mob_windows').findOne({ _id: 'global' });
    const snapshot = options.buildSnapshotFromKills(doc?.kills || {}, doc?.skips || {});
    const entry = Array.isArray(snapshot?.mobs) ? snapshot.mobs.find((m) => m.id === mob.id) : null;
    const minMinutes = Number(definition.minRespawnMinutes);
    const maxMinutes = Number(definition.maxRespawnMinutes);
    const varianceMinutes = Number.isFinite(minMinutes) && Number.isFinite(maxMinutes) ? maxMinutes - minMinutes : null;
    const lastTod = entry?.lastKillAt ? discordTime(entry.lastKillAt, 'f') : 'NEED TOD';
    const skipCount = Number.isFinite(entry?.skipCount) ? entry.skipCount : 0;
    const maxSkips = Number.isFinite(entry?.maxSkips) ? entry.maxSkips : null;
    const skipLine = maxSkips !== null ? `${skipCount} / ${maxSkips}` : `${skipCount}`;

    const lines = [
      `Configuration for ${definition.name || mob.id}.`,
      '',
      `Start: ${formatDurationMinutes(minMinutes)}`,
      `End: ${formatDurationMinutes(maxMinutes)}`,
      `Variance: ${formatDurationMinutes(varianceMinutes)}`,
      `Skip Count: ${skipLine}`,
      `Last TOD: ${lastTod}`,
      'Alerted: Unknown',
      'Alerting Soon: Unknown',
      'Warn Time: Unknown',
      'Autotod: Unknown',
    ];

    return new EmbedBuilder()
      .setColor(0x2f3136)
      .setDescription(lines.join('\n'));
  }

  async function applySkipDelta(mob, delta) {
    const db = await options.getDb();
    const collection = db.collection('mob_windows');
    const doc = await collection.findOne({ _id: 'global' });
    const kills = doc && doc.kills ? { ...doc.kills } : {};
    const skips = doc && doc.skips ? { ...doc.skips } : {};
    const current = Number(skips[mob.id] || 0);
    const next = Math.max(0, current + delta);
    const maxSkips = Number.isFinite(mob.definition?.maxSkips) ? mob.definition.maxSkips : null;
    if (delta > 0 && maxSkips !== null && next > maxSkips) {
      return { ok: false, reason: `Max skip count reached (${current} / ${maxSkips}).` };
    }
    if (next === 0) {
      delete skips[mob.id];
    } else {
      skips[mob.id] = next;
    }
    await collection.updateOne(
      { _id: 'global' },
      { $set: { kills, skips, updatedAt: new Date() } },
      { upsert: true }
    );
    const snapshot = options.buildSnapshotFromKills(kills, skips);
    await notifyMobUpdates({ snapshot, updatedMobIds: [], clearedMobIds: [] });
    return { ok: true, skipCount: next, maxSkips };
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

    const parsedHelp = parseHelpText(message.content);
    if (parsedHelp) {
      await message.reply({ embeds: [buildHelpEmbed()] });
      return;
    }

    const parsedShow = parseShowText(message.content);
    if (parsedShow) {
      if (!parsedShow.target) {
        await message.reply('Usage: !show <mob>');
        return;
      }
      const showEmbed = await buildShowEmbed(parsedShow.target);
      if (!showEmbed) {
        await message.reply(`Unknown mob: ${parsedShow.target}`);
        return;
      }
      await message.reply({ embeds: [showEmbed] });
      return;
    }

    const parsedSkip = parseSkipText(message.content);
    if (parsedSkip) {
      const mob = await resolveMob(parsedSkip.target);
      if (!mob) {
        await message.reply(`Unknown mob: ${parsedSkip.target}`);
        return;
      }
      const result = await applySkipDelta(mob, 1);
      if (!result.ok) {
        await message.reply(result.reason);
        return;
      }
      const label = result.maxSkips !== null ? `${result.skipCount} / ${result.maxSkips}` : `${result.skipCount}`;
      await message.reply(`Skipped ${mob.definition?.name || mob.id}. Skip Count: ${label}`);
      return;
    }

    const parsedUnskip = parseUnskipText(message.content);
    if (parsedUnskip) {
      const mob = await resolveMob(parsedUnskip.target);
      if (!mob) {
        await message.reply(`Unknown mob: ${parsedUnskip.target}`);
        return;
      }
      const result = await applySkipDelta(mob, -1);
      if (!result.ok) {
        await message.reply(result.reason);
        return;
      }
      const label = result.maxSkips !== null ? `${result.skipCount} / ${result.maxSkips}` : `${result.skipCount}`;
      await message.reply(`Removed skip for ${mob.definition?.name || mob.id}. Skip Count: ${label}`);
      return;
    }

    const parsed = parseTodText(message.content);
    if (!parsed) return;

    const now = new Date();
    if (parsed.kind === 'quake' && !parsed.timeText) {
      await message.reply({ embeds: [buildQuakeHelpEmbed()] });
      return;
    }

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
    const snapshot = options.buildSnapshotFromKills(doc?.kills || {}, doc?.skips || {});
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
