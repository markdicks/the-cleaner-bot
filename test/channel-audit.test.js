import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { channelAuditEvent, channelChanges } from '../app/channel-audit.js';
import { BotController } from '../app/bot.js';
import { guildDefaults, serverEventEnabled, validateGuildSettings } from '../app/settings.js';
import { initialState } from '../app/store.js';

const guildId = '1505183872705363998';
const channelId = '1574423826417193091';
const logId = '1574428730997084240';
const roleId = '1505183872705363999';
const quiet = { log() {}, error() {} };
const channel = changes => ({ id: channelId, guildId, name: 'general', type: ChannelType.GuildText,
    topic: 'Old topic', parentId: null, rawPosition: 0, nsfw: false, rateLimitPerUser: 0,
    permissionOverwrites: { cache: new Map() }, ...changes });
const overwrite = (allow, deny = [], id = roleId) => ({ id, type: 0, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) });

function fixture(t) {
    const state = initialState(); state.guilds[guildId] = guildDefaults(guildId);
    const config = state.guilds[guildId]; config.premiumTier = 'Business';
    const store = { ready: Promise.resolve(), directory: 'unused', read: async () => structuredClone(state), update: async callback => callback(state) };
    const bot = new BotController({ store, env: {}, version: '2.1.3', logger: quiet });
    t.after(() => bot.destroy());
    bot.isReady = () => true;
    const messages = [];
    const log = { id: logId, guildId, name: 'server-events', isTextBased: () => true,
        permissionsFor: () => ({ has: () => true }), send: async message => { messages.push(message); } };
    bot.client.guilds.cache.set(guildId, { members: { me: {} }, channels: { cache: new Map([[logId, log]]) } });
    config.auditLogs.serverChannelId = logId;
    return { bot, state, config, messages, log };
}

test('channel renames and topic changes record readable before/after values', () => {
    const event = channelAuditEvent(channel(), channel({ name: 'renamed', topic: 'New topic' }), 'updated');
    assert.equal(event.eventType, 'channel.updated'); assert.equal(event.guildId, guildId);
    assert.match(event.details, /Name: general -> renamed/);
    assert.match(event.details, /Topic: Old topic -> New topic/);
    assert.match(event.details, new RegExp(channelId));
});

test('channel category, slowmode, age restriction, position and voice changes are tracked', () => {
    const details = channelChanges(channel({ bitrate: 64000, userLimit: 0, rtcRegion: null }), channel({
        parentId: '1505183872705363997', rawPosition: 2, nsfw: true, rateLimitPerUser: 5,
        bitrate: 96000, userLimit: 4, rtcRegion: 'europe'
    })).join('\n');
    for (const label of ['Category:', 'Position:', 'Age-restricted:', 'Slowmode (seconds):', 'Voice bitrate:', 'Voice member limit:', 'Voice region:']) assert.ok(details.includes(label), label);
});

test('permission overwrite changes include role IDs and allowed/denied permission differences', () => {
    const before = channel({ permissionOverwrites: { cache: new Map([[roleId, overwrite(['ViewChannel'])]]) } });
    const after = channel({ permissionOverwrites: { cache: new Map([[roleId, overwrite(['ViewChannel', 'SendMessages'], ['EmbedLinks'])]]) } });
    const changes = channelChanges(before, after);
    assert.equal(changes.length, 1);
    assert.match(changes[0], /Permissions changed for Role/); assert.match(changes[0], /SendMessages/); assert.match(changes[0], /EmbedLinks/);
    assert.match(channelChanges(channel(), after)[0], /Permissions added/);
    assert.match(channelChanges(before, channel())[0], /Permissions removed/);
});

test('cache reordering, message counters, last-message IDs and null/empty topics do not create log events', () => {
    const first = overwrite(['ViewChannel']); const second = overwrite(['SendMessages'], [], '1505183872705363997');
    const before = channel({ topic: null, lastMessageId: 'old', messageCount: 1, permissionOverwrites: { cache: new Map([[first.id, first], [second.id, second]]) } });
    const after = channel({ topic: '', lastMessageId: 'new', messageCount: 2, permissionOverwrites: { cache: new Map([[second.id, second], [first.id, first]]) } });
    assert.equal(channelAuditEvent(before, after, 'updated'), null);
    assert.equal(channelAuditEvent({ id: channelId, guildId }, channel(), 'updated'), null);
});

test('creation and deletion are logged, but DMs, threads and mismatched channels are ignored', () => {
    assert.equal(channelAuditEvent(null, channel(), 'created').title, 'Channel created');
    assert.equal(channelAuditEvent(channel(), null, 'deleted').eventType, 'channel.deleted');
    assert.equal(channelAuditEvent(null, { id: channelId, name: 'DM' }, 'created'), null);
    assert.equal(channelAuditEvent(null, channel({ isThread: () => true }), 'created'), null);
    assert.equal(channelAuditEvent(channel(), channel({ id: logId }), 'updated'), null);
    assert.equal(channelAuditEvent(channel(), channel({ guildId: roleId }), 'updated'), null);
});

