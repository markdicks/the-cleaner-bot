if (globalThis.lucide) lucide.createIcons();
document.querySelector('#menu-toggle')?.addEventListener('click', event => {
    const open = document.body.classList.toggle('navigation-open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
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
