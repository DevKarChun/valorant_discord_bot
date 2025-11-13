import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN || "";
const DATA_PATH = process.env.DATA_PATH || path.join(process.cwd(), "accounts.json");
const RIOT_API_KEY = process.env.RIOT_API_KEY || "";

// Rate limit settings (buffered)
const PER_SEC_LIMIT = 19;      // buffer: 20 -> 19
const PER_2MIN_LIMIT = 95;     // buffer: 100 -> 95
const WINDOW_1S_MS = 1000;
const WINDOW_2MIN_MS = 120000;

// Simple in-memory cache for ranks and account details
const CACHE_TTL_MS = 5 * 60 * 1000;
const rankCache = new Map();
const accountCache = new Map();
const matchesCache = new Map();

// Game mode filters
const GAME_MODES = {
  competitive: "competitive",
  unrated: "unrated",
  premier: "premier",
  deathmatch: "deathmatch",
  spike: "spike",
  escalation: "escalation",
  replication: "replication",
  snowball: "snowball",
  all: null // null means no filter
};

// --- persistent storage helpers ---
function loadAccounts() {
  try {
    if (!fs.existsSync(DATA_PATH)) {
      fs.writeFileSync(DATA_PATH, JSON.stringify({ accounts: [] }, null, 2));
    }
    const raw = fs.readFileSync(DATA_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch (e) {
    console.error("Failed to load accounts:", e);
    return [];
  }
}

function saveAccounts(accounts) {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify({ accounts }, null, 2));
  } catch (e) {
    console.error("Failed to save accounts:", e);
  }
}

// --- utils ---
function normalizeKey(name, tag) {
  return `${name.trim().toLowerCase()}#${tag.trim().toLowerCase()}`;
}

function parseRiotId(token) {
  const idx = token.indexOf("#");
  if (idx === -1) return null;
  const name = token.slice(0, idx).trim();
  const tag = token.slice(idx + 1).trim();
  if (!name || !tag) return null;
  return { name, tag };
}

function validateRegion(region) {
  return ["ap", "na", "eu", "kr", "latam", "br"].includes(region.toLowerCase());
}

function validateTag(tag) {
  return /^[0-9A-Za-z]{3,5}$/.test(tag);
}

function parseEditArgs(args) {
  const changes = {};
  for (const a of args) {
    const [k, ...rest] = a.split("=");
    const v = rest.join("=");
    if (!v) continue;
    if (k === "tag") changes.tag = v.startsWith("#") ? v.slice(1) : v;
    else if (["region", "name"].includes(k)) changes[k] = v;
  }
  return changes;
}

// --- Rate limiter (sliding windows + queue) ---
class RateLimiter {
  constructor() {
    this.timestamps = []; // list of ms timestamps for past requests
    this.queue = []; // queued request resolvers
    this.processing = false;
  }

  // record a request now (called when actually sending)
  _recordNow() {
    const now = Date.now();
    this.timestamps.push(now);
    // clean old timestamps beyond 2min window
    const cutoff = now - WINDOW_2MIN_MS;
    while (this.timestamps.length && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }

  // counts in last 1s and 2min
  _counts() {
    const now = Date.now();
    const cutoff1 = now - WINDOW_1S_MS;
    const cutoff2 = now - WINDOW_2MIN_MS;
    let c1 = 0, c2 = 0;
    for (let i = this.timestamps.length - 1; i >= 0; i--) {
      const t = this.timestamps[i];
      if (t >= cutoff1) c1++;
      if (t >= cutoff2) c2++;
      if (t < cutoff2) break;
    }
    return { c1, c2 };
  }

  // returns true if a request can be sent now
  canSendNow() {
    const { c1, c2 } = this._counts();
    return c1 < PER_SEC_LIMIT && c2 < PER_2MIN_LIMIT;
  }

  // schedule a request: returns a Promise that resolves when allowed; the caller should perform request then call done()
  async schedule() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._processQueue();
    });
  }

  // internal: process the queue as capacity allows
  async _processQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        if (this.canSendNow()) {
          // consume one slot and resolve one queued requester
          this._recordNow();
          const resolve = this.queue.shift();
          // resolve with a function that the caller will use to proceed
          resolve();
          // tight loop: continue to check if more can be sent immediately
          continue;
        }
        // not allowed now: compute minimal wait time
        const now = Date.now();
        // when will 1s window free up?
        let waitUntil1 = Infinity;
        for (let i = 0; i < this.timestamps.length; i++) {
          if (this.timestamps[i] >= now - WINDOW_1S_MS) {
            waitUntil1 = Math.min(waitUntil1, this.timestamps[i] + WINDOW_1S_MS);
            break;
          }
        }
        // when will 2min window free up?
        let waitUntil2 = Infinity;
        for (let i = 0; i < this.timestamps.length; i++) {
          if (this.timestamps[i] >= now - WINDOW_2MIN_MS) {
            waitUntil2 = Math.min(waitUntil2, this.timestamps[i] + WINDOW_2MIN_MS);
            break;
          }
        }
        // pick the earliest time when either capacity may free; if no timestamps present, small sleep
        const waitUntil = Math.min(waitUntil1, waitUntil2, now + 200); // fallback 200ms
        const delay = Math.max(1, waitUntil - now);
        await new Promise(r => setTimeout(r, delay));
      }
    } finally {
      this.processing = false;
    }
  }
}

