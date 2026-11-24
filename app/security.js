import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { parse, serialize } from 'cookie';
import { environmentCredentials } from './environment.js';

export function seal(value, secret) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function unseal(value, secret) {
    try {
        const data = Buffer.from(value, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), data.subarray(0, 12));
        decipher.setAuthTag(data.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
    } catch { return null; }
}

export const secretKey = (state, env) => env.SESSION_SECRET || state.sessionKey;
export const randomToken = () => randomBytes(32).toString('base64url');
export function equalToken(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
export function readCookie(request, name, key) { return unseal(parse(request.headers.cookie || '')[name] || '', key); }
export function writeCookie(response, name, value, key, secure, maxAge = 43200) {
    response.append('Set-Cookie', serialize(name, seal(value, key), { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge }));
}
export function clearCookie(response, name, secure) {
    response.append('Set-Cookie', serialize(name, '', { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: 0 }));
}
export function credentials(state, env) {
    const key = secretKey(state, env);
    const configured = environmentCredentials(env);
    return {
        clientId: configured.clientId || state.settings.clientId,
        clientSecret: configured.clientSecret || unseal(state.settings.clientSecret, key) || '',
        token: configured.token || unseal(state.settings.botToken, key) || '',
        superAdminId: env.SUPERADMIN_DISCORD_ID || state.settings.superAdminId,
        privilegedIntents: env.DISCORD_PRIVILEGED_INTENTS !== undefined ? env.DISCORD_PRIVILEGED_INTENTS === 'true' : state.settings.privilegedIntents
    };
}

export function publicOrigin(request, env) {
    if (env.PUBLIC_URL) {
        const url = new URL(env.PUBLIC_URL);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') throw new Error('PUBLIC_URL must be an HTTP(S) origin without a path.');
        return url.origin;
    }
    const host = request.get('host');
    if (!host || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) throw new Error('Invalid website host.');
    return `${request.secure ? 'https' : 'http'}://${host}`;
}
