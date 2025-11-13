# Valorant Bot

A Discord bot for managing Valorant accounts and checking player ranks.

## Features

- Add, remove, and edit Valorant accounts
- List all stored accounts
- Check current ranks and RR (Rank Rating) for all stored accounts
- Supports multiple regions: AP, NA, EU, KR, LATAM, BR

## Prerequisites

- Node.js (v16 or higher recommended)
- A Discord Bot Token
- npm or yarn

## Installation

1. Clone or download this repository
2. Install all dependencies from `package.json`:
   ```bash
   npm install
   ```
   This command will automatically read `package.json` and install all required packages:
   - `discord.js` - Discord API library
   - `axios` - HTTP client for API requests
   - `dotenv` - Environment variable management

   **Alternative:** You can also install the packages individually:
   ```bash
   npm install discord.js axios dotenv
   ```

3. Configure your bot:
   - Create a `.env` file in the project root (or edit the existing one)
   - Add your Discord bot token:
     ```
     DISCORD_TOKEN=your_actual_bot_token_here
     ```

## Setup Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to the "Bot" section and create a bot
4. Copy the bot token
5. Enable the following intents:
   - Server Members Intent (if needed)
   - Message Content Intent (required for reading messages)
6. Invite the bot to your server with the following permissions:
   - Send Messages
   - Embed Links
   - Read Message History

## Usage

Start the bot:
```bash
npm start
```
Or alternatively:
```bash
node bot.js
```

### Commands

All commands start with `!va`:

- `!va add <region> <Name#Tag>` - Add a new Valorant account
  - Example: `!va add na DevName#1234`
  - Valid regions: `ap`, `na`, `eu`, `kr`, `latam`, `br`

- `!va remove <Name#Tag>` - Remove an account
  - Example: `!va remove DevName#1234`

- `!va edit <Name#Tag> region=<r> name=<new> tag=<new>` - Edit an account
  - Example: `!va edit DevName#1234 region=eu tag=5678`
  - You can update region, name, or tag

- `!va list` - List all stored accounts

- `!va ranks` - Check ranks and RR for all stored accounts

- `!va` or `!va help` - Show help message

## Account Format

Accounts are stored with:
- **Region**: One of the supported regions (ap, na, eu, kr, latam, br)
- **Name**: The in-game name (case-insensitive)
- **Tag**: 3-5 alphanumeric characters (e.g., 1234, ABC5)

## Data Storage

Accounts are stored in `accounts.json` in the following format:
```json
{
  "accounts": [
    {
      "region": "na",
      "name": "DevName",
      "tag": "1234"
    }
  ]
}
```

## API

This bot uses the [HenrikDev Valorant API](https://github.com/Henrik-3/unofficial-valorant-api) to fetch rank information.

## Troubleshooting

- **Bot not responding**: Check that the bot token is correct in `.env`
- **"Error fetching rank"**: The API might be down or the account name/tag might be incorrect
- **Bot can't read messages**: Make sure Message Content Intent is enabled in Discord Developer Portal

## License

ISC

