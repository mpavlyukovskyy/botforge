# Bot Inventory — Current Fleet

## Overview

| # | Bot | Handle | Port | Purpose | LLM | Maturity |
|---|-----|--------|------|---------|-----|----------|
| 1 | **Maia** (NZPE Agent) | Private | 3100 | PE deal sourcing | Opus+Sonnet | Production |
| 2 | **Harry** (LP Bot) | @harryNZVCbot | 8082 | Campaign reply mgmt | Sonnet | Production |
| 3 | **Babushka** | @babushkaStorybot | 8085 | Audio → knowledge graph | Opus+Whisper | Mature |
| 4 | **Atlas** (Agenda Bot) | @MyAtlasTaskBot | 8086 | Team task tracker | Opus | Functional |
| 5 | **Kristina** | @KristinaWorkingbot | 8087 | Personal task assistant | Opus | Functional |
| 6 | **Ashley** (Email Monitor) | @Ashley1990bot | 8084 | Email classification | Gemini Flash | Mature |
| 7 | **Alfred** (TaskBot) | Configurable | 8090 | Task mgmt + web dashboard | Opus | Newest |

All deployed on OpenClaw via systemd. Source code at `/Users/Mark/Documents/dev/`.

---

## Capability Matrix

| Capability | Maia | Harry | Babushka | Atlas | Kristina | Ashley | Alfred |
|-----------|------|-------|----------|-------|----------|--------|--------|
| **LLM** | Opus+Sonnet | Sonnet | Opus+Whisper | Opus | Opus | Gemini Flash | Opus |
| **Database** | SQLite v7 | SQLite v8 | SQLite v9 | SQLite | SQLite | SQLite | SQLite |
| **Language** | TypeScript | TypeScript | TypeScript | TypeScript | TypeScript | Plain JS | TypeScript |
| **Web Dashboard** | - | - | Yes (vanilla) | - | - | - | Yes (auth) |
| **Conversation History** | 30-day | 30-day | - | 14-day | 14-day | - | Context builder |
| **Inline Keyboards** | Yes | Yes | Yes | - | - | Yes | - |
| **Passive Message Detection** | - | - | - | Yes | Yes | - | Yes |
| **Daily Digest** | - | Yes | - | Yes (AEDT) | Yes (ET) | - | Yes |
| **External API Sync** | Spok CRM | Instantly+Spok | - | Spok (multi-fund) | Atlas board | IMAP IDLE | GCal (planned) |
| **Cron Jobs** | Scraping, email, sync | SLA, suppression | Failed alerts | Auto-archive | Auto-archive | - | Auto-archive |
| **Audio Processing** | - | - | Yes | - | - | - | - |
| **Email Handling** | IMAP + draft | Draft replies | - | - | - | IMAP IDLE | - |
| **File Handling** | PDF gen, NDA upload | - | Audio (all formats) | - | - | - | - |
| **Subtasks** | - | - | - | - | - | - | Yes |
| **Categories** | - | - | - | - | home/professional | - | home/professional |
| **Multi-user** | Single | Single | Single | Yes (Mark+Hendrik) | Single | N/A | Configurable |
| **Local Bot API (8081)** | Yes | - | Yes | Yes | Yes | - | - |

---

## Resilience Tiers

| Tier | Bots | Capabilities |
|------|------|-------------|
| **Production-hardened** | Maia, Harry | Circuit breaker (5-failure), exponential backoff retries (2s→4s→8s), transient error detection (429/502/503), Telegram alerts on API failure, token usage tracking |
| **Intermediate** | Ashley | Simpler circuit breaker (3-failure, 60s reset), 10s fetch timeouts, graceful degradation |
| **Basic** | Babushka, Atlas, Kristina, Alfred | Try/catch with logging, rely on systemd restart |

---

## Deployment Details

| Bot | Wait Time | Health Check | Config Style | Deploy Script |
|-----|-----------|-------------|-------------|---------------|
| Maia | 15s | `/api/health` (JSON) | YAML config dir | Uploads config/ |
| Harry | 30s | `/health` (JSON) | .env only | Longest startup |
| Babushka | 15s | `/health` (JSON) | .env only | Single target |
| Atlas | 10s | `/api/health` | Code-based | Fast startup |
| Kristina | 10s | `/api/health` | Code-based | Identical to Atlas |
| Ashley | 3s | `/health` (rich JSON) | YAML config | Preserves /data |
| Alfred | 10s | `/api/health` | Code-based | Uploads schema.sql |

---

## Code Lineage

- **Atlas → Kristina**: Direct fork (Agenda→Task rename, fundId removed, single-user)
- **Maia → Harry**: Similar architecture (circuit breaker, conversation history, dynamic context), independently evolved
- **Ashley**: Completely different tech stack (Plain JS, Gemini, IMAP) — the outlier
- **Alfred**: Newest bot, only one with web dashboard

---

## Backup Strategy

Shared script at `/opt/nzpe-agent/scripts/backup-databases.sh`:
- Backs up all 4 OpenClaw bot databases daily at 3am UTC
- WAL checkpoints before backup (critical for SQLite consistency)
- 7-day retention with auto-rotation
- Babushka has additional dedicated cron with 30-day retention
