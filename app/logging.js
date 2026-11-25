import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { businessActive, serverEventEnabled } from './settings.js';

const labels = { moderation: 'Moderation actions', automod: 'Flagged words & links', server: 'Server events' };
const problem = (code, message, action) => ({ ok: false, status: 'blocked', code, message, action });

export class LogDelivery {
    constructor({ getClient, isReady, logger = console }) {
        this.getClient = getClient; this.isReady = isReady; this.logger = logger;
        this.windows = new Map(); this.last = new Map(); this.testTimes = new Map();
    }
    async resolve(guildId, config, category) {
        const logs = config.auditLogs;
        const base = { category, label: labels[category], canTest: false };
        if (!labels[category]) return { ...base, ...problem('category_invalid', 'Unknown log category.', 'Select moderation, automod, or server logs.') };
        if (category !== 'moderation' && !businessActive(config)) return { ...base, ...problem('plan_required', 'Business or Enterprise is required for this log category.', 'The owner can review the server plan in Superadmin.') };
        if (!logs.enabled || (category === 'moderation' && logs.moderationActions === false) || (category === 'automod' && logs.autoModActions === false)) return { ...base, ...problem('logging_disabled', 'Logging is disabled for this category.', 'Enable audit logging and this category in server settings.') };
        if (category === 'server' && !logs.sendServerEventsToDiscord) return { ...base, ...problem('server_delivery_disabled', 'Server-event Discord delivery is off.', 'Enable Send server events to Discord and select the event categories you need.') };
        const primary = category === 'moderation' ? logs.moderationChannelId : category === 'automod' ? logs.autoModChannelId : logs.serverChannelId;
        const fallback = category !== 'server' ? config.logChannelId : '';
        if (!primary && !fallback) return { ...base, ...problem('channel_missing', 'No destination channel is configured.', 'Select a log channel and save the server settings.') };
        if (!this.isReady()) return { ...base, ...problem('bot_offline', 'The bot is not connected to Discord.', 'Resolve the connection issue or reconnect the bot in Superadmin.') };
        const guild = this.getClient()?.guilds.cache.get(guildId);
        if (!guild) return { ...base, ...problem('guild_missing', 'The bot is not in this server.', 'Add the bot to this server with the dashboard invite button.') };
        const fetchChannel = async id => {
            if (!id) return null;
            let channel = guild.channels.cache.get(id);
            if (!channel && guild.channels.fetch) channel = await guild.channels.fetch(id).catch(() => null);
            if (channel && (channel.guildId || channel.guild?.id) !== guildId) return null;
            return channel;
        };
        const primaryChannel = await fetchChannel(primary);
        const channel = primaryChannel || (fallback !== primary ? await fetchChannel(fallback) : null);
        if (!channel) return { ...base, channelId: primary || fallback, ...problem('channel_unavailable', 'The selected log channel no longer exists or is inaccessible.', 'Choose a channel from this server and allow the bot to View Channel.') };
        const channelInfo = { channelId: channel.id, channelName: channel.name, usingFallback: !primaryChannel && Boolean(primary) };
        if (!channel.isTextBased() || typeof channel.send !== 'function') return { ...base, ...channelInfo, ...problem('channel_type', 'This channel cannot receive bot messages.', 'Select a text or announcement channel.') };
        if (channel.isThread?.() && (channel.archived || channel.locked)) return { ...base, ...channelInfo, ...problem('thread_closed', 'The log thread is archived or locked.', 'Reopen the thread or select a regular text channel.') };
        const member = guild.members?.me || (guild.members?.fetchMe ? await guild.members.fetchMe().catch(() => null) : null);
        const permissions = member && channel.permissionsFor?.(member);
        if (!permissions) return { ...base, ...channelInfo, ...problem('permissions_unavailable', 'Bot channel permissions could not be checked.', 'Reconnect the bot and confirm it can access this server.') };
        const needed = [['ViewChannel', 'View Channel'], [channel.isThread?.() ? 'SendMessagesInThreads' : 'SendMessages', channel.isThread?.() ? 'Send Messages in Threads' : 'Send Messages']];
        const missingPermissions = needed.filter(([key]) => !permissions.has(PermissionsBitField.Flags[key])).map(([, label]) => label);
        if (missingPermissions.length) return { ...base, ...channelInfo, missingPermissions, ...problem('permissions_missing', `Missing permissions: ${missingPermissions.join(', ')}.`, 'Open this channel > Edit Channel > Permissions, and allow these permissions for the bot role.') };
        const embedAllowed = permissions.has(PermissionsBitField.Flags.EmbedLinks);
        const noEvents = category === 'server' && !['messageEdits', 'messageDeletes', 'memberChanges', 'voiceChanges', 'serverChanges', 'channelChanges'].some(key => serverEventEnabled(logs, key));
        return { ...base, ...channelInfo, channel, embedAllowed, canTest: true, ok: true,
            status: embedAllowed && !noEvents ? 'ready' : 'warning', code: !embedAllowed ? 'text_only' : noEvents ? 'events_not_selected' : 'ready',
            message: !embedAllowed ? `Text-only delivery to #${channel.name}; Embed Links is missing.` : noEvents ? 'The log channel is ready, but no server-event categories are enabled.' : `Ready to send to #${channel.name}.`,
            action: [!embedAllowed ? 'Allow Embed Links in this channel for rich moderation logs.' : '', noEvents ? 'Enable Channel changes or another event category, then Save audit settings.' : '', channelInfo.usingFallback ? 'The saved audit channel is unavailable; the configured fallback channel will be used.' : ''].filter(Boolean).join(' ') };
    }
    async diagnostics(guildId, config) {
        const results = [];
        for (const category of Object.keys(labels)) {
            const { channel, embedAllowed, ...result } = await this.resolve(guildId, config, category);
            const last = this.last.get(`${guildId}:${category}`);
            results.push({ ...result, lastAttemptAt: last?.lastAttemptAt || null, lastSuccessAt: last?.lastSuccessAt || null,
                lastFailure: last?.lastFailure || null });
        }
        return results;
    }
    async send(guildId, config, category, title, details, test = false) {
        const key = `${guildId}:${category}`;
        const previous = this.last.get(key);
        const lastSuccessAt = previous?.lastSuccessAt || null;
        const lastAttemptAt = new Date().toISOString();
        const remember = result => {
            const lastFailure = result.ok ? null : ['delivery_failed', 'delivery_forbidden'].includes(result.code) ? result.message : previous?.lastFailure || null;
            const entry = { ...result, lastFailure, lastAttemptAt, lastSuccessAt: result.ok ? lastAttemptAt : lastSuccessAt };
            this.last.set(key, entry); return entry;
        };
        const now = Date.now();
        if (test && now - (this.testTimes.get(guildId) || 0) < 10000) return remember(problem('test_cooldown', 'Wait 10 seconds between log tests.', 'Try again shortly.'));
        if (test) this.testTimes.set(guildId, now);
        const window = (this.windows.get(guildId) || []).filter(time => time > now - 60000);
        if (window.length >= 10) return remember(problem('rate_limited', 'Discord log delivery is limited to 10 messages per minute for this server.', 'History is retained. Wait a minute before testing again.'));
        const { channel, embedAllowed, ...check } = await this.resolve(guildId, config, category);
        if (!check.ok) return remember(check);
        window.push(now); this.windows.set(guildId, window);
        const payload = { allowedMentions: { parse: [] } };
        if (embedAllowed) payload.embeds = [new EmbedBuilder().setColor(category === 'automod' ? 0xe6b450 : 0x43b581).setTitle(title.slice(0, 256)).setDescription(String(details || 'No details').slice(0, 4000)).setTimestamp()];
        else {
            const content = `${title}\n${details || 'No details'}`;
            payload.content = content.length > 1900 ? `${content.slice(0, 1850)}\n[Truncated; full content is retained in audit history.]` : content;
        }
        try {
            await channel.send(payload);
            return remember({ ...check, message: `Log delivered to #${channel.name}${embedAllowed ? '.' : ' as plain text.'}` });
        } catch (error) {
            const forbidden = [50001, 50013].includes(Number(error.code));
            this.logger.error(`Log delivery failed (${forbidden ? 'permissions' : 'delivery_error'}).`);
            return remember({ ...check, ...problem(forbidden ? 'delivery_forbidden' : 'delivery_failed', forbidden ? 'Discord refused delivery: missing access or channel permissions.' : 'Discord could not deliver the log message.', 'Check channel permissions, including View Channel and Send Messages, then send a test log.') });
        }
    }
}
