import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { GatewayIntentBits } from 'discord.js';
import { GatewayConnection } from '../app/connection.js';
import { startRuntime } from '../runtime.js';

const logger = { log() {}, error() {} };
class FakeClient extends EventEmitter {
    constructor(options, behavior) { super(); this.options = options; this.behavior = behavior; this.ready = false; this.dead = false; this.guilds = { cache: new Map() }; }
    isReady() { return this.ready && !this.dead; }
    async login(token) {
        assert.equal(this.dead, false, 'a destroyed Discord client must never be reused');
        if (this.behavior) return this.behavior(this, token);
        this.ready = true; this.emit('clientReady'); return token;
    }
    async destroy() { this.dead = true; this.ready = false; this.emit('shardDisconnect', { code: 1000 }); }
}
function setup(t, behavior, options = {}) {
    const clients = [];
    const connection = new GatewayConnection({ logger, readyTimeoutMs: 1000, ...options,
        createClient: config => { const client = new FakeClient(config, behavior); clients.push(client); return client; } });
    t.after(() => connection.destroy());
    return { connection, clients };
}

test('reconnecting replaces the destroyed client and binds each new session once', async t => {
    let bound = 0;
    const { connection, clients } = setup(t, null, { bindClient: () => { bound++; } });
    await connection.connect('private-token', false);
    const first = connection.client;
    await connection.connect('private-token', true);
    assert.notEqual(connection.client, first); assert.equal(first.dead, true);
    assert.equal(connection.client.options.intents.includes(GatewayIntentBits.MessageContent), true);
    assert.equal(connection.getStatus().connected, true); assert.equal(connection.getStatus().privilegedActive, true);
    assert.equal(bound, clients.length);
    first.emit('shardDisconnect', { code: 4014 });
    assert.equal(connection.getStatus().status, 'connected', 'retired session events must not change the active session');
    assert.doesNotMatch(JSON.stringify(connection.getStatus()), /private-token/);
});

test('a privileged-intent rejection falls back exactly once despite simultaneous close and login errors', async t => {
    let logins = 0;
    const { connection } = setup(t, async (client, token) => {
        logins++;
        if (client.options.intents.includes(GatewayIntentBits.MessageContent)) {
            client.emit('shardDisconnect', { code: 4014 });
            throw Object.assign(new Error('Used disallowed intents'), { code: 'DisallowedIntents' });
        }
        client.ready = true; client.emit('clientReady'); return token;
    });
    await connection.connect('private-token', true);
    assert.equal(logins, 2);
    assert.equal(connection.getStatus().connected, true);
    assert.equal(connection.getStatus().status, 'limited');
    assert.equal(connection.getStatus().privilegedActive, false);
    assert.equal(connection.getStatus().errorCode, 'intents_required');
    assert.match(connection.getStatus().action.steps.join(' '), /Server Members Intent and Message Content Intent/);
});

test('after Portal permissions are corrected, reconnect restores full intents and clears action required', async t => {
    let allowed = false;
    const { connection } = setup(t, async (client, token) => {
        if (!allowed && client.options.intents.includes(GatewayIntentBits.MessageContent)) throw Object.assign(new Error('denied'), { code: 'DisallowedIntents' });
        client.ready = true; client.emit('clientReady'); return token;
    });
    await connection.connect('token', true); allowed = true;
    await connection.connect('token', true);
    assert.equal(connection.getStatus().status, 'connected');
    assert.equal(connection.getStatus().action, null);
    assert.equal(connection.getStatus().privilegedActive, true);
});

test('invalid token produces actionable diagnostics without login retries', async t => {
    let attempts = 0;
    const { connection } = setup(t, async () => { attempts++; throw Object.assign(new Error('private-token'), { code: 'TokenInvalid' }); });
    await assert.rejects(connection.connect('private-token', true));
    assert.equal(attempts, 1); assert.equal(connection.getStatus().errorCode, 'token_invalid');
    assert.equal(connection.getStatus().status, 'action_required');
    assert.doesNotMatch(JSON.stringify(connection.getStatus()), /private-token/);
    connection.client.emit('shardReconnecting');
    connection.client.emit('shardDisconnect', { code: 4014 });
    assert.equal(connection.getStatus().errorCode, 'token_invalid');
    assert.equal(connection.getStatus().status, 'action_required');
    assert.equal(attempts, 1, 'late failed-session events must not start another connection');
});

test('a login that never reaches ready times out and cleans up the attempted client', async t => {
    const { connection } = setup(t, async () => new Promise(() => {}), { readyTimeoutMs: 20 });
    await assert.rejects(connection.connect('token', false), { code: 'CONNECTION_TIMEOUT' });
    assert.equal(connection.client.dead, true);
    assert.equal(connection.getStatus().errorCode, 'connection_timeout');
});

test('concurrent reconnect requests are serialized rather than creating overlapping gateways', async t => {
    let active = 0; let maximum = 0;
    const { connection } = setup(t, async (client, token) => {
        active++; maximum = Math.max(active, maximum);
        await new Promise(resolve => setTimeout(resolve, 5));
        client.ready = true; client.emit('clientReady'); active--; return token;
    });
    await Promise.all([connection.connect('one', false), connection.connect('two', true)]);
    assert.equal(maximum, 1); assert.equal(connection.getStatus().connected, true);
});

test('normal network disconnects use Discord.js recovery and report the actual state', async t => {
    const { connection } = setup(t);
    await connection.connect('token', false);
    connection.client.ready = false; connection.client.emit('shardReconnecting');
    assert.equal(connection.getStatus().status, 'reconnecting'); assert.equal(connection.getStatus().connected, false);
    connection.client.ready = true; connection.client.emit('shardResume');
    assert.equal(connection.getStatus().status, 'connected'); assert.equal(connection.getStatus().connected, true);
});

test('a manual reconnect clears an old reconnect timeout while the new attempt starts', async t => {
    const { connection } = setup(t);
    await connection.connect('token', false);
    connection.client.ready = false; connection.client.emit('shardReconnecting');
    connection.disconnectedAt = Date.now() - 10000;
    assert.equal(connection.getStatus().status, 'action_required');
    await connection.connect('token', false);
    assert.equal(connection.getStatus().status, 'connected');
    assert.equal(connection.getStatus().errorCode, null);
});

test('stopping during a pending login cancels the attempt and prevents queued reconnects', async t => {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const { connection } = setup(t, async () => { entered(); return new Promise(() => {}); });
    const pending = connection.connect('token', false);
    const rejected = assert.rejects(pending, { code: 'CONNECTION_STOPPED' });
    await started;
    await connection.destroy(); await rejected;
    await assert.rejects(connection.connect('token', true), { code: 'CONNECTION_STOPPED' });
    assert.equal(connection.getStatus().status, 'stopped');
});

test('public status preserves managed limited-mode warnings while Discord is connected', async t => {
    const client = { isReady: () => true, login: async () => {}, destroy: async () => {},
        getConnectionStatus: () => ({ connected: true, status: 'limited', errorCode: 'intents_required', action: { title: 'Enable privileged intents', steps: [] } }) };
    const runtime = await startRuntime({ client, token: 'token', port: 0, host: '127.0.0.1', logger });
    t.after(() => runtime.stop());
    const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/status`);
    const { discord } = await response.json();
    assert.equal(discord.connected, true); assert.equal(discord.errorCode, 'intents_required');
    assert.equal(discord.action.title, 'Enable privileged intents');
});
