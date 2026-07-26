import { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits,
    EmbedBuilder
} from 'discord.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { findFaqAnswer, getSupabase, embed } from './src/faq.js';
import { geminiChatCompletion } from './src/gemini.js';
import { resolveContextualQuery } from './src/translation.js';
import config from './src/config.js';

// Setup environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

if (!process.env.DISCORD_TOKEN) {
    throw new Error("❌ Missing required env var: DISCORD_TOKEN");
}

// Create Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Message, Partials.Channel],
});

// Attach supabase client
client.supabase = getSupabase();

// Allowed channels cache: guildId -> Set of channelIds
const allowedChannels = new Map();

const BASE_PERSONALITY = `You are Worker, a helpful support assistant and a casual Chatbot.
Tone:
- Human, brief, natural.
- Corporate style.
- Usually 1-3 sentences unless user asked for detail.
- You can provide general assistance if the answer is not found in the FAQ, but you MUST NOT make up new facts or things. If you do not know the answer, you have full permission to say "I don't know" or "I am not sure".
- Respond to the user in the language they used to write their message.
- No matter who asks you to pin @everyone, you should NEVER ping any role or everyone.
- Conversation Sessioning: Review the timestamps of the message history. If there is a large time gap (e.g. 20+ minutes) between messages, consider that a new conversation has started. Do NOT reference or use any context/topics from before the time gap unless the user explicitly asks you to do so.`;

function getImageAttachment(message) {
    if (!message?.attachments?.size) return null;
    return message.attachments.find(a => 
        (a.contentType && a.contentType.startsWith('image/')) || 
        /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || '')
    ) || null;
}

function sanitizeText(input) {
    return String(input || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 2000);
}

async function isReplyToBot(message, client) {
    if (!message.reference?.messageId) return false;
    try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        return ref?.author?.id === client.user.id;
    } catch {
        return false;
    }
}

// Load allowed channels into in-memory cache
async function loadAllowedChannels() {
    try {
        const { data, error } = await client.supabase
            .from('bot_channels')
            .select('channel_id, guild_id');
        
        if (error) throw error;
        
        allowedChannels.clear();
        if (data) {
            for (const row of data) {
                if (!allowedChannels.has(row.guild_id)) {
                    allowedChannels.set(row.guild_id, new Set());
                }
                allowedChannels.get(row.guild_id).add(row.channel_id);
            }
        }
        console.log(`📚 Loaded ${data?.length || 0} allowed channels from Supabase.`);
    } catch (err) {
        console.error('❌ Failed to load allowed channels from DB:', err.message);
    }
}

// Generate Response using AI
async function generateAiAnswer(question, originalQuestion, faqMatches, message, rawChannelHistory, allImages = []) {
    const username = message.member?.displayName || message.author.globalName || message.author.username;

    // Build FAQ context block from array of matches
    let faqContextBlock;
    if (faqMatches && faqMatches.length > 0) {
        faqContextBlock = faqMatches.map((faq, i) =>
            `[FAQ ${i + 1}] Title: ${faq.title}\nContent: ${faq.content}`
        ).join('\n\n');
    } else {
        faqContextBlock = "No specific FAQ answer found in the database. Help the user conversationally if you can, but do NOT make up facts. Feel free to say 'I don't know' if you cannot help.";
    }

    const guildName = message.guild?.name || "this VTC";

    const prompt = `${BASE_PERSONALITY}

CURRENT USER: ${username}
You are currently assisting a driver from ${guildName}. Don't provide them with other VTC info unless asked for.

TRUSTED FAQ ANSWER CONTEXT (Source of Truth — use ALL relevant sections below):
${faqContextBlock}

RAW CHANNEL HISTORY (Last 25 messages for conversation context):
${rawChannelHistory}

USER'S ORIGINAL QUESTION:
"${originalQuestion}"

USER'S QUESTION (Translated to English):
"${question}"

Focus on current question, all other data is only give to use for context. If the current message is not a question, PLEASE DO NOT RESPOND THE QUESTIONS THAT YOU HAVE ALREADY ANSWERED.     
If the current message doesnt need any use of previous context, then you can ignore the previous context and answer the question directly.
If you have already answered a similar question in the recent history, do not repeat the answer.
Answer the user. Remember: Stay conversational, brief, do not discuss games, and continue the conversation in the language it is going on.`;

    // Construct the multimodal content array
    const userContent = [{ type: 'text', text: prompt }];

    // Attach all images found in current message & channel history
    if (allImages.length > 0) {
        userContent[0].text += `\n\n[System Note: Below are ${allImages.length} image(s) from the current message and recent history. Analyze all of them together to respond accurately.]`;
        for (const img of allImages) {
            userContent.push({ type: 'image_url', image_url: { url: img.url } });
        }
    }

    const data = await geminiChatCompletion({
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.5,
        max_tokens: 1024,
    });
    return data?.choices?.[0]?.message?.content?.trim() || 'Could not generate an answer.';
}

