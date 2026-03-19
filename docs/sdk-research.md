# Claude Agent SDK as LLM Backbone

## What SDK Provides
- Agentic loop with tool calling + automatic retry
- Subagents — isolated context windows, parallel execution
- Skills — reusable capabilities
- MCP — standardized integrations
- Hooks — lifecycle customization
- Built-in observability

## What SDK Replaces
All 7 bots implement manual `askClaudeWithTools()` loops (~200 lines each). SDK eliminates this.

## What BotForge Must Build On Top
1. **Platform Adapters** — SDK doesn't know Telegram/Slack/WhatsApp message types
2. **Config-driven Setup** — No YAML tool definitions, dynamic enable/disable
3. **Persistent State** — No SQLite, no conversation history TTL
4. **Multi-step Workflows** — SDK agents are stateless, no pause/resume/approvals
5. **Response Formatting** — No platform-specific formatting
