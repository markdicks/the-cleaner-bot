# The Cleaner: Hostinger JavaScript Application

This repository now contains the **Node.js management application and Discord bot**, not just the old service-status page. It runs directly on Hostinger's managed Node.js hosting; it does not require .NET, Docker, Render, PM2, a second web service, or a build step.

## Deploy

- Repository: `markdicks/the-cleaner-bot`, branch `main`.
- Framework: **Other**. Node.js: **22 or newer**.
- Entry file: **index.js**. Build command: **none**. Start command if requested: **npm start**.
- Keep the existing `DISCORD_TOKEN` environment variable. No token belongs in source control.
- Set `PUBLIC_URL=https://thecleanerbot.space` (or your actual HTTPS origin).
- Redeploy the latest commit. `/api/status` reports application version **2.1.1**, storage provider/status, and bot connection status. Credentials are never included.

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
- Additional `/dashboard`, `/warn`, `/timeout`, `/kick`, `/ban`, `/purge`, `/rank`, `/leaderboard`. The bot's Playing activity shows `version 2.1.1`.

Enable **Server Members Intent** and **Message Content Intent** in Discord's Developer Portal, then enable privileged intents and reconnect in Superadmin for content filtering and member welcome events. The app preserves the existing basic-intent connection by default; it displays filter availability accurately.

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
