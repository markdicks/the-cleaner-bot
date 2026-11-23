# The Cleaner (Node.js)

This repository is the original Discord message-cleaning bot. It is separate from the ASP.NET ModDesk moderation dashboard in `markdicks/DiscordBot`.

## Run

Use Node.js 22 or newer. Install dependencies with `npm ci`, then run `npm start`.

Set `DISCORD_TOKEN` in the hosting environment to the raw Discord **bot token**. The OAuth client ID, client secret, and MySQL password are not bot tokens. The bot reads this value from the environment; `database/botConfig.json` stores cleaning settings, not credentials.

The HTTP service listens on `PORT` (default `3000`) and `0.0.0.0`. It starts before Discord login and stays available if the token is missing or rejected. The root page displays service status; `/health` checks HTTP availability, `/ready` checks Discord readiness, and `/api/status` returns status without credentials. This status page is not the separate ModDesk dashboard.

## Hostinger Deployment

- Repository: `markdicks/the-cleaner-bot`, branch `main`.
- Entry file: `index.js`.
- Start command, if requested: `npm start` (plain Node; no PM2 or cluster mode).
- Set the runtime environment variable `DISCORD_TOKEN`, then redeploy/restart after changing it.
- Use `/health` for an HTTP health check. An offline bot should not cause a process restart loop.

If the page reports a rejected token, replace the Hostinger `DISCORD_TOKEN` value with the current bot token from the Discord Developer Portal and restart the app. The application does not retry invalid credentials continuously.

Cleaning configuration is stored in `DATA_DIRECTORY` (default `./database`). Use persistent storage if your host supports it; files inside a deployment version directory may be replaced during redeployment. A Discord bot also needs a host that supports a persistent outbound Discord connection and background work; check the limits of the selected hosting plan.

Run the HTTP/startup regression checks with `npm test`. They do not contact Discord.
