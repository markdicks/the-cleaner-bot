import { ChannelType, PermissionsBitField } from 'discord.js';

const fields = [
    ['name', 'Name'], ['type', 'Channel type'], ['topic', 'Topic'], ['parentId', 'Category'],
    ['nsfw', 'Age-restricted'], ['rateLimitPerUser', 'Slowmode (seconds)'],
    ['bitrate', 'Voice bitrate'], ['userLimit', 'Voice member limit'], ['rtcRegion', 'Voice region'],
    ['defaultAutoArchiveDuration', 'Default thread archive (minutes)'],
    ['defaultThreadRateLimitPerUser', 'Default thread slowmode (seconds)']
];

function value(field, item) {
    if (item === null || item === '') return '(none)';
    if (field === 'type') return ChannelType[item] || String(item);
    if (typeof item === 'boolean') return item ? 'On' : 'Off';
    return String(item);
}

function overwrites(channel) {
    if (!channel.permissionOverwrites?.cache) return null;
    return new Map([...channel.permissionOverwrites.cache.values()].map(entry => [String(entry.id), {
        id: String(entry.id), type: entry.type, allow: String(entry.allow.bitfield), deny: String(entry.deny.bitfield)
    }]));
}

function permissions(bits) {
    if (bits === '0') return '(none)';
    const names = new PermissionsBitField(BigInt(bits)).toArray();
    return `${names.join(', ') || 'Other permissions'} (${bits})`;
}

export function channelChanges(before, after) {
    const changes = [];
    for (const [key, label] of fields) {
        // Missing fields on partial/unsupported channel types are not evidence of a change.
        if (before[key] === undefined || after[key] === undefined || Object.is(before[key] ?? '', after[key] ?? '')) continue;
        changes.push(`${label}: ${value(key, before[key])} -> ${value(key, after[key])}`);
    }
    const oldPermissions = overwrites(before);
    const newPermissions = overwrites(after);
    if (oldPermissions && newPermissions) {
        const ids = [...new Set([...oldPermissions.keys(), ...newPermissions.keys()])].sort();
        for (const id of ids) {
            const old = oldPermissions.get(id); const current = newPermissions.get(id);
            if (old?.allow === current?.allow && old?.deny === current?.deny && old?.type === current?.type) continue;
            const subject = (current || old).type === 1 ? `Member <@${id}>` : `Role <@&${id}>`;
            if (!current) changes.push(`Permissions removed for ${subject}: allow ${permissions(old.allow)}; deny ${permissions(old.deny)}`);
            else if (!old) changes.push(`Permissions added for ${subject}: allow ${permissions(current.allow)}; deny ${permissions(current.deny)}`);
            else {
                const names = [...new Set([old.allow, old.deny, current.allow, current.deny].flatMap(bits => new PermissionsBitField(BigInt(bits)).toArray()))];
                const state = (entry, name) => new PermissionsBitField(BigInt(entry.allow)).has(name, false) ? 'Allow' : new PermissionsBitField(BigInt(entry.deny)).has(name, false) ? 'Deny' : 'Inherit';
                const differences = names.filter(name => state(old, name) !== state(current, name)).map(name => `${name}: ${state(old, name)} -> ${state(current, name)}`);
                changes.push(`Permissions changed for ${subject}:\n${differences.join('\n') || 'Overwrite target type changed'}`);
            }
        }
    }
    return changes;
}

export function channelAuditEvent(before, after, kind) {
    const channel = after || before;
    const guildId = channel?.guildId || channel?.guild?.id;
    if (!guildId || !channel.id || channel.isThread?.()) return null;
    if (before && after && (before.id !== after.id || (before.guildId || before.guild?.id) !== guildId)) return null;
    const heading = `Channel: <#${channel.id}> (#${channel.name || channel.id})`;
    if (kind === 'updated') {
        if (!before || !after) return null;
        const changes = channelChanges(before, after);
        if (!changes.length) return null;
        return { guildId, channelId: channel.id, title: 'Channel updated', eventType: 'channel.updated', details: [heading, ...changes].join('\n') };
    }
    if (!['created', 'deleted'].includes(kind)) return null;
    const description = [heading];
    if (channel.type !== undefined) description.push(`Type: ${value('type', channel.type)}`);
    if (channel.parentId) description.push(`Category: ${channel.parentId}`);
    if (channel.topic) description.push(`Topic: ${channel.topic}`);
    return { guildId, channelId: channel.id, title: kind === 'created' ? 'Channel created' : 'Channel deleted', eventType: `channel.${kind}`, details: description.join('\n') };
}
