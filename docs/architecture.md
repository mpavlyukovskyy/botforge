# BotForge — Agent Management Platform

## Context

Mark has 7 Telegram bots on OpenClaw with heavily duplicated patterns (SQLite, node-telegram-bot-api, Claude/Gemini, systemd, deploy.sh). Each bot was built independently, leading to inconsistent error handling (Maia/Harry have circuit breakers; others crash and rely on systemd restart), duplicated conversation history implementations, and no centralized management.

**Goal:** Build a scalable framework to quickly spin up, configure, deploy, and manage 50-100 agents across multiple platforms (Telegram, Slack, WhatsApp, email, web, voice, headless) with a full lifecycle management dashboard, inter-bot communication, and potential for open-source/productization.

---

## Research Summary

### Existing Landscape

| Project | Relevance | Key Takeaway |
|---------|-----------|--------------|
| [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) | **High** | Official Anthropic framework for building agents. Built-in tools, subagents, MCP, hooks, sessions, skills. TypeScript + Python. Could be the LLM backbone. |
| [Superpowers](https://github.com/obra/superpowers) | Medium | Development workflow skills for coding agents. "Skills as markdown" pattern is reusable. 95K+ stars. |
| [BotAlto](https://github.com/ProKaiiddo/BotAlto) | Medium | Multi-bot Telegram dashboard with hot-reload commands. Simple but validates the dashboard concept. |
| [CrewAI](https://crewai.com/open-source) | Medium | Multi-agent orchestration (44K+ stars). Role-playing agents, collaborative tasks. Too Python-heavy for our TS stack. |
| [AWS Agent Squad](https://github.com/awslabs/agent-squad) | Medium | Supervisor agent pattern with "agent-as-tools". Good inter-bot coordination model. |
| [Hyperspace AGI](https://github.com/hyperspaceai/agi) | Low | P2P distributed agent network. Interesting CRDT state sync but over-engineered for our needs. |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Low | Graph-based workflows. Python-first, vendor lock-in concerns. |

### Current Bot Patterns Worth Extracting

From analysis of all 7 bots:

| Pattern | Best Implementation | Found In |
|---------|-------------------|----------|
| Circuit breaker + retry | 5-failure threshold, exponential backoff, transient error detection | Maia, Harry |
| Conversation history | SQLite table, 14-30 day TTL, dynamic context injection | Maia, Harry, Atlas, Kristina |
| Health endpoint | Rich JSON (IMAP state, circuit status, DB size, token usage) | Ashley |
| Daily digest | Cron-based, timezone-aware, auto-archive done items | Atlas, Kristina, Alfred |
| Atomic deploy | dist → dist.old swap, health check gate, rollback support | All bots |
| YAML config | Strategy files, scoring weights, templates without code changes | Maia, Ashley |
| Tool-calling loop | Claude Opus with tool definitions, agentic execution | Maia, Harry, Atlas, Kristina, Alfred |
| Platform adapter | Telegram polling with inline keyboards, callback routing | All bots |

---

## Proposed Architecture

### Layer 1: Bot Definition Schema (YAML)

Every bot is defined by a single YAML file:

```yaml
# bots/kristina.yaml
name: Kristina
version: 1.0
platform:
  type: telegram
  token: ${KRISTINA_BOT_TOKEN}
  chat_ids: ["381823289"]

brain:
  model: claude-opus-4-6
  system_prompt: |
    You are Kristina, Mark's personal task assistant...
  tools:
    - create_task
    - update_task
    - query_board
    - mark_done
  temperature: 0

memory:
  conversation_history:
    enabled: true
    ttl_days: 14
    max_messages: 100
  context_blocks:
    - type: board_state
    - type: recent_history

resilience:
  circuit_breaker:
    threshold: 5
    reset_timeout_ms: 30000
  retry:
    max_attempts: 3
    backoff: exponential
    transient_codes: [429, 502, 503]

schedule:
  daily_digest:
    cron: "30 8 * * *"
    timezone: America/New_York
  auto_archive:
    cron: "0 */4 * * *"
    done_after_hours: 24

integrations:
  atlas:
    url: https://mp-atlas.fly.dev
    sync_endpoint: /api/sync/kristina-bot/items
    token: ${ATLAS_SYNC_TOKEN}

health:
  port: 8087
  path: /api/health

communication:
  team: null  # or "deal-team" for inter-bot messaging
  subscriptions: []  # event types to listen for
```

### Layer 2: Core Runtime (`@botforge/core`)

A TypeScript monorepo with shared packages:

```
packages/
  core/           # Bot lifecycle, config loader, plugin system
  adapters/
    telegram/     # Telegram polling/webhook adapter
    slack/        # Slack adapter (future)
    email/        # IMAP IDLE adapter (from Ashley)
    web/          # HTTP/WebSocket adapter
  skills/
    circuit-breaker/    # From Maia/Harry
    conversation-history/  # From Maia/Harry/Atlas
    daily-digest/       # From Atlas/Kristina
    health-server/      # From Ashley (rich health)
    cron-scheduler/     # Shared cron management
    tool-calling/       # Claude Agent SDK integration
  storage/
    sqlite/       # better-sqlite3 wrapper with migrations
  bus/            # Inter-bot event bus (Redis pub/sub)
  dashboard/      # Next.js management UI
```

**Key design decisions:**
- **Claude Agent SDK as LLM backbone** — replaces custom tool-calling loops. Provides built-in tools, subagents, MCP, hooks, sessions
- **Plugin/skill system** — each capability is a composable skill. Bots declare which skills they need in YAML
- **Platform adapters** — abstract away Telegram/Slack/email differences. Bot logic doesn't know which platform it's on
- **Process isolation** — each bot runs as its own process (systemd unit or Docker container). Crash isolation, resource limits
- **Shared SQLite per bot** — each bot gets its own DB file. No shared state except via event bus

### Layer 3: Management Dashboard

Next.js app (could live on Fly.io or OpenClaw):

| Feature | Description |
|---------|-------------|
| **Bot Registry** | List all bots with status (running/stopped/error), uptime, last activity |
| **Health Dashboard** | Real-time metrics: token usage, response times, circuit breaker state, queue depth |
| **Config Editor** | YAML editor with syntax highlighting, validation, live preview of changes |
| **Prompt Studio** | Edit system prompts, test with sample inputs, compare outputs across models |
| **Deploy Pipeline** | One-click deploy with: build → test → health check → swap → verify → auto-rollback |
| **Log Viewer** | Streaming logs from all bots, filterable by bot/level/time |
| **Secret Manager** | Manage API keys, tokens per bot. Inject as env vars at runtime |
| **Template Gallery** | Create new bots from templates (task bot, email classifier, CRM sync, etc.) |
| **Team Config** | Define bot teams, communication channels, event routing rules |
| **Rollback** | One-click rollback to any previous version per bot |

### Layer 4: Inter-Bot Communication

```
┌─────────┐    event: "deal_scored"    ┌─────────┐
│  Maia   │ ──────────────────────────▶│  Harry  │
│ (deals) │                            │ (LP)    │
└─────────┘                            └─────────┘
     │                                      │
     │  event: "new_task"                   │
     ▼                                      │
┌─────────┐                                 │
│Kristina │◀── event: "followup_needed" ────┘
│ (tasks) │
└─────────┘
```

- **Event bus**: Redis pub/sub (lightweight, already available on OpenClaw)
- **Event schema**: `{ source: "maia", type: "deal_scored", payload: {...}, timestamp }`
- **Subscriptions**: Declared in bot YAML config
- **Message routing**: Direct bot-to-bot messaging via the bus

### Layer 5: Deployment Pipeline

```
Developer                    OpenClaw
   │                            │
   │  botforge deploy kristina  │
   │ ──────────────────────────▶│
   │                            │ 1. Build (tsc)
   │                            │ 2. Test (unit + integration)
   │                            │ 3. Upload dist.new
   │                            │ 4. Swap (dist → dist.old, dist.new → dist)
   │                            │ 5. Restart systemd unit
   │                            │ 6. Health check (30s timeout)
   │                            │ 7. If unhealthy → auto-rollback
   │  ◀── deploy result ────────│
   │                            │

For Docker-based isolation (future):
  docker-compose.generated.yml (auto-generated from bot YAMLs)
  services:
    kristina:
      image: botforge-runtime
      volumes:
        - ./bots/kristina.yaml:/app/config.yaml
        - ./data/kristina:/app/data
      environment:
        - KRISTINA_BOT_TOKEN=${KRISTINA_BOT_TOKEN}
      restart: unless-stopped
      mem_limit: 256m
```

---

## Migration Path (Current Bots → BotForge)

| Phase | What | Effort |
|-------|------|--------|
| **Phase 0** | Save research, set up monorepo structure | 1 session |
| **Phase 1** | Extract `@botforge/core` from existing bots (circuit breaker, health, conversation history, deploy) | 2-3 sessions |
| **Phase 2** | Build Telegram adapter + config loader. Migrate simplest bot (Kristina) as proof of concept | 2-3 sessions |
| **Phase 3** | Migrate remaining bots one by one (Atlas, Alfred, Ashley, Babushka, Harry, Maia) | 1-2 sessions each |
| **Phase 4** | Build management dashboard (Next.js) | 3-4 sessions |
| **Phase 5** | Add inter-bot event bus + team features | 1-2 sessions |
| **Phase 6** | Add additional platform adapters (Slack, WhatsApp, email) | 1 session each |
| **Phase 7** | Open-source prep (docs, examples, CLI tool) | 2-3 sessions |

---

## Key Innovation Opportunities

Beyond standardizing existing bots:

| Innovation | Description | Inspired By |
|-----------|-------------|-------------|
| **Prompt versioning** | Git-like version control for system prompts. A/B test different prompts, rollback to previous versions | Superpowers skill versioning |
| **Skill marketplace** | Composable skills as npm packages. `botforge add skill:daily-digest` | Claude Agent SDK skills |
| **Bot templates** | `botforge create --template task-bot` creates a fully configured bot from template | BotAlto + CrewAI |
| **Hot-reload config** | Change YAML config, bot picks up changes without restart | BotAlto hot-reload |
| **Conversation replay** | Replay past conversations against new prompts/models to test changes before deploying | Claude Agent SDK sessions |
| **Cost dashboard** | Track token usage per bot, per conversation, with budget alerts | NZPE Agent token tracking |
| **Health federation** | Single endpoint that aggregates health from all bots across all servers | Ashley's rich health pattern |
| **Bot cloning** | `botforge clone kristina --name sarah --platform slack` — instant new bot from existing | Config-driven architecture |
| **Team orchestration** | Define bot teams with shared context, coordinator patterns, and handoff protocols | AWS Agent Squad supervisor pattern |
| **Canary deploys** | Route 10% of traffic to new version, monitor, then promote | Standard DevOps |

---

## Verification

After Phase 2 (Kristina migration):
- Kristina bot runs from BotForge runtime with YAML config
- All existing features work (task creation, daily digest, Atlas sync)
- Health endpoint returns same data
- Deploy via `botforge deploy kristina` instead of `./deploy.sh`
- Conversation history persists across restarts
- Circuit breaker activates on Claude API failure
