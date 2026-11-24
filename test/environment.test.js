import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { databaseMode, databaseOptions, AppStore, initialState } from '../app/store.js';
import { credentials } from '../app/security.js';

const connectionString = 'Server=db.example;Port=3306;Database=cleaner;User=cleaneradmin;Password="example;$literal";SslMode=Required;';

test('uppercase Linux deployment keys select the same MySQL configuration as .NET-style keys', () => {
    const original = { ConnectionStrings__BotDatabase: connectionString, Database__Provider: 'MySql' };
    const uppercase = { CONNECTIONSTRINGS__BOTDATABASE: connectionString, DATABASE__PROVIDER: 'MySql' };
    assert.deepEqual(databaseOptions(uppercase), databaseOptions(original));
    assert.equal(databaseOptions(uppercase).password, 'example;$literal');
    assert.equal(databaseMode(uppercase), 'MySQL');
    assert.equal(databaseMode(original), 'MySQL');
    assert.equal(databaseOptions(uppercase).ssl.rejectUnauthorized, true);
});

test('connection string alone is recognized in uppercase, without a provider setting', () => {
    assert.equal(databaseMode({ CONNECTIONSTRINGS__BOTDATABASE: connectionString }), 'MySQL');
    assert.equal(databaseOptions({ CONNECTIONSTRINGS__BOTDATABASE: connectionString }).host, 'db.example');
    assert.equal(databaseMode({}), 'Local file');
    assert.equal(databaseMode({ ConnectionStrings__BotDatabase: 'Data Source=discordbot.db' }), 'Local file');
    assert.equal(databaseMode({ CONNECTIONSTRINGS__BOTDATABASE: '"Data Source=discordbot.db"' }), 'Local file');
    assert.equal(databaseOptions({ CONNECTIONSTRINGS__BOTDATABASE: '"Data Source=discordbot.db"' }), null);
});

test('MYSQL_* variables and original mixed-case precedence remain compatible', () => {
    assert.equal(databaseOptions({ MYSQL_HOST: 'db.example', MYSQL_USER: 'user', MYSQL_PASSWORD: '$literal', MYSQL_DATABASE: 'bot' }).password, '$literal');
    assert.equal(databaseOptions({ ConnectionStrings__BotDatabase: connectionString, CONNECTIONSTRINGS__BOTDATABASE: 'bad' }).database, 'cleaner');
    const source = databaseOptions({ DATABASE__PROVIDER: 'MySql', CONNECTIONSTRINGS__BOTDATABASE: 'Data Source=db.example;Database=bot;User=user;Password=example;SslMode=Required;' });
    assert.equal(source.host, 'db.example');
    assert.equal(source.database, 'bot');
});

test('explicit MySQL provider without connection information fails instead of silently using local storage', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cleaner-env-'));
    t.after(async () => {
        if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test directory');
        await rm(directory, { recursive: true, force: true });
    });
    for (const env of [{ DATABASE__PROVIDER: 'MySql' }, { Database__Provider: 'MariaDb' }]) {
        assert.equal(databaseMode(env), 'MySQL');
        assert.throws(() => databaseOptions(env), { code: 'DATABASE_CONFIGURATION_MISSING' });
        const store = new AppStore({ env, directory, logger: { error() {} } });
        await assert.rejects(store.ready, { code: 'DATABASE_CONFIGURATION_MISSING' });
        assert.equal(store.status, 'unavailable');
        await assert.rejects(access(path.join(directory, 'dashboard.json')), { code: 'ENOENT' });
        await store.close();
    }
});

test('uppercase legacy Discord credential keys are recognized without disclosing or overriding them', () => {
    const state = initialState();
    const config = credentials(state, { BOT__DISCORDCLIENTID: '123456789012345678', BOT__DISCORDCLIENTSECRET: 'private-secret', BOT__DISCORDBOTTOKEN: 'private-token' });
    assert.equal(config.clientId, '123456789012345678');
    assert.equal(config.clientSecret, 'private-secret');
    assert.equal(config.token, 'private-token');
});
