# Botforge Reliability: Preventing Credit-Exhaustion Silent Failures

**Context:** 3-4 always-on LLM bots sharing one Anthropic account. Failure mode: spend cap or credit balance hits zero, every bot silently returns "Failed to process" to users, no operator alert fires. This happened 2026-05-25 (Kristina) and is a repeatable class of problem, not a one-off.

---

## Priority Ranking (Impact / Effort)

| # | Fix | Impact | Effort | Cost |
|---|-----|--------|--------|------|
| 1 | Enable Anthropic auto-reload | Eliminates exhaustion outages entirely | 5 min | Pay-as-you-go |
| 2 | Set workspace spend-alert at 80% of budget | Advance warning before cap hits | 5 min | Free |
| 3 | Classify billing errors, send operator Telegram alert | You hear it first, not users | ~1 hr | Free |
| 4 | Heartbeat / dead-man's-switch per bot | Detects total silence (crash, not just billing) | ~1 hr | Free (Better Stack) |
| 5 | LiteLLM proxy for provider failover | Survives Anthropic outages, not just billing | ~3 hr | Free (self-hosted) |
| 6 | Lightweight status page | Users see current status instead of cryptic error | ~30 min | Free |

---

## 1. Upstream Credit/Quota Exhaustion

### The Core Problem
Anthropic and OpenAI both use prepaid credit models. When balance hits zero (or a manually-set spend cap), the API returns an error. That error is **the same HTTP 400 / error type** for three different root causes: actual zero balance, spend cap exceeded, and stale/orphaned API key. The API does not distinguish them, so the caller cannot self-diagnose.

### What Best-in-Class Operators Do

**A. Auto-reload (eliminate the failure class entirely)**

Anthropic console supports auto-reload natively:
- Console → Settings → Billing → Edit (auto-reload section)
- Set a minimum balance threshold (e.g., $10) and a reload amount (e.g., $50)
- When balance drops below threshold, it charges your card and tops up automatically
- There is also a monthly reload cap you can set to prevent runaway spend

OpenAI has the same feature ("Auto recharge") under Settings → Billing → Payment methods. It is ON by default for new accounts; minimum recharge is $5.

**Minimal action:** Enable Anthropic auto-reload today. Set minimum $15, reload to $50, monthly cap $200. This single action eliminates the "balance hit zero" outage permanently. The spend-cap-causing-outage failure mode (2026-05-25 incident) is separate — that was a monthly workspace limit, not a zero balance. Both need addressing.

**B. Spend-cap alerting before the hard stop**

The spend cap itself can cause an outage (as it did in the Kristina incident). Set an email alert at 80% of the cap:
- Console → Workspaces → [workspace] → Limits tab → Add notification
- Set threshold at 80% of your workspace spend limit
- You get an email with ~20% headroom to act before the hard stop triggers

Also: make your spend cap meaningfully higher than your normal monthly burn. If bots burn $25/month, set the cap at $100 — not $30 (which gives no buffer). The cap exists to catch runaway loops, not to be a routine billing gate.

**C. Proactive balance polling (belt-and-suspenders)**

Anthropic's Usage & Cost Admin API allows programmatic spend monitoring. Requires an Admin API key (`sk-ant-admin...`) from Console → Settings → Admin Keys.

```bash
# Check last 24h spend
curl "https://api.anthropic.com/v1/organizations/cost_report?\
starting_at=$(date -u -v-1d +%Y-%m-%dT00:00:00Z)&\
ending_at=$(date -u +%Y-%m-%dT23:59:59Z)&\
bucket_width=1d" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY"
```

Note: The Usage/Cost API does NOT expose current credit balance directly — only historical spend. You infer proximity to cap by comparing spend to your known cap. The API is available only if you have an Organization set up in Console (not individual accounts).

**D. Redundant accounts / keys**

