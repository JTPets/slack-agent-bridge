# Slack Agent Bridge

A Slack-to-Claude-Code automation agent that polls Slack channels for task messages and executes them via Claude Code CLI. Built by JT Pets.

## Setup

1. Copy `.env.example` to `.env` and fill in your values:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your Slack bot token and channel IDs (required variables are marked in the file)

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run the agent:
   ```bash
   npm start
   ```

See `CLAUDE.md` for full documentation on environment variables and project rules.

## License

MIT - see [LICENSE](LICENSE)
