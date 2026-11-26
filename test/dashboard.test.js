import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppStore, databaseOptions, parseConnectionString } from '../app/store.js';
import { seal, unseal, secretKey } from '../app/security.js';
import { createDashboard } from '../app/web.js';
import { guildDefaults, SUPERADMIN_ID, validateGuildSettings } from '../app/settings.js';
import { findViolation } from '../app/bot.js';
import { startRuntime } from '../runtime.js';

const guildId = '1505183872705363998';
const otherGuild = '1505183872705363999';
const channelId = '1574423826417193091';
const userId = '680840717731364927';
const quiet = { log() {}, error() {} };

async function fixture(t, env = {}, fetcher) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cleaner-dashboard-'));
    const store = new AppStore({ env, directory, logger: quiet });
    await store.ready;
    await store.update(state => {
        state.guilds[guildId] = guildDefaults(guildId, 'Community server');
        state.guilds[otherGuild] = guildDefaults(otherGuild, 'Other server');
        state.settings.clientId = '123456789012345678';
    });
    const calls = [];
    let setup = 'one-time-discord-verified-owner-link';
    const bot = { isReady: () => true, contentAccess: false, origin: '', client: { user: { id: '123456789012345678' }, guilds: { cache: new Map() } },
        guilds: () => [{ id: guildId, name: 'Community server', memberCount: 42 }],
        channels: () => [{ id: channelId, name: 'moderation', text: true }],
        canManage: async (id, user) => user === SUPERADMIN_ID || (user === userId && id === guildId),
        consumeSetup: token => { const match = token === setup; setup = null; return match ? SUPERADMIN_ID : null; },
        moderate: async (...args) => { calls.push(args); }, purge: async (...args) => { calls.push(args); return 7; },
        loggingDiagnostics: async () => [{ category: 'moderation', label: 'Moderation actions', ok: true, status: 'ready', message: 'Ready to send.', canTest: true }],
        testLog: async (...args) => { calls.push(['testLog', ...args]); return { ok: true, message: 'Test log delivered.' }; },
        restart: async () => { calls.push('restart'); }, destroy: async () => {}, login: async () => {} };
    const runtime = await startRuntime({ client: bot, token: '', port: 0, host: '127.0.0.1', version: '2.1.0', logger: quiet,
        createHandler: getStatus => createDashboard({ store, bot, version: '2.1.0', env, getStatus, fetcher, logger: quiet }) });
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const request = (url, options = {}) => fetch(origin + url, { redirect: 'manual', ...options });
    const state = await store.read();
    const session = (id = SUPERADMIN_ID) => {
        const csrf = 'valid-test-csrf';
        const value = { id, name: 'Verified owner', avatar: '', guildIds: [guildId], expires: Date.now() + 60000, csrf };
        return { csrf, cookie: `CleanerSession=${seal(value, secretKey(state, env))}` };
    };
    t.after(async () => {
        await runtime.stop(); await store.close();
        if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test directory');
        await rm(directory, { recursive: true, force: true });
    });
    return { store, bot, request, origin, session, calls, directory };
}

test('root opens dashboard; status remains separate and assets actually load', async t => {
    const { request } = await fixture(t);
    const root = await request('/'); assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/Dashboard');
    const dashboard = await request('/Dashboard'); assert.equal(dashboard.status, 200); assert.match(await dashboard.text(), /The Cleaner dashboard/);
    const service = await request('/service'); assert.equal(service.status, 200); assert.match(await service.text(), /Open dashboard/);
    for (const asset of ['/assets/app.css', '/assets/app.js', '/assets/mark.svg', '/assets/lucide.js']) assert.equal((await request(asset)).status, 200, asset);
    assert.equal((await request('/health')).status, 200);
    assert.match(dashboard.headers.get('cache-control'), /no-store/);
    assert.match(dashboard.headers.get('content-security-policy'), /script-src 'self'/);
});

