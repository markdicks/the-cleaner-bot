import { createHash } from 'node:crypto';
import { PermissionsBitField } from 'discord.js';

export const digest = value => createHash('sha256').update(String(value)).digest('hex');

// Claims live in the same locked transaction as history, shared by all MySQL workers.
export function claimEvent(state, claim, now = Date.now()) {
    if (!claim) return true;
    state.eventClaims ||= {};
    for (const [key, entry] of Object.entries(state.eventClaims)) if (entry.expires <= now) delete state.eventClaims[key];
    const key = digest(claim.key);
    const previous = state.eventClaims[key];
    if (previous?.signature === claim.signature) return false;
    state.eventClaims[key] = { signature: claim.signature, expires: now + (claim.ttl || 86400000) };
    const keys = Object.keys(state.eventClaims);
    for (const expired of keys.slice(0, Math.max(0, keys.length - 10000))) delete state.eventClaims[expired];
    return true;
}

export function messageSnapshot(message) {
    return {
        id: message.id, guildId: message.guildId || message.guild?.id, channelId: message.channelId,
        userId: message.author?.id, userName: message.author?.tag || message.author?.username,
        avatarUrl: message.author?.displayAvatarURL?.({ size: 64 }), bot: message.author?.bot,
        content: message.partial ? null : message.content ?? null,
        attachments: [...(message.attachments?.values() || [])].map(item => ({ id: item.id, url: item.url, name: item.name })),
        editedAt: message.editedTimestamp, partial: Boolean(message.partial)
    };
}

export function messageText(snapshot, contentAllowed) {
    if (!contentAllowed) return '(Message content omitted by server settings.)';
    if (!snapshot || snapshot.content === null) return '(Not cached; Discord did not provide the message content.)';
    return [snapshot.content, ...snapshot.attachments.map(item => item.url)].filter(Boolean).join('\n') || '(No text or attachments.)';
}

export function messagePresentation(snapshot) {
    return {
        userId: snapshot.userId, userName: snapshot.userName, avatarUrl: snapshot.avatarUrl,
        footer: `Author: ${snapshot.userId || 'unknown'} | Message ID: ${snapshot.id}`,
        description: `From: ${snapshot.userId ? `<@${snapshot.userId}>` : 'Unknown author'}   In: <#${snapshot.channelId}>`
    };
}

export function roleAuditEvent(before, after, kind) {
    const role = after || before;
    if (!role?.guild?.id || !role.id) return null;
    const fields = [['name', 'Name'], ['color', 'Color'], ['hoist', 'Separate member list'], ['mentionable', 'Mentionable']];
    const display = (key, value) => key === 'color' ? `#${Number(value).toString(16).padStart(6, '0')}` : typeof value === 'boolean' ? value ? 'On' : 'Off' : String(value);
    const changes = [];
    if (kind === 'updated') {
        if (!before || !after || before.id !== after.id || before.guild.id !== after.guild.id) return null;
        for (const [key, label] of fields) if (before[key] !== undefined && after[key] !== undefined && before[key] !== after[key]) changes.push(`${label}: ${display(key, before[key])} -> ${display(key, after[key])}`);
        if (before.permissions && after.permissions && before.permissions.bitfield !== after.permissions.bitfield) {
            const old = new PermissionsBitField(before.permissions.bitfield).toArray();
            const current = new PermissionsBitField(after.permissions.bitfield).toArray();
            if (current.some(key => !old.includes(key))) changes.push(`Permissions added: ${current.filter(key => !old.includes(key)).join(', ')}`);
            if (old.some(key => !current.includes(key))) changes.push(`Permissions removed: ${old.filter(key => !current.includes(key)).join(', ')}`);
        }
        if (!changes.length) return null;
    } else if (!['created', 'deleted'].includes(kind)) return null;
    return { guildId: role.guild.id, channelId: undefined, entityId: role.id,
        title: `Role ${kind}`, eventType: `role.${kind}`,
        details: [`Role: <@&${role.id}> (${role.name})`, ...changes].join('\n'),
        presentation: { footer: `Role ID: ${role.id}`, color: role.color || 0x43b581 } };
}
