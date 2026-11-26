export const serverNavigation = [
    { label: 'Server', items: [['overview', 'Overview', 'layout-dashboard']] },
    { label: 'Moderation & safety', items: [['automod', 'AutoMod', 'shield-check'], ['actions', 'Moderation', 'gavel'], ['cases', 'Punishment history', 'contact-round'], ['logs', 'Action Log', 'scroll-text'], ['activity', 'Activity', 'list-filter']] },
    { label: 'Community', items: [['levels', 'Levels', 'trophy'], ['welcome', 'Welcome', 'hand'], ['cleaner', 'Cleaner', 'brush']] },
    { label: 'Configuration', items: [['settings', 'Bot settings', 'settings-2']] }
];
export const settingsSearch = [
    ['AutoMod filters', 'automod', 'rules', '', 'spam caps links invites mentions automatic moderation'],
    ['Blocked words', 'automod', 'words', '', 'banned profanity blacklist language filter'],
    ['Ignored channels', 'automod', 'ignored', '', 'exclude exclusions ignore filtering moderation'],
    ['Moderate a member', 'actions', 'member', '', 'warn ban kick timeout mute unban punishment'],
    ['Purge messages', 'actions', 'purge', '', 'delete bulk role user bots cleanup'],
    ['Warning escalation', 'actions', 'settings', '', 'automatic timeout warnings private notices dm'],
    ['Punishment history', 'cases', '', '', 'lookup cases reasons moderator warnings'],
    ['Moderation log channel', 'logs', 'channels', 'moderation-channel', 'ban warning timeout mute destination'],
    ['Flagged message log channel', 'logs', 'channels', 'automod-channel', 'blocked words links destination'],
    ['Server events', 'logs', 'events', '', 'voice channel role message edit delete logs'],
    ['Log delivery checks', 'logs', 'checks', '', 'test permissions connection failed send'],
    ['Activity history', 'activity', '', '', 'audit event search export'],
    ['Level announcements', 'levels', 'settings', 'levels-channel', 'xp channel notification voice chat'],
    ['Leaderboard', 'levels', 'leaderboard', '', 'rank level xp top'],
    ['Welcome messages', 'welcome', '', '', 'join leave goodbye channel announcements'],
    ['Cleaning targets', 'cleaner', '', 'cleaning-targets', 'bot messages interval rounds permanent'],
    ['Command prefix', 'settings', '', 'command-prefix', 'bot general settings'],
    ['Fallback log channel', 'settings', '', 'fallback-channel', 'default destination moderation']
];
const views = { automod: ['rules', 'words', 'ignored'], actions: ['member', 'purge', 'settings'], logs: ['channels', 'events', 'checks'], levels: ['settings', 'leaderboard'] };
export function serverPage(tab, view) {
    tab = ({ moderation: 'automod', channels: 'settings' })[tab] || tab;
    const item = serverNavigation.flatMap(group => group.items).find(entry => entry[0] === tab) || serverNavigation[0].items[0];
    return { tab: item[0], title: item[1], view: views[item[0]]?.includes(view) ? view : views[item[0]]?.[0] || '', views: views[item[0]] || [] };
}
export function serverUrl(id, tab = 'overview', view = '', anchor = '') {
    if (tab === 'activity') return `/Dashboard/AuditLogs/${id}`;
    return `/Dashboard/Guild/${id}?${new URLSearchParams({ tab, ...(view ? { view } : {}) })}${anchor ? `#${anchor}` : ''}`;
}
export function settingsDestination(section) {
    const target = { moderation: ['automod', 'rules'], automodRules: ['automod', 'rules'], words: ['automod', 'words'], ignored: ['automod', 'ignored'],
        moderationOptions: ['actions', 'settings'], levelSettings: ['levels', 'settings'], welcome: ['welcome'], general: ['settings'], channels: ['settings'],
        cleaner: ['cleaner'], logs: ['logs', 'channels'], logDestinations: ['logs', 'channels'], logEvents: ['logs', 'events'] }[section] || ['overview'];
    return { tab: target[0], ...(target[1] ? { view: target[1] } : {}) };
}
