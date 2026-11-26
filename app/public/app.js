if (globalThis.lucide) lucide.createIcons();
const menuToggle = document.querySelector('#menu-toggle');
const closeNavigation = () => {
    document.body.classList.remove('navigation-open');
    menuToggle?.setAttribute('aria-expanded', 'false');
    const backdrop = document.querySelector('.navigation-backdrop'); if (backdrop) backdrop.hidden = true;
};
menuToggle?.addEventListener('click', () => {
    const open = !document.body.classList.contains('navigation-open'); closeNavigation();
    if (open) {
        document.body.classList.add('navigation-open'); menuToggle.setAttribute('aria-expanded', 'true');
        document.querySelector('.navigation-backdrop').hidden = false;
        (document.querySelector('#navigation a[aria-current="page"]') || document.querySelector('#navigation summary') || document.querySelector('#navigation a'))?.focus();
    }
});
document.querySelectorAll('[data-close-navigation]').forEach(button => button.addEventListener('click', () => { closeNavigation(); menuToggle?.focus(); }));
document.addEventListener('keydown', event => {
    if (!document.body.classList.contains('navigation-open')) return;
    if (event.key === 'Escape') { closeNavigation(); menuToggle?.focus(); }
    if (event.key === 'Tab') {
        const controls = [...document.querySelectorAll('#navigation a, #navigation button, #navigation summary')].filter(node => node.getClientRects().length);
        const index = controls.indexOf(document.activeElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
    }
});
matchMedia('(min-width: 781px)').addEventListener('change', event => { if (event.matches) closeNavigation(); });

const settingsInput = document.querySelector('#settings-search');
const settingsResults = document.querySelector('#settings-results');
const settingLinks = [...document.querySelectorAll('[data-setting-result]')];
const closeSearch = () => { if (settingsResults) settingsResults.hidden = true; settingsInput?.setAttribute('aria-expanded', 'false'); };
settingsInput?.addEventListener('input', () => {
    const words = settingsInput.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let count = 0;
    for (const link of settingLinks) { link.hidden = !words.every(word => link.dataset.keywords.includes(word)); if (!link.hidden) count++; }
    settingsResults.hidden = !words.length; settingsInput.setAttribute('aria-expanded', String(Boolean(words.length)));
    settingsResults.querySelector('[data-no-settings]').hidden = Boolean(count);
});
settingsInput?.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && !settingsResults.hidden) { event.preventDefault(); settingLinks.find(link => !link.hidden)?.focus(); }
    if (event.key === 'Enter' && !settingsResults.hidden) { event.preventDefault(); settingLinks.find(link => !link.hidden)?.click(); }
    if (event.key === 'Escape') closeSearch();
});
settingsResults?.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeSearch(); settingsInput.focus(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); const visible = settingLinks.filter(link => !link.hidden); const index = visible.indexOf(document.activeElement);
        visible[(index + (event.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length]?.focus();
    }
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('.settings-search')) closeSearch(); });

const selectionCount = list => {
    const output = document.querySelector(`[data-selection-count="${list.id}"]`);
    if (output) output.textContent = `${list.querySelectorAll('input:checked').length} selected`;
};
document.querySelectorAll('[data-filter-list]').forEach(input => input.addEventListener('input', () => {
    const list = document.getElementById(input.dataset.filterList); if (!list) return;
    let count = 0;
    list.querySelectorAll('[data-filter-item]').forEach(item => { item.hidden = !item.dataset.filterItem.includes(input.value.toLowerCase().trim()); if (!item.hidden) count++; });
    const empty = list.querySelector('[data-list-empty]'); if (empty) empty.hidden = Boolean(count);
}));
document.querySelectorAll('[data-select-visible], [data-clear-list]').forEach(button => button.addEventListener('click', () => {
    const list = document.getElementById(button.dataset.selectVisible || button.dataset.clearList);
    list.querySelectorAll('[data-filter-item]').forEach(item => { if (button.dataset.clearList || !item.hidden) item.querySelector('input').checked = Boolean(button.dataset.selectVisible); });
    list.dispatchEvent(new Event('change', { bubbles: true })); selectionCount(list);
}));
document.querySelectorAll('.channel-checklist').forEach(list => list.addEventListener('change', () => selectionCount(list)));

