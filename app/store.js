import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { guildDefaults, SUPERADMIN_ID } from './settings.js';
import { seal, secretKey } from './security.js';
import { environmentValue } from './environment.js';

export function parseConnectionString(raw) {
    if (/^\s*\$env:/i.test(raw) || /SetEnvironmentVariable/i.test(raw)) throw new Error('Use only the raw database connection string, not a PowerShell command.');
    const values = {};
    let cursor = 0;
    while (cursor < raw.length) {
        while (/[;\s]/.test(raw[cursor] || '') && cursor < raw.length) cursor++;
        if (cursor === raw.length) break;
        const equals = raw.indexOf('=', cursor);
        if (equals < cursor) throw new Error('Invalid database connection string.');
        const key = raw.slice(cursor, equals).trim().toLowerCase().replaceAll(' ', '');
        cursor = equals + 1;
        while (raw[cursor] === ' ') cursor++;
        let value = '';
        const quote = ['"', "'"].includes(raw[cursor]) ? raw[cursor++] : null;
        let closed = !quote;
        while (cursor < raw.length) {
            const char = raw[cursor++];
            if (quote && char === quote) {
                if (raw[cursor] === quote) { value += quote; cursor++; }
                else { closed = true; break; }
            } else if (!quote && char === ';') break;
            else value += char;
        }
        if (!closed) throw new Error('Unterminated quoted database value.');
        if (quote) {
            while (raw[cursor] === ' ') cursor++;
            if (cursor < raw.length && raw[cursor] !== ';') throw new Error('Invalid quoted database value.');
        }
        values[key] = quote ? value : value.trim();
    }
    const sslMode = (values.sslmode || 'Preferred').toLowerCase();
    return { host: values.server || values.host || values.datasource, port: Number(values.port || 3306),
        user: values.user || values.userid || values.uid || values.username, password: values.password || values.pwd || '',
        database: values.database || values.initialcatalog,
        // mysql2 cannot negotiate Preferred; require TLS rather than silently downgrading.
        ...(!['none', 'disabled'].includes(sslMode) ? { ssl: { rejectUnauthorized: true } } : {}) };
}

export function databaseOptions(env) {
    const raw = connectionStringValue(env);
    if (raw && (!/^Data Source\s*=/i.test(raw) || isMySqlProvider(env))) return parseConnectionString(raw);
    if (env.DATABASE_URL || env.MYSQL_URL) return env.DATABASE_URL || env.MYSQL_URL;
    if (!env.MYSQL_HOST) {
        if (isMySqlProvider(env)) {
            throw Object.assign(new Error('Set CONNECTIONSTRINGS__BOTDATABASE or MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER and MYSQL_PASSWORD.'), { code: 'DATABASE_CONFIGURATION_MISSING' });
        }
        return null;
    }
    return { host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
        password: env.MYSQL_PASSWORD || '', database: env.MYSQL_DATABASE,
        ...(env.MYSQL_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}) };
}

