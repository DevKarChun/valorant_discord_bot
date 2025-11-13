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

// Simple in-memory cache for ranks
const CACHE_TTL_MS = 5 * 60 * 1000;
const rankCache = new Map();

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
function axiosConfig() {
  const cfg = { timeout: 8000 };
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

// --- bot setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

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
    return message.reply(`Added account: ${name}#${tag} (${region.toLowerCase()})`);
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
    return message.reply(`Updated account: ${updated.name}#${updated.tag} (${updated.region})`);
  }

  // !va list
  else if (cmd === "list") {
    if (accounts.length === 0) {
      return message.reply("No accounts stored. Add one with `!va add <region> <Name#Tag>`");
    }
    const embed = new EmbedBuilder()
      .setTitle("Stored Valorant accounts")
      .setColor(0x5865F2)
      .setDescription(accounts.map(a => `• ${a.name}#${a.tag} — ${a.region}`).join("\n"));
    return message.channel.send({ embeds: [embed] });
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
      } catch {
        embed.addFields({
          name: `${acc.name}#${acc.tag} (${acc.region})`,
          value: "Error fetching rank",
          inline: true
        });
      }
    }

    return message.channel.send({ embeds: [embed] });
  }

  // help
  else {
    return message.reply(
      "Commands:\n" +
      "• `!va add <region> <Name#Tag>`\n" +
      "• `!va remove <Name#Tag>`\n" +
      "• `!va edit <Name#Tag> region=<r> name=<new> tag=<new>`\n" +
      "• `!va list`\n" +
      "• `!va ranks`"
    );
  }
});

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN. Set it in .env");
  process.exit(1);
}
client.login(TOKEN);