test('channel changes are opt-in and history is retained when Discord delivery is off', async t => {
    const { bot, state, config, messages } = fixture(t);
    await bot.channelEvent(channel(), channel({ name: 'first' }), 'updated');
    assert.equal(state.audit.length, 0);
    config.auditLogs.channelChanges = true;
    await bot.channelEvent(channel(), channel({ name: 'second' }), 'updated');
    assert.equal(state.audit.length, 1); assert.equal(messages.length, 0);
    assert.equal(state.audit[0].eventType, 'channel.updated');
    config.auditLogs.sendServerEventsToDiscord = true;
    await bot.channelEvent(channel({ name: 'second' }), channel({ name: 'third' }), 'updated');
    assert.equal(messages.length, 1); assert.equal(state.audit.length, 2);
    assert.match(messages[0].embeds[0].data.description, /second -> third/);
    assert.deepEqual(messages[0].allowedMentions, { parse: [] });
});

test('duplicate channel packets are suppressed without losing real rename/revert/rename sequences', async t => {
    const { bot, config, state } = fixture(t); config.auditLogs.channelChanges = true;
    const before = channel(); const renamed = channel({ name: 'renamed' });
    await bot.channelEvent(before, renamed, 'updated');
    await bot.channelEvent(before, renamed, 'updated');
    assert.equal(state.audit.length, 1);
    await bot.channelEvent(renamed, before, 'updated');
    await bot.channelEvent(before, renamed, 'updated');
    assert.equal(state.audit.length, 3);
});

test('concurrent rename/revert/rename edits survive database responses arriving out of order', async t => {
    const { bot, config, state } = fixture(t); config.auditLogs.channelChanges = true;
    const getConfig = bot.getConfig.bind(bot); const gates = []; let calls = 0;
    bot.getConfig = async (...args) => { if (++calls <= 3) await new Promise(resolve => { gates.push(resolve); }); return getConfig(...args); };
    const original = channel(); const renamed = channel({ name: 'renamed' });
    const pending = [bot.channelEvent(original, renamed, 'updated'), bot.channelEvent(renamed, original, 'updated'), bot.channelEvent(original, renamed, 'updated')];
    assert.equal(gates.length, 3);
    gates[0](); await setImmediate();
    gates[2](); await setImmediate();
    gates[1](); await Promise.all(pending);
    assert.equal(state.audit.length, 3);
});

test('sending a log cannot create a channel-update feedback loop', async t => {
    const { bot, config, state, messages, log } = fixture(t);
    config.auditLogs.channelChanges = true; config.auditLogs.sendServerEventsToDiscord = true;
    const originalSend = log.send;
    log.send = async payload => {
        await originalSend(payload);
        await bot.channelEvent(channel({ id: logId, name: 'server-events', lastMessageId: 'old' }), channel({ id: logId, name: 'server-events', lastMessageId: 'new' }), 'updated');
    };
    await bot.channelEvent(channel(), channel({ name: 'renamed' }), 'updated');
    assert.equal(messages.length, 1); assert.equal(state.audit.length, 1);
});

test('channel event bursts keep the ten-message delivery cap and retain every distinct audit event', async t => {
    const { bot, config, state, messages } = fixture(t);
    config.auditLogs.channelChanges = true; config.auditLogs.sendServerEventsToDiscord = true;
    for (let index = 0; index < 20; index++) await bot.channelEvent(channel({ name: `name-${index}` }), channel({ name: `name-${index + 1}` }), 'updated');
    assert.equal(messages.length, 10); assert.equal(state.audit.length, 20);
});

test('old server-change preferences are respected unless Channel changes is explicitly disabled', async t => {
    const { bot, config, state } = fixture(t);
    delete config.auditLogs.channelChanges; config.auditLogs.serverChanges = true;
    assert.equal(serverEventEnabled(config.auditLogs, 'channelChanges'), true);
    await bot.channelEvent(channel(), channel({ name: 'renamed' }), 'updated');
    config.auditLogs.channelChanges = false;
    assert.equal(serverEventEnabled(config.auditLogs, 'channelChanges'), false);
    await bot.channelEvent(channel({ name: 'renamed' }), channel(), 'updated');
    assert.equal(state.audit.length, 1);
});

test('message-content privacy does not erase channel metadata but still redacts deleted message text', async t => {
    const { bot, config, state } = fixture(t);
    config.auditLogs.channelChanges = true; config.auditLogs.includeMessageContent = false; config.auditLogs.messageDeletes = true;
    await bot.channelEvent(channel(), channel({ topic: 'New topic' }), 'updated');
    await bot.serverEvent(guildId, 'messageDeletes', 'Message deleted', 'Private chat text', channelId);
    assert.match(state.audit[0].details, /Old topic -> New topic/);
    assert.equal(state.audit[1].details, '(content omitted)');
});

test('the real client event bindings dispatch channel create, update and delete handlers', async t => {
    const { bot } = fixture(t); const seen = [];
    bot.connection.activeClient = bot.client;
    bot.channelEvent = async (...args) => { seen.push(args[2]); };
    bot.client.emit('channelCreate', channel());
    bot.client.emit('channelUpdate', channel(), channel({ name: 'new' }));
    bot.client.emit('channelDelete', channel());
    await setImmediate();
    assert.deepEqual(seen, ['created', 'updated', 'deleted']);
});

test('Channel changes is validated and persisted independently from Server name changes', () => {
    const config = guildDefaults(guildId); config.premiumTier = 'Business';
    const body = { section: 'logs', enabled: 'on', channelChanges: 'on', sendServerEventsToDiscord: 'on', serverChannelId: logId };
    const next = validateGuildSettings(body, config, [{ id: logId, text: true }]);
    assert.equal(next.auditLogs.channelChanges, true); assert.equal(next.auditLogs.serverChanges, false);
    delete body.channelChanges;
    assert.equal(validateGuildSettings(body, next, [{ id: logId, text: true }]).auditLogs.channelChanges, false);
});
