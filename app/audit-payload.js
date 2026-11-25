import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { snowflake } from './settings.js';

export function auditPayload(guildId, category, title, details, presentation = {}, { embedAllowed, attachAllowed }) {
    const payload = { allowedMentions: { parse: [] } };
    const full = [title, presentation.description ?? details, ...(presentation.fields || []).flatMap(field => [field.name, field.value]), presentation.footer].filter(Boolean).join('\n\n');
    let truncated = false;
    const clip = (value, size) => {
        const text = String(value || 'No details');
        if (text.length <= size) return text;
        truncated = true;
        const suffix = '\n[Full text in history]';
        return `${text.slice(0, size - suffix.length)}${suffix}`;
    };
    if (embedAllowed) {
        const embed = new EmbedBuilder().setColor(presentation.color ?? (category === 'automod' ? 0xe6b450 : 0x43b581))
            .setTitle(clip(title, 256)).setDescription(clip(presentation.description ?? details, 3000)).setTimestamp();
        if (presentation.userName) embed.setAuthor({ name: clip(presentation.userName, 100), ...(presentation.avatarUrl ? { iconURL: presentation.avatarUrl } : {}) });
        if (presentation.footer) embed.setFooter({ text: clip(presentation.footer, 256) });
        let remaining = 5500 - embed.data.title.length - embed.data.description.length - (embed.data.author?.name.length || 0) - (embed.data.footer?.text.length || 0);
        for (const field of (presentation.fields || []).slice(0, 10)) {
            const name = clip(field.name, 100);
            const size = Math.min(1024, remaining - name.length);
            if (size < 50) { truncated = true; break; }
            const value = clip(field.value, size);
            embed.addFields({ name, value }); remaining -= name.length + value.length;
        }
        payload.embeds = [embed];
    } else payload.content = clip(full, 1900);
    if (truncated && attachAllowed) payload.files = [new AttachmentBuilder(Buffer.from(full, 'utf8'), { name: 'event-details.txt' })];
    const buttons = [];
    if (snowflake(presentation.userId)) buttons.push(new ButtonBuilder().setCustomId(`audit:user:${guildId}:${presentation.userId}`).setLabel('Get User ID').setStyle(ButtonStyle.Secondary));
    if (/^https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}(?:\/\d{17,20})?$/.test(presentation.jumpUrl || '')) buttons.push(new ButtonBuilder().setLabel(presentation.jumpLabel || 'Jump to Message').setURL(presentation.jumpUrl).setStyle(ButtonStyle.Link));
    if (buttons.length) payload.components = [new ActionRowBuilder().addComponents(buttons)];
    return payload;
}