const globalRateLimiter = new RateLimiter();

// Helper to perform an axios.get under rate limiting
async function rateLimitedGet(url, config = {}) {
  // Wait until the rate limiter allows the request
  await globalRateLimiter.schedule();
  // perform the request
  return axios.get(url, config);
}

// Build axios config including Riot API key header when available
function axiosConfig(timeout = 15000) {
  const cfg = { timeout };
  if (RIOT_API_KEY) {
    cfg.headers = { "X-Riot-Token": RIOT_API_KEY };
  }
  return cfg;
}

// Fetch rank (prefers cache). Uses rateLimitedGet for all external calls.
async function fetchRank(acc) {
  const key = normalizeKey(acc.name, acc.tag);
  const cached = rankCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.data;
  }

  const henrikUrl = `https://api.henrikdev.xyz/valorant/v1/mmr/${acc.region}/${encodeURIComponent(acc.name)}/${encodeURIComponent(acc.tag)}`;

  try {
    const res = await rateLimitedGet(henrikUrl, axiosConfig());
    const info = res.data?.data;
    const result = {
      tier: info?.currenttierpatched ?? "Unknown",
      rr: info?.ranking_in_tier ?? "N/A"
    };
    rankCache.set(key, { fetchedAt: Date.now(), data: result });
    return result;
  } catch (e) {
    // fallback attempt if RIOT_API_KEY present: try the same henrik endpoint again (best-effort)
    if (RIOT_API_KEY) {
      try {
        const res2 = await rateLimitedGet(henrikUrl, axiosConfig());
        const info2 = res2.data?.data;
        const result2 = {
          tier: info2?.currenttierpatched ?? "Unknown",
          rr: info2?.ranking_in_tier ?? "N/A"
        };
        rankCache.set(key, { fetchedAt: Date.now(), data: result2 });
        return result2;
      } catch (e2) {
        console.warn("Rank fetch failed for", key, e2?.message ?? e2);
        throw new Error("Failed to fetch rank");
      }
    }
    console.warn("Rank fetch failed for", key, e?.message ?? e);
    throw new Error("Failed to fetch rank");
  }
}

// Fetch full account details including level, rank, and other stats
async function fetchAccountDetails(acc) {
  const key = normalizeKey(acc.name, acc.tag);
  const cached = accountCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    // Fetch account info with longer timeout for account details
    const accountUrl = `https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(acc.name)}/${encodeURIComponent(acc.tag)}`;
    const accountRes = await rateLimitedGet(accountUrl, axiosConfig(15000));
    const accountData = accountRes.data?.data;
    
    // Check for API errors
    if (accountRes.data?.status === 401 || accountRes.data?.status === 404) {
      throw new Error(`API returned ${accountRes.data.status}: ${accountRes.data.message || 'Unauthorized or account not found'}`);
    }

    // Fetch rank info
    let rankData = null;
    try {
      rankData = await fetchRank(acc);
    } catch (e) {
      // Rank fetch failed, but continue with account data
      console.warn("Rank fetch failed in account details:", e?.message);
    }

    // Try to fetch additional stats if available
    let additionalStats = null;
    try {
      // Try to get match history for wins count (with shorter timeout since it's optional)
      const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/matches/${acc.region}/${encodeURIComponent(acc.name)}/${encodeURIComponent(acc.tag)}?filter=competitive`;
      const matchesRes = await rateLimitedGet(matchesUrl, axiosConfig(10000));
      const matchesData = matchesRes.data?.data;
      
      // Check for API errors
      if (matchesRes.data?.status === 401 || matchesRes.data?.status === 404) {
        // Silently skip match stats if unauthorized
        throw new Error("Unauthorized or not found");
      }
      if (matchesData && Array.isArray(matchesData)) {
        const wins = matchesData.filter(m => m.teams?.red?.has_won || m.teams?.blue?.has_won).length;
        additionalStats = {
          recentMatches: matchesData.length,
          recentWins: wins
        };
      }
    } catch (e) {
      // Additional stats are optional
    }

    const result = {
      accountLevel: accountData?.account_level ?? "N/A",
      rank: rankData?.tier ?? "Unknown",
      rr: rankData?.rr ?? "N/A",
      puuid: accountData?.puuid ?? null,
      region: accountData?.region ?? acc.region,
      card: accountData?.card?.small ?? null,
      lastUpdate: accountData?.last_update ?? null,
      additionalStats: additionalStats
    };

    accountCache.set(key, { fetchedAt: Date.now(), data: result });
    return result;
  } catch (e) {
    const errorMsg = e?.message ?? String(e);
    console.warn(`Account details fetch failed for ${key}:`, errorMsg);
    
    // Try to get at least rank info even if account details fail
    let rankData = null;
    try {
      rankData = await fetchRank(acc);
    } catch (rankErr) {
      // Rank fetch also failed
    }
    
    // Return minimal data on error with better error info
    return {
      accountLevel: "N/A",
      rank: rankData?.tier ?? "Unknown",
      rr: rankData?.rr ?? "N/A",
      puuid: null,
      region: acc.region,
      card: null,
      lastUpdate: null,
      additionalStats: null,
      error: true,
      errorMessage: errorMsg.includes("401") ? "Unauthorized - Enable third-party trackers (use !va tracker)" : 
                    errorMsg.includes("timeout") ? "Request timeout - API may be slow" :
                    errorMsg.includes("404") ? "Account not found" : "Failed to fetch - Check !va tracker"
    };
  }
}

// Fetch matches for a specific game mode
async function fetchMatches(acc, gameMode = null, limit = 10) {
  const key = `${normalizeKey(acc.name, acc.tag)}_${gameMode || 'all'}_${limit}`;
  const cached = matchesCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    let matchesUrl = `https://api.henrikdev.xyz/valorant/v3/matches/${acc.region}/${encodeURIComponent(acc.name)}/${encodeURIComponent(acc.tag)}`;
    if (gameMode && gameMode !== 'all') {
      matchesUrl += `?filter=${gameMode}`;
    }
    
    const matchesRes = await rateLimitedGet(matchesUrl, axiosConfig(15000));
    const matchesData = matchesRes.data?.data;
    
    if (matchesRes.data?.status === 401 || matchesRes.data?.status === 404) {
      throw new Error(`API returned ${matchesRes.data.status}`);
    }
    
    if (!Array.isArray(matchesData)) {
      return { matches: [], stats: null };
    }

    // Filter by game mode if needed and limit results
    let filteredMatches = matchesData;
    if (gameMode && gameMode !== 'all') {
      filteredMatches = matchesData.filter(m => {
        const mode = m.metadata?.mode?.toLowerCase();
        return mode === gameMode || mode?.includes(gameMode);
      });
    }
    
    filteredMatches = filteredMatches.slice(0, limit);
    
    // Calculate statistics
    const stats = calculateMatchStats(filteredMatches, gameMode);
    
    const result = {
      matches: filteredMatches,
      stats: stats,
      total: matchesData.length
    };
    
    matchesCache.set(key, { fetchedAt: Date.now(), data: result });
    return result;
  } catch (e) {
    console.warn(`Matches fetch failed for ${normalizeKey(acc.name, acc.tag)} (${gameMode}):`, e?.message);
    throw e;
  }
}