test('no public setup or query-string admin bypass; one-time setup requires verified Discord link', async t => {
    const { request } = await fixture(t);
    assert.doesNotMatch(await (await request('/SuperAdmin?userId=' + SUPERADMIN_ID)).text(), /Owner verified/);
    assert.equal((await request('/Auth/Setup?token=wrong')).status, 403);
    // A bad link does not consume a different, valid link in production; this mock is reset here.
    const { request: fresh } = await fixture(t);
    const first = await fresh('/Auth/Setup?token=one-time-discord-verified-owner-link');
    assert.equal(first.status, 302); assert.equal(first.headers.get('location'), '/SuperAdmin');
    assert.match(first.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await fresh('/Auth/Setup?token=one-time-discord-verified-owner-link')).status, 403);
});

test('all dashboard pages render; non-owner cannot access superadmin or another server', async t => {
    const { request, session } = await fixture(t);
    const owner = session();
    assert.equal((await request('/SuperAdmin', { headers: { cookie: owner.cookie } })).status, 200);
    for (const tab of ['overview', 'moderation', 'channels', 'automod', 'actions', 'logs', 'cleaner', 'cases', 'levels', 'welcome', 'settings']) {
        const response = await request(`/Dashboard/Guild/${guildId}?tab=${tab}`, { headers: { cookie: owner.cookie } });
        assert.equal(response.status, 200, tab); assert.doesNotMatch(await response.text(), /Request could not be completed/);
    }
    const member = session(userId);
    assert.equal((await request('/SuperAdmin', { headers: { cookie: member.cookie } })).status, 403);
    assert.equal((await request(`/Dashboard/Guild/${otherGuild}`, { headers: { cookie: member.cookie } })).status, 403);
    assert.equal((await request(`/Dashboard/AuditLogs/${guildId}`, { headers: { cookie: member.cookie } })).status, 403);
    assert.equal((await request('/SuperAdmin', { headers: { cookie: owner.cookie.slice(0, -5) + 'wrong' } })).status, 200);
    assert.doesNotMatch(await (await request('/SuperAdmin', { headers: { cookie: 'CleanerSession=forged' } })).text(), /Owner verified/);
});

test('module views render one focused form with server-scoped navigation and direct setting search', async t => {
    const { request, session, store, calls } = await fixture(t); const member = session(userId);
    await store.update(state => { state.guilds[guildId].premiumTier = 'Business'; });
    for (const [tab, view, section] of [['automod','rules','automodRules'],['automod','words','words'],['automod','ignored','ignored'],['actions','settings','moderationOptions'],['logs','channels','logDestinations'],['logs','events','logEvents'],['levels','settings','levelSettings'],['welcome','','welcome'],['settings','','general'],['cleaner','','cleaner']]) {
        const response = await request(`/Dashboard/Guild/${guildId}?tab=${tab}&view=${view}`, { headers: { cookie: member.cookie } });
        assert.equal(response.status, 200, `${tab}/${view}`); const page = await response.text();
        assert.match(page, new RegExp(`name="section" value="${section}"`));
        assert.equal((page.match(/data-settings-form/g) || []).length, 1);
        assert.match(page, /aria-label="Server navigation"/); assert.match(page, /aria-label="Search settings"/);
        assert.match(page, /data-save-state/); assert.match(page, /data-discard/);
        assert.doesNotMatch(page, /Other server/);
    }
    const words = await (await request(`/Dashboard/Guild/${guildId}?tab=automod&view=words`, { headers: { cookie: member.cookie } })).text();
    assert.doesNotMatch(words, /name="levelsChannelId"|name="welcomeMessage"|name="spamMessageLimit"/);
    const levels = await (await request(`/Dashboard/Guild/${guildId}?tab=levels`, { headers: { cookie: member.cookie } })).text();
    assert.match(levels, /Level announcement channel/); assert.doesNotMatch(levels, /name="welcomeChannelId"|name="ignoredModerationChannelIds"/);
    assert.deepEqual(calls, [], 'page loads must not send log tests or run moderation actions');
});