const formStates = new Map();
document.querySelectorAll('[data-settings-form]').forEach(form => {
    const original = JSON.stringify([...new FormData(form)]);
    const targets = form.querySelector('[data-target-list]'); const originalTargets = targets?.cloneNode(true);
    const sync = () => {
        form.querySelectorAll('[data-rule-toggle]').forEach(toggle => { const options = toggle.closest('.filter-rule')?.querySelector('[data-rule-options]'); if (options) options.hidden = !toggle.checked; });
        form.querySelectorAll('[data-target-row]').forEach(row => { const rounds = row.querySelector('[name=botRounds]'); row.querySelector('[data-permanent]').checked = rounds.value === '-1'; rounds.setCustomValidity(rounds.value === '0' ? 'Use at least one round, or select Permanent.' : ''); });
        const blockedWords = form.querySelector('[name=blockedWords]');
        if (blockedWords) {
            const words = [...new Set(blockedWords.value.split(/[\r\n,]+/).map(word => word.trim().toLowerCase()).filter(Boolean))];
            blockedWords.setCustomValidity(words.length > 1000 ? 'Use at most 1,000 blocked words.' : words.some(word => word.length > 100) ? 'Each word or phrase must contain at most 100 characters.' : '');
            form.querySelector('[data-word-count]').textContent = `${words.length} / 1,000`;
        }
        const empty = form.querySelector('[data-target-empty]'); if (empty) empty.hidden = Boolean(targets.children.length);
        const add = form.querySelector('[data-add-target]'); if (add) add.disabled = targets.children.length >= 100;
        form.querySelectorAll('.channel-checklist').forEach(selectionCount);
        const dirty = JSON.stringify([...new FormData(form)]) !== original;
        formStates.set(form, dirty); form.querySelector('.save-bar').classList.toggle('is-dirty', dirty);
        form.querySelector('[data-save-state]').textContent = dirty ? 'Unsaved changes' : 'All changes saved';
        form.querySelector('[data-save]').disabled = !dirty; form.querySelector('[data-discard]').disabled = !dirty;
    };
    form.addEventListener('input', event => { if (!event.target.matches('[data-permanent]')) sync(); });
    form.addEventListener('change', event => {
        if (event.target.matches('[data-permanent]')) event.target.closest('[data-target-row]').querySelector('[name=botRounds]').value = event.target.checked ? '-1' : '1';
        sync();
    });
    form.addEventListener('click', event => {
        const remove = event.target.closest('[data-remove-target]');
        if (remove) { remove.closest('[data-target-row]').remove(); sync(); }
        if (event.target.closest('[data-add-target]') && targets.children.length < 100) {
            targets.append(document.querySelector('#cleaning-target-template').content.cloneNode(true));
            if (globalThis.lucide) lucide.createIcons(); targets.lastElementChild.querySelector('input').focus(); sync();
        }
    });
    form.addEventListener('reset', () => {
        if (targets) targets.replaceChildren(...originalTargets.cloneNode(true).childNodes);
        setTimeout(() => { form.querySelectorAll('[data-filter-list]').forEach(input => input.dispatchEvent(new Event('input'))); sync(); }, 0);
    });
    form.addEventListener('submit', () => { formStates.set(form, false); form.querySelector('[data-save-state]').textContent = 'Saving changes...'; form.querySelector('[data-discard]').disabled = true; });
    sync();
});
addEventListener('beforeunload', event => { if ([...formStates.values()].some(Boolean)) { event.preventDefault(); event.returnValue = ''; } });

