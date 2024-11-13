import fs from 'fs';
import path from 'path';
import discord from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

// Destructure the necessary objects from discord.js
const { Client, GatewayIntentBits, REST, Routes } = discord;

// Path to the configuration file and its folder
const configFolderPath = './database';
const configFilePath = path.join(configFolderPath, 'botConfig.json');

// Default configuration
const defaultConfig = { botList: [], allowedRoles: [], logChannelId: null, monitorChannels: []};

// Create necessary directories if they don't exist
const createDirectoriesIfNeeded = () => {
    if (!fs.existsSync(configFolderPath)) {
        fs.mkdirSync(configFolderPath);
        console.log(`Created directory: ${configFolderPath}`);
    }
};

// Load configuration from file, or return default if file is missing
const loadConfig = () => {
    try {
        // Ensure the file exists before trying to read it
        if (!fs.existsSync(configFilePath)) {
            console.log("Config file does not exist, using default config.");
            saveConfig(defaultConfig); // Save default config if file doesn't exist
            return defaultConfig;
        }

        const data = fs.readFileSync(configFilePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Error loading config, using default:", error);
        return defaultConfig;
    }
};

// Save configuration to file
const saveConfig = (config) => {
    try {
        // Make sure the directory exists
        createDirectoriesIfNeeded();
        fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf-8');
        console.log("Config saved successfully.");
    } catch (error) {
        console.error("Error saving config:", error);
    }
};

// Initialize config
let config = loadConfig();

// Default check interval in milliseconds (60 minutes)
let checkInterval = 3600000; // 1 hour in milliseconds
let lastTwoCheckResults = []; // Track last two check results (boolean for bot deletion)
let checkTimeout; // Declare the timeout variable globally

// Max interval of 12 weeks (in minutes)
const MAX_INTERVAL = 12 * 7 * 24 * 60 * 60 * 1000; // 12 weeks in milliseconds

// Register Slash Commands
async function registerCommands(client) {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log("Started refreshing application (/) commands.");

        // Define the bot-specific commands
        const commands = [
            {
                name: "current-interval",
                description: "Displays the current interval",
                options: []
            },
            {
                name: "add-bot",
                description: "Add a bot to the cleaning list",
                options: [
                    {
                        name: "bot",
                        type: 6, // USER type for @mention
                        description: "The bot to add (mention the bot)",
                        required: true
                    },
                    {
                        name: "rounds",
                        type: 4, // INTEGER type
                        description: "Number of rounds to monitor",
                        required: true
                    }
                ]
            },
            {
                name: "remove-bot",
                description: "Remove a bot from the cleaning list",
                options: [
                    {
                        name: "bot",
                        type: 6, // USER type for @mention
                        description: "The bot to remove (mention the bot)",
                        required: true
                    }
                ]
            },
            {
                name: "modify-interval",
                description: "Modify the time interval for bot message checks",
                options: [
                    {
                        name: "minutes",
                        type: 4, // INTEGER type
                        description: "Interval in minutes (minimum 1 minute, maximum 12 weeks)",
                        required: true
                    }
                ]
            },
            {
                name: "configure",
                description: "Configure roles allowed to manage bot cleaning",
                options: [
                    {
                        name: "role_id",
                        type: 8, // ROLE type
                        description: "ID of the role to allow",
                        required: true
                    }
                ]
            },
            {
                name: "set-log-channel",
                description: "Set a logging channel for bot activity and resets",
                options: [
                    {
                        name: "channel",
                        type: 7, // CHANNEL type
                        description: "The channel to log messages",
                        required: true
                    }
                ]
            },
            {
                name: "add-monitor-channel",
                description: "Add a channel to monitor for bot activity",
                options: [
                    {
                        name: "channel",
                        type: 7, // CHANNEL type
                        description: "The channel to monitor for bots",
                        required: true
                    }
                ]
            }
        ];

        // Register the commands globally
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("Successfully reloaded application (/) commands.");
    } catch (error) {
        console.error("Failed to reload commands:", error);
    }
}

