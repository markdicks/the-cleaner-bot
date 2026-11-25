import assert from 'node:assert/strict';
import test from 'node:test';
import { editSegments, underlineDiff } from '../app/message-diff.js';
import { messageEditFields } from '../app/audit-events.js';
import { auditPayload } from '../app/audit-payload.js';

const render = (before, after) => {
    const parts = editSegments(before, after);
    return { before: underlineDiff(parts.before).value, after: underlineDiff(parts.after).value };
};
const snapshot = content => ({ content, attachments: [] });

test('replaced words are underlined on each side, unchanged text is plain', () => {
    assert.deepEqual(render('The red car arrived.', 'The blue car arrived.'), { before: 'The __red__ car arrived.', after: 'The __blue__ car arrived.' });
    assert.deepEqual(render('A red car arrived today', 'A blue car arrived tomorrow'), { before: 'A __red__ car arrived __today__', after: 'A __blue__ car arrived __tomorrow__' });
});

test('insertions, removals and punctuation-only edits underline only the affected side', () => {
    assert.deepEqual(render('Hello world', 'Hello, world!'), { before: 'Hello world', after: 'Hello__,__ world__!__' });
    assert.deepEqual(render('Hello, world!', 'Hello world'), { before: 'Hello__,__ world__!__', after: 'Hello world' });
    assert.deepEqual(render('', 'New message'), { before: '', after: '__New message__' });
    assert.deepEqual(render('Old message', ''), { before: '__Old message__', after: '' });
    assert.deepEqual(render('No change', 'No change'), { before: 'No change', after: 'No change' });
});

test('whitespace-only changes are visible, while their raw history text remains unchanged', () => {
    const fields = messageEditFields(snapshot('One  two'), snapshot('One two'), true);
    assert.equal(fields[0].value, 'One  two'); assert.equal(fields[1].value, 'One two');
    assert.match(underlineDiff(fields[0].segments).value, /__\[space\]\[space\]__/);
    assert.match(underlineDiff(fields[1].segments).value, /__\[space\]__/);
    assert.equal(fields[0].segments.map(part => part.text).join(''), fields[0].value);
    assert.match(render('One\ntwo', 'One two').before, /\[newline\]/);
});

test('emoji, combining marks and non-Latin text are preserved exactly in diff segments', () => {
    for (const [before, after] of [
        ['Hello \u{1f44d}\u{1f3fb}', 'Hello \u{1f44d}\u{1f3ff}'],
        ['Family \u{1f468}\u200d\u{1f469}\u200d\u{1f467}', 'Family \u{1f468}\u200d\u{1f469}\u200d\u{1f466}'],
        ['Cafe\u0301 today', 'Cafe\u0301 tomorrow'],
        ['\u4f60\u597d\u4e16\u754c', '\u4f60\u597d\u670b\u53cb']
    ]) {
        const parts = editSegments(before, after);
        assert.equal(parts.before.map(part => part.text).join(''), before);
        assert.equal(parts.after.map(part => part.text).join(''), after);
        assert.ok(parts.before.concat(parts.after).every(part => !/^[\u0300-\u036f\u200d]|\u200d$/.test(part.text)));
    }
});

test('literal Markdown cannot hide the underlining or inject formatting around changed text', () => {
    const result = render('**hello** _name_ `code` ||secret||', '**goodbye** _name_ `code` ||secret||');
    assert.match(result.before, /\\\*\\\*__hello__\\\*\\\*/);
    assert.match(result.after, /__goodbye__/);
    assert.ok(result.before.includes('\\_name\\_'));
    assert.ok(result.before.includes('\\`code\\`'));
    assert.ok(result.before.includes('\\|\\|secret\\|\\|'));
    const link = underlineDiff([{ text: 'https://example.com/__path__', changed: true }]).value;
    assert.equal(link, '__https://example.com/\\_\\_path\\_\\___');
    assert.equal(underlineDiff([{ text: '* list\n- other\n> quoted', changed: false }]).value, '\\* list\n\\- other\n\\> quoted');
    assert.equal(underlineDiff([{ text: '\\*literal', changed: false }]).value, '\\\\\\*literal');
});

test('unknown-before and private messages never receive fabricated diff segments', () => {
    const missing = messageEditFields(snapshot(null), snapshot('Current text'), true);
    assert.ok(missing.every(field => field.segments === undefined)); assert.match(missing[0].value, /Not cached/);
    const privateFields = messageEditFields(snapshot('private-before'), snapshot('private-after'), false);
    assert.ok(privateFields.every(field => field.segments === undefined));
    assert.doesNotMatch(JSON.stringify(privateFields), /private-before|private-after/);
    const empty = messageEditFields(snapshot(''), snapshot('Added text'), true);
    assert.equal(empty[0].segments, undefined); assert.match(empty[0].value, /No text/);
});

test('underlined previews close their Markdown before truncation and respect embed limits', () => {
    const fields = messageEditFields(snapshot('A'.repeat(4000)), snapshot('B'.repeat(4000)), true);
    const payload = auditPayload('1505183872705363998', 'server', 'Message Edited', '', { description: 'Edit', fields }, { embedAllowed: true, attachAllowed: true });
    for (const field of payload.embeds[0].data.fields) {
        assert.ok(field.value.length <= 1024);
        assert.match(field.value, /^__[AB]+__\n\[Full text in history\]$/);
    }
    assert.ok(payload.files[0].attachment.toString().includes('B'.repeat(4000)));
    assert.ok(!payload.files[0].attachment.toString().includes('__'));
    const emoji = underlineDiff([{ text: '\u{1f44d}\u{1f3ff}'.repeat(1000), changed: true }], 1024).value;
    assert.ok(emoji.length <= 1024); assert.match(emoji, /\u{1f44d}\u{1f3ff}__\n/u);
});

test('text-only Discord delivery keeps underlining and sends no additional message', () => {
    const fields = messageEditFields(snapshot('A red car'), snapshot('A blue car'), true);
    const payload = auditPayload('1505183872705363998', 'server', 'Message Edited', '', { description: 'Edit', fields }, { embedAllowed: false, attachAllowed: false });
    assert.match(payload.content, /Before:\nA __red__ car/); assert.match(payload.content, /After:\nA __blue__ car/);
    assert.ok(payload.content.length <= 1900); assert.equal(payload.embeds, undefined);
});

test('large divergent inputs complete with a bounded diff and retain all original text', () => {
    const before = 'old '.repeat(2000); const after = 'new '.repeat(2000);
    const started = performance.now(); const parts = editSegments(before, after);
    assert.ok(performance.now() - started < 1500);
    assert.equal(parts.before.map(part => part.text).join(''), before);
    assert.equal(parts.after.map(part => part.text).join(''), after);
});
