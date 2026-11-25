import { Client, GatewayIntentBits } from 'discord.js';

const basicIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildModeration, GatewayIntentBits.AutoModerationExecution];
const portal = 'https://discord.com/developers/applications';
const issue = (code, title, steps, url = '/SuperAdmin') => ({ code, title, steps, url });

export function connectionAction(code) {
    if (code === 'intents_required') return issue(code, 'Enable privileged intents in Discord', [
        'Open the Discord Developer Portal and select this bot application.',
        'Under Bot > Privileged Gateway Intents, enable Server Members Intent and Message Content Intent, then save.',
        'Return to Superadmin and select Reconnect bot. The bot remains available with basic intents meanwhile.'
    ], portal);
    if (code === 'token_missing' || code === 'token_invalid') return issue(code, code === 'token_missing' ? 'Configure a bot token' : 'Discord rejected the bot token', [
        'Use the bot token from Developer Portal > Bot, not the application ID, client secret, or database password.',
        'Update DISCORD_TOKEN in Hostinger if it is environment-managed; otherwise update Bot token in Superadmin.',
        'Redeploy after an environment change, or select Reconnect bot after saving in the app.'
    ]);
    if (code === 'storage_unavailable') return issue(code, 'Bot settings could not be loaded', ['Check MySQL connectivity and database environment variables in Hostinger.', 'Restart the application after correcting its database configuration.']);
    if (code === 'connection_timeout' || code === 'connection_failed') return issue(code, 'Discord connection needs attention', ['Confirm the host permits outbound HTTPS and secure WebSocket connections to Discord.', 'Check the Hostinger runtime log for gateway errors, then select Reconnect bot.']);
    return null;
}

function errorCode(error) {
    if (error?.code === 'TokenInvalid' || error?.code === 4004 || error?.status === 401) return 'token_invalid';
    if (error?.code === 'DisallowedIntents' || error?.code === 4014 || error?.message === 'Used disallowed intents') return 'intents_required';
    if (error?.code === 'CONNECTION_TIMEOUT') return 'connection_timeout';
    return 'connection_failed';
}

