import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionsBitField } from 'discord.js';
import { businessActive, guildDefaults, snowflake, validateGuildSettings } from './settings.js';
import { clearCookie, credentials, equalToken, publicOrigin, randomToken, readCookie, seal, secretKey, writeCookie } from './security.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sessionCookie = 'CleanerSession';
const oauthCookie = 'CleanerOAuth';
const manageable = guild => guild.owner || (BigInt(guild.permissions || '0') & 0x28n) !== 0n;
const csrfError = () => Object.assign(new Error('The form expired. Reload the page and try again.'), { status: 403 });

export function createDashboard({ store, bot, version, env = process.env, getStatus, fetcher = fetch, logger = console }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.set('view engine', 'ejs');
    app.set('views', path.join(directory, 'views'));
    app.use((request, response, next) => {
        response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        response.locals.version = version;
        response.locals.status = getStatus();
        response.locals.user = null;
        response.locals.superAdmin = false;
        response.locals.path = request.path;
        response.locals.message = typeof request.query.message === 'string' ? request.query.message.slice(0, 500) : '';
        response.locals.notice = '';
        response.locals.storageMode = store.mode;
        next();
    });
    app.use('/assets', express.static(path.join(directory, 'public'), { maxAge: '1y', immutable: true, index: false }));
    app.get('/assets/lucide.js', (request, response) => response.sendFile('lucide.min.js', { root: path.join(directory, '../node_modules/lucide/dist/umd') }));
    app.get(['/service', '/Service', '/status'], (request, response) => response.render('service', { storageStatus: store.status }));
    app.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 2000 }));
    app.use(async (request, response, next) => {
        await store.ready;
        request.state = await store.read();
        request.key = secretKey(request.state, env);
        request.creds = credentials(request.state, env);
        request.origin = publicOrigin(request, env);
        bot.origin = request.origin;
        const session = readCookie(request, sessionCookie, request.key);
        request.session = session && session.expires > Date.now() ? session : null;
        response.locals.user = request.session;
        response.locals.superAdmin = request.session?.id === request.creds.superAdminId;
        response.locals.csrf = request.session?.csrf || '';
        response.locals.inviteUrl = inviteUrl(request.creds.clientId || bot.client?.user?.id);
        response.locals.oauthConfigured = Boolean((request.creds.clientId || bot.client?.user?.id) && request.creds.clientSecret);
        if (request.method === 'POST') {
            if (!request.session || !equalToken(request.body.csrf, request.session.csrf)) throw csrfError();
            if (request.get('origin') && request.get('origin') !== request.origin) throw csrfError();
        }
        next();
    });
    const authenticate = (request, response, next) => {
        if (!request.session) return response.status(200).render('login');
        next();
    };
    const administrator = (request, response, next) => {
        if (!request.session) return response.status(200).render('login');
        if (request.session.id !== request.creds.superAdminId) return response.status(403).render('error', { title: 'Access denied', detail: 'This page is restricted to the bot owner.' });
        next();
    };
    const guildAccess = async (request, response, next) => {
        if (!request.session) return response.status(200).render('login');
        const id = request.params.guildId;
        if (!snowflake(id) || !await bot.canManage(id, request.session.id, request.session.guildIds, request.method === 'POST')) return response.status(403).render('error', { title: 'Access denied', detail: 'Manage Server access is required.' });
        request.config = request.state.guilds[id] || guildDefaults(id, bot.guilds().find(guild => guild.id === id)?.name);
        request.channels = bot.channels(id);
        response.locals.guild = request.config;
        response.locals.channels = request.channels;
        response.locals.business = businessActive(request.config);
        next();
    };
    const issueSession = (request, response, user, lifetime = 43200000) => {
        const session = { ...user, csrf: randomToken(), expires: Date.now() + lifetime };
        writeCookie(response, sessionCookie, session, request.key, request.origin.startsWith('https:'), lifetime / 1000);
    };
    const rate = new Map();
    const loginRate = (request, response, next) => {
        const now = Date.now();
        for (const [key, values] of rate) if (values.at(-1) < now - 60000) rate.delete(key);
        const values = (rate.get(request.ip) || []).filter(time => time > now - 60000);
        if (values.length >= 20) return response.status(429).render('error', { title: 'Too many attempts', detail: 'Wait a minute before trying again.' });
        values.push(now); rate.set(request.ip, values); next();
    };
    app.get('/', (request, response) => response.redirect('/Dashboard'));
    app.get('/Auth/Login', loginRate, async (request, response) => {
        const clientId = request.creds.clientId || bot.client?.user?.id;
        if (!clientId || !request.creds.clientSecret) return response.render('login');
        const state = randomToken();
        writeCookie(response, oauthCookie, { state, expires: Date.now() + 600000 }, request.key, request.origin.startsWith('https:'), 600);
        const query = new URLSearchParams({ client_id: clientId, redirect_uri: `${request.origin}/Auth/Callback`, response_type: 'code', scope: 'identify guilds', state });
        response.redirect(`https://discord.com/oauth2/authorize?${query}`);
    });
    app.get('/Auth/Callback', loginRate, async (request, response) => {
        const pending = readCookie(request, oauthCookie, request.key);
        clearCookie(response, oauthCookie, request.origin.startsWith('https:'));
        if (!pending || pending.expires <= Date.now() || !equalToken(request.query.state, pending.state) || typeof request.query.code !== 'string') return response.status(400).render('error', { title: 'Sign-in could not be verified', detail: 'Start a new Discord sign-in.' });
        const tokenResponse = await fetcher('https://discord.com/api/v10/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: request.creds.clientId || bot.client.user.id, client_secret: request.creds.clientSecret, grant_type: 'authorization_code', code: request.query.code, redirect_uri: `${request.origin}/Auth/Callback` }), signal: AbortSignal.timeout(15000) });
        if (!tokenResponse.ok) return response.status(400).render('error', { title: 'Discord sign-in failed', detail: 'Check the client secret and registered redirect URL.' });
        const token = await tokenResponse.json();
        const options = { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15000) };
        const userResponse = await fetcher('https://discord.com/api/v10/users/@me', options);
        const guildResponse = await fetcher('https://discord.com/api/v10/users/@me/guilds', options);
        if (!userResponse.ok || !guildResponse.ok) return response.status(502).render('error', { title: 'Discord is unavailable', detail: 'Try signing in again shortly.' });
        const user = await userResponse.json(); const guilds = await guildResponse.json();
        if (!snowflake(user.id) || !Array.isArray(guilds)) throw new Error('Invalid Discord identity response.');
        issueSession(request, response, { id: user.id, name: String(user.global_name || user.username).slice(0, 80), avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=80` : '', guildIds: guilds.filter(manageable).slice(0, 80).map(guild => guild.id) });
        response.redirect('/Dashboard');
    });
    app.get('/Auth/Setup', loginRate, async (request, response) => {
        const userId = typeof request.query.token === 'string' ? bot.consumeSetup(request.query.token) : null;
        if (!userId || userId !== request.creds.superAdminId) return response.status(403).render('error', { title: 'Setup link expired', detail: 'Request a new private link with /dashboard in Discord.' });
        issueSession(request, response, { id: userId, name: 'Superadmin', avatar: '', guildIds: [] }, 1800000);
        response.redirect('/SuperAdmin');
    });
    app.post('/Auth/Logout', (request, response) => { clearCookie(response, sessionCookie, request.origin.startsWith('https:')); response.redirect('/Dashboard'); });
    app.get('/Auth/Logout', (request, response) => response.redirect('/Dashboard'));
    app.get('/Dashboard', authenticate, async (request, response) => {
        const live = new Map(bot.guilds().map(guild => [guild.id, guild]));
        const ids = [...new Set([...live.keys(), ...Object.keys(request.state.guilds)])];
        const guilds = [];
        for (const id of ids) {
            if (!await bot.canManage(id, request.session.id, request.session.guildIds)) continue;
            const config = request.state.guilds[id] || guildDefaults(id);
            guilds.push({ ...config, ...live.get(id), id, name: live.get(id)?.name || config.guildName, memberCount: live.get(id)?.memberCount || 0 });
        }
        guilds.sort((a, b) => a.name.localeCompare(b.name));
        response.render('dashboard', { guilds, cases: request.state.cases.filter(entry => guilds.some(guild => guild.id === entry.guildId)).slice(-8).reverse(), contentAccess: bot.contentAccess });
    });
    app.get('/Dashboard/Guild/:guildId', guildAccess, (request, response) => {
        const validTabs = ['overview', 'moderation', 'channels', 'logs', 'cleaner', 'cases', 'levels'];
        const tab = validTabs.includes(request.query.tab) ? request.query.tab : 'overview';
        response.render('guild', { tab, contentAccess: bot.contentAccess,
            cases: request.state.cases.filter(entry => entry.guildId === request.params.guildId).slice(-100).reverse(),
            levels: Object.values(request.state.levels).filter(entry => entry.guildId === request.params.guildId).sort((a, b) => b.xp - a.xp).slice(0, 100) });
    });
    app.post('/Dashboard/Guild/:guildId', guildAccess, async (request, response) => {
        try {
            await store.update(state => { state.guilds[request.params.guildId] = validateGuildSettings(request.body, state.guilds[request.params.guildId] || request.config, request.channels); });
            response.redirect(`/Dashboard/Guild/${request.params.guildId}?tab=${encodeURIComponent(request.body.section)}&message=Settings%20saved.`);
        } catch (error) { response.redirect(`/Dashboard/Guild/${request.params.guildId}?tab=${encodeURIComponent(request.body.section || 'overview')}&message=${encodeURIComponent(error.message.slice(0, 300))}`); }
    });
    app.post('/Dashboard/Guild/:guildId/action', guildAccess, async (request, response) => {
        if (request.body.confirm !== 'on') throw Object.assign(new Error('Confirm the moderation action before submitting.'), { status: 400 });
        try {
            let message = 'Action completed and recorded.';
            if (request.body.action === 'purge') {
                if (request.body.roleId && !bot.client.guilds.cache.get(request.params.guildId)?.roles.cache.has(request.body.roleId)) throw new Error('Choose a role from this server.');
                const deleted = await bot.purge(request.params.guildId, { channelId: request.body.channelId, count: request.body.count, userId: request.body.userId, roleId: request.body.roleId, bots: request.body.bots === 'on', contains: request.body.contains }, request.session.id);
                message = `Deleted ${deleted} messages.`;
            } else await bot.moderate(request.params.guildId, request.body.action, request.body.userId, String(request.body.reason || '').trim(), request.session.id, Number(request.body.minutes));
            response.redirect(`/Dashboard/Guild/${request.params.guildId}?tab=cases&message=${encodeURIComponent(message)}`);
        } catch (error) { response.redirect(`/Dashboard/Guild/${request.params.guildId}?tab=cases&message=${encodeURIComponent(error.code ? `Discord action failed (${error.code}). Check bot permissions and role order.` : error.message.slice(0, 300))}`); }
    });
    app.get('/Dashboard/AuditLogs/:guildId', guildAccess, (request, response) => {
        if (!businessActive(request.config)) return response.status(403).render('error', { title: 'Business plan required', detail: 'Audit history is available on Business and Enterprise.' });
        const query = String(request.query.q || '').slice(0, 200).toLowerCase();
        const category = ['moderation', 'automod', 'server'].includes(request.query.category) ? request.query.category : '';
        const entries = request.state.audit.filter(entry => entry.guildId === request.params.guildId && (!category || entry.category === category) && (!query || `${entry.title} ${entry.details} ${entry.targetUserId || ''}`.toLowerCase().includes(query))).reverse();
        if (request.query.format === 'csv') {
            const cell = value => {
                const text = String(value ?? '');
                const safe = /^\s*[=+\-@]/.test(text) || /^[\t\r]/.test(text) ? `'${text}` : text;
                return `"${safe.replaceAll('"', '""')}"`;
            };
            response.type('text/csv').attachment(`audit-${request.params.guildId}.csv`).send(['Time,Category,Event,Details', ...entries.slice(0, 1000).map(entry => [entry.createdAt, entry.category, entry.title, entry.details].map(cell).join(','))].join('\r\n'));
            return;
        }
        response.render('logs', { entries: entries.slice(0, 200), query, category });
    });
    app.get('/SuperAdmin', administrator, (request, response) => response.render('admin', { settings: request.state.settings,
        configured: { token: Boolean(request.creds.token), secret: Boolean(request.creds.clientSecret), clientId: request.creds.clientId || bot.client?.user?.id || '', privilegedIntents: request.creds.privilegedIntents },
        envManaged: { token: Boolean(env.DISCORD_TOKEN || env.Bot__DiscordBotToken), secret: Boolean(env.DISCORD_CLIENT_SECRET || env.Bot__DiscordClientSecret), clientId: Boolean(env.DISCORD_CLIENT_ID || env.Bot__DiscordClientId), privilegedIntents: env.DISCORD_PRIVILEGED_INTENTS !== undefined }, guilds: request.state.guilds, callbackUrl: `${request.origin}/Auth/Callback` }));
    app.post('/SuperAdmin', administrator, async (request, response) => {
        const id = String(request.body.clientId || '').trim();
        const token = String(request.body.botToken || '').trim(); const secret = String(request.body.clientSecret || '').trim();
        if (id && !snowflake(id)) throw Object.assign(new Error('Enter a valid Discord application ID.'), { status: 400 });
        if (token.length > 500 || secret.length > 500) throw Object.assign(new Error('The supplied credential is too long.'), { status: 400 });
        await store.update(state => {
            if (!env.DISCORD_CLIENT_ID && !env.Bot__DiscordClientId) state.settings.clientId = id;
            if (secret && !env.DISCORD_CLIENT_SECRET && !env.Bot__DiscordClientSecret) state.settings.clientSecret = seal(secret, request.key);
            if (token && !env.DISCORD_TOKEN && !env.Bot__DiscordBotToken) state.settings.botToken = seal(token, request.key);
            if (env.DISCORD_PRIVILEGED_INTENTS === undefined) state.settings.privilegedIntents = request.body.privilegedIntents === 'on';
        });
        if (request.body.restart === 'on') void bot.restart().catch(error => logger.error(`Bot restart failed (${error.code || error.name}).`));
        response.redirect('/SuperAdmin?message=Settings%20saved.');
    });
    app.post('/SuperAdmin/plan', administrator, async (request, response) => {
        const id = String(request.body.guildId || '');
        if (!snowflake(id) || !request.state.guilds[id] || !['Free', 'Pro', 'Business', 'Enterprise'].includes(request.body.tier)) throw Object.assign(new Error('Choose a server and a valid plan.'), { status: 400 });
        const expires = request.body.expires ? new Date(request.body.expires) : null;
        if (expires && Number.isNaN(expires.getTime())) throw Object.assign(new Error('Invalid expiry date.'), { status: 400 });
        await store.update(state => { state.guilds[id].premiumTier = request.body.tier; state.guilds[id].premiumExpiresAt = expires?.toISOString() || null; });
        response.redirect('/SuperAdmin?message=Plan%20updated.');
    });
    app.use((request, response) => response.status(404).render('error', { title: 'Page not found', detail: 'The requested page does not exist.' }));
    app.use((error, request, response, next) => {
        logger.error(`Dashboard request failed (${error.code || error.name}).`);
        if (response.headersSent) return next(error);
        response.status(error.status || (store.status !== 'ready' ? 503 : 500)).render('error', { title: store.status !== 'ready' ? 'Database unavailable' : 'Request could not be completed', detail: error.status && error.status < 500 ? error.message : 'Check the server configuration or try again shortly. Service status is still available.' });
    });
    return app;
}

export function inviteUrl(id) {
    const permissions = new PermissionsBitField(['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'ReadMessageHistory', 'ViewAuditLog', 'ManageMessages', 'ModerateMembers', 'KickMembers', 'BanMembers']).bitfield.toString();
    return snowflake(id) ? `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: id, scope: 'bot applications.commands', permissions })}` : '';
}