For a fleet this small, a second Anthropic account with a loaded backup key is cheap insurance. Keep $20 pre-loaded. Circuit-break to the backup key on `credit_balance_too_low`. This is extreme for most solo operators — auto-reload achieves the same outcome without key rotation complexity.

---

## 2. Proactive Alerting

### The Core Problem
The operator learns about failures from end users. The bot returns a vague "Failed to process" message. There is no channel that pages the operator at the moment of failure.

### What Best-in-Class Operators Do

**A. Classify errors at the source, send Telegram alert immediately**

The existing `classifyError`/`renderError`/`maybeNotifyAdmin` framework (shipped 2026-05-25 as `fix/honest-errors-on-main`) already has this structure. The gap: `credit_balance_too_low` must send a Telegram DM to the operator immediately, not just return honest copy to the user.

Minimal implementation — add to the `maybeNotifyAdmin` path:

```typescript
// Detect billing exhaustion from Anthropic error
function isBillingError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes('credit_balance_too_low') ||
    msg.includes('insufficient credits') ||
    msg.includes('credit balance is too low') ||
    (err as any)?.status === 402
  );
}

// In error handler — fire immediately, don't queue
if (isBillingError(err)) {
  await telegramAdmin.sendMessage(
    OPERATOR_CHAT_ID,
    `BILLING ALERT: ${botName} hit credit_balance_too_low at ${new Date().toISOString()}. ` +
    `Check https://console.anthropic.com/settings/billing`
  );
}
```

**B. Dead-man's-switch per bot (heartbeat monitoring)**

A heartbeat monitor inverts the monitoring model: your bot pings a URL every N minutes to say "I am alive and healthy." If the ping stops, you get paged. This catches ALL silent failure modes — billing, crashes, deploy failures, systemd restarts that get stuck — not just billing.

**Better Stack** (betterstack.com/uptime) is the best choice here:
- Free plan: 10 heartbeat monitors, email + Slack alerts, 3-minute check interval
- Telegram alerts available on free plan via the Telegram integration
- Setup: create a heartbeat with a 5-minute interval + 5-minute grace period; drop a `curl` ping into each bot's main loop

```typescript
// In bot's cron handler, after successful processing:
const HEARTBEAT_URL = process.env.BOTFORGE_HEARTBEAT_URL; // per-bot
if (HEARTBEAT_URL) {
  fetch(HEARTBEAT_URL).catch(() => {}); // fire and forget
}
```

If a billing failure silences the bot, the heartbeat stops, Better Stack pages you within ~10 minutes.

**Alternative: healthchecks.io** — open source, self-hostable, BSD license. Free hosted plan available. Native Telegram integration. Slightly less polished UI than Better Stack but functionally equivalent.

**C. Error-rate alerting**

For bots processing user messages, track the rate of error responses vs. successful responses. A sudden spike to 100% errors is a signal. If you already log to a SQLite/Postgres database, a 5-minute cron that runs:

```sql
SELECT COUNT(*) as errors FROM messages
WHERE created_at > NOW() - INTERVAL '10 minutes'
AND status = 'error';
```

...and alerts if errors > threshold is sufficient. No external service required.

---

## 3. Graceful Degradation and Honest Error UX

### The Core Problem
Users receive "Failed to process" — a message that (a) gives no information and (b) sounds like a permanent failure, causing trust erosion.

### What Best-in-Class Products Do

The principle: **transparency beats silence**. Users forgive service disruptions when they understand what is happening. They do not forgive being stonewalled.

**Error message hierarchy by error class:**

| Error class | Anthropic error | User-facing copy |
|---|---|---|
| Billing exhaustion | `credit_balance_too_low` | "I'm temporarily offline due to a billing issue. The operator has been notified and should have this resolved within an hour." |
| Rate limit | `429 rate_limit_error` | "I'm getting too many requests right now. Try again in 60 seconds." |
| Provider outage | `529 overloaded_error` | "The AI service is under heavy load. I'll retry automatically — check back in a few minutes." |
| Transient error | `500 api_error` | "Something went wrong on my end. I'm trying again — if this persists, let [operator] know." |
| Unknown | anything else | "I ran into an unexpected error (ref: [error-id]). The operator has been notified." |

The key improvements over "Failed to process":
1. Tell users whether to wait or take action
2. Tell them who has been notified and that someone is on it
3. For billing errors specifically: do not say "billing" to end users if the bots are consumer-facing. Say "temporary service disruption."

**Circuit breaker pattern for billing errors:**

Once a `credit_balance_too_low` is detected, a circuit breaker trips to OPEN state. All subsequent requests fail fast (no API call, no burn) with the honest user message. The circuit probes back to CLOSED every 5 minutes with a lightweight `$0.001` test message. This prevents continued failed API calls burning through whatever credits remain (e.g., if there is a race between the cap and a reload).

```typescript
// Minimal circuit breaker for billing
class BillingCircuitBreaker {
  private state: 'closed' | 'open' = 'closed';
  private openedAt: number | null = null;
  private readonly probePeriodMs = 5 * 60 * 1000; // 5 min

