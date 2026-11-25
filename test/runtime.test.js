import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeToken, startRuntime } from '../runtime.js';

const logger = { log() {}, error() {} };
const address = runtime => `http://127.0.0.1:${runtime.server.address().port}`;

function fakeClient(login = async () => {}) {
    return { isReady: () => false, login, destroy: async () => {} };
}

test('missing token keeps the website and health endpoint available without login retries', async t => {
    let attempts = 0;
    const runtime = await startRuntime({ client: fakeClient(() => { attempts++; }), token: '', host: '127.0.0.1', port: 0, version: '1.0.1', logger });
    t.after(() => runtime.stop());
    const response = await fetch(address(runtime));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Bot token is not configured/);
    assert.equal((await fetch(address(runtime) + '/health')).status, 200);
    assert.equal((await fetch(address(runtime) + '/ready')).status, 503);
    assert.equal(attempts, 0);
});

test('rejected token does not terminate the HTTP service or repeatedly log in', async t => {
    let attempts = 0;
    const runtime = await startRuntime({ client: fakeClient(async () => { attempts++; throw Object.assign(new Error('secret-token-value'), { code: 'TokenInvalid' }); }), token: 'secret-token-value', host: '127.0.0.1', port: 0, logger });
    t.after(() => runtime.stop());
    await setTimeout(10);
    const response = await fetch(address(runtime) + '/api/status');
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(body).discord.errorCode, 'token_invalid');
    assert.ok(!body.includes('secret-token-value'));
    assert.equal(attempts, 1);
});

test('connection errors also preserve HTTP availability', async t => {
    const runtime = await startRuntime({ client: fakeClient(() => { throw new Error('network unavailable'); }), token: 'test-token', host: '127.0.0.1', port: 0, logger });
    t.after(() => runtime.stop());
    await setTimeout(10);
    const response = await fetch(address(runtime) + '/api/status');
    assert.equal((await response.json()).discord.errorCode, 'connection_failed');
    assert.equal((await fetch(address(runtime))).status, 200);
});

test('failed database settings lookup reports storage action, not a misleading missing-token error', async t => {
    const runtime = await startRuntime({ client: fakeClient(), token: async () => { throw new Error('private-database-value'); }, host: '127.0.0.1', port: 0, logger });
    t.after(() => runtime.stop());
    const body = await (await fetch(address(runtime) + '/api/status')).text();
    assert.equal(JSON.parse(body).discord.errorCode, 'storage_unavailable');
    assert.doesNotMatch(body, /private-database-value/);
});

test('connected client is ready and HTTP methods/routes are restricted', async t => {
    const client = fakeClient();
    client.isReady = () => true;
    const runtime = await startRuntime({ client, token: 'test-token', host: '127.0.0.1', port: 0, logger });
    t.after(() => runtime.stop());
    assert.equal((await fetch(address(runtime) + '/ready')).status, 200);
    assert.equal((await fetch(address(runtime) + '/api/status', { method: 'POST' })).status, 405);
    assert.equal((await fetch(address(runtime) + '/missing')).status, 404);
    assert.equal((await fetch(address(runtime), { method: 'HEAD' })).status, 200);
});

test('public status reports the selected storage provider and current readiness without connection credentials', async t => {
    let storageStatus = 'starting';
    const runtime = await startRuntime({ client: fakeClient(), token: '', host: '127.0.0.1', port: 0, logger,
        getStorageStatus: () => ({ provider: 'MySQL', status: storageStatus }) });
    t.after(() => runtime.stop());
    assert.deepEqual((await (await fetch(address(runtime) + '/api/status')).json()).storage, { provider: 'MySQL', status: 'starting' });
    storageStatus = 'ready';
    const body = await (await fetch(address(runtime) + '/api/status')).text();
    assert.deepEqual(JSON.parse(body).storage, { provider: 'MySQL', status: 'ready' });
    assert.doesNotMatch(body, /"(?:password|connectionString|hostname|username)"\s*:/i);
});

test('the listener starts before Discord login is attempted', async t => {
    let runtime;
    let ready;
    const loggedIn = new Promise(resolve => { ready = resolve; });
    const client = fakeClient(async () => {
        await setTimeout(10);
        const response = await fetch(address(runtime) + '/health');
        ready(response.status);
    });
    runtime = await startRuntime({ client, token: 'test-token', host: '127.0.0.1', port: 0, logger });
    t.after(() => runtime.stop());
    assert.equal(await loggedIn, 200);
});

test('invalid port values produce an actionable startup error', async () => {
    await assert.rejects(startRuntime({ client: fakeClient(), port: 'bad-port', logger }), /PORT/);
});

test('copied wrapping quotes and Bot prefix are normalized', () => {
    assert.equal(normalizeToken('  "Bot example-token"  '), 'example-token');
    assert.equal(normalizeToken(undefined), '');
});

test('Hostinger-style CommonJS loading starts the real HTTP service without top-level await', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cleaner-startup-'));
    const child = spawn(process.execPath, ['--input-type=commonjs', '-e', "require('./index.js')"], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, DISCORD_TOKEN: '', Bot__DiscordBotToken: '', BOT__DISCORDBOTTOKEN: '', DATABASE_URL: '', MYSQL_URL: '', MYSQL_HOST: '', ConnectionStrings__BotDatabase: '', CONNECTIONSTRINGS__BOTDATABASE: '', Database__Provider: '', DATABASE__PROVIDER: '', PORT: '0', DATA_DIRECTORY: directory },
        windowsHide: true
    });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const closed = once(child, 'close');
            child.kill();
            await closed;
        }
        if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test directory');
        await rm(directory, { recursive: true, force: true });
    });
    let output = '';
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const port = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Hosted entry exited (${code}): ${errors}`)));
        child.stdout.on('data', chunk => {
            output += chunk;
            const match = output.match(/HTTP service listening on port (\d+)/);
            if (match) resolve(Number(match[1]));
        });
    });
    let status;
    for (let attempt = 0; attempt < 50; attempt++) {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        assert.equal(response.status, 200);
        status = await response.json();
        if (status.discord.errorCode) break;
        await setTimeout(50);
    }
    assert.equal(status.discord.errorCode, 'token_missing');
    assert.deepEqual(status.storage, { provider: 'Local file', status: 'ready' });
    const dashboard = await fetch(`http://127.0.0.1:${port}/Dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /The Cleaner dashboard/);
    assert.ok(!errors.includes('ERR_REQUIRE_ASYNC_MODULE'));
});