document.querySelectorAll('[data-member-action]').forEach(select => {
    const update = () => {
        const form = select.closest('form'); const timeout = select.value === 'timeout';
        form.querySelector('[data-timeout-field]').hidden = !timeout;
        const minutes = form.querySelector('[name=minutes]'); minutes.disabled = !timeout; minutes.required = timeout;
        form.querySelector('[data-action-label]').textContent = { warn: 'Issue warning', timeout: 'Apply timeout', untimeout: 'Remove timeout', kick: 'Kick member', ban: 'Ban member', unban: 'Unban member' }[select.value];
    };
    select.addEventListener('change', update); update();
});
document.querySelectorAll('.dismiss-notice').forEach(button => button.addEventListener('click', () => button.closest('.notice').remove()));
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copy);
    try { await navigator.clipboard.writeText(input.value); button.title = 'Copied'; }
    catch { input.select(); }
}));
document.querySelectorAll('form[method="post"]').forEach(form => form.addEventListener('submit', () => {
    form.querySelectorAll('button[type="submit"], button:not([type])').forEach(button => { button.disabled = true; button.classList.add('saving'); });
}));
if (document.querySelector('[data-connection-panel], [data-service-refresh]')) {
    let checking = false;
    let previousConnection = '';
    const text = (selector, value) => { const node = document.querySelector(selector); if (node && node.textContent !== value) node.textContent = value; };
    setInterval(async () => {
        if (checking || document.hidden) return;
        checking = true;
        try {
            const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error('unavailable');
            const status = await response.json();
            const connection = status.discord;
            document.querySelectorAll('[data-compact-connection]').forEach(node => { node.hidden = Boolean(connection.connected && !connection.action); });
            const busy = !connection.connected && (connection.reconnecting || ['starting', 'connecting', 'reconnecting'].includes(connection.status));
            const label = connection.connected ? connection.action ? 'Online - limited' : 'Connected' : busy ? 'Connecting' : 'Action required';
            document.querySelectorAll('[data-bot-status]').forEach(node => {
                node.textContent = connection.connected ? 'Bot online' : busy ? 'Bot reconnecting' : 'Bot offline';
                node.className = `badge ${connection.connected && !connection.action ? 'success' : 'warning'}`;
            });
            document.querySelectorAll('[data-content-warning]').forEach(node => { node.hidden = Boolean(connection.privilegedActive); });
            const key = JSON.stringify([label, connection.action, busy]);
            if (key !== previousConnection) {
                previousConnection = key;
                text('[data-connection-badge]', label);
                const badge = document.querySelector('[data-connection-badge]');
                if (badge) badge.className = `badge ${connection.connected && !connection.action ? 'success' : 'warning'}`;
                text('[data-connection-message]', connection.action?.title || (connection.connected ? 'Connected to Discord.' : busy ? 'Connecting to Discord. Status updates automatically.' : 'The bot is not connected. Review its settings and reconnect.'));
                const steps = document.querySelector('[data-connection-steps]');
                if (steps) {
                    steps.replaceChildren(...(connection.action?.steps || []).map(step => { const item = document.createElement('li'); item.textContent = step; return item; }));
                    steps.hidden = !connection.action?.steps?.length;
                }
                const action = document.querySelector('[data-connection-action]');
                if (action) {
                    action.hidden = !connection.action;
                    action.href = connection.action?.url === 'https://discord.com/developers/applications' ? connection.action.url : '/SuperAdmin';
                    text('[data-connection-action-label]', connection.action?.code === 'intents_required' ? 'Open Developer Portal' : 'Connection settings');
                }
                document.querySelectorAll('[data-reconnect-button]').forEach(button => { button.disabled = Boolean(busy); });
            }
            const bot = document.querySelector('[data-service-bot]');
            if (bot) { bot.textContent = connection.connected ? connection.action ? 'Connected - limited' : 'Connected to Discord' : label; bot.className = connection.connected && !connection.action ? 'text-success' : 'text-warning'; }
            text('[data-service-uptime]', `${Math.floor(status.uptimeSeconds / 60)} minutes`);
            text('[data-service-refresh]', `Checked ${new Date().toLocaleTimeString()}`);
        } catch { text('[data-service-refresh]', 'Status check unavailable'); }
        finally { checking = false; }
    }, 5000);
}
