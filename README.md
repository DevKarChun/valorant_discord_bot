# Valorant Bot

A Discord bot for managing Valorant accounts, tracking ranks, viewing match history, and analyzing statistics across all game modes.

## ✨ Features

- **Account Management** - Add, remove, and edit Valorant accounts
- **Rank Tracking** - Check current competitive ranks and RR (Rank Rating)
- **Match History** - View recent matches with detailed information
- **Statistics** - Comprehensive stats for all game modes
- **Multi-Region Support** - AP, NA, EU, KR, LATAM, BR
- **Game Mode Filtering** - Competitive, Unrated, Premier, Deathmatch, and more
- **24/7 Reliability** - Automatic reconnection and error recovery
- **Caching** - Optimized API usage with intelligent caching

## 📋 Prerequisites

- **Node.js** v16 or higher
- **Discord Bot Token** ([Get one here](https://discord.com/developers/applications))
- **npm** or **yarn**

## 🚀 Quick Start

### 1. Installation

```bash
# Clone or download the repository
cd valorant_bot

# Install dependencies
npm install
```

### 2. Configuration

Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token_here
```

### 3. Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Go to **Bot** section
3. Create a bot and copy the token
4. Enable **Message Content Intent** (required)
5. Invite bot to your server with permissions:
   - Send Messages
   - Embed Links
   - Read Message History

### 4. Run the Bot

```bash
npm start
```

Or:

```bash
node bot.js
```

The bot will automatically reconnect if the connection is lost, ensuring 24/7 operation.

## 📖 Commands

All commands start with `!va`. Use `!va help` in Discord for a quick reference.

### Account Management

| Command | Description | Example |
|---------|-------------|---------|
| `!va add <region> <Name#Tag>` | Add a Valorant account | `!va add na PlayerName#1234` |
| `!va remove <Name#Tag>` | Remove an account | `!va remove PlayerName#1234` |
| `!va edit <Name#Tag> [options]` | Edit account details | `!va edit PlayerName#1234 region=eu tag=5678` |
| `!va list` | List all stored accounts with details | `!va list` |

**Valid Regions:** `ap`, `na`, `eu`, `kr`, `latam`, `br`

### Viewing Information

| Command | Description | Example |
|---------|-------------|---------|
| `!va ranks` | Check ranks for all accounts | `!va ranks` |
| `!va matches [Name#Tag] [mode] [limit]` | View match history | `!va matches competitive 10` |
| `!va stats [Name#Tag] [mode]` | View detailed statistics | `!va stats PlayerName#1234 premier` |

**Game Modes:** `competitive`, `unrated`, `premier`, `deathmatch`, `spike`, `escalation`, `replication`, `snowball`, `all`

### Help & Setup

| Command | Description |
|---------|-------------|
| `!va help` | Show all available commands |
| `!va tracker` | Instructions for enabling third-party trackers |

## 🎮 Command Examples

### Match History

```bash
!va matches                          # Last 10 matches (first account)
!va matches PlayerName#1234         # Last 10 matches (specific account)
!va matches competitive 5            # Last 5 competitive matches
!va matches PlayerName#1234 deathmatch 15  # 15 deathmatch matches
```

### Statistics

```bash
!va stats                            # Stats for first account (all modes)
!va stats PlayerName#1234            # Stats for specific account
!va stats competitive                # Competitive stats only
!va stats PlayerName#1234 premier    # Premier stats for specific account
```

### Editing Accounts

```bash
!va edit PlayerName#1234 region=eu           # Change region
!va edit PlayerName#1234 tag=5678            # Change tag
!va edit PlayerName#1234 name=NewName tag=9999  # Change multiple fields
```

## ⚙️ Enabling Third-Party Trackers

**⚠️ Required:** To view ranks and match data, you must enable third-party trackers.

### Quick Setup

1. Visit [account.riotgames.com](https://account.riotgames.com)
2. Log in and go to **Privacy** or **Data Sharing** settings
3. Enable **"Allow others to see my match history"**
4. Enable **"Allow third-party applications to access my match data"** (if available)

### Verify

- Search your account on [tracker.gg/valorant](https://tracker.gg/valorant)
- If it appears, trackers are enabled ✅
- Use `!va tracker` in Discord for detailed instructions

## 🔧 Troubleshooting

### Connection Issues

| Problem | Solution |
|---------|----------|
| Bot not responding | Check `.env` file has correct `DISCORD_TOKEN` |
| Can't read messages | Enable **Message Content Intent** in Discord Developer Portal |
| Connection timeout | Bot will auto-reconnect; check internet connection |

### Data Issues

| Problem | Solution |
|---------|----------|
| "401 Unauthorized" | Enable third-party trackers (see above) |
| "Account not found" | Verify account name and tag are correct |
| Ranks not showing | Wait a few minutes after enabling trackers |
| No match data | Ensure account has played matches in selected mode |

## 📊 Data Storage

Accounts are stored in `accounts.json`:

```json
{
  "accounts": [
    {
      "region": "na",
      "name": "PlayerName",
      "tag": "1234"
    }
  ]
}
```

## 🔌 API Information

This bot uses the [HenrikDev Valorant API](https://github.com/Henrik-3/unofficial-valorant-api) to fetch:
- Account information and levels
- Competitive ranks and RR
- Match history for all game modes
- Player statistics

**Note:** The API requires third-party trackers to be enabled for your Valorant account.

## 🛡️ 24/7 Reliability

The bot includes automatic features for continuous operation:

- **Auto-Reconnection** - Automatically reconnects if connection is lost
- **Error Recovery** - Handles errors without crashing
- **Health Monitoring** - Tracks uptime and connection status
- **Graceful Shutdown** - Clean shutdown on termination signals

The bot will keep running and automatically recover from network issues, ensuring it's always available.

## 📝 Account Format

- **Region**: One of `ap`, `na`, `eu`, `kr`, `latam`, `br`
- **Name**: In-game name (case-insensitive)
- **Tag**: 3-5 alphanumeric characters (e.g., `1234`, `ABC5`)

## 📄 License

This project is licensed under the **MIT License**.

---

**Need Help?** Use `!va help` in Discord or check the troubleshooting section above.