test('partial module saves change only the fields owned by that view', async t => {
    const { request, session, store } = await fixture(t); const owner = session();
    await store.update(state => { const config = state.guilds[guildId]; config.prefix = '?'; config.enableDmModerationNotices = true; config.enableWelcome = true; config.welcomeMessage = 'Keep welcome'; config.ignoredModerationChannelIds = [channelId]; });
    const scenarios = [
        [{ section: 'words', blockedWords: 'first,second' }, ['blockedWords']],
        [{ section: 'ignored' }, ['ignoredModerationChannelIds']],
        [{ section: 'levelSettings', levelsChannelId: channelId, enableLevels: 'on' }, ['levelsChannelId','enableLevels','enableVoiceXp']],
        [{ section: 'welcome', welcomeChannelId: channelId, welcomeMessage: 'Hello', goodbyeMessage: 'Goodbye' }, ['welcomeChannelId','enableWelcome','welcomeMessage','goodbyeMessage']],
        [{ section: 'general', prefix: '!!', logChannelId: channelId }, ['prefix','logChannelId']],
        [{ section: 'moderationOptions', maxWarningsBeforeTimeout: '7', timeoutMinutes: '20' }, ['maxWarningsBeforeTimeout','timeoutMinutes','enableDmModerationNotices']],
        [{ section: 'automodRules', enableModeration: 'on', enableAntiSpam: 'on', spamWindowSeconds: '9', spamMessageLimit: '6', mentionLimit: '7', capsMinimumLength: '15', capsPercentage: '80' }, ['enableModeration','enableAntiSpam','enableInviteFilter','enableLinkFilter','enableCapsFilter','enableProfanityFilter','enableMentionFilter','spamWindowSeconds','spamMessageLimit','mentionLimit','capsMinimumLength','capsPercentage']]
    ];
    for (const [body, keys] of scenarios) {
        const before = structuredClone((await store.read()).guilds[guildId]);
        const result = await request(`/Dashboard/Guild/${guildId}`, { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: owner.csrf, premiumTier: 'Enterprise', ...body }) });
        assert.equal(new URL(result.headers.get('location'), 'http://local').searchParams.get('message'), 'Settings saved.');
        const after = (await store.read()).guilds[guildId];
        for (const key of [...keys, 'updatedAt']) { delete before[key]; delete after[key]; }
        assert.deepEqual(after, before, body.section);
    }
});

test('log destination and event saves preserve settings in the other Action Log view', async t => {
    const { request, session, store } = await fixture(t); const owner = session();
    await store.update(state => { const config = state.guilds[guildId]; config.premiumTier = 'Business'; config.auditLogs.messageEdits = true; config.auditLogs.channelChanges = true; config.auditLogs.roleChanges = true; });
    const post = body => request(`/Dashboard/Guild/${guildId}`, { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: owner.csrf, ...body }) });
    await post({ section: 'logDestinations', enabled: 'on', moderationActions: 'on', autoModActions: 'on', includeMessageContent: 'on', moderationChannelId: channelId, autoModChannelId: channelId, serverChannelId: channelId });
    let logs = (await store.read()).guilds[guildId].auditLogs;
    assert.equal(logs.messageEdits, true); assert.equal(logs.channelChanges, true); assert.equal(logs.roleChanges, true);
    await post({ section: 'logEvents', serverChannelId: channelId, sendServerEventsToDiscord: 'on', voiceChanges: 'on' });
    logs = (await store.read()).guilds[guildId].auditLogs;
    assert.equal(logs.moderationChannelId, channelId); assert.equal(logs.autoModChannelId, channelId);
    assert.equal(logs.moderationActions, true); assert.equal(logs.autoModActions, true); assert.equal(logs.includeMessageContent, true);
    assert.equal(logs.voiceChanges, true); assert.equal(logs.channelChanges, false);
});