export class GatewayConnection {
    constructor({ createClient = options => new Client(options), bindClient = () => {}, readyTimeoutMs = 45000, logger = console } = {}) {
        this.createClient = createClient; this.bindClient = bindClient; this.readyTimeoutMs = readyTimeoutMs; this.logger = logger;
        this.state = 'idle'; this.errorCode = null; this.privilegedRequested = false; this.activePrivileged = false;
        this.tail = Promise.resolve(); this.closing = false; this.attempting = false; this.fallbackScheduled = false;
        this.activeClient = null;
        this.client = this.newClient(false);
    }
    newClient(privileged) {
        const client = this.createClient({ intents: [...basicIntents, ...(privileged ? [GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent] : [])] });
        const current = () => this.client === client && this.activeClient === client && !this.closing;
        client.on('clientReady', () => {
            if (!current()) return;
            this.state = this.errorCode === 'intents_required' ? 'limited' : 'connected';
            this.lastConnectedAt = new Date().toISOString();
            this.disconnectedAt = null;
        });
        client.on('shardReconnecting', () => { if (current()) this.disconnected(); });
        client.on('shardResume', () => {
            if (!current()) return;
            this.state = this.errorCode === 'intents_required' ? 'limited' : 'connected';
            this.disconnectedAt = null;
        });
        client.on('shardDisconnect', event => {
            if (!current()) return;
            this.lastCloseCode = event.code;
            if (this.attempting) {
                if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) this.cancelAttempt?.(Object.assign(new Error('Gateway closed'), { code: event.code }));
                else this.disconnected();
                return;
            }
            if (event.code === 4014 && this.activePrivileged && !this.fallbackScheduled) {
                this.fallbackScheduled = true;
                void this.connect(this.lastToken, false, true).catch(() => {}).finally(() => { this.fallbackScheduled = false; });
            } else if (event.code === 4004) {
                this.activeClient = null;
                this.state = 'action_required'; this.errorCode = 'token_invalid';
            } else this.disconnected();
        });
        // An error listener is always present, including while an old client retires.
        client.on('error', () => { if (current() && !client.isReady() && !this.attempting) this.disconnected(); });
        this.bindClient(client);
        return client;
    }
    disconnected() {
        this.state = 'reconnecting';
        this.disconnectedAt ||= Date.now();
    }
    getStatus() {
        const connected = this.activeClient === this.client && (this.client?.isReady() || false);
        const timedOut = this.disconnectedAt && Date.now() - this.disconnectedAt >= this.readyTimeoutMs;
        const code = timedOut && !connected ? 'connection_timeout' : this.errorCode;
        return {
            connected, status: timedOut && !connected ? 'action_required' : this.state,
            errorCode: code, action: connectionAction(code),
            privilegedRequested: this.privilegedRequested, privilegedActive: connected && this.activePrivileged,
            reconnecting: ['connecting', 'reconnecting'].includes(this.state) && !timedOut,
            lastAttemptAt: this.lastAttemptAt || null, lastConnectedAt: this.lastConnectedAt || null,
            gatewayCloseCode: this.lastCloseCode || null
        };
    }
    connect(token, privileged, limited = false) {
        if (this.closing) return Promise.reject(Object.assign(new Error('Connection stopped'), { code: 'CONNECTION_STOPPED' }));
        const operation = this.tail.then(async () => {
            if (this.closing) throw Object.assign(new Error('Connection stopped'), { code: 'CONNECTION_STOPPED' });
            this.privilegedRequested = privileged || limited;
            this.errorCode = limited ? 'intents_required' : null;
            this.lastCloseCode = null;
            this.disconnectedAt = null;
            this.lastToken = token;
            this.lastAttemptAt = new Date().toISOString();
            if (!token) { this.state = 'action_required'; this.errorCode = 'token_missing'; return; }
            try { return await this.attempt(token, privileged); }
            catch (error) {
                if (this.closing) throw error;
                const code = errorCode(error);
                if (privileged && code === 'intents_required') {
                    this.errorCode = code;
                    this.logger.error('Discord rejected privileged intents; reconnecting once with basic intents.');
                    try { return await this.attempt(token, false); }
                    catch (fallbackError) { this.errorCode = errorCode(fallbackError); this.state = 'action_required'; throw fallbackError; }
                }
                this.errorCode = code; this.state = 'action_required'; throw error;
            }
        }).finally(() => { this.attempting = false; });
        this.tail = operation.catch(() => {});
        return operation;
    }
    async attempt(token, privileged) {
        const previous = this.client;
        this.state = 'connecting'; this.attempting = true;
        // Retire the old client; never log back in through destroyed Discord.js internals.
        this.client = null;
        this.activeClient = null;
        await previous?.destroy();
        if (this.closing) throw Object.assign(new Error('Connection stopped'), { code: 'CONNECTION_STOPPED' });
        this.activePrivileged = privileged;
        const client = this.newClient(privileged);
        this.client = client;
        this.activeClient = client;
        let timeout;
        let ready;
        let fail;
        const waiting = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
        this.cancelAttempt = fail;
        const onReady = () => ready();
        client.once('clientReady', onReady);
        timeout = setTimeout(() => fail(Object.assign(new Error('Gateway readiness timed out'), { code: 'CONNECTION_TIMEOUT' })), this.readyTimeoutMs);
        try {
            const login = Promise.resolve().then(() => client.login(token)).then(value => { if (client.isReady()) ready(); return value; });
            await Promise.race([login.then(() => waiting), waiting]);
            this.state = this.errorCode === 'intents_required' ? 'limited' : 'connected';
            this.lastConnectedAt = new Date().toISOString(); this.disconnectedAt = null;
            return token;
        } catch (error) {
            client.removeListener('clientReady', onReady);
            this.client = null;
            this.activeClient = null;
            await client.destroy();
            // Keep a stopped client for safe read-only cache access, not for reuse.
            if (!this.client) this.client = client;
            throw error;
        } finally {
            clearTimeout(timeout); client.removeListener('clientReady', onReady);
            this.cancelAttempt = null; this.attempting = false;
        }
    }
    async destroy() {
        this.closing = true;
        this.cancelAttempt?.(Object.assign(new Error('Connection stopped'), { code: 'CONNECTION_STOPPED' }));
        await this.tail;
        await this.client?.destroy();
        this.state = 'stopped';
        this.lastToken = null;
    }
}
