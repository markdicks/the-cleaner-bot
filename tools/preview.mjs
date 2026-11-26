// Local, isolated UI fixture. Never used by the production index.js entry point.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppStore } from '../app/store.js';
import { BotController } from '../app/bot.js';
import { createDashboard } from '../app/web.js';
import { guildDefaults, SUPERADMIN_ID } from '../app/settings.js';
import { startRuntime } from '../runtime.js';
import { connectionAction } from '../app/connection.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'cleaner-ui-preview-'));
const store = new AppStore({ env: {}, directory });
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
await store.ready;
const guildId = '1505183872705363998';
const guilds = [
    { id: guildId, name: 'Community QA Server', memberCount: 1248, iconUrl: '/assets/mark.svg' },
    { id: '1505183872705363999', name: 'A Community With A Longer Server Name', memberCount: 86, iconUrl: '' },
    { id: '1505183872705363997', name: 'Gaming & Friends', memberCount: 423, iconUrl: '' }
];
await store.update(state => {
    state.settings.clientId = '123456789012345678';
    for (const guild of guilds) { state.guilds[guild.id] = guildDefaults(guild.id, guild.name); state.guilds[guild.id].premiumTier = 'Business'; }
    state.guilds[guildId].blockedWords = ['example phrase'];
    state.guilds[guildId].auditLogs.serverChannelId = '1574428730997084240';
    state.guilds[guildId].auditLogs.sendServerEventsToDiscord = true;
    state.guilds[guildId].auditLogs.messageEdits = true;
    state.guilds[guildId].cleaner.botList = [{ botId: '123456789012345678', rounds: -1 }, { botId: '123456789012345679', rounds: 12 }];
    state.guilds[guildId].cleaner.monitorChannels = ['1574423826417193091'];
    state.guilds['1505183872705363997'].premiumTier = 'Free';
    state.cases = Array.from({ length: 33 }, (_, index) => ({ id: index + 1, guildId, action: ['warn','timeout','kick','ban'][index % 4], targetUserId: '680840717731364927', targetUserTag: `Example member ${index % 3 + 1}`, moderatorUserId: '680840717731364926', reason: ['Message spam', 'Repeated external links', 'Mention spam'][index % 3], createdAt: new Date(Date.now() - index * 3600000).toISOString() }));
    state.nextCaseId = 34;
    state.audit = [{ guildId, category: 'server', title: 'Message Edited', details: 'Example edit before and after', createdAt: new Date().toISOString(),
        presentation: { description: 'From: Example member | In: general-chat', footer: 'Author: 680840717731364927 | Message ID: 1574423826417193092',
            fields: [{ name: 'Before', value: 'The original message before it was edited.' }, { name: 'After', value: 'The updated message with a long link: https://example.com/' + 'long-path-segment/'.repeat(18) }],
            jumpUrl: `https://discord.com/channels/${guildId}/1574423826417193091/1574423826417193092` } }];
});
const bot = new BotController({ store, env: {}, version });
let connected = process.env.PREVIEW_DISCONNECTED !== 'true';
Object.defineProperty(bot, 'contentAccess', { get: () => connected });
bot.isReady = () => connected;
bot.getConnectionStatus = () => ({ connected, status: connected ? 'connected' : 'action_required', errorCode: connected ? null : 'intents_required', action: connected ? null : connectionAction('intents_required'), privilegedActive: connected, reconnecting: false });
bot.restart = async () => { connected = true; };
bot.guilds = () => guilds;
bot.channels = () => [{ id: '1574423826417193091', name: 'flagged-messages', text: true }, { id: '1574428730997084240', name: 'moderation-log', text: true }, { id: '1246174778281300048', name: 'levels', text: true }, { id: '1574423826417193092', name: 'general-chat', text: true }, { id: '1574423826417193093', name: 'a-very-long-channel-name-for-community-announcements', text: true }];
bot.canManage = async () => true;
bot.login = async () => {};
bot.moderate = async () => { throw new Error('This local UI fixture has no Discord connection.'); };
bot.loggingDiagnostics = async () => [
    { category: 'moderation', label: 'Moderation actions', ok: false, status: 'blocked', message: 'Missing permissions: Send Messages.', action: 'Open this channel > Edit Channel > Permissions, and allow Send Messages for the bot role.', canTest: false },
    { category: 'automod', label: 'Flagged words & links', ok: true, status: 'ready', message: 'Ready to send to #flagged-messages.', canTest: true },
    { category: 'server', label: 'Server events', ok: false, status: 'blocked', message: 'Discord delivery is disabled.', action: 'Enable Send server events to Discord.', canTest: false }
];
bot.testLog = async () => ({ ok: false, message: 'This isolated preview does not send Discord messages.', action: '' });
const runtime = await startRuntime({ client: bot, token: '', port: 0, host: '127.0.0.1', version, createHandler: getStatus => createDashboard({ store, bot, version, env: {}, getStatus }) });
const origin = `http://127.0.0.1:${runtime.server.address().port}`;
console.log(`UI_PREVIEW=${bot.createSetupLink(SUPERADMIN_ID, origin)}`);
console.log(`UI_ORIGIN=${origin}`);
const stop = async () => {
    await runtime.stop(); await store.close();
    if (path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir())) await rm(directory, { recursive: true, force: true });
};
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