  isBroken(): boolean {
    if (this.state === 'open' && this.openedAt) {
      if (Date.now() - this.openedAt > this.probePeriodMs) {
        this.state = 'closed'; // half-open probe
      }
    }
    return this.state === 'open';
  }

  trip(): void {
    this.state = 'open';
    this.openedAt = Date.now();
  }

  reset(): void {
    this.state = 'closed';
    this.openedAt = null;
  }
}
```

**Retry policy:**

Only retry `429` and `529`. Never retry `400 credit_balance_too_low` — the error will not resolve on its own within the retry window. Retry `500` once with exponential backoff (1s, 3s). Maximum 3 total attempts for transient errors.

---

## 4. Status Visibility

### What Best-in-Class Operators Do

For a tiny fleet, a status page is optional but valuable: it gives users a URL to check rather than messaging the bot or the operator.

**Minimal option — Better Stack status page (free):**
Better Stack's free plan includes a status page. It is automatically updated when a heartbeat monitor goes into incident state. No manual incident posting required. You get a URL like `status.botforge.example.com` that shows green/red per bot.

**Alternative — Uptime Kuma (self-hosted, free):**
Run on acemagic alongside the bots. Docker image, 200MB RAM. Web UI at `http://acemagic:3001`. Supports Telegram push notifications. Built-in status page. Works without any external service.

```bash
docker run -d --restart=always \
  -p 3001:3001 \
  -v uptime-kuma:/app/data \
  --name uptime-kuma louislam/uptime-kuma:1
```

**What to monitor on the status page:**
- One entry per bot (heartbeat-style)
- Anthropic API status feed: `https://status.anthropic.com` (RSS/JSON available via StatusGator)
- The acemagic host itself (ping monitor)

For a solo operator with only a handful of technically-adjacent users, a Telegram channel (`@botforge_status`) where you post incident updates is sufficient and takes 0 setup time.

---

## 5. Cost Guardrails

### The Failure Mode

The 2026-05-25 Kristina incident was caused by a **monthly workspace spend cap** acting as a hard stop. A protective cap that is set too close to normal spend will routinely trigger outages. This is a well-known failure mode — the guardrail becomes the incident.

### Best-in-Class Pattern: Layered Budget Controls

```
Layer 1: Auto-reload (eliminates zero-balance outages)
   └── Minimum balance: $15 → reload to $50
Layer 2: Workspace spend cap (catches runaway loops)
   └── Set at 3-5x normal monthly burn, NOT at 1.1x
Layer 3: Spend alert at 80% of workspace cap
   └── Gives you time to act before the cap triggers
Layer 4: Application-level token budget per request
   └── max_tokens: 1024 (or appropriate for use case)
   └── Prevents a single runaway conversation from being expensive
Layer 5: Spend-spike cron (programmatic)
   └── If today's spend > 3x yesterday's average, alert immediately
```

