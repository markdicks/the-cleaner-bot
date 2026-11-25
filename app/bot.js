import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AuditLogEvent, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { credentials, randomToken } from './security.js';
import { businessActive, guildDefaults, serverEventEnabled, snowflake } from './settings.js';
import { normalizeToken } from '../runtime.js';
import { GatewayConnection } from './connection.js';
import { LogDelivery } from './logging.js';
import { channelAuditEvent } from './channel-audit.js';

const manage = PermissionsBitField.Flags.ManageGuild;
const option = (name, description, type, required = false) => ({ name, description, type, required });
const commands = [
    { name: 'dashboard', description: 'Open the server dashboard or securely configure sign-in' },
    { name: 'current-interval', description: 'Show this server\'s cleaning interval' },
    { name: 'add-bot', description: 'Add a bot to this server\'s cleaning targets', options: [option('bot', 'Bot to clean', 6, true), option('rounds', 'Cleaning rounds, or -1 for permanent', 4, true)] },
    { name: 'remove-bot', description: 'Remove a cleaning target', options: [option('bot', 'Bot to remove', 6, true)] },
    { name: 'modify-interval', description: 'Change this server\'s cleaning interval', options: [option('minutes', 'Minutes between cleaning checks', 4, true)] },
    { name: 'configure', description: 'Allow a role to manage cleaning', options: [option('role_id', 'Role', 8, true)] },
    { name: 'set-log-channel', description: 'Set the cleaning log channel', options: [option('channel', 'Text channel', 7, true)] },
    { name: 'add-monitor-channel', description: 'Add a cleaning channel', options: [option('channel', 'Text channel', 7, true)] },
    ...['warn', 'timeout', 'kick', 'ban'].map(name => ({ name, description: `${name[0].toUpperCase() + name.slice(1)} a member`, options: [option('user', 'Member', 6, true), option('reason', 'Reason', 3, true), ...(name === 'timeout' ? [option('minutes', 'Timeout duration', 4)] : [])] })),
    { name: 'purge', description: 'Delete matching recent messages', options: [option('count', 'Messages to inspect, up to 1000', 4, true), option('user', 'Only this member', 6), option('role', 'Only members with this role', 8), option('bots', 'Only bot messages', 5), option('contains', 'Only messages containing text', 3)] },
    { name: 'rank', description: 'Show your XP and level' },
    { name: 'leaderboard', description: 'Show this server\'s XP leaders' }
];

export function voiceEligibleMembers(channel) {
    const members = [...channel.members.values()].filter(member => !member.user.bot && !member.voice.deaf);
    return members.length >= 2 ? members : [];
}