test('new module forms reject foreign channels, missing channels, CSRF failures and free-plan log writes', async t => {
    const { request, session, store, bot } = await fixture(t); const owner = session();
    const post = body => request(`/Dashboard/Guild/${guildId}`, { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: owner.csrf, ...body }) });
    const before = (await store.read()).guilds[guildId];
    const wrongCsrf = await post({ csrf: 'wrong', section: 'words', blockedWords: 'changed' }); assert.equal(wrongCsrf.status, 403);
    for (const body of [{ section: 'levelSettings', levelsChannelId: otherGuild }, { section: 'welcome', welcomeChannelId: otherGuild }, { section: 'ignored', ignoredModerationChannelIds: otherGuild }, { section: 'logEvents', serverChannelId: channelId }]) await post(body);
    assert.deepEqual((await store.read()).guilds[guildId], before);
    bot.channels = () => [];
    await post({ section: 'levelSettings', levelsChannelId: '', enableLevels: 'on' });
    assert.deepEqual((await store.read()).guilds[guildId], before);
});

test('punishment history searches all records, filters and paginates with moderator IDs', async t => {
    const { request, session, store } = await fixture(t); const member = session(userId);
    await store.update(state => { state.cases = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, guildId, targetUserId: userId, targetUserTag: 'Member', moderatorUserId: SUPERADMIN_ID, action: index % 2 ? 'ban' : 'warn', reason: `Record-${index + 1}-end`, createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() })); state.cases.push({ ...state.cases[0], id: 1000, guildId: otherGuild, reason: 'cross-server-secret' }); });
    const headers = { cookie: member.cookie };
    const first = await (await request(`/Dashboard/Guild/${guildId}?tab=cases`, { headers })).text();
    assert.match(first, /Page 1 of 3/); assert.match(first, /Record-60-end/); assert.doesNotMatch(first, /Record-1-end|cross-server-secret/);
    const last = await (await request(`/Dashboard/Guild/${guildId}?tab=cases&page=3`, { headers })).text();
    assert.match(last, /Record-1-end/); assert.match(last, new RegExp(SUPERADMIN_ID));
    const filtered = await (await request(`/Dashboard/Guild/${guildId}?tab=cases&q=${SUPERADMIN_ID}&action=ban`, { headers })).text();
    assert.match(filtered, /Page 1 of 2/); assert.doesNotMatch(filtered, /Record-59-end|cross-server-secret/);
    const one = await (await request(`/Dashboard/Guild/${guildId}?tab=cases&q=Record-1-end`, { headers })).text();
    assert.match(one, /Record-1-end/); assert.doesNotMatch(one, /Record-2-end/);
});

test('punishment CSV exports all matching records with safe cells and existing server authorization', async t => {
    const { request, session, store } = await fixture(t); const member = session(userId);
    await store.update(state => { state.cases = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, guildId, targetUserId: userId, moderatorUserId: SUPERADMIN_ID, action: 'warn', reason: '=SUM(1,2)', createdAt: '2026-01-01T00:00:00Z' })); state.cases.push({ ...state.cases[0], guildId: otherGuild, reason: 'hidden-other-guild' }); });
    const response = await request(`/Dashboard/Guild/${guildId}?tab=cases&format=csv`, { headers: { cookie: member.cookie } });
    assert.equal(response.status, 200); const csv = await response.text();
    assert.equal(csv.split('\r\n').length, 41); assert.match(csv, /Moderator ID/); assert.match(csv, /"'=SUM/); assert.doesNotMatch(csv, /hidden-other-guild/);
    assert.equal((await request(`/Dashboard/Guild/${otherGuild}?tab=cases&format=csv`, { headers: { cookie: member.cookie } })).status, 403);
});