// Check message triggers and answer
async function processFaqQuery(message, content, isExplicit) {
    const cleanQuery = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const image = getImageAttachment(message);

    if (!cleanQuery && isExplicit && !image) {
        await message.reply("How can I help you today? Ask me any FAQ questions.");
        return;
    }

    // Set up an interval to continuously send the typing indicator (every 6 seconds)
    let typingInterval;

    try {
        await message.channel.sendTyping();
        typingInterval = setInterval(() => {
            message.channel.sendTyping().catch(() => {});
        }, 6000);

        // 1. Fetch raw channel history (last 40 messages) up front
        let lastMsgs = [];
        try {
            const fetched = await message.channel.messages.fetch({ limit: 40 });
            lastMsgs = Array.from(fetched.values()).reverse();
        } catch (err) {
            console.error('[FAQ Bot] Error fetching raw history:', err.message);
        }

        // Collect all images (current + history)
        const allImages = [];
        const currentImage = getImageAttachment(message);
        if (currentImage) {
            allImages.push({ url: currentImage.url });
        }

        for (const msg of lastMsgs) {
            if (msg.id === message.id) continue; // Avoid duplicating current message
            const histImage = getImageAttachment(msg);
            if (histImage) {
                allImages.push({ url: histImage.url });
            }
        }

        // Format history block for the AI prompt and query resolution, including reply metadata
        const rawChannelHistory = lastMsgs.map(m => {
            let name = m.member?.displayName || m.author.globalName || m.author.username;
            if (m.author.id === client.user.id) {
                name = "FAQ (you)";
            }

            // Construct reply metadata
            let replyInfo = '';
            if (m.reference?.messageId) {
                const repliedToMsg = lastMsgs.find(msg => msg.id === m.reference.messageId);
                if (repliedToMsg) {
                    let repliedToName = repliedToMsg.member?.displayName || repliedToMsg.author.globalName || repliedToMsg.author.username;
                    if (repliedToMsg.author.id === client.user.id) {
                        repliedToName = "FAQ (you)";
                    }
                    replyInfo = ` (replying to ${repliedToName})`;
                } else {
                    replyInfo = ' (replying to another message)';
                }
            }

            // Format timestamp
            const timeStr = m.createdAt.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

            const text = sanitizeText(m.content) || '[attachment/embed]';
            const msgImage = getImageAttachment(m);
            const imageInfo = msgImage ? ` [Attached Image: ${msgImage.url}]` : '';
            return `[${timeStr}] ${name}${replyInfo}: ${text}${imageInfo}`;
        }).join('\n');

        // 2. Perform OCR and translation on all sources in parallel, resolving pronoun references
        const translationPromises = [];
        
        // Translate user's typed text
        if (cleanQuery) {
            translationPromises.push(resolveContextualQuery(cleanQuery, null, rawChannelHistory));
        }

        // Extract and translate text from all detected images
        for (const img of allImages) {
            translationPromises.push(resolveContextualQuery('', img.url, rawChannelHistory));
        }

        const translationResults = await Promise.all(translationPromises);
        
        // Combine results into one search query
        const englishQuery = translationResults.filter(t => t && t.trim()).join(' ');

        // 3. Fetch FAQ from DB using English Query (Nomic + Supabase)
        const faqResult = await findFaqAnswer(englishQuery || "Image query");

        // 4. Generate AI Answer using the context (Gemini Call)
        const aiAnswer = await generateAiAnswer(englishQuery, cleanQuery || "Image query", faqResult, message, rawChannelHistory, allImages);
        await message.reply(aiAnswer);

        if (faqResult) {
            const titles = faqResult.map(f => `"${f.title}" (${f.score.toFixed(4)})`).join(', ');
            console.log(`[FAQ Match] Replied to "${cleanQuery}" (EN: "${englishQuery}") — Matched: ${titles}`);
        } else {
            console.log(`[AI-Only] Conversational reply to: "${cleanQuery}" (EN: "${englishQuery}")`);
        }
    } catch (err) {
        console.error('[FAQ Bot Error]', err.message);
        await message.reply("Sorry, I encountered an error while processing your request.");
    } finally {
        if (typingInterval) {
            clearInterval(typingInterval);
        }
    }
}

