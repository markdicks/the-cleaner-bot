# The Cleaner: Hostinger JavaScript Application

This repository now contains the **Node.js management application and Discord bot**, not just the old service-status page. It runs directly on Hostinger's managed Node.js hosting; it does not require .NET, Docker, Render, PM2, a second web service, or a build step.

## Deploy

- Repository: `markdicks/the-cleaner-bot`, branch `main`.
- Framework: **Other**. Node.js: **22 or newer**.
- Entry file: **index.js**. Build command: **none**. Start command if requested: **npm start**.
- Keep the existing `DISCORD_TOKEN` environment variable. No token belongs in source control.
- Set `PUBLIC_URL=https://thecleanerbot.space` (or your actual HTTPS origin).
- Redeploy the latest commit. `/api/status` reports application version **2.2.1**, storage provider/status, and bot connection diagnostics. Credentials are never included.

The entry remains synchronously loadable by Hostinger's CommonJS launcher. The HTTP listener starts before database initialization or Discord login; bad bot credentials do not terminate the website. No SDK downloads or extra child processes are started.

## Application URLs

| URL | Purpose |
| --- | --- |
| `/` | Opens `/Dashboard` |
| `/Dashboard` | Discord sign-in and manageable servers |
| `/Dashboard/Guild/{guildId}` | Server settings, cleaner, moderation actions, cases, levels |
| `/Dashboard/AuditLogs/{guildId}` | Business/Enterprise history and CSV export |
| `/SuperAdmin` | Owner-only credentials, intents, and plans |
| `/service` | Separate public service page, with a link back to the application |
| `/health` | HTTP liveness; remains 200 if Discord is offline |
| `/ready` | Discord readiness; 503 until the bot is connected |
| `/api/status` | Public status JSON, without credentials or server data |

## Secure First Sign-In

1. Visit the website once, or set `PUBLIC_URL` in Hostinger.
2. In a server containing the bot, run **`/dashboard` using Discord account `680840717731364926`**.
3. The bot sends that account an **ephemeral, one-use owner link**, valid for five minutes. It opens `/SuperAdmin` with a 30-minute owner session, even if OAuth is not configured yet. No publicly accessible setup bypass exists.
4. Enter the Discord application/client ID and client secret. The existing environment-managed bot token is masked and cannot be overwritten by a form.
5. Register `https://thecleanerbot.space/Auth/Callback` as a redirect URL in the same application's Discord Developer Portal. Use the exact URL displayed in Superadmin for another domain.
6. Other managers use **Continue with Discord**. Only servers they can manage are shown. Writes recheck current server permissions through the bot.

Alternatively configure `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` directly in Hostinger. Set a stable, random `SESSION_SECRET` of at least 32 characters **before** saving credentials; changing it invalidates sessions and requires re-entering database-stored secrets. Credentials saved through Superadmin are encrypted and never returned to the browser. Environment variables take precedence.

## Persistent MySQL Storage