test('structured cleaner targets save correctly, including permanent targets and clearing the list', async t => {
    const { request, session, store } = await fixture(t); const owner = session();
    const body = new URLSearchParams({ csrf: owner.csrf, section: 'cleaner', intervalMinutes: '30', cleanerLogChannelId: channelId, monitorChannels: channelId });
    for (const [id, rounds] of [['123456789012345678','-1'],['123456789012345679','12']]) { body.append('botIds', id); body.append('botRounds', rounds); }
    await request(`/Dashboard/Guild/${guildId}`, { method: 'POST', headers: { cookie: owner.cookie }, body });
    assert.deepEqual((await store.read()).guilds[guildId].cleaner.botList, [{ botId: '123456789012345678', rounds: -1 }, { botId: '123456789012345679', rounds: 12 }]);
    body.delete('botIds'); body.delete('botRounds');
    await request(`/Dashboard/Guild/${guildId}`, { method: 'POST', headers: { cookie: owner.cookie }, body });
    assert.deepEqual((await store.read()).guilds[guildId].cleaner.botList, []);
});

test('writes require CSRF and reject cross-origin requests', async t => {
    const { request, session } = await fixture(t);
    const owner = session();
    for (const [csrf, origin] of [['wrong', undefined], [owner.csrf, 'https://evil.example']]) {
        const response = await request('/SuperAdmin', { method: 'POST', headers: { cookie: owner.cookie, ...(origin ? { origin } : {}) }, body: new URLSearchParams({ csrf }) });
        assert.equal(response.status, 403);
    }
    assert.equal((await request('/SuperAdmin', { method: 'POST', body: new URLSearchParams({ clientId: '123456789012345678' }) })).status, 403);
});

test('credentials are encrypted, masked, and environment-managed values are not overwritten', async t => {
    const { request, session, store } = await fixture(t, { DISCORD_TOKEN: 'secret-environment-token', SESSION_SECRET: 'stable-test-key' });
    const owner = session();
    const result = await request('/SuperAdmin', { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: owner.csrf, clientId: '123456789012345678', clientSecret: 'private-client-secret', botToken: 'attempted-override' }) });
    assert.equal(result.status, 302);
    const state = await store.read();
    assert.equal(state.settings.botToken, '');
    assert.notEqual(state.settings.clientSecret, 'private-client-secret');
    assert.equal(unseal(state.settings.clientSecret, 'stable-test-key'), 'private-client-secret');
    const page = await (await request('/SuperAdmin', { headers: { cookie: owner.cookie } })).text();
    assert.doesNotMatch(page, /secret-environment-token|private-client-secret|attempted-override/);
});

test('server channel settings persist and reject cross-server IDs', async t => {
    const { request, session, store } = await fixture(t);
    const owner = session();
    const body = { csrf: owner.csrf, section: 'channels', prefix: '?', levelsChannelId: channelId, logChannelId: '', welcomeChannelId: '', enableLevels: 'on', enableVoiceXp: 'on', ignoredModerationChannelIds: channelId, welcomeMessage: 'Hi {user}', goodbyeMessage: 'Bye' };
    const saved = await request(`/Dashboard/Guild/${guildId}`, { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams(body) });
    assert.equal(new URL(saved.headers.get('location'), 'http://local').searchParams.get('message'), 'Settings saved.');
    const state = await store.read(); assert.equal(state.guilds[guildId].levelsChannelId, channelId); assert.deepEqual(state.guilds[guildId].ignoredModerationChannelIds, [channelId]);
    await request(`/Dashboard/Guild/${guildId}`, { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ ...body, levelsChannelId: otherGuild }) });
    assert.equal((await store.read()).guilds[guildId].levelsChannelId, channelId);
});