export function findViolation(message, config, recent = []) {
    if (!config.enableModeration || config.ignoredModerationChannelIds.includes(message.channelId) || config.ignoredModerationChannelIds.includes(message.channel?.parentId)) return null;
    const text = message.content || '';
    if (config.enableProfanityFilter && config.blockedWords.some(word => text.toLowerCase().includes(word.toLowerCase()))) return 'Blocked word';
    if (config.enableInviteFilter && /(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i.test(text)) return 'Discord invite';
    if (config.enableLinkFilter && /https?:\/\/\S+/i.test(text)) return 'Blocked link';
    if (config.enableMentionFilter && (message.mentions?.users?.size || 0) + (message.mentions?.roles?.size || 0) >= config.mentionLimit) return 'Mention spam';
    const letters = text.match(/[a-z]/gi) || [];
    if (config.enableCapsFilter && letters.length >= config.capsMinimumLength && letters.filter(char => char === char.toUpperCase()).length * 100 / letters.length >= config.capsPercentage) return 'Excessive capitals';
    if (config.enableAntiSpam && recent.length >= config.spamMessageLimit) return 'Message spam';
    const imageMessages = recent.filter(item => item.images >= 2);
    if (config.enableAntiSpam && imageMessages.length >= 2 && new Set(imageMessages.map(item => item.channelId)).size >= 2) return 'Image flood across channels';
    return null;
}

export class BotController {
    constructor({ store, env = process.env, version, logger = console, createClient, readyTimeoutMs }) {
        this.store = store; this.env = env; this.version = version; this.logger = logger;
        this.pendingSetups = new Map(); this.windows = new Map(); this.voiceSince = new Map(); this.cleaningRuns = new Map();
        this.origin = env.PUBLIC_URL || ''; this.maintenanceBusy = false;
        this.nativeEvents = new Map();
        this.channelEventWindows = new Map();
        this.connection = new GatewayConnection({ createClient, readyTimeoutMs, logger, bindClient: client => this.bindClient(client) });
        this.logDelivery = new LogDelivery({ getClient: () => this.client, isReady: () => this.isReady(), logger });
    }
    get client() { return this.connection.client; }
    get contentAccess() { return this.connection.getStatus().privilegedActive; }
    getConnectionStatus() { return this.connection.getStatus(); }
    bindClient(client) {
        const on = (event, handler) => client.on(event, (...args) => {
            if (this.client !== client || this.connection.activeClient !== client || this.connection.closing) return;
            void Promise.resolve().then(() => { if (this.client === client && this.connection.activeClient === client && !this.connection.closing) return handler(...args); }).catch(error => this.report(event, error));
        });
        on('clientReady', () => this.onReady(client));
        on('interactionCreate', interaction => this.onInteraction(interaction));
        on('messageCreate', message => this.onMessage(message));
        on('messageUpdate', (before, after) => { if (before.content !== after.content && after.guild && !after.author?.bot) return this.onMessage(after, true); });
        on('messageDelete', message => { if (message.guild && !message.author?.bot) return this.serverEvent(message.guild.id, 'messageDeletes', 'Message deleted', message.content || '(not cached)', message.channelId); });
        on('guildMemberAdd', member => this.memberChange(member, true));
        on('guildMemberRemove', member => this.memberChange(member, false));
        on('guildUpdate', (before, after) => { if (before.name !== after.name) return this.serverEvent(after.id, 'serverChanges', 'Server renamed', `${before.name} -> ${after.name}`); });
        on('channelCreate', channel => this.channelEvent(null, channel, 'created'));
        on('channelUpdate', (before, after) => this.channelEvent(before, after, 'updated'));
        on('channelDelete', channel => this.channelEvent(channel, null, 'deleted'));
        on('guildAuditLogEntryCreate', (entry, guild) => this.nativeModeration(entry, guild));
        on('autoModerationActionExecution', execution => this.nativeAutoMod(execution));
        on('voiceStateUpdate', (before, after) => {
            if (before.channelId !== after.channelId || after.deaf) this.voiceSince.delete(`${after.guild.id}:${after.id}`);
            for (const channel of [before.channel, after.channel]) if (channel && !voiceEligibleMembers(channel).length) for (const member of channel.members.values()) this.voiceSince.delete(`${after.guild.id}:${member.id}`);
            if (before.channelId !== after.channelId) void this.serverEvent(after.guild.id, 'voiceChanges', 'Voice channel changed', `<@${after.id}>: ${before.channel?.name || 'disconnected'} -> ${after.channel?.name || 'disconnected'}`).catch(error => this.report('Voice log', error));
        });
        on('error', error => this.report('Discord', error));
    }
    report(area, error) { this.logger.error(`${area}: ${error.code || error.name || 'failed'}`); }
    isReady() { return this.client?.isReady() || false; }
    async getToken() { return credentials(await this.store.read(), this.env).token; }
    async login(token) {
        const config = credentials(await this.store.read(), this.env);
        return this.connection.connect(normalizeToken(token), config.privilegedIntents);
    }
    async restart(privileged) {
        const config = credentials(await this.store.read(), this.env);
        clearInterval(this.timer);
        return this.connection.connect(normalizeToken(config.token), privileged ?? config.privilegedIntents);
    }
    async destroy() { clearInterval(this.timer); await this.connection.destroy(); }
    guilds() { return [...(this.client?.guilds.cache.values() || [])].map(guild => ({ id: guild.id, name: guild.name, memberCount: guild.memberCount, iconUrl: guild.iconURL({ size: 128 }) })); }
    channels(id) { return [...(this.client?.guilds.cache.get(id)?.channels.cache.values() || [])].filter(channel => channel.isTextBased() && !channel.isThread()).map(channel => ({ id: channel.id, name: channel.name, text: true })).sort((a, b) => a.name.localeCompare(b.name)); }
    async getConfig(id) { const state = await this.store.read(); return state.guilds[id] || guildDefaults(id, this.client?.guilds.cache.get(id)?.name); }
    async onReady(client = this.client) {
        if (this.connection.closing || this.client !== client) return;
        client.user.setActivity(`version ${this.version}`);
        await this.store.update(state => {
            for (const guild of this.guilds()) {
                state.guilds[guild.id] ||= guildDefaults(guild.id, guild.name);
                state.guilds[guild.id].guildName = guild.name;
            }
        });
        if (this.connection.closing || this.client !== client) return;
        await this.importLegacyCleaner(client);
        if (this.connection.closing || this.client !== client) return;
        const definitions = commands.map(command => ({ ...command, dmPermission: false }));
        await client.application.commands.set(definitions).catch(error => this.report('Global command registration', error));
        for (const guild of client.guilds.cache.values()) await guild.commands.set(definitions).catch(error => this.report('Server command registration', error));
        if (this.connection.closing || this.client !== client) return;
        clearInterval(this.timer);
        this.timer = setInterval(() => { void this.maintenance().catch(error => this.report('Maintenance', error)); }, 60000);
        this.timer.unref();
        this.logger.log(`Dashboard bot ready. Registered ${commands.length} commands.`);
    }
    async importLegacyCleaner(client = this.client) {
        let legacy;
        try { legacy = JSON.parse(await readFile(path.join(this.store.directory, 'botConfig.json'), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        await this.store.update(state => {
            if (state.importedCleaner) return;
            for (const guild of client.guilds.cache.values()) {
                const channelIds = (legacy.monitorChannels || []).filter(id => guild.channels.cache.has(id));
                if (!channelIds.length && !guild.channels.cache.has(legacy.logChannelId)) continue;
                state.guilds[guild.id].cleaner = { ...state.guilds[guild.id].cleaner, botList: legacy.botList || [], allowedRoles: legacy.allowedRoles || [], monitorChannels: channelIds, logChannelId: guild.channels.cache.has(legacy.logChannelId) ? legacy.logChannelId : '' };
            }
            state.importedCleaner = true;
        });
    }
    createSetupLink(userId, origin) {
        const token = randomToken();
        for (const [key, entry] of this.pendingSetups) if (entry.expires < Date.now()) this.pendingSetups.delete(key);
        this.pendingSetups.set(token, { userId, expires: Date.now() + 5 * 60000 });
        return `${origin}/Auth/Setup?token=${encodeURIComponent(token)}`;
    }
    consumeSetup(token) {
        const entry = this.pendingSetups.get(token);
        this.pendingSetups.delete(token);
        return entry && entry.expires > Date.now() ? entry.userId : null;
    }
    async canManage(guildId, userId, oauthGuilds = [], write = false) {
        const config = credentials(await this.store.read(), this.env);
        if (userId === config.superAdminId) return true;
        const guild = this.client?.guilds.cache.get(guildId);
        if (guild && this.isReady()) {
            try { return (await guild.members.fetch(userId)).permissions.has(manage); }
            catch { return false; }
        }
        return !write && oauthGuilds.includes(guildId);
    }
    async onInteraction(interaction) {
        if (interaction.isButton() && interaction.customId.startsWith('notice:dismiss:')) {
            if (interaction.customId !== `notice:dismiss:${interaction.user.id}`) return interaction.reply({ content: 'This notice is private.', flags: 64 });
            await interaction.update({ content: 'Notice dismissed.', embeds: [], components: [] });
            return;
        }
        if (!interaction.isChatInputCommand() || !interaction.guildId) return;
        await interaction.deferReply({ flags: 64 });
        try {
            const state = await this.store.read();
            const config = state.guilds[interaction.guildId] || guildDefaults(interaction.guildId);
            const superAdmin = credentials(state, this.env).superAdminId === interaction.user.id;
            const command = interaction.commandName;
            if (command === 'dashboard') {
                const origin = this.env.PUBLIC_URL || this.origin;
                if (!origin) throw new Error('Set PUBLIC_URL to the public website origin.');
                const url = superAdmin ? this.createSetupLink(interaction.user.id, origin) : `${origin}/Dashboard`;
                await interaction.editReply({ content: superAdmin && url.includes('/Auth/Setup') ? 'Your private setup link expires in 5 minutes.' : 'Open your server dashboard.', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open dashboard').setStyle(ButtonStyle.Link).setURL(url))] });
                return;
            }
            if (command === 'rank' || command === 'leaderboard') {
                const entries = Object.values(state.levels).filter(entry => entry.guildId === interaction.guildId).sort((a, b) => b.xp - a.xp);
                const own = state.levels[`${interaction.guildId}:${interaction.user.id}`];
                await interaction.editReply(command === 'rank' ? `Level ${own?.level || 0} | ${own?.xp || 0} XP` : entries.slice(0, 10).map((entry, index) => `${index + 1}. ${entry.userTag} - Level ${entry.level} (${entry.xp} XP)`).join('\n') || 'No XP recorded yet.');
                return;
            }
            if (command === 'current-interval') { await interaction.editReply(`Cleaning interval: ${config.cleaner.intervalMinutes} minutes.`); return; }
            const cleanerCommand = ['add-bot', 'remove-bot', 'modify-interval', 'configure', 'set-log-channel', 'add-monitor-channel'].includes(command);
            const cleanerRole = config.cleaner.allowedRoles.some(role => interaction.member.roles.cache.has(role));
            if (!superAdmin && !interaction.memberPermissions.has(manage) && !(cleanerCommand && cleanerRole)) throw new Error('Manage Server permission is required.');
            if (cleanerCommand) {
                await this.store.update(next => {
                    next.guilds[interaction.guildId] ||= config;
                    const cleaner = next.guilds[interaction.guildId].cleaner;
                    if (command === 'add-bot') {
                        const user = interaction.options.getUser('bot', true); const rounds = interaction.options.getInteger('rounds', true);
                        if (!user.bot || user.id === this.client.user.id || (rounds !== -1 && (rounds < 1 || rounds > 10000))) throw new Error('Select another bot and use 1–10,000 rounds, or -1 for permanent.');
                        cleaner.botList = cleaner.botList.filter(bot => bot.botId !== user.id); cleaner.botList.push({ botId: user.id, rounds });
                    }
                    if (command === 'remove-bot') cleaner.botList = cleaner.botList.filter(bot => bot.botId !== interaction.options.getUser('bot', true).id);
                    if (command === 'modify-interval') {
                        const minutes = interaction.options.getInteger('minutes', true);
                        if (minutes < 1 || minutes > 120960) throw new Error('Use between 1 and 120,960 minutes.');
                        cleaner.intervalMinutes = minutes;
                    }
                    if (command === 'configure') cleaner.allowedRoles = [...new Set([...cleaner.allowedRoles, interaction.options.getRole('role_id', true).id])];
                    if (command === 'set-log-channel' || command === 'add-monitor-channel') {
                        const channel = interaction.options.getChannel('channel', true);
                        if (!channel.isTextBased() || channel.guildId !== interaction.guildId) throw new Error('Choose a text channel in this server.');
                        if (command === 'set-log-channel') cleaner.logChannelId = channel.id;
                        else cleaner.monitorChannels = [...new Set([...cleaner.monitorChannels, channel.id])];
                    }
                });
                await interaction.editReply('Cleaning settings saved.'); return;
            }
            if (command === 'purge') {
                const deleted = await this.purge(interaction.guildId, { channelId: interaction.channelId, count: interaction.options.getInteger('count'), userId: interaction.options.getUser('user')?.id, roleId: interaction.options.getRole('role')?.id, bots: interaction.options.getBoolean('bots'), contains: interaction.options.getString('contains') }, interaction.user.id);
                await interaction.editReply(`Deleted ${deleted} messages.`); return;
            }
            await this.moderate(interaction.guildId, command, interaction.options.getUser('user', true).id, interaction.options.getString('reason', true), interaction.user.id, interaction.options.getInteger('minutes') || config.timeoutMinutes);
            await interaction.editReply('Moderation action recorded.');
        } catch (error) { await interaction.editReply({ content: error.expose ? error.message : error.code ? `Discord could not complete the action (${error.code}). Check bot permissions and role order.` : error.message.slice(0, 300), components: [] }); }
    }
    async moderate(guildId, action, targetId, reason, actorId, minutes = 10) {
        if (!['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'].includes(action) || !snowflake(targetId) || !reason?.trim() || reason.length > 500) throw new Error('Choose an action, a valid user ID, and a reason of up to 500 characters.');
        const guild = this.client?.guilds.cache.get(guildId);
        if (!guild || !this.isReady()) throw new Error('The bot must be online in this server.');
        if ([guild.ownerId, this.client.user.id, actorId].includes(targetId)) throw new Error('You cannot moderate yourself, the server owner, or this bot.');
        const member = await guild.members.fetch(targetId).catch(() => null);
        const required = { timeout: 'ModerateMembers', untimeout: 'ModerateMembers', kick: 'KickMembers', ban: 'BanMembers', unban: 'BanMembers', warn: 'ModerateMembers' }[action];
        const state = await this.store.read();
        const isAdmin = credentials(state, this.env).superAdminId === actorId;
        if (actorId !== this.client.user.id && !isAdmin) {
            const actor = await guild.members.fetch(actorId);
            if (!actor.permissions.has(PermissionsBitField.Flags[required])) throw new Error(`${required} permission is required.`);
            if (member && actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(member.roles.highest) <= 0) throw new Error('The member has an equal or higher role than yours.');
        }
        if (action === 'timeout' || action === 'untimeout') {
            if (!member?.moderatable) throw new Error('The bot cannot moderate this member. Check role order.');
            if (action === 'timeout' && (!Number.isInteger(Number(minutes)) || minutes < 1 || minutes > 40320)) throw new Error('Timeout must be between 1 and 40,320 minutes.');
            await member.timeout(action === 'untimeout' ? null : Number(minutes) * 60000, reason);
        } else if (action === 'kick') {
            if (!member?.kickable) throw new Error('The bot cannot kick this member. Check role order.');
            await member.kick(reason);
        } else if (action === 'ban') {
            if (member && !member.bannable) throw new Error('The bot cannot ban this member. Check role order.');
            await guild.members.ban(targetId, { reason });
        } else if (action === 'unban') await guild.members.unban(targetId, reason);
        await this.recordCase(guildId, action, targetId, member?.user.tag || targetId, actorId, reason);
    }
    async purge(guildId, filters, actorId) {
        const count = Number(filters.count);
        const guild = this.client?.guilds.cache.get(guildId);
        const channel = guild?.channels.cache.get(filters.channelId);
        if (!channel?.isTextBased() || !channel.messages || !Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Choose a text channel and a count between 1 and 1,000.');
        const state = await this.store.read();
        if (credentials(state, this.env).superAdminId !== actorId && !(await guild.members.fetch(actorId)).permissionsIn(channel).has(PermissionsBitField.Flags.ManageMessages)) throw new Error('Manage Messages permission is required in this channel.');
        let before; let inspected = 0; const matches = [];
        while (inspected < count) {
            const batch = await channel.messages.fetch({ limit: Math.min(100, count - inspected), ...(before ? { before } : {}) });
            if (!batch.size) break;
            for (const message of batch.values()) {
                if (Date.now() - message.createdTimestamp >= 14 * 86400000) continue;
                if (filters.userId && message.author.id !== filters.userId) continue;
                if (filters.bots && !message.author.bot) continue;
                if (filters.contains && !message.content.toLowerCase().includes(filters.contains.toLowerCase())) continue;
                if (filters.roleId && !(message.member || await guild.members.fetch(message.author.id).catch(() => null))?.roles.cache.has(filters.roleId)) continue;
                matches.push(message.id);
            }
            inspected += batch.size; before = batch.last().id;
            if (batch.size < 100) break;
        }
        let deleted = 0;
        for (let index = 0; index < matches.length; index += 100) deleted += (await channel.bulkDelete(matches.slice(index, index + 100), true)).size;
        await this.recordCase(guildId, 'purge', '', channel.name, actorId, `Deleted ${deleted} of ${count} inspected messages in #${channel.name}.`);
        return deleted;
    }
    async recordCase(guildId, action, targetUserId, targetUserTag, moderatorUserId, reason) {
        await this.store.update(state => { state.cases.push({ id: state.nextCaseId++, guildId, action, targetUserId, targetUserTag, moderatorUserId, reason, createdAt: new Date().toISOString() }); });
        await this.audit(guildId, 'moderation', action, `${action}: ${targetUserTag}`, reason, { targetUserId, moderatorUserId });
    }
    async audit(guildId, category, eventType, title, details, extra = {}) {
        const config = await this.getConfig(guildId);
        const content = category === 'automod' && !config.auditLogs.includeMessageContent ? '(Message content omitted by server settings.)' : String(details);
        const included = config.auditLogs.enabled && (category !== 'moderation' || config.auditLogs.moderationActions !== false) && (category !== 'automod' || config.auditLogs.autoModActions !== false);
        if (businessActive(config) && included) await this.store.update(state => {
            state.audit.push({ guildId, category, eventType, title, details: content.slice(0, 8000), ...extra, createdAt: new Date().toISOString() });
        });
        return this.logDelivery.send(guildId, config, category, title, content);
    }
    async loggingDiagnostics(guildId, config) {
        config ||= await this.getConfig(guildId);
        const checks = await this.logDelivery.diagnostics(guildId, config);
        const me = this.client?.guilds.cache.get(guildId)?.members?.me;
        const moderation = checks.find(check => check.category === 'moderation');
        if (moderation && me && businessActive(config) && !me.permissions?.has(PermissionsBitField.Flags.ViewAuditLog)) moderation.observationWarning = 'Discord-native bans, kicks and timeouts require View Audit Log on the bot role. Bot-issued actions can still be logged.';
        const automod = checks.find(check => check.category === 'automod');
        if (automod && me && !me.permissions?.has(PermissionsBitField.Flags.ManageGuild)) automod.observationWarning = 'Discord-native AutoMod events require Manage Server on the bot role. Bot-filter events can still be logged.';
        return checks;
    }
    async testLog(guildId, category) {
        return this.logDelivery.send(guildId, await this.getConfig(guildId), category, 'The Cleaner log test', 'Log delivery verified. This test was requested from the server dashboard.', true);
    }
    seenNativeEvent(key) {
        const now = Date.now();
        for (const [id, time] of this.nativeEvents) if (time < now - 60000) this.nativeEvents.delete(id);
        if (this.nativeEvents.has(key)) return true;
        if (this.nativeEvents.size >= 1000) this.nativeEvents.delete(this.nativeEvents.keys().next().value);
        this.nativeEvents.set(key, now);
        return false;
    }
    async nativeModeration(entry, guild) {
        if (!guild || entry.executorId === this.client?.user?.id || !businessActive(await this.getConfig(guild.id))) return;
        let action = new Map([[AuditLogEvent.MemberBanAdd, 'ban'], [AuditLogEvent.MemberBanRemove, 'unban'], [AuditLogEvent.MemberKick, 'kick']]).get(entry.action);
        if (entry.action === AuditLogEvent.MemberUpdate) {
            const timeout = entry.changes?.find(change => change.key === 'communication_disabled_until');
            const mute = entry.changes?.find(change => change.key === 'mute');
            if (timeout) action = timeout.new && Date.parse(timeout.new) > Date.now() ? 'timeout' : 'untimeout';
            else if (mute) action = mute.new ? 'mute' : 'unmute';
        }
        if (!action || this.seenNativeEvent(`audit:${guild.id}:${entry.id}`)) return;
        const target = entry.targetId || entry.target?.id;
        if (!target) return;
        await this.recordCase(guild.id, action, target, entry.target?.tag || entry.target?.username || target, entry.executorId || 'Discord', entry.reason || 'Action performed in Discord.');
    }
    async nativeAutoMod(execution) {
        const guildId = execution.guild?.id;
        if (!guildId || !businessActive(await this.getConfig(guildId))) return;
        const content = execution.content || execution.matchedContent || '(Discord did not include message content.)';
        const hash = createHash('sha256').update(`${execution.ruleId}:${execution.userId}:${execution.channelId}:${content}`).digest('hex');
        if (this.seenNativeEvent(`automod:${guildId}:${execution.messageId || hash}`)) return;
        await this.audit(guildId, 'automod', 'discord.automod', 'Discord AutoMod flagged a message', `Member: ${execution.userId}\nChannel: ${execution.channelId || 'unknown'}\n${content}`, { targetUserId: execution.userId, channelId: execution.channelId });
    }
    async channelEvent(before, after, kind) {
        const entry = channelAuditEvent(before, after, kind);
        if (!entry) return;
        // Deduplicate in gateway receipt order, before asynchronous database reads can reorder edits.
        const now = Date.now();
        const key = `${entry.guildId}:${entry.channelId}`;
        const signature = createHash('sha256').update(`${entry.eventType}:${entry.details}`).digest('hex');
        const previous = this.channelEventWindows.get(key);
        if (previous?.signature === signature && now - previous.at < 5000) return;
        for (const [id, snapshot] of this.channelEventWindows) if (now - snapshot.at > 60000) this.channelEventWindows.delete(id);
        if (this.channelEventWindows.size >= 1000) this.channelEventWindows.delete(this.channelEventWindows.keys().next().value);
        this.channelEventWindows.set(key, { signature, at: now });
        return this.serverEvent(entry.guildId, 'channelChanges', entry.title, entry.details, entry.channelId, entry.eventType);
    }
    async serverEvent(guildId, toggle, title, content, channelId, eventType = toggle) {
        const config = await this.getConfig(guildId);
        if (!businessActive(config) || !config.auditLogs.enabled || !serverEventEnabled(config.auditLogs, toggle)) return;
        const omitMessage = ['messageEdits', 'messageDeletes'].includes(toggle) && !config.auditLogs.includeMessageContent;
        return this.audit(guildId, 'server', eventType, title, omitMessage ? '(content omitted)' : content, { channelId });
    }
    async onMessage(message, edited = false) {
        if (!message.guild || message.author.bot || !message.member) return;
        const config = await this.getConfig(message.guildId);
        if (edited) await this.serverEvent(message.guildId, 'messageEdits', 'Message edited', message.content, message.channelId);
        const key = `${message.guildId}:${message.author.id}`;
        const now = Date.now();
        const images = [...message.attachments.values()].filter(attachment => attachment.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || '')).length;
        const recent = (this.windows.get(key) || []).filter(item => item.at > now - Math.max(45, config.spamWindowSeconds) * 1000);
        if (!edited) recent.push({ at: now, channelId: message.channelId, images, id: message.id });
        this.windows.set(key, recent.slice(-50));
        const violation = message.member.permissions.has(manage) ? null : findViolation(message, config,
            recent.filter(item => images >= 2 ? true : item.at > now - config.spamWindowSeconds * 1000));
        if (violation) {
            await message.delete().catch(error => this.report('Message removal', error));
            const fullMessage = `${message.content || '(no text)'}\n${[...message.attachments.values()].map(item => item.url).join('\n')}`.trim();
            await this.recordCase(message.guildId, 'warn', message.author.id, message.author.tag, this.client.user.id, violation);
            await this.audit(message.guildId, 'automod', 'message.flagged', violation, fullMessage, { targetUserId: message.author.id, channelId: message.channelId });
            const state = await this.store.read();
            const warnings = state.cases.filter(entry => entry.guildId === message.guildId && entry.targetUserId === message.author.id && entry.action === 'warn' && Date.parse(entry.createdAt) > now - 86400000).length;
            if (warnings >= config.maxWarningsBeforeTimeout && message.member.moderatable) await this.moderate(message.guildId, 'timeout', message.author.id, `Automatic timeout: ${violation}`, this.client.user.id, config.timeoutMinutes);
            if (config.enableDmModerationNotices) await message.author.send({ embeds: [new EmbedBuilder().setTitle('Moderation notice').setDescription(`${message.guild.name}: your message was removed.\n${violation}`).setColor(0xe6b450)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`notice:dismiss:${message.author.id}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary))] }).catch(() => {});
            return;
        }
        if (!edited && config.enableLevels) await this.awardXp(message.guildId, message.author, 15, 'message', message.channel);
    }
    async awardXp(guildId, user, amount, source, channel) {
        const now = Date.now(); let levelUp = null;
        await this.store.update(state => {
            const key = `${guildId}:${user.id}`;
            const entry = state.levels[key] ||= { guildId, userId: user.id, userTag: user.tag || user.username, xp: 0, level: 0, lastMessageAt: 0, lastVoiceXpAt: 0 };
            const field = source === 'voice' ? 'lastVoiceXpAt' : 'lastMessageAt';
            if (now - entry[field] < (source === 'voice' ? 300000 : 60000)) return;
            entry[field] = now; entry.userTag = user.tag || user.username; entry.xp += amount;
            const level = Math.floor(Math.sqrt(entry.xp / 100));
            if (level > entry.level) levelUp = level;
            entry.level = level;
        });
        if (levelUp !== null) {
            const config = await this.getConfig(guildId);
            const destination = config.levelsChannelId ? this.client?.guilds.cache.get(guildId)?.channels.cache.get(config.levelsChannelId) : source === 'message' ? channel : null;
            if (destination?.isTextBased()) await destination.send({ content: `${user.username} reached level ${levelUp}.`, allowedMentions: { parse: [] } }).catch(error => this.report('Level announcement', error));
        }
    }
    async memberChange(member, joined) {
        const config = await this.getConfig(member.guild.id);
        await this.serverEvent(member.guild.id, 'memberChanges', joined ? 'Member joined' : 'Member left', member.user.tag);
        const channel = member.guild.channels.cache.get(config.welcomeChannelId);
        if (config.enableWelcome && channel?.isTextBased()) await channel.send({ content: (joined ? config.welcomeMessage : config.goodbyeMessage).replaceAll('{user}', member.user.username).replaceAll('{username}', member.user.username).replaceAll('{server}', member.guild.name), allowedMentions: { parse: [] } });
    }
    async maintenance() {
        if (this.maintenanceBusy || !this.isReady()) return;
        this.maintenanceBusy = true;
        try {
            const state = await this.store.read(); const now = Date.now(); const eligible = new Set();
            for (const guild of this.client.guilds.cache.values()) {
                const config = state.guilds[guild.id] || guildDefaults(guild.id);
                if (config.enableLevels && config.enableVoiceXp) for (const channel of guild.channels.cache.values()) {
                    if (!channel.isVoiceBased()) continue;
                    const members = voiceEligibleMembers(channel);
                    for (const member of members) {
                        const key = `${guild.id}:${member.id}`; eligible.add(key);
                        if (!this.voiceSince.has(key)) this.voiceSince.set(key, now);
                        if (now - this.voiceSince.get(key) >= 300000) await this.awardXp(guild.id, member.user, 20, 'voice');
                    }
                }
                if (now - (this.cleaningRuns.get(guild.id) || now) >= config.cleaner.intervalMinutes * 60000) {
                    this.cleaningRuns.set(guild.id, now);
                    await this.cleanGuild(guild.id, config).catch(error => this.report('Cleaning', error));
                }
                if (!this.cleaningRuns.has(guild.id)) this.cleaningRuns.set(guild.id, now);
            }
            for (const key of this.voiceSince.keys()) if (!eligible.has(key)) this.voiceSince.delete(key);
            for (const [key, entries] of this.windows) if (!entries.length || entries.at(-1).at < now - 60000) this.windows.delete(key);
        } finally { this.maintenanceBusy = false; }
    }
    async cleanGuild(guildId, config) {
        const guild = this.client?.guilds.cache.get(guildId); if (!guild) return;
        const removed = new Set(); let deleted = 0;
        for (const channelId of config.cleaner.monitorChannels) {
            const channel = guild.channels.cache.get(channelId); if (!channel?.messages) continue;
            const messages = await channel.messages.fetch({ limit: 100 });
            for (const message of messages.values()) {
                if (!message.author.bot || message.author.id === this.client.user.id || Date.now() - message.createdTimestamp > 12 * 3600000) continue;
                if (!config.cleaner.botList.some(bot => bot.botId === message.author.id)) continue;
                await message.delete(); removed.add(message.author.id); deleted++;
            }
        }
        if (removed.size) await this.store.update(state => {
            const cleaner = state.guilds[guildId]?.cleaner; if (!cleaner) return;
            for (const bot of cleaner.botList) if (removed.has(bot.botId) && bot.rounds > 0) bot.rounds--;
            cleaner.botList = cleaner.botList.filter(bot => bot.rounds !== 0);
        });
        if (deleted && config.cleaner.logChannelId) {
            const channel = guild.channels.cache.get(config.cleaner.logChannelId);
            if (channel?.isTextBased()) await channel.send({ content: `Cleaning complete: ${deleted} bot messages removed.`, allowedMentions: { parse: [] } });
        }
        return deleted;
    }
}