function connectionStringValue(env) {
    return String(environmentValue(env, 'ConnectionStrings__BotDatabase') || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

function isMySqlProvider(env) {
    return ['mysql', 'mariadb'].includes(String(environmentValue(env, 'Database__Provider') || '').toLowerCase());
}

export function databaseMode(env) {
    const raw = connectionStringValue(env);
    return env.MYSQL_HOST || env.DATABASE_URL || env.MYSQL_URL || isMySqlProvider(env) || (raw && !/^\s*Data Source\s*=/i.test(raw)) ? 'MySQL' : 'Local file';
}

export function initialState() {
    return { schema: 1, sessionKey: randomBytes(32).toString('hex'), settings: { superAdminId: SUPERADMIN_ID, clientId: '',
        clientSecret: '', botToken: '', privilegedIntents: false }, guilds: {}, cases: [], audit: [], levels: {}, nextCaseId: 1 };
}

export class AppStore {
    constructor({ env = process.env, directory = env.DATA_DIRECTORY || './database', logger = console } = {}) {
        this.env = env; this.directory = path.resolve(directory); this.logger = logger;
        this.mode = databaseMode(env);
        this.status = 'starting'; this.tail = Promise.resolve();
        this.ready = this.initialize();
        this.ready.catch(error => { this.status = 'unavailable'; logger.error(`Dashboard storage unavailable (${error.code || error.name}). Check database environment variables.`); });
    }
    async initialize() {
        const options = databaseOptions(this.env);
        if (options) {
            const { createPool } = await import('mysql2/promise');
            this.pool = createPool(typeof options === 'string' ? options : { ...options, connectionLimit: 3, connectTimeout: 10000, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
            await this.pool.query('CREATE TABLE IF NOT EXISTS CleanerDashboardState (Id INT PRIMARY KEY, StateJson LONGTEXT NOT NULL) CHARACTER SET utf8mb4');
            const connection = await this.pool.getConnection();
            try {
                await connection.beginTransaction();
                await connection.query('INSERT IGNORE INTO CleanerDashboardState (Id, StateJson) VALUES (1, ?)', [JSON.stringify(initialState())]);
                const [rows] = await connection.query('SELECT StateJson FROM CleanerDashboardState WHERE Id = 1 FOR UPDATE');
                const state = JSON.parse(rows[0].StateJson);
                if (!state.importedDotNet) await importDotNet(connection, state, this.env);
                await connection.query('UPDATE CleanerDashboardState SET StateJson = ? WHERE Id = 1', [JSON.stringify(state)]);
                await connection.commit();
                this.state = state;
            } catch (error) { await connection.rollback(); throw error; }
            finally { connection.release(); }
        } else {
            await mkdir(this.directory, { recursive: true });
            this.file = path.join(this.directory, 'dashboard.json');
            try { this.state = JSON.parse(await readFile(this.file, 'utf8')); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                this.state = initialState();
                await this.persistFile(this.state);
            }
        }
        this.status = 'ready';
    }
    async read() {
        await this.ready;
        if (this.pool) {
            const [rows] = await this.pool.query('SELECT StateJson FROM CleanerDashboardState WHERE Id = 1');
            return JSON.parse(rows[0].StateJson);
        }
        await this.tail;
        return structuredClone(this.state);
    }
    async update(mutator) {
        await this.ready;
        const operation = this.tail.then(async () => {
            if (this.pool) {
                const connection = await this.pool.getConnection();
                try {
                    await connection.beginTransaction();
                    const [rows] = await connection.query('SELECT StateJson FROM CleanerDashboardState WHERE Id = 1 FOR UPDATE');
                    const next = JSON.parse(rows[0].StateJson);
                    const result = await mutator(next);
                    trimHistory(next);
                    await connection.query('UPDATE CleanerDashboardState SET StateJson = ? WHERE Id = 1', [JSON.stringify(next)]);
                    await connection.commit(); this.state = next;
                    return result;
                } catch (error) { await connection.rollback(); throw error; }
                finally { connection.release(); }
            }
            const next = structuredClone(this.state);
            const result = await mutator(next);
            trimHistory(next);
            await this.persistFile(next); this.state = next;
            return result;
        });
        this.tail = operation.catch(() => {});
        return operation;
    }
    async persistFile(state) {
        const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await rename(temporary, this.file);
    }
    async close() { await this.ready.catch(() => {}); await this.tail; if (this.pool) await this.pool.end(); }
}

function trimHistory(state) {
    const since = Date.now() - 30 * 86400000;
    state.audit = state.audit.filter(entry => Date.parse(entry.createdAt) >= since).slice(-10000);
    for (const [key, expires] of Object.entries(state.suppressedDeletions || {})) if (expires <= Date.now()) delete state.suppressedDeletions[key];
}

async function importDotNet(connection, state, env) {
    const [tables] = await connection.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    const names = new Set(tables.map(table => table.name));
    const load = async name => names.has(name) ? (await connection.query(`SELECT * FROM \`${name}\``))[0] : [];
    for (const row of await load('GuildConfigs')) {
        const config = guildDefaults(String(row.GuildId), row.GuildName);
        for (const key of Object.keys(config)) {
            const column = key[0].toUpperCase() + key.slice(1);
            if (row[column] !== undefined && row[column] !== null) config[key] = typeof config[key] === 'boolean' ? Boolean(row[column]) : row[column];
        }
        if (row.IgnoredModerationChannelIdsJson) config.ignoredModerationChannelIds = JSON.parse(row.IgnoredModerationChannelIdsJson);
        if (row.AuditLogSettingsJson) for (const [key, value] of Object.entries(JSON.parse(row.AuditLogSettingsJson))) config.auditLogs[key[0].toLowerCase() + key.slice(1)] = value;
        if (config.premiumExpiresAt instanceof Date) config.premiumExpiresAt = config.premiumExpiresAt.toISOString();
        state.guilds[config.guildId] = config;
    }
    for (const row of await load('BlockedWords')) state.guilds[String(row.GuildId)]?.blockedWords.push(row.Word);
    for (const row of await load('ModerationCases')) state.cases.push({ id: Number(row.Id), guildId: String(row.GuildId), action: row.Action,
        targetUserId: row.TargetUserId, targetUserTag: row.TargetUserTag, moderatorUserId: row.ModeratorUserId, reason: row.Reason, createdAt: new Date(row.CreatedAt).toISOString() });
    for (const row of await load('GuildMemberLevels')) state.levels[`${row.GuildId}:${row.UserId}`] = { guildId: String(row.GuildId), userId: String(row.UserId), userTag: row.UserTag,
        xp: row.Xp, level: row.Level, lastMessageAt: new Date(row.LastMessageAt).getTime(), lastVoiceXpAt: row.LastVoiceXpAt ? new Date(row.LastVoiceXpAt).getTime() : 0 };
    if (names.has('GuildAuditEntries')) {
        const [entries] = await connection.query('SELECT * FROM GuildAuditEntries WHERE CreatedAtUnixSeconds >= ? ORDER BY Id DESC LIMIT 10000', [Math.floor(Date.now() / 1000) - 30 * 86400]);
        state.audit = entries.reverse().map(row => ({ guildId: String(row.GuildId), category: row.Category === 'Moderation' ? 'moderation' : row.Category === 'AutoMod' ? 'automod' : 'server',
            eventType: row.EventType, title: row.Summary, details: row.Details, targetUserId: row.SubjectId, moderatorUserId: row.ActorId, channelId: row.ChannelId, createdAt: new Date(Number(row.CreatedAtUnixSeconds) * 1000).toISOString() }));
    }
    state.nextCaseId = state.cases.reduce((latest, entry) => Math.max(latest, entry.id), 0) + 1;
    const [legacy] = await load('BotSettings');
    if (legacy) {
        state.settings.superAdminId = legacy.SuperAdminDiscordUserId || SUPERADMIN_ID;
        state.settings.clientId = legacy.DiscordClientId || '';
        const key = secretKey(state, env);
        state.settings.botToken = legacy.DiscordBotToken ? seal(legacy.DiscordBotToken, key) : '';
        state.settings.clientSecret = legacy.DiscordClientSecret ? seal(legacy.DiscordClientSecret, key) : '';
    }
    state.importedDotNet = true;
}
