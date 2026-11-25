import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { ApplicationCommandManager, MessageFlagsBitField, PermissionsBitField } from 'discord.js';
import { BotController } from '../app/bot.js';
import { historyCases, historyDownload, historyPage, lookupCommand } from '../app/punishment-history.js';
import { guildDefaults, SUPERADMIN_ID } from '../app/settings.js';
import { AppStore, initialState } from '../app/store.js';

const guildId = '1505183872705363998';
const otherGuild = '1505183872705363999';
const targetId = '680840717731364927';
const staffId = '680840717731364928';
const otherUser = '680840717731364929';
const botId = '123456789012345678';
const ownerId = '680840717731364930';
const quiet = { log() {}, error() {} };
const entry = (id, changes = {}) => ({ id, guildId, targetUserId: targetId, targetUserTag: 'Member', action: 'warn',
    moderatorUserId: staffId, reason: `Reason ${id}`, createdAt: new Date(Date.UTC(2026, 0, id)).toISOString(), ...changes });

function fixture(t, entries = [entry(1)]) {
    const state = initialState(); state.guilds[guildId] = guildDefaults(guildId); state.cases = entries;
    const store = { read: async () => structuredClone(state), update: async callback => callback(state) };
    const bot = new BotController({ store, env: {}, version: 'test', logger: quiet });
    bot.isReady = () => true; bot.client.user = { id: botId, setActivity() {} };
    const access = { permissions: new PermissionsBitField(['ModerateMembers']) }; const fetched = [];
    const guild = { id: guildId, ownerId, channels: { cache: new Map() }, members: { fetch: async options => { fetched.push(options); return { permissions: access.permissions }; } } };
    bot.client.guilds.cache.set(guildId, guild);
    t.after(() => bot.destroy());
    function interaction(values = {}, buttonId) {
        const calls = []; const replies = [];
        return { calls, replies, guildId: values.guildId || guildId, user: { id: values.actorId || staffId }, commandName: 'lookup',
            customId: buttonId, message: { author: { id: botId }, flags: new MessageFlagsBitField(64) },
            isButton: () => Boolean(buttonId), isChatInputCommand: () => !buttonId,
            options: { getUser: () => values.user || null, getString: () => values.id ?? null, getInteger: () => values.page ?? null },
            deferReply: async payload => calls.push(['deferReply', payload]), deferUpdate: async () => calls.push(['deferUpdate']),
            editReply: async payload => { calls.push(['editReply']); replies.push(payload); },
            reply: async payload => { calls.push(['reply']); replies.push(payload); } };
    }
    return { bot, state, store, guild, access, fetched, interaction };
}

const buttonId = (reply, index) => reply.components[0].components[index].data.custom_id;
const data = reply => reply.embeds[0].toJSON();

test('lookup definition serializes with member/ID/page options and moderation permissions', () => {
    const command = ApplicationCommandManager.transformCommand({ ...lookupCommand, dmPermission: false });
    assert.equal(command.name, 'lookup'); assert.equal(command.dm_permission, false);
    assert.equal(command.default_member_permissions, PermissionsBitField.Flags.ModerateMembers.toString());
    assert.deepEqual(command.options.map(option => option.name), ['user', 'user-id', 'page']);
    assert.equal(command.options[2].min_value, 1);
});

