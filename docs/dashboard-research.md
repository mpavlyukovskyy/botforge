# Dashboard UX Patterns

## Best Patterns (from Portainer, Grafana, Railway, n8n, Botpress)

- **Summary tiles** — Active/Error/Idle/Deploying cards with sparklines
- **Sidebar nav** — Dashboard, Bots, Templates, Logs, Analytics, Settings
- **Real-time panels** — WebSocket, 10-30s update interval
- **Split-panel detail** — Click row → detail slides in, no context loss
- **Form-first, YAML toggle** — Visual for simple fields, YAML for power users
- **Search-first nav** — Faceted search as primary nav for 100+ bots

## Anti-Patterns to Avoid
- Stale data (must be WebSocket)
- Deep modal nesting
- YAML-first config
- Logs detached from context
- No audit trail

## Tech Stack
Next.js 16, Socket.IO, shadcn/ui + Radix UI, TanStack Query, Recharts, Tailwind 4, Fly.io