// Calculate statistics from matches
function calculateMatchStats(matches, gameMode = null) {
  if (!matches || matches.length === 0) {
    return null;
  }

  let wins = 0;
  let losses = 0;
  let totalKills = 0;
  let totalDeaths = 0;
  let totalAssists = 0;
  let totalScore = 0;
  let totalRoundsWon = 0;
  let totalRoundsLost = 0;
  const agents = {};
  const maps = {};

  for (const match of matches) {
    const player = match.players?.all_players?.find(p => 
      p.name?.toLowerCase() === match.metadata?.name?.toLowerCase() ||
      p.puuid === match.metadata?.puuid
    ) || match.players?.all_players?.[0];

    if (!player) continue;

    // Win/Loss
    const playerTeam = player.team?.toLowerCase();
    const redWon = match.teams?.red?.has_won;
    const blueWon = match.teams?.blue?.has_won;
    
    if (playerTeam === 'red' && redWon) wins++;
    else if (playerTeam === 'blue' && blueWon) wins++;
    else losses++;

    // Stats
    totalKills += player.stats?.kills || 0;
    totalDeaths += player.stats?.deaths || 0;
    totalAssists += player.stats?.assists || 0;
    totalScore += player.stats?.score || 0;

    // Rounds
    if (playerTeam === 'red') {
      totalRoundsWon += match.teams?.red?.rounds_won || 0;
      totalRoundsLost += match.teams?.red?.rounds_lost || 0;
    } else {
      totalRoundsWon += match.teams?.blue?.rounds_won || 0;
      totalRoundsLost += match.teams?.blue?.rounds_lost || 0;
    }

    // Agent usage
    const agent = player.character;
    if (agent) {
      agents[agent] = (agents[agent] || 0) + 1;
    }

    // Map usage
    const map = match.metadata?.map;
    if (map) {
      maps[map] = (maps[map] || 0) + 1;
    }
  }

  const totalMatches = wins + losses;
  const winRate = totalMatches > 0 ? ((wins / totalMatches) * 100).toFixed(1) : 0;
  const kd = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : totalKills.toFixed(2);
  const avgKills = (totalKills / totalMatches).toFixed(1);
  const avgDeaths = (totalDeaths / totalMatches).toFixed(1);
  const avgAssists = (totalAssists / totalMatches).toFixed(1);
  const avgScore = (totalScore / totalMatches).toFixed(0);

  // Most played agent
  const mostPlayedAgent = Object.entries(agents).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";
  const mostPlayedMap = Object.entries(maps).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

  return {
    totalMatches,
    wins,
    losses,
    winRate: `${winRate}%`,
    kd,
    avgKills,
    avgDeaths,
    avgAssists,
    avgScore,
    totalKills,
    totalDeaths,
    totalAssists,
    totalRoundsWon,
    totalRoundsLost,
    mostPlayedAgent,
    mostPlayedMap,
    agents,
    maps
  };
}

