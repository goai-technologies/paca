# paca-acp-bridge

A small local daemon that connects an **ACP-type** Paca AI agent to a coding
CLI running on your own machine — Claude Code, Codex, Gemini CLI,
[Goose](https://github.com/block/goose),
[OpenCode](https://opencode.ai), or a custom
[Agent Client Protocol](https://agentclientprotocol.com) server. Run it from
your project's source directory; it spawns the ACP server there and streams
the conversation back to Paca. Nothing is cloned into a cloud sandbox and no
source code leaves your machine — Paca only ever sends task requests and
receives responses back.

## Prerequisites

- Node.js (the built-in providers — Claude Code, Codex, Gemini CLI — are
  launched via `npx`; not needed for Goose, OpenCode, or a custom ACP server
  that doesn't require it)
- Your own local auth for whichever provider you pick — e.g. run
  `claude setup-token` for Claude Code, export `OPENAI_API_KEY` /
  `GEMINI_API_KEY` for Codex/Gemini CLI, or run `goose configure` (or export
  `GOOSE_PROVIDER`/the provider's own API key env var) for Goose, or run
  `opencode auth login` (or export your model provider's API key) for
  OpenCode. This is
  entirely your own local setup, exactly as if you were running that CLI
  yourself — Paca never sees, stores, or forwards this. Likewise, any MCP
  servers or skills you've configured for your local ACP client are used
  as-is; Paca doesn't manage or inject any of that.

## Run it

Install the binary once (no Go toolchain needed — this downloads a prebuilt
binary for your platform):

```sh
curl -fsSL https://github.com/Paca-AI/paca/releases/latest/download/install-acp-bridge.sh | bash
```

Then run it from your project's directory:

```sh
cd /path/to/your/project
paca-acp-bridge run \
  --agent-id <agent-id> \
  --token <token> \
  --server https://your-paca-instance.example.com
```

`--agent-id`, `--token`, and `--server` can also be set via
`PACA_ACP_AGENT_ID`, `PACA_ACP_TOKEN`, and `PACA_ACP_SERVER`. The agent id and
token are shown once when you generate (or regenerate) the local bridge token
for an ACP agent in Paca's Agents UI — copy the run command shown there.

By default the ACP server operates on your current directory; pass
`--workspace <path>` to point at a different one.

Building from source instead (requires Go 1.26+):

```sh
cd apps/acp-bridge
go build -o paca-acp-bridge ./cmd/paca-acp-bridge
./paca-acp-bridge run --agent-id <agent-id> --token <token> --server <url>
```

## OpenCode

Select **OpenCode** as the agent's ACP provider and the bridge launches
`opencode acp` in your workspace — nothing to configure on the Paca side.
Install the CLI first (`npm i -g opencode-ai`, or see
[opencode.ai](https://opencode.ai/docs)) so `opencode` is on your `PATH`
(on Windows, run the bridge from the same shell where `opencode --version`
works), and authenticate it with `opencode auth login`.

OpenCode owns its own MCP and skill configuration (`opencode.json`, or
`~/.config/opencode/`), and the bridge injects none. To make it Paca-aware,
run the skill installer below with the `opencode` platform
(`--platforms=opencode`; it writes `~/.config/opencode/skills/`) and add the
Paca MCP server to your `opencode.json` — running `paca-mcp` by hand in a
terminal does not register it with OpenCode. The agent id, API key and
project id are in the setup steps Paca's Agents UI shows for this agent:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "paca": {
      "type": "local",
      "command": ["npx", "-y", "@paca-ai/paca-mcp"],
      "environment": {
        "PACA_API_URL": "<your-paca-url>",
        "PACA_API_KEY": "<agent-api-key>",
        "PACA_AGENT_ID": "<agent-id>",
        "PACA_PROJECT_ID": "<project-id>"
      }
    }
  }
}
```

This is the `mcp.<name>` shape used by current OpenCode releases (1.x). Newer
OpenCode schemas move servers under `mcp.servers` and use `disabled` instead
of `enabled`, while still accepting the form above as deprecated — if your
version rejects it, check the schema at
[opencode.ai/config.json](https://opencode.ai/config.json).

## Tools, MCP servers, skills, and git access

ACP agents don't take Paca-managed tool/MCP/skill configuration — the ACP
server you run owns all of that, using your own local setup. This also means
it has full, native access to whatever git/`gh` credentials you already have
configured locally, so it can clone, commit, push, and open pull requests
exactly as if you were driving it yourself in a terminal.

Since Paca doesn't inject anything into an ACP conversation, making your
agent Paca-aware — so it uses Paca's MCP tools and task/doc workflow instead
of local TODOs and stray markdown files — means installing that yourself
into whichever CLI you're running. Paca's Agents UI walks through this for
your specific agent (bridge install, skill install, MCP connection), or run
it directly from a terminal:

```sh
PACA_API_URL=<your-paca-url> \
  curl -fsSL https://raw.githubusercontent.com/Paca-AI/paca/master/scripts/install-paca-skills.sh | bash
```

`PACA_API_URL` is required here — the installer fetches skill content from
that instance's API (matching the exact version it's running) rather than
GitHub. `PACA_API_KEY` (from Paca → Settings → API Keys) is optional, but
also pulls in skills contributed by any plugins enabled on that instance.
Run this from the same project directory you'll run the ACP bridge from —
Claude Code and Gemini CLI pick the skills up globally either way, but
Codex (and anything else that reads `AGENTS.md`) only sees them if the
installer's `AGENTS.md` output landed in that project. See
[docs/guides/install-skills.md](../../docs/guides/install-skills.md) for
details.

## How it works

This daemon spawns your chosen ACP CLI as a real local subprocess against
the current directory and speaks the [Agent Client
Protocol](https://agentclientprotocol.com) to it directly over its
stdin/stdout — no separate SDK or runtime dependency. Right after starting a
session it requests whichever session mode suppresses interactive
permission prompts for that provider (falling back to auto-approving each
individual permission request if the provider doesn't offer one), since
there's no human on the other end of a headless daemon to answer them.

Conversation events (the agent's streamed reply text, its reasoning, and
every tool call it makes) stream back to Paca over an authenticated
WebSocket (`/agent-bridge/ws` on your Paca instance) and are stored the same
way as any other agent conversation, so the chat UI works identically
regardless of where the agent actually ran.

Keep this process running for as long as you want the agent to be reachable
from Paca — it reconnects automatically on a dropped connection.

Pressing "stop" mid-turn sends the ACP CLI a real `session/cancel` — the
same interruption a stop button would trigger if you were driving that CLI
yourself in a terminal — rather than just disconnecting and hoping.
