// Local, isolated UI fixture. Never used by the production index.js entry point.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppStore } from '../app/store.js';
import { BotController } from '../app/bot.js';
import { createDashboard } from '../app/web.js';
import { guildDefaults, SUPERADMIN_ID } from '../app/settings.js';
import { startRuntime } from '../runtime.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'cleaner-ui-preview-'));
const store = new AppStore({ env: {}, directory });
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
    state.cases = [{ id: 1, guildId, action: 'warn', targetUserTag: 'Example member', reason: 'Message spam', createdAt: new Date().toISOString() }];
    state.nextCaseId = 2;
});
const bot = new BotController({ store, env: {}, version: '2.1.0' });
bot.isReady = () => true;
bot.guilds = () => guilds;
bot.channels = () => [{ id: '1574423826417193091', name: 'flagged-messages', text: true }, { id: '1574428730997084240', name: 'moderation-log', text: true }, { id: '1246174778281300048', name: 'levels', text: true }];
bot.canManage = async () => true;
bot.login = async () => {};
bot.moderate = async () => { throw new Error('This local UI fixture has no Discord connection.'); };
const runtime = await startRuntime({ client: bot, token: '', port: 0, host: '127.0.0.1', version: '2.1.0', createHandler: getStatus => createDashboard({ store, bot, version: '2.1.0', env: {}, getStatus }) });
const origin = `http://127.0.0.1:${runtime.server.address().port}`;
console.log(`UI_PREVIEW=${bot.createSetupLink(SUPERADMIN_ID, origin)}`);
console.log(`UI_ORIGIN=${origin}`);
const stop = async () => {
    await runtime.stop(); await store.close();
    if (path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir())) await rm(directory, { recursive: true, force: true });
};
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