// Format match for display
function formatMatch(match, playerName) {
  const player = match.players?.all_players?.find(p => 
    p.name?.toLowerCase() === playerName?.toLowerCase() ||
    p.puuid === match.metadata?.puuid
  ) || match.players?.all_players?.[0];

  if (!player) return null;

  const playerTeam = player.team?.toLowerCase();
  const redWon = match.teams?.red?.has_won;
  const blueWon = match.teams?.blue?.has_won;
  const won = (playerTeam === 'red' && redWon) || (playerTeam === 'blue' && blueWon);
  const result = won ? "✅ Win" : "❌ Loss";
  
  const score = playerTeam === 'red' 
    ? `${match.teams?.red?.rounds_won || 0}-${match.teams?.blue?.rounds_won || 0}`
    : `${match.teams?.blue?.rounds_won || 0}-${match.teams?.red?.rounds_won || 0}`;

  const mode = match.metadata?.mode || "Unknown";
  const map = match.metadata?.map || "Unknown";
  const agent = player.character || "Unknown";
  const kda = `${player.stats?.kills || 0}/${player.stats?.deaths || 0}/${player.stats?.assists || 0}`;
  const combatScore = player.stats?.score || 0;

  // Format date
  const matchDate = match.metadata?.game_start_patched 
    ? new Date(match.metadata.game_start_patched).toLocaleDateString()
    : "Unknown";

  return {
    result,
    mode,
    map,
    agent,
    kda,
    score,
    combatScore,
    date: matchDate
  };
}

// --- bot setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  // Enable automatic reconnection
  rest: {
    timeout: 30000, // 30 second timeout
    retries: 3,
  },
  ws: {
    // Keep connection alive
    large_threshold: 250,
    compress: true,
  },
});

// Connection state tracking
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = Infinity; // Keep trying forever
let heartbeatInterval = null;
let healthCheckInterval = null;

// Use clientReady to avoid deprecation warning (works in v14+, required in v15+)
client.once("clientReady", () => {
  isConnected = true;
  reconnectAttempts = 0;
  console.log(`✓ Logged in as ${client.user.username}`);
  console.log(`✓ Bot is online and ready to receive commands!`);
  console.log(`✓ Use !va help in Discord to see available commands`);
  
  // Start heartbeat to keep connection alive
  startHeartbeat();
  
  // Start health check
  startHealthCheck();
});

// Handle connection errors
client.on("error", (error) => {
  console.error(`[${new Date().toISOString()}] Discord client error:`, error.message);
  // Don't exit, let reconnection handle it
});

client.on("disconnect", (event) => {
  isConnected = false;
  console.warn(`[${new Date().toISOString()}] Bot disconnected from Discord. Code: ${event.code}, Reason: ${event.reason || 'Unknown'}`);
  console.warn("Automatic reconnection will be attempted...");
  
  // Stop heartbeat when disconnected
  stopHeartbeat();
  stopHealthCheck();
});

client.on("reconnecting", () => {
  reconnectAttempts++;
  console.log(`[${new Date().toISOString()}] Reconnecting to Discord... (Attempt ${reconnectAttempts})`);
});

client.on("resume", () => {
  isConnected = true;
  reconnectAttempts = 0;
  console.log(`[${new Date().toISOString()}] Connection resumed successfully`);
  startHeartbeat();
  startHealthCheck();
});

client.on("shardDisconnect", (event, id) => {
  console.warn(`[${new Date().toISOString()}] Shard ${id} disconnected. Code: ${event.code}`);
});

client.on("shardReconnecting", (id) => {
  console.log(`[${new Date().toISOString()}] Shard ${id} reconnecting...`);
});

client.on("shardResume", (id) => {
  console.log(`[${new Date().toISOString()}] Shard ${id} resumed`);
});

