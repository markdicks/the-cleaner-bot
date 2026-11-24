import { createServer } from 'node:http';

export function normalizeToken(value) {
    let token = typeof value === 'string' ? value.trim() : '';
    if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
        token = token.slice(1, -1).trim();
    }
    token = token.replace(/^Bot\s+/i, '').trim();
    return token;
}

export async function startRuntime({ client, token, port = process.env.PORT || 3000, host = '0.0.0.0', version, logger = console, createHandler, getStorageStatus }) {
    const listenPort = Number(port);
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
        throw new Error('PORT must be a valid TCP port number.');
    }

    let discordStatus = 'starting';
    let errorCode = null;
    const startedAt = Date.now();
    const getStatus = () => ({
        service: 'the-cleaner-bot',
        version,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        ...(getStorageStatus ? { storage: getStorageStatus() } : {}),
        discord: {
            connected: client.isReady(),
            status: client.isReady() ? 'connected' : discordStatus,
            errorCode: client.isReady() ? null : errorCode
        }
    });

    const handler = createHandler?.(getStatus);
    const server = createServer((request, response) => {
        let pathname;
        try {
            pathname = new URL(request.url, 'http://localhost').pathname;
        } catch {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Bad request');
            return;
        }
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
        if (handler && !['/health', '/api/status', '/ready'].includes(pathname)) {
            handler(request, response);
            return;
        }
        if (!['GET', 'HEAD'].includes(request.method)) {
            response.writeHead(405, { Allow: 'GET, HEAD' });
            response.end();
            return;
        }

        const status = getStatus();
        let body;
        if (['/', '/index.html', '/service'].includes(pathname)) {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            body = renderStatus(status);
        } else if (['/health', '/api/status', '/ready'].includes(pathname)) {
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            if (pathname === '/ready' && !status.discord.connected) response.statusCode = 503;
            body = JSON.stringify(status);
        } else {
            response.statusCode = 404;
            response.setHeader('Content-Type', 'text/plain; charset=utf-8');
            body = 'Not found';
        }
        response.end(request.method === 'HEAD' ? undefined : body);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    logger.log(`HTTP service listening on port ${server.address().port}.`);

    const normalizedToken = normalizeToken(typeof token === 'function' ? await Promise.resolve().then(token).catch(() => '') : token);
    if (!normalizedToken) {
        discordStatus = 'configuration_required';
        errorCode = 'token_missing';
        logger.error('DISCORD_TOKEN is missing. Set it in the hosting environment and restart. The HTTP service will stay available.');
    } else {
        void Promise.resolve().then(() => client.login(normalizedToken)).then(() => {
            discordStatus = 'connecting';
        }).catch(async error => {
            errorCode = error.code === 'TokenInvalid' ? 'token_invalid' : 'connection_failed';
            discordStatus = 'offline';
            logger.error(`Discord login failed (${errorCode}). Check DISCORD_TOKEN and restart. The HTTP service will stay available.`);
            await client.destroy();
        }).catch(() => logger.error('Discord client cleanup failed.'));
    }

    return {
        server,
        getStatus,
        async stop() {
            await client.destroy();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    };
}

function renderStatus(status) {
    const message = status.discord.connected ? 'Connected to Discord'
        : status.discord.errorCode === 'token_missing' ? 'Bot token is not configured'
        : status.discord.errorCode === 'token_invalid' ? 'Bot token was rejected'
        : status.discord.errorCode === 'connection_failed' ? 'Discord connection failed'
        : 'Connecting to Discord';
    const version = String(status.version || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="30"><title>The Cleaner | Service status</title>
<style>*{box-sizing:border-box}body{margin:0;background:#111318;color:#eef0f3;font:16px/1.5 system-ui,sans-serif}main{max-width:800px;margin:0 auto;padding:48px 20px}header{border-bottom:1px solid #343840;padding-bottom:20px;margin-bottom:28px}h1{font-size:28px;margin:0}header p{color:#aab0bc;margin:4px 0}dl{margin:0}dl div{display:flex;justify-content:space-between;gap:20px;padding:18px 0;border-bottom:1px solid #343840;flex-wrap:wrap}dt{color:#aab0bc}dd{margin:0;font-weight:600;overflow-wrap:anywhere}.healthy{color:#79d2a3}.notice{color:#ffc571}</style></head>
<body><main><header><h1>The Cleaner</h1><p>Service status</p></header><dl><div><dt>Website</dt><dd class="healthy">Online</dd></div><div><dt>Discord bot</dt><dd class="${status.discord.connected ? 'healthy' : 'notice'}">${message}</dd></div><div><dt>Node.js release</dt><dd>${version}</dd></div></dl></main></body></html>`;
}
