// .NET-style keys are commonly uppercased by Linux deployment dashboards.
export function environmentValue(env, name) {
    return env[name] ?? env[name.toUpperCase()];
}

export function environmentCredentials(env) {
    return {
        clientId: env.DISCORD_CLIENT_ID || environmentValue(env, 'Bot__DiscordClientId'),
        clientSecret: env.DISCORD_CLIENT_SECRET || environmentValue(env, 'Bot__DiscordClientSecret'),
        token: env.DISCORD_TOKEN || environmentValue(env, 'Bot__DiscordBotToken')
    };
}
