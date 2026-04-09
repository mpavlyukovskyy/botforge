# Alfred Bot — Contributor Guide

Alfred is Sara's personal task assistant on Telegram with a web dashboard.

## Dashboard

The dashboard is a kanban board showing all tasks. It's publicly accessible (no login required).

**URL:** Mark will share the current Cloudflare tunnel URL. It looks like `https://xxx.trycloudflare.com/board`.

What you can do on the dashboard:
- View all tasks in a kanban board (To Do / In Progress / Done)
- Create new tasks
- Edit task details, add subtasks
- Move tasks between columns
- Mark tasks as done

## Telegram Commands

Talk to **@AlfredoWorkingbot** in Telegram. You can use commands or just type naturally.

| Command | What it does |
|---------|-------------|
| `/status` | Show open tasks summary |
| `/home` | List home tasks |
| `/work` | List work tasks |
| `/done` | Mark a task as done (shows picker) |
| `/refresh` | Re-scrape LunchDrop menus |
| `/help` | Show all commands |

**Natural language works too.** Examples:
- "Add a task to buy groceries"
- "What's on my list?"
- "Mark the laundry task as done"
- "What's for lunch this week?"

## Making Changes via GitHub

You don't need to install anything. Edit files directly on github.com:

1. Go to the repo: `github.com/mpavlyukovskyy/botforge`
2. Navigate to `standalone/taskbot/`
3. Click on the file you want to edit
4. Click the pencil icon (edit)
5. Make your changes
6. Click **"Commit changes"** — commit directly to `main`

That's it. The deploy starts automatically.

## How Deploy Works

1. You push a change to `standalone/taskbot/**` on the `main` branch
2. GitHub Actions builds the project on the server
3. The new code is copied to the server
4. The bot restarts
5. A health check runs — if it fails, **the previous version is automatically restored**

You can check deploy status in the **Actions** tab on GitHub.

## Common Edits

### Change bot personality
Edit `src/ai/claude.ts` — the system prompt near the top defines how Alfred talks.

### Change cron schedule
Edit `src/scheduler/cron.ts` — daily digest time, auto-archive schedule, and LunchDrop scrape schedule.

### Add or change Telegram commands
Edit `src/telegram/commands.ts` — each command handler is a function. Add new ones following the same pattern.

### Change dashboard look
Edit `src/web/templates.ts` — the HTML/CSS for all dashboard pages. Edit `src/web/static.ts` for JavaScript behavior.

## Key Files

| File | What it does |
|------|-------------|
| `src/ai/claude.ts` | AI brain — system prompt, tool handling |
| `src/ai/tools.ts` | Tools Alfred can use (create task, mark done, etc.) |
| `src/telegram/commands.ts` | Telegram slash commands |
| `src/telegram/bot.ts` | Telegram message handling |
| `src/scheduler/cron.ts` | Scheduled jobs (daily digest, LunchDrop) |
| `src/lunch/` | LunchDrop scraping + meal recommendations |
| `src/web/server.ts` | Dashboard web server |
| `src/web/templates.ts` | Dashboard HTML pages |
| `src/config.ts` | Environment variable config |
| `src/db/schema.sql` | Database schema |

## If Something Breaks

**Don't panic.** The deploy system has automatic rollback:

- If the health check fails after deploy, the previous working version is restored automatically
- The bot will keep running on the old code
- Check the **Actions** tab on GitHub to see what happened
- If you're stuck, message Mark

## Environment Variables

The `.env.example` file shows all config options. Only three are required:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `ANTHROPIC_API_KEY`

Everything else has defaults or is optional. You shouldn't need to touch these — they're already set on the server.