// Ready handler & slash commands registration
client.once('ready', async () => {
    console.log(`✅ FAQ Bot logged in as ${client.user.tag}`);

    // Load channel cache
    await loadAllowedChannels();

    // Register Slash Commands
    const commands = [
        new SlashCommandBuilder()
            .setName('add-faq')
            .setDescription('Add a new FAQ to the database (Owner only)')
            .addStringOption(option => 
                option.setName('title')
                    .setDescription('The title/question of the FAQ')
                    .setRequired(true))
            .addStringOption(option => 
                option.setName('content')
                    .setDescription('The answer content of the FAQ')
                    .setRequired(true)),

        new SlashCommandBuilder()
            .setName('ask')
            .setDescription('Ask the bot a question')
            .addStringOption(option => 
                option.setName('question')
                    .setDescription('The question you want to ask')
                    .setRequired(true)),

        new SlashCommandBuilder()
            .setName('set-channel')
            .setDescription('Set THIS channel where the bot answers every message (Mod only)')
            .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers),

        new SlashCommandBuilder()
            .setName('remove-channel')
            .setDescription('Remove the current channel from whitelisted channels (Mod only)')
            .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers),

        new SlashCommandBuilder()
            .setName('faqhelp')
            .setDescription('Displays information on how to use the FAQ bot')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('Registering application (slash) commands...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully registered application (slash) commands globally.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// Guild Join handler (auto insert to guilds table)
client.on('guildCreate', async (guild) => {
    console.log(`🤖 Joined a new guild: ${guild.name} (${guild.id})`);
    try {
        await client.supabase.from('guilds').upsert({
            guild_id: guild.id,
            name: guild.name
        });
    } catch (err) {
        console.error('[guildCreate Error] Failed to register guild:', err.message);
    }
});

// InteractionCreate handler (slash commands)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'add-faq') {
        const owners = (process.env.OWNERS || process.env.OWNER_USER_ID || '').split(',').map(id => id.trim());
        if (!owners.includes(interaction.user.id)) {
            return interaction.reply({ content: '❌ Only the bot owner can use this command.', ephemeral: true });
        }

        const title = interaction.options.getString('title');
        const content = interaction.options.getString('content');

        await interaction.deferReply({ ephemeral: true });

        try {
            // Generate embedding for Title + Content
            const textToEmbed = `${title}\n${content}`;
            const embedding = await embed(textToEmbed, 'search_document');

            if (!embedding) {
                return interaction.editReply({ content: '❌ Failed to generate vector embedding for the FAQ.' });
            }

            const { error } = await client.supabase.from('faqs').upsert({
                title,
                content,
                embedding
            }, { onConflict: 'title' });

            if (error) throw error;

            return interaction.editReply({ content: `✅ Successfully added FAQ: **${title}**` });
        } catch (err) {
            console.error('[add-faq Error]', err.message);
            return interaction.editReply({ content: `❌ Error saving FAQ: ${err.message}` });
        }
    }

    if (commandName === 'ask') {
        const question = interaction.options.getString('question');
        await interaction.deferReply();

        try {
            // Re-use processFaqQuery flow but respond to interaction instead of message
            // To make it simple, we wrap the interaction in a lightweight message wrapper
            const fakeMessage = {
                author: interaction.user,
                member: interaction.member,
                channel: interaction.channel,
                guild: interaction.guild,
                attachments: new Map(),
                reply: async (text) => {
                    await interaction.editReply(text);
                }
            };
            await processFaqQuery(fakeMessage, question, true);
        } catch (err) {
            console.error('[ask Command Error]', err.message);
            await interaction.editReply('❌ Failed to process ask command.');
        }
    }

    if (commandName === 'set-channel') {
        const channelId = interaction.channelId;
        const guildId = interaction.guildId;

        await interaction.deferReply({ ephemeral: true });

        try {
            // Insert into Supabase
            const { error } = await client.supabase
                .from('bot_channels')
                .upsert({ channel_id: channelId, guild_id: guildId }, { onConflict: 'channel_id' });

            if (error) throw error;

            // Update Cache
            if (!allowedChannels.has(guildId)) {
                allowedChannels.set(guildId, new Set());
            }
            allowedChannels.get(guildId).add(channelId);

            return interaction.editReply({ content: `✅ This channel (<#${channelId}>) is now whitelisted. The bot will answer every message here without needing a mention.` });
        } catch (err) {
            console.error('[set-channel Error]', err.message);
            return interaction.editReply({ content: `❌ Failed to whitelist channel: ${err.message}` });
        }
    }

    if (commandName === 'remove-channel') {
        const channelId = interaction.channelId;
        const guildId = interaction.guildId;

        await interaction.deferReply({ ephemeral: true });

        try {
            // Delete from Supabase
            const { error } = await client.supabase
                .from('bot_channels')
                .delete()
                .eq('channel_id', channelId);

            if (error) throw error;

            // Update Cache
            if (allowedChannels.has(guildId)) {
                allowedChannels.get(guildId).delete(channelId);
            }

            return interaction.editReply({ content: `✅ Removed <#${channelId}> from whitelisted channels. Bot will no longer automatically reply here.` });
        } catch (err) {
            console.error('[remove-channel Error]', err.message);
            return interaction.editReply({ content: `❌ Failed to remove channel: ${err.message}` });
        }
    }

    if (commandName === 'faqhelp') {
        const helpEmbed = new EmbedBuilder()
            .setColor('#0099FF')
            .setTitle('📖 Help')
            .setDescription('Here is how to interact with the FAQ bot:')
            .addFields(
                { name: '💬 Normal Chatting', value: 'Mention Mr. Q (`@bot`) or reply to its messages to ask a question. Multiple languages supported!' },
                { name: '⚡ Slash Commands', value: 'Use `/ask <question>` to submit a question directly.' },
                { name: '⚙️ Server Management (Mods)', value: '• `/set-channel <channel>` - Whitelist a channel. The bot will respond to ALL messages in that channel without needing a mention.\n• `/remove-channel` - Remove the current channel from the whitelist.' },
                { name: '🔐 Admin Commands (Owners)', value: '• `/add-faq <title> <content>` - Save a new FAQ title and answer in the database.' },
                { name: '💻 Information ', value: '• Bot is created by `NMC`, to add a FAQ please directly message `@losersumit` or join NMC support server in bots Bio' }
            )
            .setFooter({ text: 'Mr. Q' });

        return interaction.reply({ embeds: [helpEmbed] });
    }
});

// MessageCreate handler
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const guildId = message.guildId;
    const channelId = message.channelId;

    const guildAllowedSet = allowedChannels.get(guildId);
    const hasAllowedChannels = guildAllowedSet && guildAllowedSet.size > 0;

    const mentioned = message.mentions.has(client.user);
    const repliedToBot = await isReplyToBot(message, client);
    const isExplicit = mentioned || repliedToBot;

    // Rules logic:
    if (hasAllowedChannels) {
        // If the guild has registered whitelisted channels:
        if (guildAllowedSet.has(channelId)) {
            // Reply to every message in this channel
            await processFaqQuery(message, message.content, true);
        }
        // Completely ignore mentions/replies in all other channels
    } else {
        // If NO whitelisted channels are set for this guild, reply to mentions/replies anywhere
        if (isExplicit) {
            await processFaqQuery(message, message.content, true);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