test('Channel changes is visible and saved on the audit settings page, including legacy preferences', async t => {
    const { request, session, store } = await fixture(t);
    const owner = session();
    await store.update(state => { const config = state.guilds[guildId]; config.premiumTier = 'Business'; delete config.auditLogs.channelChanges; config.auditLogs.serverChanges = true; });
    const legacyPage = await (await request(`/Dashboard/Guild/${guildId}?tab=logs&view=events`, { headers: { cookie: owner.cookie } })).text();
    assert.match(legacyPage, /name="channelChanges"\s+checked/);
    assert.match(legacyPage, /name="roleChanges"/);
    const saved = await request(`/Dashboard/Guild/${guildId}`, { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: owner.csrf, section: 'logs', enabled: 'on', moderationActions: 'on', autoModActions: 'on', sendServerEventsToDiscord: 'on', serverChannelId: channelId, channelChanges: 'on', roleChanges: 'on' }) });
    assert.equal(saved.status, 302); assert.equal(new URL(saved.headers.get('location'), 'http://local').searchParams.get('message'), 'Settings saved.');
    const config = (await store.read()).guilds[guildId];
    assert.equal(config.auditLogs.channelChanges, true); assert.equal(config.auditLogs.serverChanges, false); assert.equal(config.auditLogs.roleChanges, true);
});

test('uppercase legacy credentials remain environment-managed on the owner settings page', async t => {
    const { request, session, store } = await fixture(t, { BOT__DISCORDCLIENTID: '123456789012345679', BOT__DISCORDCLIENTSECRET: 'uppercase-private-secret', BOT__DISCORDBOTTOKEN: 'uppercase-private-token' });
    const owner = session();
    const page = await (await request('/SuperAdmin', { headers: { cookie: owner.cookie } })).text();
    assert.match(page, /Application \/ client ID \(environment\)/);
    assert.match(page, /Client secret \(environment\)/);
    assert.match(page, /Bot token \(environment\)/);
    assert.doesNotMatch(page, /uppercase-private-secret|uppercase-private-token/);
    await request('/SuperAdmin', { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: owner.csrf, clientId: '123456789012345670', clientSecret: 'override', botToken: 'override' }) });
    const state = await store.read();
    assert.equal(state.settings.clientId, '123456789012345678');
    assert.equal(state.settings.clientSecret, '');
    assert.equal(state.settings.botToken, '');
});

test('moderation form invokes the bot only after confirmation and permission checks', async t => {
    const { request, session, calls } = await fixture(t);
    const owner = session();
    const body = { csrf: owner.csrf, action: 'timeout', userId, reason: 'Spam', minutes: '10' };
    assert.equal((await request(`/Dashboard/Guild/${guildId}/action`, { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams(body) })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await request(`/Dashboard/Guild/${guildId}/action`, { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ ...body, confirm: 'on' }) })).status, 302);
    assert.deepEqual(calls[0], [guildId, 'timeout', userId, 'Spam', SUPERADMIN_ID, 10]);
});

test('changing privileged intents reconnects automatically, without the optional restart checkbox', async t => {
    const { request, session, calls, store } = await fixture(t);
    const owner = session();
    const result = await request('/SuperAdmin', { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: owner.csrf, clientId: '123456789012345678', privilegedIntents: 'on' }) });
    assert.equal(result.status, 302); assert.match(result.headers.get('location'), /Reconnecting/);
    assert.equal((await store.read()).settings.privilegedIntents, true);
    assert.deepEqual(calls, ['restart']);
});

test('reconnect endpoint requires both owner access and CSRF', async t => {
    const { request, session, calls } = await fixture(t);
    const owner = session(); const member = session(userId);
    assert.equal((await request('/SuperAdmin/reconnect', { method: 'POST', headers: { cookie: member.cookie }, body: new URLSearchParams({ csrf: member.csrf }) })).status, 403);
    assert.equal((await request('/SuperAdmin/reconnect', { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: 'wrong' }) })).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await request('/SuperAdmin/reconnect', { method: 'POST', headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: owner.csrf }) })).status, 302);
    assert.deepEqual(calls, ['restart']);
});

