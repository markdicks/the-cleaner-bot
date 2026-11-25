import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Collection, Partials, PermissionsBitField } from 'discord.js';
import { BotController } from '../app/bot.js';
import { auditPayload } from '../app/audit-payload.js';
import { claimEvent, roleAuditEvent } from '../app/audit-events.js';
import { guildDefaults, SUPERADMIN_ID, validateGuildSettings } from '../app/settings.js';
import { initialState } from '../app/store.js';

const guildId = '1505183872705363998';
const channelId = '1574423826417193091';
const logId = '1574428730997084240';
const userId = '680840717731364927';
const botId = '123456789012345678';
const messageId = '1574423826417193092';

function fixture(t) {
    const state = initialState(); const config = state.guilds[guildId] = guildDefaults(guildId);
    config.premiumTier = 'Business'; config.auditLogs.serverChannelId = logId;
    Object.assign(config.auditLogs, { messageEdits: true, messageDeletes: true, roleChanges: true, voiceChanges: true, sendServerEventsToDiscord: true });
    const store = { read: async () => structuredClone(state), update: async callback => callback(state) };
    const bot = new BotController({ store, env: {}, version: 'test', logger: { error() {} } });
    t.after(() => bot.destroy()); bot.isReady = () => true; bot.client.user = { id: botId };
    const messages = [];
    const log = { id: logId, guildId, name: 'logs', isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: async payload => messages.push(payload) };
    const guild = { id: guildId, members: { me: {} }, channels: { cache: new Map([[logId, log]]) } };
    bot.client.guilds.cache.set(guildId, guild);
    const user = { id: userId, tag: 'member', bot: false, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
    const message = (changes = {}) => ({ id: messageId, guildId, guild, channelId, author: user, content: 'Original text', attachments: new Collection(), ...changes });
    return { bot, state, config, messages, guild, user, message };
}

test('edited messages have Before/After, IDs, author, channel and buttons, with one delivery', async t => {
    const { bot, state, messages, message } = fixture(t); let moderated = 0;
    bot.onMessage = async () => moderated++;
    const before = message(); const after = message({ content: 'Edited text', editedTimestamp: 12345 });
    await bot.messageUpdated(before, after);
    await bot.messageUpdated(before, after);
    assert.equal(messages.length, 1); assert.equal(state.audit.length, 1);
    const data = messages[0].embeds[0].toJSON();
    assert.equal(data.fields[0].value, 'Original text'); assert.equal(data.fields[1].value, 'Edited text');
    assert.match(data.description, new RegExp(userId)); assert.match(data.description, new RegExp(channelId));
    assert.match(data.footer.text, new RegExp(messageId)); assert.equal(data.author.name, 'member');
    assert.equal(messages[0].components[0].components[0].data.label, 'Get User ID');
    assert.match(messages[0].components[0].components[1].data.url, new RegExp(messageId));
    assert.equal(moderated, 1);
});

test('embed-only message updates do not create edit logs or moderation actions', async t => {
    const { bot, message, messages } = fixture(t);
    await bot.messageUpdated(message(), message({ embeds: [{ title: 'Link preview' }] }));
    assert.equal(messages.length, 0);
});

test('deletion has cached text and channel context; partial deletion explicitly says not cached', async t => {
    const { bot, state, message, messages } = fixture(t);
    await bot.messageDeleted(message()); await bot.messageDeleted(message());
    assert.equal(messages.length, 1); assert.equal(state.audit.length, 1);
    assert.equal(messages[0].embeds[0].data.fields[0].value, 'Original text');
    const link = messages[0].components[0].components[1].data.url;
    assert.equal(link, `https://discord.com/channels/${guildId}/${channelId}`);
    await bot.messageDeleted(message({ id: '1574423826417193093', partial: true, author: null }));
    assert.match(messages[1].embeds[0].data.fields[0].value, /Not cached/);
    assert.match(messages[1].embeds[0].data.description, /Unknown author/);
    assert.ok(bot.client.options.partials.includes(Partials.Message));
});

test('content privacy redacts Before/After, deleted text, attachments, history and outbound payload', async t => {
    const { bot, config, state, message, messages } = fixture(t);
    config.auditLogs.includeMessageContent = false;
    const attachments = new Collection([['file', { id: 'file', url: 'https://example.com/private.png' }]]);
    await bot.messageUpdated(message({ content: 'private-before' }), message({ content: 'private-after', editedTimestamp: 12345, attachments }));
    await bot.messageDeleted(message({ content: 'private-delete', attachments }));
    assert.doesNotMatch(JSON.stringify([state.audit, messages]), /private-before|private-after|private-delete|private\.png/);
    assert.match(JSON.stringify(state.audit), new RegExp(userId));
});

test('a native bulk delete creates one summary, not one log for every message', async t => {
    const { bot, guild, message, messages, state } = fixture(t);
    const batch = new Collection([[messageId, message()], ['1574423826417193093', message({ id: '1574423826417193093' })]]);
    await bot.messagesBulkDeleted(batch, { id: channelId, guild });
    await bot.messagesBulkDeleted(batch, { id: channelId, guild });
    assert.equal(messages.length, 1); assert.equal(state.audit.length, 1);
    assert.match(messages[0].embeds[0].data.description, /2 messages deleted/);
});

test('our own purge suppresses gateway bulk/single callbacks and posts one invoker/count/filter result', async t => {
    const { bot, guild, message, messages, state } = fixture(t);
    const batch = new Collection([[messageId, message({ createdTimestamp: Date.now() })], ['1574423826417193093', message({ id: '1574423826417193093', createdTimestamp: Date.now() })]]);
    const channel = { id: channelId, guildId, guild, name: 'chat', isTextBased: () => true, messages: { fetch: async () => batch },
        bulkDelete: async ids => { await bot.messagesBulkDeleted(new Collection(ids.map(id => [id, batch.get(id)])), channel); return new Collection(ids.map(id => [id, batch.get(id)])); } };
    guild.channels.cache.set(channelId, channel);
    assert.equal(await bot.purge(guildId, { channelId, count: 50, userId }, SUPERADMIN_ID), 2);
    await bot.messageDeleted(batch.first());
    assert.equal(messages.length, 1); assert.equal(state.cases.length, 1); assert.equal(state.audit.length, 1);
    const data = messages[0].embeds[0].data;
    assert.match(data.description, new RegExp(SUPERADMIN_ID)); assert.match(data.fields[0].value, /2 messages deleted/);
    assert.match(data.fields[1].value, new RegExp(userId));
});

test('roles report color and permission changes, not position recalculations, once', async t => {
    const { bot, guild, messages } = fixture(t);
    const before = { id: userId, guild, name: 'Member', color: 0x0095eb, position: 1, permissions: new PermissionsBitField([]) };
    const moved = { ...before, position: 2 };
    assert.equal(roleAuditEvent(before, moved, 'updated'), null);
    const after = { ...moved, color: 0xa6f1d3, permissions: new PermissionsBitField(['ViewChannel']) };
    await Promise.all([bot.roleEvent(before, after, 'updated'), bot.roleEvent(before, after, 'updated')]);
    assert.equal(messages.length, 1);
    assert.match(messages[0].embeds[0].data.description, /#0095eb -> #a6f1d3/);
    assert.match(messages[0].embeds[0].data.description, /Permissions added: ViewChannel/);
});

test('voice join, switch and leave identify the user and both channels without duplicate sends', async t => {
    const { bot, guild, user, messages } = fixture(t);
    const voice = channelId => ({ id: userId, guild, member: { user }, channelId });
    await bot.voiceEvent(voice(null), voice(channelId));
    await bot.voiceEvent(voice(channelId), voice(logId));
    await bot.voiceEvent(voice(channelId), voice(logId));
    await bot.voiceEvent(voice(logId), voice(null));
    assert.deepEqual(messages.map(payload => payload.embeds[0].data.title), ['Voice channel joined', 'Voice channel switched', 'Voice channel left']);
    assert.match(messages[1].embeds[0].data.description, new RegExp(`${channelId}.*${logId}`));
});

test('Get User ID is an ephemeral response and rejects buttons outside their originating server', async t => {
    const { bot } = fixture(t); const replies = [];
    const interaction = { isButton: () => true, customId: `audit:user:${guildId}:${userId}`, guildId,
        message: { author: { id: botId } }, reply: async payload => replies.push(payload) };
    await bot.onInteraction(interaction);
    assert.equal(replies[0].flags, 64); assert.equal(replies[0].content, `User ID: ${userId}`);
    await bot.onInteraction({ ...interaction, guildId: userId });
    assert.match(replies[1].content, /not valid/);
});

test('real event bindings include messages, bulk deletes and roles without old duplicate paths', async t => {
    const { bot, guild, message } = fixture(t); const seen = [];
    bot.connection.activeClient = bot.client;
    for (const name of ['messageUpdated', 'messageDeleted', 'messagesBulkDeleted', 'roleEvent']) bot[name] = async () => seen.push(name);
    bot.client.emit('messageUpdate', message(), message({ content: 'After' }));
    bot.client.emit('messageDelete', message());
    bot.client.emit('messageDeleteBulk', new Collection(), { id: channelId, guild });
    bot.client.emit('roleCreate', { id: userId, guild });
    await setImmediate();
    assert.deepEqual(seen, ['messageUpdated', 'messageDeleted', 'messagesBulkDeleted', 'roleEvent']);
});

test('duplicate bot-filter events remove the message and record its warning only once', async t => {
    const { bot, config, message, state } = fixture(t); let removals = 0;
    config.blockedWords = ['banned']; config.maxWarningsBeforeTimeout = 100;
    const flagged = message({ content: 'A banned word', member: { permissions: { has: () => false } }, delete: async () => removals++ });
    await Promise.all([bot.onMessage(flagged), bot.onMessage(flagged)]);
    assert.equal(removals, 1); assert.equal(state.cases.length, 1);
    assert.equal(state.audit.filter(entry => entry.eventType === 'message.flagged').length, 1);
});

test('member events include identity and suppress repeated join notifications', async t => {
    const { bot, config, guild, user, messages } = fixture(t); config.auditLogs.memberChanges = true;
    const member = { id: user.id, guild, user };
    await bot.memberChange(member, true); await bot.memberChange(member, true); await bot.memberChange(member, false);
    assert.equal(messages.length, 2); assert.match(messages[0].embeds[0].data.description, new RegExp(userId));
});

test('role changes are opt-in, plan-gated and validated independently of channel changes', async t => {
    const { bot, config, guild, state } = fixture(t);
    const role = { id: userId, guild, name: 'Member' };
    config.auditLogs.roleChanges = false;
    await bot.roleEvent(null, role, 'created'); assert.equal(state.audit.length, 0);
    const saved = validateGuildSettings({ section: 'logs', roleChanges: 'on' }, config, []);
    assert.equal(saved.auditLogs.roleChanges, true); assert.equal(saved.auditLogs.channelChanges, false);
    config.auditLogs.roleChanges = true; config.premiumTier = 'Pro';
    await bot.roleEvent(role, null, 'deleted'); assert.equal(state.audit.length, 0);
});

test('large edits respect embed limits with full text attached in the same single message', () => {
    const fields = [{ name: 'Before', value: 'B'.repeat(4000) }, { name: 'After', value: 'A'.repeat(4000) }];
    const payload = auditPayload(guildId, 'server', 'Message Edited', '', { description: 'Message', fields }, { embedAllowed: true, attachAllowed: true });
    const data = payload.embeds[0].toJSON();
    assert.ok(data.fields.every(field => field.value.length <= 1024));
    assert.ok(data.title.length + data.description.length + data.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) <= 6000);
    assert.match(payload.files[0].attachment.toString(), /A{4000}/);
    assert.equal(payload.embeds.length, 1); assert.equal(payload.files.length, 1);
    const fallback = auditPayload(guildId, 'server', 'Message Edited', '', { fields }, { embedAllowed: false, attachAllowed: false });
    assert.ok(fallback.content.length <= 1900); assert.equal(fallback.files, undefined);
});

test('persistent claims expire, remain bounded and distinguish a real reverse transition', () => {
    const state = {};
    assert.equal(claimEvent(state, { key: 'channel', signature: 'AB', ttl: 5 }, 10), true);
    assert.equal(claimEvent(state, { key: 'channel', signature: 'AB', ttl: 5 }, 11), false);
    assert.equal(claimEvent(state, { key: 'channel', signature: 'BA', ttl: 5 }, 12), true);
    assert.equal(claimEvent(state, { key: 'channel', signature: 'AB', ttl: 5 }, 13), true);
    assert.equal(claimEvent(state, { key: 'channel', signature: 'AB', ttl: 5 }, 20), true);
});
