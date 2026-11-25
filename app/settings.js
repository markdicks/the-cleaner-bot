export const SUPERADMIN_ID = '680840717731364926';
export const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
export const planActive = config => config.premiumTier !== 'Free' && (!config.premiumExpiresAt || Date.parse(config.premiumExpiresAt) > Date.now());
export const businessActive = config => planActive(config) && ['Business', 'Enterprise'].includes(config.premiumTier);

export function guildDefaults(id, name = id) {
    return {
        guildId: id, guildName: name, prefix: '!', premiumTier: 'Free', premiumExpiresAt: null,
        enableModeration: true, enableAntiSpam: true, enableInviteFilter: true, enableLinkFilter: false,
        enableCapsFilter: true, enableProfanityFilter: true, enableMentionFilter: true,
        enableLevels: true, enableVoiceXp: true, enableWelcome: false, enableDmModerationNotices: false,
        spamWindowSeconds: 8, spamMessageLimit: 5, mentionLimit: 6, capsMinimumLength: 14,
        capsPercentage: 75, maxWarningsBeforeTimeout: 3, timeoutMinutes: 10,
        levelsChannelId: '1246174778281300048', logChannelId: '', welcomeChannelId: '',
        welcomeMessage: 'Welcome {user} to {server}.', goodbyeMessage: '{user} left {server}.',
        ignoredModerationChannelIds: [], blockedWords: [],
        auditLogs: { enabled: true, moderationActions: true, autoModActions: true, moderationChannelId: '1574428730997084240', autoModChannelId: '1574423826417193091',
            serverChannelId: '', sendServerEventsToDiscord: false, messageEdits: false, messageDeletes: false,
            memberChanges: false, voiceChanges: false, serverChanges: false, includeMessageContent: true },
        cleaner: { botList: [], allowedRoles: [], monitorChannels: [], logChannelId: '', intervalMinutes: 60 },
        updatedAt: new Date().toISOString()
    };
}

export function validateGuildSettings(body, current, channels) {
    const next = structuredClone(current);
    const isChannel = value => !value || channels.some(channel => channel.id === value && channel.text);
    const checkChannel = value => {
        const id = String(value || '').trim();
        if (!isChannel(id)) throw new Error('Select a text channel from this server.');
        return id;
    };
    if (body.section === 'moderation') {
        for (const key of ['enableModeration', 'enableAntiSpam', 'enableInviteFilter', 'enableLinkFilter', 'enableCapsFilter', 'enableProfanityFilter', 'enableMentionFilter', 'enableDmModerationNotices']) next[key] = body[key] === 'on';
        for (const [key, min, max] of [['spamWindowSeconds', 2, 120], ['spamMessageLimit', 2, 50], ['mentionLimit', 2, 50], ['capsMinimumLength', 5, 2000], ['capsPercentage', 25, 100], ['maxWarningsBeforeTimeout', 1, 100], ['timeoutMinutes', 1, 40320]]) {
            const value = Number(body[key]);
            if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
            next[key] = value;
        }
        next.blockedWords = [...new Set(String(body.blockedWords || '').split(/[\r\n,]+/).map(word => word.trim().toLowerCase()).filter(Boolean))];
        if (next.blockedWords.length > 1000 || next.blockedWords.some(word => word.length > 100)) throw new Error('Use at most 1,000 blocked words of 100 characters each.');
    } else if (body.section === 'channels') {
        for (const key of ['levelsChannelId', 'logChannelId', 'welcomeChannelId']) next[key] = checkChannel(body[key]);
        next.ignoredModerationChannelIds = [...new Set([body.ignoredModerationChannelIds || []].flat().map(checkChannel).filter(Boolean))];
        next.enableWelcome = body.enableWelcome === 'on';
        next.enableLevels = body.enableLevels === 'on';
        next.enableVoiceXp = body.enableVoiceXp === 'on';
        next.prefix = String(body.prefix || '!').trim();
        if (!next.prefix || next.prefix.length > 10) throw new Error('Prefix must contain 1 to 10 characters.');
        for (const key of ['welcomeMessage', 'goodbyeMessage']) next[key] = String(body[key] || '').slice(0, 1900);
    } else if (body.section === 'logs') {
        if (!businessActive(current)) throw new Error('Business or Enterprise is required for audit log settings.');
        for (const key of ['moderationChannelId', 'autoModChannelId', 'serverChannelId']) next.auditLogs[key] = checkChannel(body[key]);
        for (const key of ['enabled', 'moderationActions', 'autoModActions', 'sendServerEventsToDiscord', 'messageEdits', 'messageDeletes', 'memberChanges', 'voiceChanges', 'serverChanges', 'includeMessageContent']) next.auditLogs[key] = body[key] === 'on';
    } else if (body.section === 'cleaner') {
        const interval = Number(body.intervalMinutes);
        if (!Number.isInteger(interval) || interval < 1 || interval > 120960) throw new Error('Cleaning interval must be between 1 and 120,960 minutes.');
        next.cleaner.intervalMinutes = interval;
        next.cleaner.monitorChannels = [...new Set([body.monitorChannels || []].flat().map(checkChannel).filter(Boolean))];
        next.cleaner.logChannelId = checkChannel(body.cleanerLogChannelId);
        const bots = String(body.botList || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
            const [botId, roundsText = '-1'] = line.split(/\s+/);
            const rounds = Number(roundsText);
            if (!snowflake(botId) || !Number.isInteger(rounds) || (rounds !== -1 && (rounds < 1 || rounds > 10000))) throw new Error('Use a bot ID followed by rounds (1–10,000 or -1 for permanent).');
            return { botId, rounds };
        });
        if (bots.length > 100) throw new Error('At most 100 cleaning targets are allowed.');
        next.cleaner.botList = [...new Map(bots.map(bot => [bot.botId, bot])).values()];
    } else throw new Error('Unknown settings section.');
    next.updatedAt = new Date().toISOString();
    return next;
}