test('log diagnostics are read-only and log tests require server access, CSRF, valid category and plan', async t => {
    const { request, session, calls } = await fixture(t);
    const member = session(userId);
    const checks = await request(`/Dashboard/Guild/${guildId}/diagnostics`, { headers: { cookie: member.cookie } });
    assert.equal(checks.status, 200); assert.equal((await checks.json()).logs[0].status, 'ready');
    assert.equal(calls.length, 0);
    const options = body => ({ method: 'POST', headers: { cookie: member.cookie }, body: new URLSearchParams(body) });
    assert.equal((await request(`/Dashboard/Guild/${otherGuild}/test-log`, options({ csrf: member.csrf, category: 'moderation' }))).status, 403);
    assert.equal((await request(`/Dashboard/Guild/${guildId}/test-log`, options({ csrf: 'wrong', category: 'moderation' }))).status, 403);
    assert.equal((await request(`/Dashboard/Guild/${guildId}/test-log`, options({ csrf: member.csrf, category: 'invalid' }))).status, 400);
    assert.equal((await request(`/Dashboard/Guild/${guildId}/test-log`, options({ csrf: member.csrf, category: 'automod' }))).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await request(`/Dashboard/Guild/${guildId}/test-log`, options({ csrf: member.csrf, category: 'moderation' }))).status, 302);
    assert.deepEqual(calls[0], ['testLog', guildId, 'moderation']);
});

