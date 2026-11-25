import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionsBitField } from 'discord.js';
import { LogDelivery } from '../app/logging.js';
import { guildDefaults } from '../app/settings.js';

const guildId = '1505183872705363998';
const channelId = '1574428730997084240';
function fixture({ missing = [], cached = true, sendError = null, online = true } = {}) {
    const sent = []; const fetched = [];
    const channel = { id: channelId, guildId, name: 'mod-log', isTextBased: () => true,
        permissionsFor: () => ({ has: permission => !missing.some(name => PermissionsBitField.Flags[name] === permission) }),
        send: async payload => { if (sendError) throw sendError; sent.push(payload); } };
    const guild = { members: { me: {} }, channels: { cache: new Map(cached ? [[channelId, channel]] : []), fetch: async id => { fetched.push(id); return id === channelId ? channel : null; } } };
    const delivery = new LogDelivery({ getClient: () => ({ guilds: { cache: new Map([[guildId, guild]]) } }), isReady: () => online, logger: { error() {} } });
    const config = guildDefaults(guildId); config.premiumTier = 'Business';
    return { delivery, config, sent, fetched, channel, guild };
}

test('log preflight identifies missing channel permissions rather than silently dropping logs', async () => {
    const { delivery, config, sent } = fixture({ missing: ['SendMessages'] });
    const result = await delivery.send(guildId, config, 'moderation', 'Warning', 'reason');
    assert.equal(result.ok, false); assert.equal(result.code, 'permissions_missing');
    assert.deepEqual(result.missingPermissions, ['Send Messages']); assert.equal(sent.length, 0);
    assert.match(result.action, /Edit Channel/);
});

test('uncached log channels are fetched from the correct server', async () => {
    const { delivery, config, sent, fetched } = fixture({ cached: false });
    assert.equal((await delivery.send(guildId, config, 'moderation', 'Warning', 'reason')).ok, true);
    assert.deepEqual(fetched, [channelId]); assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('missing Embed Links permission falls back to safe plain-text delivery', async () => {
    const { delivery, config, sent } = fixture({ missing: ['EmbedLinks'] });
    const result = await delivery.send(guildId, config, 'moderation', 'Warning', '@everyone reason');
    assert.equal(result.ok, true); assert.equal(result.code, 'text_only');
    assert.match(sent[0].content, /@everyone reason/); assert.equal(sent[0].embeds, undefined);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('an unavailable audit channel uses a valid configured fallback within the same server', async () => {
    const { delivery, config, sent } = fixture();
    config.auditLogs.moderationChannelId = '1574428730997084299'; config.logChannelId = channelId;
    const result = await delivery.send(guildId, config, 'moderation', 'Warning', 'reason');
    assert.equal(result.ok, true); assert.equal(result.usingFallback, true); assert.equal(sent.length, 1);
});

test('a fetched channel from another server is never accepted as a log destination', async () => {
    const { delivery, config, channel, sent } = fixture({ cached: false });
    channel.guildId = '1505183872705363999';
    const result = await delivery.send(guildId, config, 'moderation', 'Warning', 'reason');
    assert.equal(result.code, 'channel_unavailable'); assert.equal(sent.length, 0);
});

test('offline, plan-gated and disabled logging return distinct actionable states', async () => {
    const { delivery, config } = fixture({ online: false });
    assert.equal((await delivery.send(guildId, config, 'moderation', 'test', 'test')).code, 'bot_offline');
    config.premiumTier = 'Free';
    assert.equal((await delivery.send(guildId, config, 'automod', 'test', 'test')).code, 'plan_required');
    config.auditLogs.enabled = false;
    assert.equal((await delivery.send(guildId, config, 'moderation', 'test', 'test')).code, 'logging_disabled');
});

test('Discord delivery errors are sanitized and visible in diagnostics', async () => {
    const { delivery, config } = fixture({ sendError: Object.assign(new Error('private-token'), { code: 50013 }) });
    const result = await delivery.send(guildId, config, 'moderation', 'Warning', 'reason');
    assert.equal(result.code, 'delivery_forbidden');
    const checks = await delivery.diagnostics(guildId, config);
    assert.match(checks[0].lastFailure, /Discord refused/);
    assert.doesNotMatch(JSON.stringify(checks), /private-token|"channel":/);
    await delivery.send(guildId, config, 'moderation', 'Test', 'test', true);
    await delivery.send(guildId, config, 'moderation', 'Test', 'test', true);
    assert.match((await delivery.diagnostics(guildId, config))[0].lastFailure, /Discord refused/, 'test cooldown must not erase the previous delivery failure');
});

test('delivery remains capped at ten messages per minute and test messages have a cooldown', async () => {
    const { delivery, config, sent } = fixture();
    assert.equal((await delivery.send(guildId, config, 'moderation', 'Test', 'test', true)).ok, true);
    assert.equal((await delivery.send(guildId, config, 'moderation', 'Test', 'test', true)).code, 'test_cooldown');
    for (let i = 0; i < 15; i++) await delivery.send(guildId, config, 'moderation', 'Warning', 'reason');
    assert.equal(sent.length, 10);
});

test('diagnostic GET checks send no Discord messages', async () => {
    const { delivery, config, sent } = fixture();
    const checks = await delivery.diagnostics(guildId, config);
    assert.equal(checks.length, 3); assert.equal(sent.length, 0);
    assert.equal(checks[2].code, 'server_delivery_disabled');
});

test('a ready server log channel warns when no event categories are enabled', async () => {
    const { delivery, config } = fixture();
    config.auditLogs.sendServerEventsToDiscord = true; config.auditLogs.serverChannelId = channelId;
    const first = (await delivery.diagnostics(guildId, config))[2];
    assert.equal(first.code, 'events_not_selected'); assert.equal(first.canTest, true);
    assert.match(first.action, /Channel changes/);
    config.auditLogs.channelChanges = true;
    assert.equal((await delivery.diagnostics(guildId, config))[2].code, 'ready');
});