test('slash lookup is private and shows case action, when, moderator and reason only for this server/person', async t => {
    const { bot, interaction, fetched, state } = fixture(t, [entry(1), entry(2, { action: 'timeout' }), entry(3, { guildId: otherGuild, reason: 'other-server-private' }), entry(4, { targetUserId: otherUser, reason: 'other-member-private' })]);
    const request = interaction({ user: { id: targetId } }); await bot.onInteraction(request);
    assert.deepEqual(request.calls[0], ['deferReply', { flags: 64 }]);
    const reply = request.replies[0]; const embed = data(reply);
    assert.match(embed.description, /2 recorded cases/); assert.equal(embed.fields.length, 2);
    assert.match(embed.fields[0].name, /Case #2 \| Timeout/);
    assert.match(embed.fields[0].value, new RegExp(`<t:${Date.parse(entry(2).createdAt) / 1000}:F>`));
    assert.match(embed.fields[0].value, new RegExp(staffId)); assert.match(embed.fields[0].value, /Reason 2/);
    assert.doesNotMatch(JSON.stringify(reply), /other-server-private|other-member-private/);
    assert.deepEqual(reply.allowedMentions, { parse: [] }); assert.equal(state.cases.length, 4);
    assert.deepEqual(fetched, [{ user: staffId, force: true }]);
});

test('former and banned members can be looked up by user ID without fetching the target member', async t => {
    const { bot, interaction, fetched } = fixture(t, [entry(1, { action: 'ban' })]);
    const request = interaction({ id: ` ${targetId} ` }); await bot.onInteraction(request);
    assert.match(data(request.replies[0]).fields[0].name, /Ban/);
    assert.ok(fetched.every(options => options.user === staffId));
});

test('missing, ambiguous, invalid IDs and invalid page numbers fail privately without history', async t => {
    const { bot, interaction } = fixture(t);
    for (const values of [{}, { user: { id: targetId }, id: targetId }, { id: '123' }, { id: targetId, page: 0 }, { id: targetId, page: 1.5 }, { id: targetId, page: 1000000000 }]) {
        const request = interaction(values); await bot.onInteraction(request);
        assert.equal(request.calls[0][1].flags, 64); assert.equal(request.replies[0].embeds.length, 0);
        assert.doesNotMatch(request.replies[0].content, /Reason 1/);
    }
});

test('ordinary members cannot view even their own history', async t => {
    const { bot, access, interaction } = fixture(t); access.permissions = new PermissionsBitField([]);
    const request = interaction({ id: targetId, actorId: targetId }); await bot.onInteraction(request);
    assert.match(request.replies[0].content, /Moderate Members or Manage Server/);
    assert.equal(request.replies[0].embeds.length, 0);
});

test('Manage Server, server owner and superadmin are accepted; no paid plan is needed', async t => {
    const { bot, access, interaction, state } = fixture(t); assert.equal(state.guilds[guildId].premiumTier, 'Free');
    access.permissions = new PermissionsBitField(['ManageGuild']);
    const manager = interaction({ id: targetId }); await bot.onInteraction(manager); assert.equal(manager.replies[0].embeds.length, 1);
    access.permissions = new PermissionsBitField([]);
    for (const actorId of [ownerId, SUPERADMIN_ID]) {
        const request = interaction({ id: targetId, actorId }); await bot.onInteraction(request); assert.equal(request.replies[0].embeds.length, 1);
    }
});

test('pagination updates the same private panel, with stable boundaries as new punishments arrive', async t => {
    const { bot, state, interaction } = fixture(t, Array.from({ length: 9 }, (_, i) => entry(i + 1)));
    const first = interaction({ id: targetId }); await bot.onInteraction(first);
    assert.equal(first.replies[0].components[0].components[0].data.disabled, true);
    const next = buttonId(first.replies[0], 1);
    state.cases.push(entry(10));
    const second = interaction({}, next); await bot.onInteraction(second);
    assert.deepEqual(second.calls[0], ['deferUpdate']); assert.match(data(second.replies[0]).footer.text, /Page 2 of 3/);
    assert.deepEqual(data(second.replies[0]).fields.map(field => field.name.match(/#(\d+)/)[1]), ['5', '4', '3', '2']);
    const third = interaction({}, buttonId(second.replies[0], 1)); await bot.onInteraction(third);
    assert.equal(data(third.replies[0]).fields.length, 1); assert.equal(third.replies[0].components[0].components[1].data.disabled, true);
    const fresh = interaction({ id: targetId }); await bot.onInteraction(fresh);
    assert.match(data(fresh.replies[0]).fields[0].name, /#10/);
});

test('explicit page selection reaches older records and clamps pages beyond the end', async t => {
    const { bot, interaction } = fixture(t, Array.from({ length: 9 }, (_, i) => entry(i + 1)));
    for (const page of [3, 99999]) {
        const request = interaction({ id: targetId, page }); await bot.onInteraction(request);
        assert.match(data(request.replies[0]).footer.text, /Page 3 of 3/); assert.match(data(request.replies[0]).fields[0].name, /#1/);
    }
});

test('history buttons reject other moderators, other servers, public messages and other bots', async t => {
    const { bot, interaction } = fixture(t); const first = interaction({ id: targetId }); await bot.onInteraction(first);
    const id = buttonId(first.replies[0], 2);
    const attempts = [interaction({ actorId: otherUser }, id), interaction({ guildId: otherGuild }, id), interaction({}, id), interaction({}, id), interaction({}, 'lookup:malformed')];
    attempts[2].message.flags = new MessageFlagsBitField(0); attempts[3].message.author.id = otherUser;
    for (const request of attempts) {
        await bot.onInteraction(request); assert.equal(request.calls[0][0], 'reply');
        assert.equal(request.replies[0].flags, 64); assert.equal(request.replies[0].embeds.length, 0);
        assert.doesNotMatch(request.replies[0].content, /Reason 1/);
    }
});

test('permissions are rechecked on every page and download click; revoked permissions expose no new data', async t => {
    const { bot, access, interaction } = fixture(t); const first = interaction({ id: targetId }); await bot.onInteraction(first);
    access.permissions = new PermissionsBitField([]);
    for (const index of [1, 2]) {
        const request = interaction({}, buttonId(first.replies[0], index)); await bot.onInteraction(request);
        assert.match(request.replies[0].content, /permission is required/); assert.equal(request.replies[0].embeds.length, 0);
        assert.equal(request.replies[0].files, undefined);
    }
});

test('download contains all cases, full original reasons and moderator IDs without cross-server records', async t => {
    const longReason = '**long original reason**\n' + 'Details '.repeat(300);
    const { bot, interaction } = fixture(t, [entry(1, { reason: longReason }), ...Array.from({ length: 8 }, (_, i) => entry(i + 2)), entry(10, { guildId: otherGuild, reason: 'hidden-other-server' })]);
    const first = interaction({ id: targetId }); await bot.onInteraction(first);
    const download = interaction({}, buttonId(first.replies[0], 2)); await bot.onInteraction(download);
    assert.deepEqual(download.calls[0], ['deferReply', { flags: 64 }]);
    const file = download.replies[0].files[0]; const text = file.attachment.toString();
    assert.match(file.name, /\.txt$/); assert.match(text, /Recorded cases: 9/);
    assert.ok(text.includes(longReason)); assert.ok(text.includes(`Given by (Discord user ID): ${staffId}`));
    assert.match(text, /When \(UTC\): 2026-01-01T00:00:00.000Z/); assert.doesNotMatch(text, /hidden-other-server/);
});

test('history buttons remain usable after the controller restarts', async t => {
    const firstBot = fixture(t, Array.from({ length: 6 }, (_, i) => entry(i + 1)));
    const first = firstBot.interaction({ id: targetId }); await firstBot.bot.onInteraction(first);
    const restarted = fixture(t, firstBot.state.cases);
    const next = restarted.interaction({}, buttonId(first.replies[0], 1)); await restarted.bot.onInteraction(next);
    assert.match(data(next.replies[0]).footer.text, /Page 2 of 2/);
});

test('unknown dates, moderators and reasons are labelled unavailable; reversals stay in history', () => {
    const entries = [entry(1, { action: 'untimeout', moderatorUserId: '', reason: '', createdAt: 'invalid' })];
    const reply = historyPage(entries, { guildId, requesterId: staffId, targetId, anchor: 1 });
    assert.match(data(reply).fields[0].name, /Timeout removed/); assert.match(data(reply).fields[0].value, /When: Not recorded\nBy: Not recorded\nReason: No reason recorded/);
    assert.doesNotMatch(JSON.stringify(reply), /NaN/);
});

test('empty histories have a precise recorded-history message, without dead navigation buttons', async t => {
    const { bot, interaction } = fixture(t, []); const request = interaction({ id: targetId }); await bot.onInteraction(request);
    assert.match(data(request.replies[0]).description, /No punishments recorded/); assert.deepEqual(request.replies[0].components, []);
});

test('large reasons fit a single embed and remain complete in the optional download', async () => {
    const entries = Array.from({ length: 4 }, (_, i) => entry(i + 1, { reason: '@everyone **literal** ' + 'X'.repeat(5000) }));
    const reply = historyPage(entries, { guildId: '9'.repeat(20), requesterId: '8'.repeat(20), targetId: '7'.repeat(20), anchor: Number.MAX_SAFE_INTEGER });
    const embed = data(reply);
    assert.ok(embed.fields.every(field => field.value.length <= 1024));
    assert.ok(embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0) <= 6000);
    assert.match(embed.fields[0].value, /Full reason in history download/);
    assert.ok(reply.components[0].components.every(button => button.data.custom_id.length <= 100));
    assert.deepEqual(reply.allowedMentions, { parse: [] });
    const file = await historyDownload(entries, guildId, targetId);
    assert.ok(file.attachment.toString().includes('X'.repeat(5000)));
});

test('large downloads compress losslessly and impossible attachment sizes fail without partial data', async () => {
    const entries = [entry(1, { reason: 'Long reason '.repeat(1000) })];
    const file = await historyDownload(entries, guildId, targetId, 1000);
    assert.match(file.name, /\.txt\.gz$/); assert.ok(gunzipSync(file.attachment).toString().includes(entries[0].reason));
    await assert.rejects(historyDownload(entries, guildId, targetId, 1), /download limit/);
});

test('internal failures are sanitized and never expose connection details in a history response', async t => {
    const { bot, interaction, store } = fixture(t); const first = interaction({ id: targetId }); await bot.onInteraction(first);
    store.read = async () => { throw new Error('private database credentials'); };
    const request = interaction({}, buttonId(first.replies[0], 2)); await bot.onInteraction(request);
    assert.match(request.replies[0].content, /could not be loaded/); assert.doesNotMatch(JSON.stringify(request.replies), /private database/);
    const slash = interaction({ id: targetId }); await bot.onInteraction(slash);
    assert.match(slash.replies[0].content, /could not be loaded/); assert.doesNotMatch(JSON.stringify(slash.replies), /private database/);
});

test('all matching records remain available beyond a single page or the audit-retention window', () => {
    const state = initialState(); state.cases = [entry(1, { createdAt: '2020-01-01T00:00:00Z' }), entry(2), entry(3, { guildId: otherGuild })];
    assert.equal(historyCases(state, guildId, targetId).length, 2);
    assert.equal(historyCases(state, guildId, targetId, 1).length, 1);
});

test('persistent storage retains old punishment cases beyond the previous 20,000-case cap', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cleaner-lookup-'));
    const store = new AppStore({ env: {}, directory, logger: quiet }); await store.ready;
    t.after(async () => {
        await store.close();
        if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test directory');
        await rm(directory, { recursive: true, force: true });
    });
    await store.update(state => { state.cases = Array.from({ length: 20001 }, (_, i) => ({ ...entry(1), id: i + 1 })); });
    assert.equal((await store.read()).cases.length, 20001); assert.equal((await store.read()).cases[0].id, 1);
    const reopened = new AppStore({ env: {}, directory, logger: quiet }); await reopened.ready;
    assert.equal((await reopened.read()).cases.length, 20001); await reopened.close();
});

test('ready registration installs lookup globally and in each server without removing existing commands', async t => {
    const { bot, guild } = fixture(t); const registered = [];
    bot.guilds = () => [{ id: guildId, name: 'Server' }]; bot.importLegacyCleaner = async () => {};
    bot.client.application = { commands: { set: async definitions => registered.push(definitions) } };
    guild.commands = { set: async definitions => registered.push(definitions) };
    await bot.onReady();
    assert.equal(registered.length, 2);
    for (const definitions of registered) {
        assert.equal(definitions.filter(command => command.name === 'lookup').length, 1);
        assert.ok(definitions.some(command => command.name === 'purge')); assert.ok(definitions.some(command => command.name === 'warn'));
    }
});
