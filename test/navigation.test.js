import assert from 'node:assert/strict';
import test from 'node:test';
import { serverNavigation, serverPage, serverUrl, settingsDestination, settingsSearch } from '../app/navigation.js';

test('every sidebar module and search target resolves to a supported focused view', () => {
    for (const [, tab, view] of settingsSearch) {
        const page = serverPage(tab, view); assert.equal(page.tab, tab); assert.equal(page.view, view);
    }
    const keys = serverNavigation.flatMap(group => group.items.map(item => item[0]));
    assert.equal(keys.length, new Set(keys).size);
    for (const key of keys) assert.equal(serverPage(key).tab, key);
});

test('older combined-page links resolve to their current module names', () => {
    assert.equal(serverPage('moderation').tab, 'automod');
    assert.equal(serverPage('channels').tab, 'settings');
    assert.equal(serverPage('unknown', 'unexpected').tab, 'overview');
    assert.equal(serverPage('automod', 'unexpected').view, 'rules');
});

test('section redirects return to the exact form that was saved, with unknown sections contained', () => {
    assert.deepEqual(settingsDestination('words'), { tab: 'automod', view: 'words' });
    assert.deepEqual(settingsDestination('ignored'), { tab: 'automod', view: 'ignored' });
    assert.deepEqual(settingsDestination('logEvents'), { tab: 'logs', view: 'events' });
    assert.deepEqual(settingsDestination('levelSettings'), { tab: 'levels', view: 'settings' });
    assert.deepEqual(settingsDestination('https://evil.example'), { tab: 'overview' });
});

test('module links stay within the selected server and produce deterministic deep links', () => {
    const id = '1505183872705363998';
    assert.equal(serverUrl(id, 'logs', 'channels', 'moderation-channel'), `/Dashboard/Guild/${id}?tab=logs&view=channels#moderation-channel`);
    assert.equal(serverUrl(id, 'activity'), `/Dashboard/AuditLogs/${id}`);
});