**Specific settings for botforge:**
- Workspace spend cap: $150/month (if normal burn is $25-40/month)
- Auto-reload: minimum $15, reload to $60
- Email alert: at $80 (roughly 80% of $100 effective cap before buffer)
- Do NOT set the spend cap at $30 if you spend $25 — that's a single bad day from an outage

**The spend-spike detector (5-minute cron, runs on acemagic):**

```bash
#!/bin/bash
# /opt/botforge/scripts/spend-check.sh
ADMIN_KEY="$ANTHROPIC_ADMIN_KEY"
BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
CHAT_ID="$OPERATOR_CHAT_ID"
THRESHOLD_RATIO=3  # alert if today > 3x yesterday

TODAY_SPEND=$(curl -s "https://api.anthropic.com/v1/organizations/cost_report?\
starting_at=$(date -u +%Y-%m-%dT00:00:00Z)&\
ending_at=$(date -u +%Y-%m-%dT23:59:59Z)&\
bucket_width=1d" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $ADMIN_KEY" | jq -r '.data[0].total_cost // "0"')

# Compare against rolling 7-day average and alert if spike detected
# (Full implementation: compare against stored baseline in /tmp/spend-baseline.json)
echo "Today spend: $TODAY_SPEND"
```

Note: the Anthropic Cost API requires an **Admin API key** (`sk-ant-admin...`), not a regular API key. Provision one at Console → Settings → Admin Keys. Store it separately from bot keys — it has read access to all org spend data.

---

## Minimum Viable Setup (Do These in Order)

1. **Right now (5 min):** Enable auto-reload in Anthropic Console. Set cap alert at 80%.
2. **Today (30 min):** Add billing-error detection to `maybeNotifyAdmin` — send Telegram DM immediately on `credit_balance_too_low`.
3. **This week (1 hr):** Add a heartbeat ping to each bot's main processing loop. Wire to Better Stack free plan with Telegram alerts.
4. **This week (1 hr):** Expand error copy per the table above. Replace "Failed to process" with class-specific messages.
5. **Optional (3 hr):** Deploy LiteLLM proxy on acemagic with an OpenAI backup key for Anthropic outage failover.

---

## Tools Reference

| Tool | What it does | Cost | Notes |
|---|---|---|---|
| Anthropic Console auto-reload | Prevents zero-balance outage | Free (you pay for credits consumed) | Console → Settings → Billing |
| Anthropic Workspace spend alert | Email at % of cap | Free | Console → Workspaces → Limits → Add notification |
| Anthropic Admin API `/v1/organizations/cost_report` | Programmatic spend data | Free | Requires `sk-ant-admin...` key |
| Better Stack (betterstack.com) | Heartbeat + status page + on-call | Free (10 monitors) | Telegram integration on free tier |
| healthchecks.io | Heartbeat / dead-man's-switch | Free (self-hostable) | BSD license, Telegram integration |
| Uptime Kuma | Self-hosted monitoring + status page | Free (self-host) | Run on acemagic, ~200MB RAM |
| LiteLLM proxy | Multi-provider failover, budget tracking | Free (self-host) | overkill for 3 bots, powerful |
| Portkey | Managed LLM gateway with failover | $49/month + API costs | More than needed at this scale |

---

## What Enterprise SREs Do That Solo Operators Can Skip

- Multi-region provider failover with parallel hedging (doubles token costs)
- PagerDuty on-call rotation (there's one person)
- 99.9% SLA commitments (these are internal bots)
- Full observability stack (Datadog, Honeycomb, etc.) — overkill, $100+/month
- Runbook automation — document instead

The minimum viable stack for a solo operator running 3-4 Telegram bots on one Linux box: auto-reload + billing alert email + Telegram alert on billing error in code + Better Stack heartbeat per bot. Total cost: ~$0/month extra, ~2 hours to implement. This eliminates silent outages.
