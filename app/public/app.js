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
if (document.querySelector('[data-service-refresh]')) {
    setInterval(async () => {
        try {
            const response = await fetch('/api/status', { cache: 'no-store' });
            if (!response.ok) throw new Error('unavailable');
            const status = await response.json();
            const bot = document.querySelector('[data-service-bot]');
            bot.textContent = status.discord.connected ? 'Connected to Discord' : 'Disconnected';
            bot.className = status.discord.connected ? 'text-success' : 'text-warning';
            document.querySelector('[data-service-uptime]').textContent = `${Math.floor(status.uptimeSeconds / 60)} minutes`;
            document.querySelector('[data-service-refresh]').textContent = `Checked ${new Date().toLocaleTimeString()}`;
        } catch { document.querySelector('[data-service-refresh]').textContent = 'Status check unavailable'; }
    }, 15000);
}
