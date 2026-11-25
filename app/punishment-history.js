import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionsBitField, escapeMarkdown } from 'discord.js';
import { credentials } from './security.js';
import { snowflake } from './settings.js';

const compress = promisify(gzip);
const pageSize = 4;
const issue = message => Object.assign(new Error(message), { expose: true });
const actions = { warn: 'Warning', warning: 'Warning', timeout: 'Timeout', untimeout: 'Timeout removed', mute: 'Mute', unmute: 'Mute removed',
    kick: 'Kick', ban: 'Ban', unban: 'Ban removed', softban: 'Soft ban' };
const label = action => actions[String(action).toLowerCase()] || String(action || 'Unknown action').slice(0, 80);
const timestamp = entry => Number.isFinite(Date.parse(entry.createdAt)) ? Date.parse(entry.createdAt) : 0;
const moderator = entry => snowflake(entry.moderatorUserId) ? `<@${entry.moderatorUserId}> (\`${entry.moderatorUserId}\`)` : 'Not recorded';

export const lookupCommand = {
    name: 'lookup', description: 'View a person\'s recorded punishment history in this server',
    defaultMemberPermissions: PermissionsBitField.Flags.ModerateMembers.toString(),
    options: [
        { name: 'user', description: 'Person to look up', type: 6 },
        { name: 'user-id', description: 'Discord user ID, including people who left or were banned', type: 3 },
        { name: 'page', description: 'Page number, newest cases first', type: 4, minValue: 1, maxValue: 999999999 }
    ]
};

export function historyCases(state, guildId, targetId, anchor = Number.MAX_SAFE_INTEGER) {
    return state.cases.filter(entry => entry.guildId === guildId && entry.targetUserId === targetId && Number(entry.id) <= anchor)
        .sort((a, b) => timestamp(b) - timestamp(a) || Number(b.id) - Number(a.id));
}

function field(entry) {
    const when = Number.isFinite(Date.parse(entry.createdAt)) ? `<t:${Math.floor(Date.parse(entry.createdAt) / 1000)}:F>` : 'Not recorded';
    const heading = `When: ${when}\nBy: ${moderator(entry)}\nReason: `;
    const reason = escapeMarkdown(String(entry.reason || 'No reason recorded.'));
    const suffix = '\n[Full reason in history download]';
    const available = 1024 - heading.length;
    return { name: `Case #${entry.id} | ${label(entry.action)}`.slice(0, 120),
        value: heading + (reason.length <= available ? reason : reason.slice(0, available - suffix.length) + suffix) };
}

export function historyPage(entries, { guildId, requesterId, targetId, anchor, page = 1 }) {
    const pages = Math.max(1, Math.ceil(entries.length / pageSize));
    page = Math.max(1, Math.min(page, pages));
    const start = (page - 1) * pageSize;
    const embed = new EmbedBuilder().setTitle('Punishment history').setColor(entries.length ? 0xe6b450 : 0x43b581)
        .setDescription(`Member: <@${targetId}>\nUser ID: \`${targetId}\`\n${entries.length ? `${entries.length} recorded case${entries.length === 1 ? '' : 's'} in this server.` : 'No punishments recorded for this person in this server.'}`)
        .setFooter({ text: `Page ${page} of ${pages}${entries.length ? ` | Cases ${start + 1}-${Math.min(start + pageSize, entries.length)} of ${entries.length}` : ''} | Recorded cases only` });
    if (entries.length) embed.addFields(entries.slice(start, start + pageSize).map(field));
    const id = (number, action) => `lookup:${guildId}:${requesterId}:${targetId}:${anchor}:${number}:${action}`;
    const components = entries.length ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id(Math.max(1, page - 1), 'p')).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
        new ButtonBuilder().setCustomId(id(Math.min(pages, page + 1), 'p')).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pages),
        new ButtonBuilder().setCustomId(id(page, 'x')).setLabel('Download history').setStyle(ButtonStyle.Secondary)
    )] : [];
    return { content: '', embeds: [embed], components, attachments: [], allowedMentions: { parse: [] } };
}

