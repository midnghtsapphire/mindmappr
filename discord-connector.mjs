// ══════════════════════════════════════════════════════════════════════════════
// ── Discord Connector for MindMappr ─────────────────────────────────────────
// ── All agents accessible via Discord (Rex, Watcher, Scheduler, etc.) ───────
// ══════════════════════════════════════════════════════════════════════════════
import { Client, GatewayIntentBits, Partials, EmbedBuilder, ChannelType } from "discord.js";

let discordClient = null;
let invokeAgentFn = null;
let getAllAgentDefsFn = null;
let logActivityFn = null;
let getConnectionTokenFn = null;

// Agent mention patterns: @Rex, @Watcher, etc.
const AGENT_ALIASES = {
  rex: ["rex", "brain"],
  watcher: ["watcher", "monitor"],
  scheduler: ["scheduler", "cron"],
  processor: ["processor", "process"],
  generator: ["generator", "gen", "writer"],
  telegram: ["mindmappr", "bot", "mm"],
  lex: ["lex", "attorney", "lawyer", "legal"],
};

/**
 * Parse Discord message for @agent mentions
 */
function parseDiscordAgentMention(content) {
  const lower = content.toLowerCase().trim();

  // Check for @AgentName pattern
  const mentionMatch = lower.match(/^@(\w+)\s*/);
  if (mentionMatch) {
    const name = mentionMatch[1];
    for (const [agentId, aliases] of Object.entries(AGENT_ALIASES)) {
      if (aliases.includes(name)) {
        return { agentName: agentId, cleanMessage: content.slice(mentionMatch[0].length).trim() };
      }
    }
  }

  // Check for agent name at start of message
  for (const [agentId, aliases] of Object.entries(AGENT_ALIASES)) {
    for (const alias of aliases) {
      if (lower.startsWith(alias + " ") || lower.startsWith(alias + ",") || lower.startsWith(alias + ":")) {
        return { agentName: agentId, cleanMessage: content.slice(alias.length + 1).trim() };
      }
    }
  }

  // Default to Rex for general messages
  return { agentName: "rex", cleanMessage: content };
}

/**
 * Format agent response for Discord (max 2000 chars, markdown-safe)
 */
function formatForDiscord(text, agentName, agentIcon) {
  // Discord has a 2000 char limit
  const prefix = `${agentIcon} **${agentName}**\n`;
  const maxLen = 2000 - prefix.length - 10;

  let formatted = text;
  if (formatted.length > maxLen) {
    formatted = formatted.slice(0, maxLen - 3) + "...";
  }

  return `${prefix}${formatted}`;
}

/**
 * Split long messages for Discord (2000 char limit)
 */
function splitMessage(text, maxLen = 1900) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen / 2) splitIdx = maxLen;
    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trim();
  }
  return parts;
}

/**
 * Initialize Discord bot client
 */
export function initDiscord({ invokeAgent, getAllAgentDefinitions, logActivity, getConnectionToken }) {
  invokeAgentFn = invokeAgent;
  getAllAgentDefsFn = getAllAgentDefinitions;
  logActivityFn = logActivity;
  getConnectionTokenFn = getConnectionToken;
}

/**
 * Start the Discord bot with the given token
 */