// Command handler
const handleCommands = async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    try {
        if (commandName === 'current-interval') {
            await interaction.reply(`The current interval is set to ${checkInterval/60000} minutes`);
        }else if (commandName === 'add-bot') {
            const bot = options.getUser('bot');
            const rounds = options.getInteger('rounds');
            const botId = bot.id; // Extract the bot's ID from the mention
            config.botList.push({ botId, rounds });
            saveConfig(config);
            await interaction.reply(`Bot <@${botId}> added for ${rounds} cleaning rounds.`);
        } else if (commandName === 'remove-bot') {
            const bot = options.getUser('bot');
            const botId = bot.id; // Extract the bot's ID from the mention
            const index = config.botList.findIndex(b => b.botId === botId);

            if (index > -1) {
                config.botList.splice(index, 1);
                saveConfig(config);
                await interaction.reply(`Bot <@${botId}> removed.`);
            } else {
                await interaction.reply("Bot not found in the list.");
            }
        } else if (commandName === 'modify-interval') {
            let interval = options.getInteger('interval'); // Interval in minutes
        
            // Ensure the interval is within valid bounds (1 minute to 12 weeks)
            interval = Math.min(interval, 12 * 7 * 24 * 60); // Maximum 12 weeks (in minutes)
            interval = Math.max(interval, 1); // Minimum interval should be 1 minute
        
            checkInterval = interval * 60000; // Convert to milliseconds
        
            // Immediately update the interval by calling the checking function again
            clearTimeout(checkTimeout); // Clear the current timeout
            checkBotsAndResetInterval(); // Start the checking process again with the new interval
        
            await interaction.reply(`Check interval modified to ${interval} minutes.`);
        }
         else if (commandName === 'configure') {
            const roleId = options.getRole('role_id').id;
            config.allowedRoles.push(roleId);
            saveConfig(config);
            await interaction.reply(`Role <@&${roleId}> added to allowed roles for command use.`);
        }else if (commandName === 'set-log-channel') {
            const channel = options.getChannel('channel');
            config.logChannelId = channel.id;
            saveConfig(config);
            await interaction.reply(`Log channel set to <#${channel.id}>.`);
        }else if (commandName === 'add-monitor-channel') {
            const channel = options.getChannel('channel');
            // Add the channel to the list of monitored channels
            if (!config.monitorChannels.includes(channel.id)) {
                config.monitorChannels.push(channel.id);
                saveConfig(config);
                await interaction.reply(`Channel <#${channel.id}> is now being monitored for bot activity.`);
            } else {
                await interaction.reply("This channel is already being monitored.");
            }
        }
    } catch (error) {
        console.error("Error handling command:", error);
        await interaction.reply("An error occurred while processing the command.");
    }
};

// Set bot status and login
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity("with the other bots xD");

    // Register commands on bot startup
    await registerCommands(client);
});

// Logic for checking bots and resetting interval if necessary