// Connection monitoring (Discord.js handles heartbeats automatically)
function startHeartbeat() {
  stopHeartbeat(); // Clear any existing interval
  
  heartbeatInterval = setInterval(() => {
    if (client.isReady()) {
      // Just log status - Discord.js handles heartbeats automatically
      const ping = client.ws.ping;
      console.log(`[${new Date().toISOString()}] Connection active | Ping: ${ping}ms | Guilds: ${client.guilds.cache.size}`);
    } else {
      console.warn(`[${new Date().toISOString()}] Connection check: Client not ready`);
    }
  }, 60000); // Every 60 seconds
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// Health check to monitor connection status
function startHealthCheck() {
  stopHealthCheck(); // Clear any existing interval
  
  healthCheckInterval = setInterval(() => {
    const status = {
      ready: client.isReady(),
      uptime: process.uptime(),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      reconnectAttempts: reconnectAttempts
    };
    
    if (!status.ready && isConnected) {
      console.warn(`[${new Date().toISOString()}] Health check: Client not ready but marked as connected`);
      isConnected = false;
    }
    
    // Log status every 5 minutes
    if (status.ready) {
      console.log(`[${new Date().toISOString()}] Health check: OK | Uptime: ${Math.floor(status.uptime / 60)}m | Memory: ${status.memory}MB`);
    }
  }, 300000); // Every 5 minutes
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!va")) return;

  const parts = message.content.trim().split(/\s+/);
  const cmd = parts[1]?.toLowerCase();
  let accounts = loadAccounts();

  // !va add <region> <Name#Tag>
  if (cmd === "add") {
    const region = parts[2];
    const riotToken = parts[3];

    if (!region || !riotToken) {
      return message.reply("Usage: `!va add <region> <Name#Tag>`");
    }
    if (!validateRegion(region)) {
      return message.reply("Invalid region. Use one of: ap, na, eu, kr, latam, br");
    }
    const parsed = parseRiotId(riotToken);
    if (!parsed) {
      return message.reply("Invalid Riot ID. Use format `Name#Tag` (e.g., DevName#1234).");
    }
    const { name, tag } = parsed;
    if (!validateTag(tag)) {
      return message.reply("Invalid tag. Use 3–5 alphanumeric characters.");
    }

    const key = normalizeKey(name, tag);
    if (accounts.some(a => normalizeKey(a.name, a.tag) === key)) {
      return message.reply(`Account ${name}#${tag} already exists.`);
    }

    accounts.push({ region: region.toLowerCase(), name, tag });
    saveAccounts(accounts);
    const embed = new EmbedBuilder()
      .setTitle("Account Added Successfully")
      .setDescription(`✓ Added account: ${name}#${tag} (${region.toLowerCase()})`)
      .setColor(0x57F287)
      .addFields({
        name: "⚠️ Important: Enable Third-Party Trackers",
        value: "To view ranks, you must enable third-party trackers in your Valorant settings.\n" +
               "Use `!va tracker` for detailed instructions."
      });
    return message.reply({ embeds: [embed] });
  }

  // !va remove <Name#Tag>
  else if (cmd === "remove") {
    const riotToken = parts[2];
    if (!riotToken) {
      return message.reply("Usage: `!va remove <Name#Tag>`");
    }
    const parsed = parseRiotId(riotToken);
    if (!parsed) {
      return message.reply("Invalid Riot ID. Use format `Name#Tag`.");
    }
    const { name, tag } = parsed;

    const key = normalizeKey(name, tag);
    const before = accounts.length;
    accounts = accounts.filter(a => normalizeKey(a.name, a.tag) !== key);
    if (accounts.length === before) {
      return message.reply(`Account ${name}#${tag} not found.`);
    }
    saveAccounts(accounts);
    return message.reply(`Removed account: ${name}#${tag}`);
  }

  // !va edit <Name#Tag> [region=.. name=.. tag=..]
  else if (cmd === "edit") {
    const riotToken = parts[2];
    const editArgs = parts.slice(3);
    if (!riotToken || editArgs.length === 0) {
      return message.reply("Usage: `!va edit <Name#Tag> region=<r> name=<new> tag=<new>`");
    }
    const parsed = parseRiotId(riotToken);
    if (!parsed) {
      return message.reply("Invalid Riot ID. Use format `Name#Tag`.");
    }
    const { name, tag } = parsed;

    const idx = accounts.findIndex(a => normalizeKey(a.name, a.tag) === normalizeKey(name, tag));
    if (idx === -1) {
      return message.reply(`Account ${name}#${tag} not found.`);
    }

    const changes = parseEditArgs(editArgs);
    if (changes.region && !validateRegion(changes.region)) {
      return message.reply("Invalid region. Use one of: ap, na, eu, kr, latam, br");
    }
    if (changes.tag && !validateTag(changes.tag)) {
      return message.reply("Invalid tag. Use 3–5 alphanumeric characters.");
    }

    const updated = { ...accounts[idx], ...changes };
    const newKey = normalizeKey(updated.name, updated.tag);
    const duplicate = accounts.some((a, i) => i !== idx && normalizeKey(a.name, a.tag) === newKey);
    if (duplicate) {
      return message.reply(`Another account with ${updated.name}#${updated.tag} already exists.`);
    }

    accounts[idx] = updated;
    saveAccounts(accounts);
    // invalidate cache for changed key(s)
    rankCache.delete(normalizeKey(name, tag));
    rankCache.delete(newKey);
    accountCache.delete(normalizeKey(name, tag));
    accountCache.delete(newKey);
    return message.reply(`Updated account: ${updated.name}#${updated.tag} (${updated.region})`);
  }

  // !va list
  else if (cmd === "list") {
    if (accounts.length === 0) {
      return message.reply("No accounts stored. Add one with `!va add <region> <Name#Tag>`");
    }

    const embed = new EmbedBuilder()
      .setTitle("Stored Valorant Accounts - Detailed View")
      .setColor(0x5865F2)
      .setFooter({ text: "Fetching account details..." })
      .setTimestamp();

    // Send initial message
    const loadingMsg = await message.channel.send({ embeds: [embed] });

    // Fetch details for all accounts
    const accountDetails = [];
    for (const acc of accounts) {
      try {
        const details = await fetchAccountDetails(acc);
        accountDetails.push({ account: acc, details });
      } catch (e) {
        accountDetails.push({ 
          account: acc, 
          details: { error: true, accountLevel: "N/A", rank: "Unknown", rr: "N/A" } 
        });
      }
    }

    // Build detailed embed
    const detailedEmbed = new EmbedBuilder()
      .setTitle("Stored Valorant Accounts - Detailed View")
      .setColor(0x5865F2)
      .setFooter({ text: RIOT_API_KEY ? "Data via third-party API; Riot key included" : "Data via third-party API" })
      .setTimestamp();

    for (const { account, details } of accountDetails) {
      let fieldValue = `**Region:** ${account.region.toUpperCase()}\n`;
      fieldValue += `**Account Level:** ${details.accountLevel}\n`;
      fieldValue += `**Rank:** ${details.rank}\n`;
      fieldValue += `**RR:** ${details.rr}\n`;

      if (details.additionalStats) {
        if (details.additionalStats.recentMatches > 0) {
          fieldValue += `**Recent Matches:** ${details.additionalStats.recentMatches}\n`;
          if (details.additionalStats.recentWins > 0) {
            fieldValue += `**Recent Wins:** ${details.additionalStats.recentWins}\n`;
          }
        }
      }

      if (details.error) {
        if (details.errorMessage) {
          fieldValue += `\n⚠️ *${details.errorMessage}*`;
        } else {
          fieldValue += `\n⚠️ *Some data unavailable*`;
        }
      }

      detailedEmbed.addFields({
        name: `${account.name}#${account.tag}`,
        value: fieldValue,
        inline: true
      });
    }

    // Update the message with detailed information
    await loadingMsg.edit({ embeds: [detailedEmbed] });
    return;
  }

  // !va ranks
  else if (cmd === "ranks") {
    if (accounts.length === 0) {
      return message.reply("No accounts stored. Add one with `!va add <region> <Name#Tag>`");
    }

    const embed = new EmbedBuilder()
      .setTitle("Valorant ranks")
      .setColor(0x57F287)
      .setFooter({ text: RIOT_API_KEY ? "Data via third-party API; Riot key included" : "Data via third-party API" });

    // Fetch ranks sequentially to make rate-limiting predictable.
    for (const acc of accounts) {
      try {
        const rank = await fetchRank(acc);
        embed.addFields({
          name: `${acc.name}#${acc.tag} (${acc.region})`,
          value: `Rank: ${rank.tier}\nRR: ${rank.rr}`,
          inline: true
        });
      } catch (e) {
        embed.addFields({
          name: `${acc.name}#${acc.tag} (${acc.region})`,
          value: "❌ Error fetching rank\n" +
                 "⚠️ Enable third-party trackers\n" +
                 "Use `!va tracker` for help",
          inline: true
        });
      }
    }

    return message.channel.send({ embeds: [embed] });
  }

  // !va matches <Name#Tag> [mode] [limit]
  else if (cmd === "matches" || cmd === "match") {
    if (accounts.length === 0) {
      return message.reply("No accounts stored. Add one with `!va add <region> <Name#Tag>`");
    }

    const riotToken = parts[2];
    const modeInput = parts[3]?.toLowerCase();
    const limitInput = parseInt(parts[4]) || 10;

    // Find account
    let targetAcc = null;
    if (riotToken) {
      const parsed = parseRiotId(riotToken);
      if (parsed) {
        const key = normalizeKey(parsed.name, parsed.tag);
        targetAcc = accounts.find(a => normalizeKey(a.name, a.tag) === key);
      }
    }

    // If no account specified, use first account
    if (!targetAcc && accounts.length > 0) {
      targetAcc = accounts[0];
    }

    if (!targetAcc) {
      return message.reply("Account not found. Usage: `!va matches [Name#Tag] [mode] [limit]`\n" +
                          "Modes: competitive, unrated, premier, deathmatch, spike, escalation, replication, snowball, all");
    }

    // Validate game mode
    const gameMode = modeInput && Object.keys(GAME_MODES).includes(modeInput) 
      ? GAME_MODES[modeInput] 
      : null;

    const limit = Math.min(Math.max(limitInput, 1), 20); // Limit between 1-20

    try {
      const matchData = await fetchMatches(targetAcc, gameMode, limit);
      
      if (!matchData.matches || matchData.matches.length === 0) {
        return message.reply(`No matches found for ${targetAcc.name}#${targetAcc.tag}${gameMode ? ` in ${modeInput} mode` : ''}.`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`Match History - ${targetAcc.name}#${targetAcc.tag}`)
        .setColor(0x5865F2)
        .setDescription(gameMode ? `**Mode:** ${modeInput}\n**Showing:** ${matchData.matches.length} of ${matchData.total} matches` : `**Showing:** ${matchData.matches.length} of ${matchData.total} matches`)
        .setFooter({ text: "Use !va stats for detailed statistics" })
        .setTimestamp();

      // Add match fields (limit to 10 for embed limits)
      const matchesToShow = matchData.matches.slice(0, 10);
      for (const match of matchesToShow) {
        const formatted = formatMatch(match, targetAcc.name);
        if (formatted) {
          embed.addFields({
            name: `${formatted.result} - ${formatted.map}`,
            value: `**Mode:** ${formatted.mode}\n` +
                   `**Agent:** ${formatted.agent}\n` +
                   `**K/D/A:** ${formatted.kda}\n` +
                   `**Score:** ${formatted.score}\n` +
                   `**Combat Score:** ${formatted.combatScore}\n` +
                   `**Date:** ${formatted.date}`,
            inline: true
          });
        }
      }

      return message.channel.send({ embeds: [embed] });
    } catch (e) {
      return message.reply(`Failed to fetch matches: ${e?.message || 'Unknown error'}\n` +
                          "Make sure third-party trackers are enabled (use `!va tracker`)");
    }
  }

  // !va stats <Name#Tag> [mode]
  else if (cmd === "stats" || cmd === "statistics") {
    if (accounts.length === 0) {
      return message.reply("No accounts stored. Add one with `!va add <region> <Name#Tag>`");
    }

    const riotToken = parts[2];
    const modeInput = parts[3]?.toLowerCase();

    // Find account
    let targetAcc = null;
    if (riotToken) {
      const parsed = parseRiotId(riotToken);
      if (parsed) {
        const key = normalizeKey(parsed.name, parsed.tag);
        targetAcc = accounts.find(a => normalizeKey(a.name, a.tag) === key);
      }
    }

    // If no account specified, use first account
    if (!targetAcc && accounts.length > 0) {
      targetAcc = accounts[0];
    }

    if (!targetAcc) {
      return message.reply("Account not found. Usage: `!va stats [Name#Tag] [mode]`\n" +
                          "Modes: competitive, unrated, premier, deathmatch, spike, escalation, replication, snowball, all");
    }

    // Validate game mode
    const gameMode = modeInput && Object.keys(GAME_MODES).includes(modeInput) 
      ? GAME_MODES[modeInput] 
      : null;

    try {
      const matchData = await fetchMatches(targetAcc, gameMode, 50); // Get more matches for better stats
      
      if (!matchData.stats) {
        return message.reply(`No statistics available for ${targetAcc.name}#${targetAcc.tag}${gameMode ? ` in ${modeInput} mode` : ''}.`);
      }

      const stats = matchData.stats;
      const embed = new EmbedBuilder()
        .setTitle(`Statistics - ${targetAcc.name}#${targetAcc.tag}`)
        .setColor(0x57F287)
        .setDescription(gameMode ? `**Mode:** ${modeInput}\n**Based on:** ${stats.totalMatches} matches` : `**Based on:** ${stats.totalMatches} matches`)
        .addFields(
          {
            name: "Win/Loss",
            value: `**Wins:** ${stats.wins}\n**Losses:** ${stats.losses}\n**Win Rate:** ${stats.winRate}`,
            inline: true
          },
          {
            name: "Combat",
            value: `**K/D:** ${stats.kd}\n**Avg Kills:** ${stats.avgKills}\n**Avg Deaths:** ${stats.avgDeaths}\n**Avg Assists:** ${stats.avgAssists}`,
            inline: true
          },
          {
            name: "Performance",
            value: `**Total Kills:** ${stats.totalKills}\n**Total Deaths:** ${stats.totalDeaths}\n**Total Assists:** ${stats.totalAssists}\n**Avg Score:** ${stats.avgScore}`,
            inline: true
          },
          {
            name: "Rounds",
            value: `**Rounds Won:** ${stats.totalRoundsWon}\n**Rounds Lost:** ${stats.totalRoundsLost}`,
            inline: true
          },
          {
            name: "Most Played",
            value: `**Agent:** ${stats.mostPlayedAgent}\n**Map:** ${stats.mostPlayedMap}`,
            inline: true
          }
        )
        .setFooter({ text: "Use !va matches to see recent match history" })
        .setTimestamp();

      return message.channel.send({ embeds: [embed] });
    } catch (e) {
      return message.reply(`Failed to fetch statistics: ${e?.message || 'Unknown error'}\n` +
                          "Make sure third-party trackers are enabled (use `!va tracker`)");
    }
  }

  // !va tracker - Instructions for enabling third-party trackers
  else if (cmd === "tracker" || cmd === "trackers" || cmd === "help-tracker") {
    const embed = new EmbedBuilder()
      .setTitle("How to Enable Third-Party Trackers")
      .setDescription("To view ranks and account details, you must enable third-party trackers. This allows tracking services to access your match data.")
      .setColor(0xFF4655)
      .addFields(
        {
          name: "Method 1: Riot Games Website",
          value: "1. Go to [account.riotgames.com](https://account.riotgames.com)\n" +
                 "2. Log in with your Riot account\n" +
                 "3. Navigate to **Privacy** or **Data Sharing** settings\n" +
                 "4. Enable **\"Allow others to see my match history\"**\n" +
                 "5. Enable **\"Allow third-party applications to access my match data\"** (if available)"
        },
        {
          name: "Method 2: Verify via Tracker.gg",
          value: "1. Visit [tracker.gg/valorant](https://tracker.gg/valorant)\n" +
                 "2. Search for your account (Name#Tag)\n" +
                 "3. If your account appears with stats, trackers are already enabled\n" +
                 "4. If not found, you may need to enable data sharing in Riot account settings"
        },
        {
          name: "Method 3: In-Game Settings (if available)",
          value: "1. Open Valorant\n" +
                 "2. Go to **Settings** (gear icon)\n" +
                 "3. Look for **Privacy** or **Data Sharing** options\n" +
                 "4. Enable match history sharing (exact location may vary by game version)"
        },
        {
          name: "After Enabling",
          value: "• Wait a few minutes for changes to take effect\n" +
                 "• Try `!va ranks` again to verify\n" +
                 "• If still not working, check that your account name and tag are correct"
        },
        {
          name: "Note",
          value: "Settings location may vary. If you can't find these options, your account may already have trackers enabled. " +
                 "Try searching on tracker.gg first to verify."
        }
      )
      .setFooter({ text: "If you're still having issues, the account may be private or require additional verification" })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // help
  else if (cmd === "help" || !cmd) {
    const embed = new EmbedBuilder()
      .setTitle("Valorant Bot Commands")
      .setColor(0x5865F2)
      .setDescription("All commands start with `!va`")
      .addFields(
        {
          name: "Account Management",
          value: "• `!va add <region> <Name#Tag>` - Add an account\n" +
                 "• `!va remove <Name#Tag>` - Remove an account\n" +
                 "• `!va edit <Name#Tag> region=<r> name=<new> tag=<new>` - Edit an account"
        },
        {
          name: "View Information",
          value: "• `!va list` - List all accounts with details\n" +
                 "• `!va ranks` - Check ranks for all accounts\n" +
                 "• `!va matches [Name#Tag] [mode] [limit]` - View match history\n" +
                 "• `!va stats [Name#Tag] [mode]` - View detailed statistics"
        },
        {
          name: "Game Modes",
          value: "competitive, unrated, premier, deathmatch, spike, escalation, replication, snowball, all"
        },
        {
          name: "Help & Setup",
          value: "• `!va help` - Show this help message\n" +
                 "• `!va tracker` - How to enable third-party trackers"
        }
      )
      .setFooter({ text: "⚠️ Ranks require third-party trackers to be enabled. Use !va tracker for instructions." });
    return message.reply({ embeds: [embed] });
  }

  // Unknown command
  else {
    return message.reply(
      "Unknown command. Use `!va help` for available commands.\n" +
      "💡 **Tip:** If ranks aren't showing, use `!va tracker` to learn how to enable third-party trackers."
    );
  }
});

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN. Set it in .env");
  process.exit(1);
}

// Login with infinite retry logic for 24/7 operation
async function loginWithRetry(delay = 5000, maxDelay = 60000) {
  let attempt = 0;
  let currentDelay = delay;
  
  while (true) {
    try {
      attempt++;
      console.log(`[${new Date().toISOString()}] Attempting to connect to Discord... (Attempt ${attempt})`);
      await client.login(TOKEN);
      console.log(`[${new Date().toISOString()}] Successfully connected to Discord!`);
      return; // Success, exit function
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Login attempt ${attempt} failed:`, error.message);
      console.error(`Retrying in ${currentDelay / 1000} seconds...`);
      
      // Exponential backoff with max delay
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      currentDelay = Math.min(currentDelay * 1.5, maxDelay); // Increase delay up to max
      
      // Reset delay after successful connection attempts
      if (attempt % 10 === 0) {
        console.log(`[${new Date().toISOString()}] Resetting retry delay after ${attempt} attempts`);
        currentDelay = delay;
      }
    }
  }
}

// Graceful shutdown handler
function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    console.log(`\n[${new Date().toISOString()}] Received ${signal}. Shutting down gracefully...`);
    
    // Stop intervals
    stopHeartbeat();
    stopHealthCheck();
    
    // Destroy client
    if (client.isReady()) {
      try {
        client.destroy();
        console.log(`[${new Date().toISOString()}] Discord client destroyed`);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Error destroying client:`, e.message);
      }
    }
    
    // Give time for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log(`[${new Date().toISOString()}] Shutdown complete`);
    process.exit(0);
  };
  
  // Handle different termination signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error(`[${new Date().toISOString()}] Uncaught Exception:`, error);
    // Don't exit, try to recover
  });
  
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${new Date().toISOString()}] Unhandled Rejection at:`, promise, 'reason:', reason);
    // Don't exit, try to recover
  });
}

// Start the bot
setupGracefulShutdown();
loginWithRetry();