test('Business log history escapes hostile content and exports formula-safe CSV', async t => {
    const { request, session, store } = await fixture(t);
    const owner = session();
    await store.update(state => { state.guilds[guildId].premiumTier = 'Business'; state.audit.push({ guildId, category: 'automod', title: 'Blocked link', details: '=SUM(1,2)<script>alert(1)</script>', createdAt: new Date().toISOString() }); });
    const page = await (await request(`/Dashboard/AuditLogs/${guildId}`, { headers: { cookie: owner.cookie } })).text();
    assert.match(page, /&lt;script&gt;/); assert.doesNotMatch(page, /<script>alert/);
    const csv = await (await request(`/Dashboard/AuditLogs/${guildId}?format=csv`, { headers: { cookie: owner.cookie } })).text();
    assert.match(csv, /"'=SUM/);
});

test('structured audit history escapes before/after and only renders Discord context links', async t => {
    const { request, session, store } = await fixture(t); const owner = session();
    await store.update(state => {
        state.guilds[guildId].premiumTier = 'Business';
        state.audit.push({ guildId, category: 'server', title: 'Message Edited', details: 'Before and after text', createdAt: new Date().toISOString(),
            presentation: { description: 'From member', fields: [{ name: 'Before', value: '<script>hostile()</script>', segments: [{ text: '<script>hostile()</script>', changed: true }] }, { name: 'After', value: 'Updated text', segments: [{ text: 'Updated', changed: true }, { text: ' text', changed: false }] }], footer: 'Message ID: 123', jumpUrl: `https://discord.com/channels/${guildId}/${channelId}` } });
        state.audit.push({ guildId, category: 'server', title: 'Old entry', details: 'Legacy text', createdAt: new Date().toISOString(), presentation: { jumpUrl: 'javascript:hostile()' } });
    });
    const page = await (await request(`/Dashboard/AuditLogs/${guildId}`, { headers: { cookie: owner.cookie } })).text();
    assert.match(page, /<h4>Before<\/h4>/); assert.match(page, /<h4>After<\/h4>/);
    assert.match(page, /<u class="edit-change">&lt;script&gt;hostile/); assert.match(page, /<u class="edit-change">Updated<\/u> text/); assert.match(page, /Legacy text/);
    assert.match(page, new RegExp(`https://discord.com/channels/${guildId}/${channelId}`));
    assert.doesNotMatch(page, /javascript:hostile|<script>hostile/);
});

test('OAuth state must match, callback uses the public HTTPS origin, session never contains access token', async t => {
    const urls = [];
    const fetcher = async (url, options) => {
        urls.push([url, options]);
        const data = url.endsWith('/token') ? { access_token: 'private-access-token' } : url.endsWith('/guilds') ? [{ id: guildId, permissions: '32' }] : { id: userId, username: 'Moderator', avatar: null };
        return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { request, store } = await fixture(t, { DISCORD_CLIENT_SECRET: 'client-secret', PUBLIC_URL: 'https://thecleanerbot.space' }, fetcher);
    assert.equal((await request('/Auth/Callback?code=code&state=forged')).status, 400);
    const login = await request('/Auth/Login');
    const location = new URL(login.headers.get('location'));
    assert.equal(location.searchParams.get('redirect_uri'), 'https://thecleanerbot.space/Auth/Callback');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const callback = await request(`/Auth/Callback?code=code&state=${location.searchParams.get('state')}`, { headers: { cookie } });
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get('set-cookie'), /Secure/);
    const sessionCookie = callback.headers.getSetCookie().find(value => value.startsWith('CleanerSession='));
    const state = await store.read();
    const session = unseal(sessionCookie.split(';')[0].split('=')[1], state.sessionKey);
    assert.equal(session.id, userId); assert.deepEqual(session.guildIds, [guildId]);
    assert.doesNotMatch(JSON.stringify(session), /private-access-token|client-secret/);
    assert.equal(urls[0][1].body.get('redirect_uri'), 'https://thecleanerbot.space/Auth/Callback');
});

test('file storage survives restart, serializes concurrent writes and rolls back failed mutations', async t => {
    const { store, directory } = await fixture(t);
    await Promise.all(Array.from({ length: 8 }, () => store.update(state => { state.nextCaseId++; })));
    const before = await store.read();
    await assert.rejects(store.update(state => { state.nextCaseId = 10000; throw new Error('No commit'); }));
    const reopened = new AppStore({ env: {}, directory, logger: quiet }); await reopened.ready;
    assert.equal((await reopened.read()).nextCaseId, before.nextCaseId);
    await reopened.close();
});

test('MySQL connection string parsing preserves dollars, semicolons, and quoted passwords', () => {
    const settings = parseConnectionString('Server=db.example;Port=3306;Database=bot;User ID=admin;Password="example;dollar$";SslMode=Required;');
    assert.equal(settings.password, 'example;dollar$'); assert.equal(settings.user, 'admin'); assert.equal(settings.ssl.rejectUnauthorized, true);
    assert.equal(parseConnectionString("Server=db;Password='it''s;quoted';SslMode=None;").password, "it's;quoted");
    assert.throws(() => parseConnectionString('Server=db;Password="not closed;'));
    assert.equal(databaseOptions({ ConnectionStrings__BotDatabase: 'Data Source=discordbot.db' }), null);
});

test('filters honor ignored channels, word/link rules, and image floods without matching normal chat', () => {
    const config = guildDefaults(guildId); config.blockedWords = ['banned'];
    const message = { content: 'BANNED words', channelId, channel: {}, mentions: { users: { size: 0 }, roles: { size: 0 } } };
    assert.equal(findViolation(message, config), 'Blocked word');
    config.ignoredModerationChannelIds = [channelId]; assert.equal(findViolation(message, config), null);
    config.ignoredModerationChannelIds = []; config.enableLinkFilter = true; message.content = 'https://example.com'; assert.equal(findViolation(message, config), 'Blocked link');
    message.content = 'ordinary chat'; assert.equal(findViolation(message, config), null);
    assert.equal(findViolation(message, config, [{ images: 2, channelId }, { images: 3, channelId: otherGuild }]), 'Image flood across channels');
    assert.throws(() => validateGuildSettings({ section: 'logs' }, config, []), /Business/);
});