const checkBotsAndResetInterval = async () => {
    let botDeleted = false; // Flag to track if any bot's messages were deleted
    let totalFetchedMessages = 0;

    // Loop through all the bots in the bot list and check their rounds
    for (let i = 0; i < config.botList.length; i++) {
        const bot = config.botList[i];

        // Skip bots with rounds of -1 as they are permanent
        if (bot.rounds === -1) {
            continue;
        }

        let botMessagesDeleted = false; // Track if messages were deleted for this bot

        // Get the current timestamp and calculate the timestamp for 12 hours ago
        const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000); // 12 hours ago in milliseconds

        // Check if this bot has any messages in the monitor channels
        for (const channelId of config.monitorChannels) {
            const channel = client.channels.cache.get(channelId);
            if (!channel) {
                console.error(`Channel with ID ${channelId} not found.`);
                continue;
            }

            try {
                let lastMessageId = null;
                

                // Fetch messages in batches, but only from the last 12 hours
                do {
                    try {
                        // Fetch a batch of messages
                        const fetchedMessages = await channel.messages.fetch({
                            limit: 100, // Fetch up to 100 messages at a time
                            before: lastMessageId, // Fetch messages before the last message ID from the previous batch
                        });

                        // Ensure that fetchedMessages is a valid collection before accessing size
                        if (!fetchedMessages || !(fetchedMessages instanceof Discord.Collection)) {
                            console.error(`Invalid messages fetched in channel ${channelId}`);
                            break; // Exit the loop if no valid messages are returned
                        }

                        // Filter messages that are older than 12 hours
                        const messages = fetchedMessages.filter(msg => msg.createdTimestamp >= twelveHoursAgo);

                        totalFetchedMessages += messages.size; // Track total messages fetched

                        // Delete the bot's messages
                        const botMessages = messages.filter(msg => msg.author.id === bot.botId);
                        for (const message of botMessages.values()) {
                            await message.delete();
                            console.log(`Deleted message from bot ${bot.botId} in channel ${channelId}`);
                            botMessagesDeleted = true; // Mark that a message has been deleted
                        }

                        // Update the last message ID for the next batch of messages
                        const lastMessage = fetchedMessages.last();
                        if (lastMessage) {
                            lastMessageId = lastMessage.id;
                        }

                    } catch (error) {
                        console.error(`Error fetching messages in channel ${channelId}:`, error);
                    }

                } while (totalFetchedMessages < 200 && fetchedMessages.size === 100); // Fetch messages in batches until 200 messages or less are fetched
            } catch (error) {
                console.error(`Error fetching messages in channel ${channelId}:`, error);
            }
        }

        // If the bot's message was deleted, subtract 1 from its rounds
        if (botMessagesDeleted) {
            bot.rounds -= 1;
            if (bot.rounds <= 0) {
                // Mark bot for removal later
                config.botList.splice(i, 1);
                saveConfig(config); // Save the updated config
                console.log(`Removed bot ${bot.botId} from the bot list.`);
            }
        }

        // Track if any bot messages were deleted in total
        if (botMessagesDeleted) {
            botDeleted = true;
        }
    }

    // Remove bots from the list after looping through all of them
    for (let i = config.botList.length - 1; i >= 0; i--) {
        const botIndex = i;
        const bot = config.botList[botIndex];
        if (bot.rounds <= 0) {
            config.botList.splice(botIndex, 1);
            console.log(`Removed bot ${bot.botId} from the bot list.`);
        }
    }

    // If no bot messages were deleted in the last two rounds, reset the interval to 60 minutes
    lastTwoCheckResults.push(botDeleted);
    if (lastTwoCheckResults.length > 2) lastTwoCheckResults.shift(); // Keep only the last two results

    // Reset interval if no bot messages were deleted for two rounds
    if (lastTwoCheckResults.length === 2 && lastTwoCheckResults.every(result => !result)) {
        checkInterval = 60 * 60000; // Reset to 60 minutes (1 hour)
        console.log("No commands recognized for a while, resetting timer to check every 1 hour.");

        // Send a message to the log channel to notify that the interval has been reset
        const logChannel = client.channels.cache.get(config.logChannelId); // Retrieve log channel from config
        if (logChannel) {
            logChannel.send("No commands recognized for a while, resetting timer to check every 1 hour.");
        } else {
            console.error("Log channel not found.");
        }
    }

    // Schedule the next check with the updated interval
    checkTimeout = setTimeout(checkBotsAndResetInterval, checkInterval);
};

// Initialize the checkBotsAndResetInterval function to start running
checkBotsAndResetInterval();





// Command handler event listener
client.on('interactionCreate', handleCommands);

// Error handling for login
client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log("Bot logged in successfully."))
    .catch((error) => {
        console.error("Failed to log in:", error);
        process.exit(1); // Exit the process if login fails
    });
