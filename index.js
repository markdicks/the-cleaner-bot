import fs from 'node:fs';
import dotenv from 'dotenv';
import { startRuntime } from './runtime.js';
import { AppStore } from './app/store.js';
import { BotController } from './app/bot.js';
import { createDashboard } from './app/web.js';

dotenv.config();
const version = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const store = new AppStore();
const bot = new BotController({ store, version });

// Hostinger requires a synchronous-loadable entry; initialization runs after HTTP starts.
let runtime;
const startup = startRuntime({
    client: bot,
    token: () => bot.getToken(),
    version,
    getStorageStatus: () => ({ provider: store.mode, status: store.status }),
    createHandler: getStatus => createDashboard({ store, bot, version, getStatus })
}).then(service => { runtime = service; }).catch(error => {
    console.error('HTTP startup failed:', error.code || error.name);
    process.exitCode = 1;
});

let shuttingDown = false;
const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await startup;
    if (runtime) await runtime.stop();
    await store.close();
};
process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