Configure the Hostinger runtime environment with `MYSQL_HOST`, `MYSQL_PORT` (default 3306), `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, and optionally `MYSQL_SSL=true` for TLS. `DATABASE_URL`/`MYSQL_URL` are also supported.

The original .NET variable **`ConnectionStrings__BotDatabase`** and its all-uppercase Hostinger form **`CONNECTIONSTRINGS__BOTDATABASE`** are both supported. `Database__Provider` / `DATABASE__PROVIDER` also work. Linux environment keys are case-sensitive, so the application explicitly supports both spellings. An explicit MySQL/MariaDB provider without connection information produces a configuration error instead of silently using local files.

The connection value must be the raw MySQL connection string, without a PowerShell assignment or outer quotes. Dollar signs are literal values in a hosting environment field. Prefer the separate `MYSQL_*` fields for passwords containing semicolons or quotes. Legacy Discord keys such as `Bot__DiscordClientSecret` also accept their all-uppercase forms, while remaining masked and environment-managed in Superadmin.

The app creates a separate `CleanerDashboardState` table. It imports existing .NET server configuration, blocked words, moderation cases, levels, owner credentials, and recent audit history once, without dropping or changing the original tables. Updates use transactions and row locking. Original casino accounts and other .NET-specific tables remain untouched.

Without MySQL, the application uses `DATA_DIRECTORY/dashboard.json` and warns the owner that local deployment files may be replaced during redeployment. A local fallback is not a claim of durable Hostinger storage. A configured but unavailable MySQL database produces an actionable dashboard error; the app does **not** silently switch to an empty local database. `/service` and `/health` remain available.

Old `DATA_DIRECTORY/botConfig.json` cleaning settings are imported once and scoped to their actual Discord servers/channels. Slash commands and web forms update the same persistent settings.

## Included in This JavaScript Release

- Dark responsive management dashboard, server invite, server-specific settings, owner settings, separate service status.
- Discord OAuth, encrypted HttpOnly cookies, one-time verified owner setup, CSRF protection, server and action permission checks, role-hierarchy checks, escaped templates, formula-safe CSV exports, credential masking.
- Automatic blocked-word, link, invite, caps, mention, spam, and cross-channel image-flood filtering; ignored channels and threads; warnings and automatic timeouts.
- Member warnings, timeouts/mutes, timeout removal, kicks, bans, unbans, filtered purges, and case history.
- Configurable moderation, flagged-message, server-event, welcome, and level channels. Private dismissible DM notices do not post warnings in the chat channel.
- Business/Enterprise audit history, message content, search, CSV, 30-day retention. Server events are opt-in; Discord log delivery is capped at 10 messages per server per minute.
- Chat XP and voice XP. Voice XP needs **2+ human members** in the same voice channel; muted users qualify, deafened users and bots do not.
- Existing cleaning commands: `/current-interval`, `/add-bot`, `/remove-bot`, `/modify-interval`, `/configure`, `/set-log-channel`, `/add-monitor-channel`.
- Additional `/dashboard`, `/warn`, `/timeout`, `/kick`, `/ban`, `/purge`, `/rank`, `/leaderboard`. The bot's Playing activity shows `version 2.2.1`.

Enable **Server Members Intent** and **Message Content Intent** in Discord's Developer Portal, then enable privileged intents in Superadmin for content filtering and member welcome events. Saving a changed token or intent setting automatically reconnects the bot. The app preserves the existing basic-intent connection by default; it displays filter availability accurately.

## Connection Recovery and Log Checks

- Reconnects create a fresh Discord.js client, serialize overlapping requests, and ignore events from retired sessions. They never reuse a destroyed client. Normal transient gateway recovery remains managed by Discord.js.
- If Discord rejects privileged intents, the bot retries once with basic intents and reports **Online - limited**, rather than remaining offline. The dashboard, Superadmin, and `/service` show the required Portal settings and a link to the Developer Portal. Only the owner can use the CSRF-protected **Reconnect bot** control. The app cannot grant Portal privileges or channel permissions itself.
- Startup has a 45-second readiness deadline. Invalid tokens, unavailable settings storage, and connection timeouts have distinct instructions. `/api/status` reflects manual reconnects and subsequent disconnects, not just the initial startup result. No invalid-token retry loop is started.
- **Server > Audit logs > Log channel connection** checks the destination, current server membership, channel access, and send permissions. It fetches uncached channels within that server, checks any explicitly configured fallback channel, and never sends to another server. Missing Embed Links falls back to plain text with mentions disabled.
- Each log category has an explicit **Send test log** button. Page loads and checks do not post messages. Tests have a ten-second cooldown and share the existing ten-messages-per-minute delivery cap. Failed sends are visible in diagnostics; stored moderation cases and enabled audit history are retained.
- Business/Enterprise logs also capture native Discord bans, kicks, timeouts/mutes and AutoMod executions. Bot-issued audit events and repeated rule-action notifications are deduplicated. Server-settings noise remains excluded; server-event delivery stays opt-in.
- Enable **Channel changes** under **Server > Audit logs > Audit logging**, alongside **Send server events to Discord** and a **Server events** destination, to log channel creation/deletion and edits to names, topics, permissions, categories, slowmode, age restrictions and voice settings. Logs show before/after values. Only subsequent events are captured; previous edits are not backfilled.
- **Position-only channel and role updates are ignored.** Moving one channel recalculates neighbouring positions; those recalculations do not generate logs. Channel activity counters and last-message IDs are also ignored. Repeated packets are suppressed while genuine rename/revert sequences remain distinct. Event claims are stored atomically with history in MySQL, preventing duplicate workers from delivering the same claimed event. The ten-messages-per-minute delivery cap is safe against concurrent sends in each worker. Claims are made before sending; an ambiguous delivery failure is not automatically retried, avoiding double posts. Enabled history remains available for diagnosis.
- **Message edits** show author/channel, Before/After, IDs, timestamp, a private **Get User ID** button, and **Jump to Message**. Removed/replaced text is underlined in Before; added/replacement text is underlined in After. Unchanged text stays plain. Punctuation and whitespace changes are included; whitespace-only changes use visible `[space]`, `[tab]`, or `[newline]` markers. The dashboard uses the same underlined differences. Original text is preserved in history values, CSV and full-text attachments, without formatting markers. Missing cached content and privacy-redacted text are not diffed. **Message deletions & bulk deletes** show cached text or a single bulk summary, with channel context rather than a dead link to a deleted message. Discord cannot recover deleted text that the bot never cached; partial deletions are explicitly labelled unavailable. Content logging requires Message Content Intent, and disabling **Include message content** redacts both structured history and outgoing message text/attachments.
- **Voice changes** identify joins, switches and leaves, including the user avatar and channel mentions. **Role changes** is a separate opt-in toggle for role creation/deletion and name, color, permissions, hoist and mentionability edits. New categories remain off by default.
- A bot-issued **purge** creates one result containing the invoker, channel, count and selected filters. Its associated gateway deletion callbacks are suppressed rather than producing duplicate deletion logs. Native Discord bulk deletes produce one summary per batch, not one message per deletion.
- Each event is delivered in one Discord message. Long content is retained in structured history; when Embed Links and Attach Files permissions permit, the same message includes a full-text attachment for truncated previews. Without Embed Links, delivery falls back to plain text. The renderer observes Discord's [embed limits](https://docs.discord.com/developers/resources/message#embed-object-embed-limits). For older Node settings without `channelChanges`, the existing `serverChanges` preference is respected until the channel toggle is saved explicitly.

Discord-native moderation observation needs **View Audit Log** on the bot role. Native AutoMod event observation needs **Manage Server**, and full flagged text needs the **Message Content** intent. These requirements are shown in the log checks; permissions are not silently granted. See the official [Discord gateway event requirements](https://docs.discord.com/developers/events/gateway-events#auto-moderation-action-execution) and [privileged intent requirements](https://docs.discord.com/developers/events/gateway#privileged-intents).

This is a real Node port of the management/moderation/cleaning workflow, **not an embedded copy of the .NET server**. The .NET casino/poker/blackjack and music engine are **not ported in this release**, and are not advertised as working web controls. Their original source and database tables are preserved in `markdicks/DiscordBot`. Hostinger's managed Node process lifecycle also still applies: deployment/restart interrupts gateway connections and in-memory timers.

## Local Run and Verification

```text
npm ci
npm test
npm start
```

Open `http://localhost:3000/Dashboard` (unless `PORT` differs). Use a local `PUBLIC_URL` while testing Discord sign-in, and register its exact callback URL.

`npm test` exercises actual HTTP routes, templates/assets, OAuth state and public callback origin, owner setup, credential masking/encryption, CSRF, cross-server access, settings persistence, moderation invocation, logging limits, XP, and the real CommonJS-loaded production entry. Tests never log in to Discord or use production database credentials. MySQL requires a separate live connectivity check with your hosting environment.

For isolated visual QA only, `node tools/preview.mjs` starts synthetic server data on an ephemeral loopback port and prints a temporary owner link. It has no real Discord connection and is never loaded by the production entry.
