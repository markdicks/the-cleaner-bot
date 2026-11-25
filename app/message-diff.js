import { diffArrays } from 'diff';
import { escapeMarkdown } from 'discord.js';

const words = new Intl.Segmenter('en', { granularity: 'word' });
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const tokens = text => Array.from(words.segment(text), part => part.segment);
const escape = text => escapeMarkdown(text, { bold: false, italic: false, underline: false, heading: true, numberedList: true, maskedLink: true })
    .replace(/[*_>]/g, '\\$&').replace(/^( *)-(?=\s)/gm, '$1\\-');
const suffix = '\n[Full text in history]';

export function editSegments(before, after) {
    const changes = diffArrays(tokens(before), tokens(after), { timeout: 25, maxEditLength: 2000 }) || [
        { removed: true, value: [before] }, { added: true, value: [after] }
    ];
    const sides = { before: [], after: [] };
    for (const change of changes) {
        const text = change.value.join('');
        if (!text) continue;
        const changed = Boolean(change.added || change.removed);
        const part = { text, changed };
        // Make otherwise invisible whitespace-only edits visible without altering the raw text.
        if (changed && /^\s+$/.test(text)) part.display = text.replace(/\r\n|\r|\n/g, '[newline]\n').replace(/\t/g, '[tab]').replace(/ /g, '[space]');
        if (!change.added) sides.before.push(part);
        if (!change.removed) sides.after.push(part);
    }
    return sides;
}

export function underlineDiff(parts, limit = Infinity) {
    const render = (part, text = part.display ?? part.text) => part.changed ? `__${escape(text)}__` : escape(text);
    const full = parts.map(part => render(part)).join('');
    if (full.length <= limit) return { value: full, truncated: false };
    const available = Math.max(0, limit - suffix.length);
    let value = '';
    for (const part of parts) {
        const rendered = render(part);
        if (value.length + rendered.length <= available) { value += rendered; continue; }
        const units = Array.from(graphemes.segment(part.display ?? part.text), item => item.segment);
        let low = 0; let high = units.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (value.length + render(part, units.slice(0, middle).join('')).length <= available) low = middle;
            else high = middle - 1;
        }
        if (low) value += render(part, units.slice(0, low).join(''));
        break;
    }
    return { value: value + suffix, truncated: true };
}