export async function startDiscordBot(token) {
  if (!token) {
    console.log("[Discord] No bot token provided — skipping Discord setup");
    return null;
  }

  // Destroy existing client if reconnecting
  if (discordClient) {
    try { discordClient.destroy(); } catch {}
    discordClient = null;
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  discordClient.on("ready", () => {
    console.log(`[Discord] Bot logged in as ${discordClient.user.tag}`);
    console.log(`[Discord] Serving ${discordClient.guilds.cache.size} server(s)`);
    if (logActivityFn) {
      logActivityFn("rex", "Rex", "discord_connect", `Discord bot online as ${discordClient.user.tag}`);
    }
  });

  discordClient.on("messageCreate", async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Check if bot is mentioned or message is in DM
    const isMentioned = message.mentions.has(discordClient.user);
    const isDM = !message.guild;
    const startsWithPrefix = message.content.startsWith("!mm ") || message.content.startsWith("!rex ");

    if (!isMentioned && !isDM && !startsWithPrefix) return;

    // Clean the message content
    let content = message.content;
    // Remove bot mention
    content = content.replace(/<@!?\d+>/g, "").trim();
    // Remove prefix
    if (content.startsWith("!mm ")) content = content.slice(4).trim();
    if (content.startsWith("!rex ")) content = content.slice(5).trim();

    if (!content) {
      const allDefs = getAllAgentDefsFn ? getAllAgentDefsFn() : {};
      const agentList = Object.entries(allDefs)
        .map(([id, def]) => `${def.icon} **${def.name}** — ${def.role}`)
        .join("\n");
      await message.reply(`Hey! I'm MindMappr. Here are the agents you can talk to:\n\n${agentList}\n\nJust mention me and say \`@Rex check status\` or \`@Generator write a blog post\`.`);
      return;
    }

    // Parse which agent to route to
    const { agentName, cleanMessage } = parseDiscordAgentMention(content);

    // Show typing indicator
    try { await message.channel.sendTyping(); } catch {}

    const sessionId = `discord-${message.guild?.id || "dm"}-${message.channel.id}`;

    try {
      if (logActivityFn) {
        logActivityFn(agentName, agentName, "discord_message", `From ${message.author.username}: ${cleanMessage.slice(0, 80)}...`);
      }

      const result = await invokeAgentFn(agentName, cleanMessage, sessionId);
      const allDefs = getAllAgentDefsFn ? getAllAgentDefsFn() : {};
      const agentDef = allDefs[agentName] || { name: agentName, icon: "🤖" };

      const responseText = formatForDiscord(result.text, agentDef.name, agentDef.icon);
      const parts = splitMessage(responseText);

      for (const part of parts) {
        await message.reply(part);
      }

      if (logActivityFn) {
        logActivityFn(agentName, agentDef.name, "discord_reply", `Replied to ${message.author.username} (${result.text.length} chars)`);
      }
    } catch (err) {
      console.error("[Discord] Message handling error:", err.message);
      await message.reply(`Something went wrong while processing your request. Error: ${err.message.slice(0, 200)}`);
    }
  });

  // Handle slash command for agent help
  discordClient.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "agents") {
      const allDefs = getAllAgentDefsFn ? getAllAgentDefsFn() : {};
      const embed = new EmbedBuilder()
        .setTitle("MindMappr Agents")
        .setColor(0x6c5ce7)
        .setDescription("Available agents you can interact with:")
        .setTimestamp();

      for (const [id, def] of Object.entries(allDefs)) {
        embed.addFields({ name: `${def.icon} ${def.name}`, value: def.role || def.description, inline: true });
      }

      await interaction.reply({ embeds: [embed] });
    }
  });

  discordClient.on("error", (err) => {
    console.error("[Discord] Client error:", err.message);
  });

  try {
    await discordClient.login(token);
    return discordClient;
  } catch (err) {
    console.error("[Discord] Login failed:", err.message);
    discordClient = null;
    return null;
  }
}

/**
 * Send a notification message to a Discord channel
 */
export async function sendDiscordNotification(channelId, message, options = {}) {
  if (!discordClient || !discordClient.isReady()) {
    console.warn("[Discord] Cannot send notification — bot not connected");
    return false;
  }

  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel) {
      console.error(`[Discord] Channel ${channelId} not found`);
      return false;
    }

    if (options.embed) {
      const embed = new EmbedBuilder()
        .setTitle(options.title || "MindMappr Notification")
        .setDescription(message)
        .setColor(options.color || 0x6c5ce7)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    } else {
      const parts = splitMessage(message);
      for (const part of parts) {
        await channel.send(part);
      }
    }
    return true;
  } catch (err) {
    console.error("[Discord] Send notification error:", err.message);
    return false;
  }
}

/**
 * Get Discord bot status
 */
export function getDiscordStatus() {
  if (!discordClient) return { connected: false, tag: null, guilds: 0 };
  return {
    connected: discordClient.isReady(),
    tag: discordClient.user?.tag || null,
    guilds: discordClient.guilds?.cache?.size || 0,
    channels: discordClient.channels?.cache?.size || 0,
  };
}

/**
 * Disconnect Discord bot
 */
export function disconnectDiscord() {
  if (discordClient) {
    try { discordClient.destroy(); } catch {}
    discordClient = null;
    console.log("[Discord] Bot disconnected");
  }
}

/**
 * Get the live Discord client instance (for channel/role management tools)
 */
export function getDiscordClient() {
  return discordClient;
}

export default {
  initDiscord,
  startDiscordBot,
  sendDiscordNotification,
  getDiscordStatus,
  disconnectDiscord,
  getDiscordClient,
};
