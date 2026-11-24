import assert from 'node:assert/strict';
import test from 'node:test';
import { BotController, voiceEligibleMembers } from '../app/bot.js';
import { guildDefaults, SUPERADMIN_ID } from '../app/settings.js';
import { initialState } from '../app/store.js';

const guildId = '1505183872705363998';
const userId = '680840717731364927';
const quiet = { log() {}, error() {} };
function memoryStore() {
    let state = initialState(); state.guilds[guildId] = guildDefaults(guildId);
    return { directory: 'unused', ready: Promise.resolve(), read: async () => structuredClone(state), update: async callback => callback(state) };
}

test('voice XP requires two humans, allows mute, excludes deafened members and bots', () => {
    const member = (id, values = {}) => ({ id, user: { bot: false }, voice: { deaf: false, mute: true }, ...values });
    const channel = members => ({ members: new Map(members.map(item => [item.id, item])) });
    assert.equal(voiceEligibleMembers(channel([member('1'), member('2')])).length, 2);
    assert.equal(voiceEligibleMembers(channel([member('1'), member('2', { voice: { deaf: true } })])).length, 0);
    assert.equal(voiceEligibleMembers(channel([member('1'), member('2', { user: { bot: true } })])).length, 0);
});

test('private setup links expire, are one-use, and an invalid guess does not consume a valid link', async t => {
    const bot = new BotController({ store: memoryStore(), env: {}, version: '2.1.0', logger: quiet });
    t.after(() => bot.destroy());
    const link = new URL(bot.createSetupLink(SUPERADMIN_ID, 'https://example.com'));
    assert.equal(bot.consumeSetup('guessed'), null);
    assert.equal(bot.consumeSetup(link.searchParams.get('token')), SUPERADMIN_ID);
    assert.equal(bot.consumeSetup(link.searchParams.get('token')), null);
    bot.pendingSetups.set('expired', { userId: SUPERADMIN_ID, expires: Date.now() - 1 });
    assert.equal(bot.consumeSetup('expired'), null);
});

test('timeout calls the actual Discord member API and persists a case; owner/self moderation is blocked', async t => {
    const store = memoryStore(); const bot = new BotController({ store, env: {}, version: '2.1.0', logger: quiet });
    t.after(() => bot.destroy());
    const timeouts = [];
    const member = { moderatable: true, user: { tag: 'member' }, timeout: async (...args) => timeouts.push(args) };
    const guild = { id: guildId, ownerId: '680840717731364929', members: { fetch: async () => member }, channels: { cache: new Map() } };
    bot.client.guilds.cache.set(guildId, guild); bot.client.user = { id: '123456789012345678' }; bot.isReady = () => true;
    await bot.moderate(guildId, 'timeout', userId, 'Spam', SUPERADMIN_ID, 5);
    assert.deepEqual(timeouts, [[300000, 'Spam']]);
    assert.equal((await store.read()).cases[0].action, 'timeout');
    await assert.rejects(bot.moderate(guildId, 'ban', SUPERADMIN_ID, 'test', SUPERADMIN_ID), /yourself/);
    await assert.rejects(bot.moderate(guildId, 'timeout', userId, 'test', SUPERADMIN_ID, 50000), /40,320/);
});

test('server audit delivery is opt-in and capped at ten messages per minute', async t => {
    const store = memoryStore(); const bot = new BotController({ store, env: {}, version: '2.1.0', logger: quiet });
    t.after(() => bot.destroy());
    let sends = 0;
    const channel = { isTextBased: () => true, send: async () => { sends++; } };
    bot.client.guilds.cache.set(guildId, { channels: { cache: new Map([['channel', channel]]) } });
    await store.update(state => { const config = state.guilds[guildId]; config.premiumTier = 'Business'; config.auditLogs.serverChannelId = 'channel'; config.auditLogs.serverChanges = true; });
    await bot.serverEvent(guildId, 'serverChanges', 'Server renamed', 'name');
    assert.equal(sends, 0);
    await store.update(state => { state.guilds[guildId].auditLogs.sendServerEventsToDiscord = true; });
    for (let i = 0; i < 20; i++) await bot.serverEvent(guildId, 'serverChanges', 'Server renamed', 'name');
    assert.equal(sends, 10);
});

test('XP cooldown prevents message spam from awarding repeated XP', async t => {
    const store = memoryStore(); const bot = new BotController({ store, env: {}, version: '2.1.0', logger: quiet });
    t.after(() => bot.destroy());
    const user = { id: userId, username: 'member', tag: 'member' };
    await bot.awardXp(guildId, user, 15, 'message'); await bot.awardXp(guildId, user, 15, 'message');
    assert.equal((await store.read()).levels[`${guildId}:${userId}`].xp, 15);
});