export async function historyDownload(entries, guildId, targetId, limit = 7500000) {
    const text = [`Punishment history`, `Server ID: ${guildId}`, `User ID: ${targetId}`, `Recorded cases: ${entries.length}`, '',
        ...entries.flatMap(entry => [
            `Case #${entry.id} | ${label(entry.action)}`,
            `When (UTC): ${Number.isFinite(Date.parse(entry.createdAt)) ? new Date(entry.createdAt).toISOString() : 'Not recorded'}`,
            `Given by (Discord user ID): ${entry.moderatorUserId || 'Not recorded'}`,
            `Reason: ${entry.reason || 'No reason recorded.'}`, ''
        ])].join('\n');
    let attachment = Buffer.from(text, 'utf8');
    let name = `punishment-history-${guildId}-${targetId}.txt`;
    if (attachment.length > limit) { attachment = await compress(attachment); name += '.gz'; }
    if (attachment.length > limit) throw issue('This history exceeds the Discord download limit. All recorded cases remain accessible using the page option and navigation buttons.');
    return new AttachmentBuilder(attachment, { name });
}

export async function handleLookup(bot, interaction) {
    const button = interaction.isButton();
    let acknowledged = false;
    try {
        let targetId; let anchor; let page = 1; let action = 'p';
        if (button) {
            const match = /^lookup:(\d{17,20}):(\d{17,20}):(\d{17,20}):(\d{1,16}):(\d{1,9}):([px])$/.exec(interaction.customId);
            if (!match || match[1] !== interaction.guildId || match[2] !== interaction.user.id || interaction.message?.author?.id !== bot.client?.user?.id || !interaction.message.flags?.has(MessageFlags.Ephemeral)) throw issue('This private history panel is not available to you.');
            targetId = match[3]; anchor = Number(match[4]); page = Number(match[5]); action = match[6];
            if (!Number.isSafeInteger(anchor) || page < 1) throw issue('This history panel is invalid. Run /lookup again.');
            if (action === 'x') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            else await interaction.deferUpdate();
            acknowledged = true;
        } else {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            acknowledged = true;
            const user = interaction.options.getUser('user');
            const id = interaction.options.getString('user-id')?.trim();
            if (Boolean(user) === Boolean(id)) throw issue('Choose either a user or a user-id, not both.');
            targetId = user?.id || id;
            page = interaction.options.getInteger('page') ?? 1;
            if (!snowflake(targetId) || !Number.isInteger(page) || page < 1 || page > 999999999) throw issue('Provide a valid Discord user ID and a positive page number.');
        }
        const guild = bot.client?.guilds.cache.get(interaction.guildId);
        if (!guild || !bot.isReady()) throw issue('The bot must be connected to this server to look up punishment history.');
        const state = await bot.store.read();
        if (interaction.user.id !== credentials(state, bot.env).superAdminId && interaction.user.id !== guild.ownerId) {
            const member = await guild.members.fetch({ user: interaction.user.id, force: true }).catch(() => null);
            if (!member || (!member.permissions.has(PermissionsBitField.Flags.ModerateMembers) && !member.permissions.has(PermissionsBitField.Flags.ManageGuild))) throw issue('Moderate Members or Manage Server permission is required to view punishment history.');
        }
        const entries = historyCases(state, interaction.guildId, targetId, anchor);
        anchor ??= entries.reduce((latest, entry) => Math.max(latest, Number(entry.id)), 0);
        if (action === 'x') {
            const limit = Math.min(7500000, Number(interaction.attachmentSizeLimit) || 7500000);
            const file = await historyDownload(entries, interaction.guildId, targetId, limit);
            await interaction.editReply({ content: `${entries.length} recorded case${entries.length === 1 ? '' : 's'} for user ${targetId}.`, files: [file], allowedMentions: { parse: [] } });
        } else await interaction.editReply(historyPage(entries, { guildId: interaction.guildId, requesterId: interaction.user.id, targetId, anchor, page }));
    } catch (error) {
        if (!error.expose) bot.report('Punishment lookup', error);
        const payload = { content: error.expose ? error.message : 'Punishment history could not be loaded. Try again shortly or check the bot connection.', embeds: [], components: [], attachments: [], allowedMentions: { parse: [] } };
        if (acknowledged) await interaction.editReply(payload);
        else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
}
