# Kristina incentive system — how it works today + best-in-class redesign

**Date:** 2026-06-09. No code — design recommendations. Sources: 2 incentive-design experts (mechanism-design + behavioral) + 2 research streams (gig/bounty/commission/SLA + OKR/gamification/behavioral-econ). All four converged.

---

## PART 1 — How the system works today (ground truth from the code)

It's a **piece-rate compensation/scoreboard for a remote EA (Kristina; also Sara/Hendrik)**, administered by the bot. Money model lives in `lib/decay.js`, `lib/working-hours.js`, `lib/db.js` (computeBalance/markTaskDoneLocally), and the cron jobs.

**The bounty + decay engine**
- Every task = a flat **$1.00 bounty** if delivered by its deadline. *All tasks worth the same, regardless of importance or effort.*
- Past deadline, value **decays linearly $1.00 → $0 over 20 "working hours,"** then keeps going **negative** (a late task becomes a *debt*, only UI-capped). "Working hour" = the non-standard **Sun–Thu 3pm–1am ET** window.
- **Handoff freeze:** if Kristina delegates a task *before* its deadline, value freezes at $1.00 (full credit kept by handing off on time).
- **Completing a task pays its current value:** on-time = +$1.00, late = reduced, very late = negative.

**Automatic deductions (two nudge crons)**
- `nudge_send` (5pm Sun–Thu): DMs about In-Progress tasks with no recent activity — "status? ($0.10 deduction at 7pm if no reply)."
- `nudge_deductions` (7:05pm): applies a **$0.10 deduction per un-answered nudge**, **capped $5/day** per person. Writes a `deductions` row.

**Manual deductions** (`record_deduction` tool): an **arbitrary $ penalty** with a free-text reason; creates a visible `[PENALTY]` card and a deductions row. One-sided (no symmetric bonus).

**Balance** (`get_balance` / `/balance`): **monthly**. `Net = earned (sum of completed task values) − deductions − overdue debt`. Reported on demand.

**Prioritization:** Mark's **only** lever is the **deadline** — an earlier deadline makes decay bite sooner. There is no way to mark a task as more important or more valuable than another.

---

## PART 2 — What's wrong with it (first principles, where all 4 agents agreed)

1. **Flat $1/task = no priority signal + an equity violation.** A 4-constraint flight booking pays the same as forwarding an email. The rational worker does cheap/fast/unambiguous tasks and lets hard, important, ambiguous ones rot — the system literally pays to deprioritize the most valuable work.
2. **It rewards COUNT, not VALUE** → task-count inflation/atomization (split one job into five $1 cards), cherry-picking, hard-task avoidance.
3. **Negative debt is the worst feature** — unbounded downside on a $1 upside. Causes *concealment and abandonment* of underwater tasks (touching them realizes the loss), and is demoralizing/trust-eroding.
4. **The deadline is overloaded** — it's forced to encode urgency AND importance AND decay-rate at once. So Mark sets fake-early deadlines to signal "this matters," and deadlines stop meaning "when it's needed."
5. **Quality is unmeasured → it gets starved** (Holmström–Milgrom multitask theorem, the load-bearing result: pay hard on the measured axis and the unmeasured ones — judgment, thoroughness, taste — are sacrificed *by construction*). Nothing pays for "done *well*"; a redo can even pay twice.
6. **Nudge-deductions reward replying to the bot, not progress** ("still on it" defeats it), tax deep-focus time, read as surveillance (reactance), and the $5/day cap creates an end-of-day "responsiveness is now free" collapse.
7. **Arbitrary, unappealable penalties are the #1 trust-killer** (procedural justice > payout size; MTurk/Boomerang research: a one-sided unappealable penalty from an automated scorer is the most corrosive design known).
8. **It's ~80% stick, ~0% carrot, 100% individual** — no recognition, no visible progress, no purpose. The monthly view is a *ledger of failure*, not a scoreboard of wins. At $1/task the money is below the threshold of caring AND risks crowding out the intrinsic motivation of a salaried EA (overjustification).

**What to KEEP:** per-task visibility + immediate feedback loop (its real asset); deadline as time-salience; handoff-freeze (correctly models "not your fault"); loss-aversion as the engine (just re-pointed).

---

## PART 3 — Mark's prioritization levers (the missing piece)

**Separate Importance from Urgency — Mark owns importance, the bot infers urgency.** (Eisenhower; SLAs; WSJF.)

- **IMPORTANCE → value tier (a multiplier), set by Mark when it matters.** Use a small, discrete set, not free-form dollars (free-form invites haggling). Recommended **super-linear** tiers so the higher tier always wins when the worker must choose:

  | Tier | Multiplier | Meaning | Target frequency |
  |---|---|---|---|
  | Routine | **0.5×** | nice-to-have | ~30% |
  | Standard | **1×** (default) | normal work | ~50% |
  | Important | **3×** | do this over standard work | ~15% |
  | Drop-everything (P0) | **8×** + responsiveness override | rare, stop other work | ~5% |

- **Scarcity is the anti-inflation device:** give Mark a **weekly P0/P1 budget** (e.g. ≤2 P0 + ≤6 P1 per week). If everything is urgent, nothing is — a budget forces Mark to *reveal* true priorities (and disciplines the principal, who is usually the source of priority inflation). Cap active "Now" at ~1 and "Today" at ~3.
- **URGENCY → the deadline = the true need-by date** (stop faking it), and **decay steepness scales with tier** (convex/steep for P0/P1 — slightly late on something critical is heavily penalized; gentle, floored-at-$0 for routine).
- **Temporary boost (SPIF/sales-modifier pattern):** a one-tap multiplier Mark can slap on a task/project "this week" without rewriting anything.
- **The sequencing brain = WSJF:** the bot orders the queue by **(value + time-criticality) ÷ job-size** so the highest value-per-hour, nearest-deadline item surfaces first — and protects a slice for important-but-not-urgent (the quadrant that currently always starves).

---

## PART 4 — Best-in-class incentive structure (the recommended design)

**Philosophy:** pay for *priority-weighted, quality-gated, time-decayed VALUE* — never raw count. Keep the loss-aversion engine; bound the downside; gate speed on quality; insure the week, reward the month.

1. **Unit of value:** `earned = $1 base × ImportanceTier(0.5/1/3/8) × DecayFactor(0→1, FLOORED AT 0) × QualityGate`.
2. **Pay structure — hybrid, not pure piece-rate:** ~**70% stable base** (insurance + protects intrinsic motivation) + ~**30% variable bounty pool**. Calibrate so a normal good month earns the *full* variable — the dollar figures are a **steering wheel and scoreboard, not the paycheck.** (Holmström–Milgrom + overjustification both say keep the variable component low-powered for judgment work.)
3. **No negative balance.** Floor every task at **$0** (a blown deadline earns *nothing*, never a debt). **Relocate loss-aversion** to an **endowed pool with clawback**: the month's variable pool starts "full" and missed commitments *draw it down* — the single most evidence-backed structural choice (Fryer–Levitt teacher experiment: loss-framed/clawback beat gain-framed bonuses, which were null). Add a **forgiveness valve** (a "streak-freeze" / one protected bad day) so PTO or a chaos day doesn't nuke momentum (Duolingo: −21% churn).
4. **Quality protection (non-negotiable counterweight):**
   - **Reopen/rejected ⇒ QualityGate = 0, and the redo does NOT pay again** (kills "fast-and-wrong pays, redo pays twice").
   - **Safelite rework-liability:** a defect must be fixed before new paid tasks flow.
   - **Clawback** (sales 90-day analog) if a "done" task later proves wrong.
   - **Scarce "+15% excellent" star** — Mark needs an *upside* lever symmetric to the penalty card.
   - **No early-finish bonus** (value caps at on-time) so speed never cannibalizes quality; speed only matters vs. decay *after* the deadline.
   - **Hold back the rubric / boss spot-check** (Kaggle hidden-holdout) so the score can't be gamed to the visible metric.
5. **Throughput without busywork:** a consistency multiplier on **priority-weighted, quality-gated earned VALUE**, never task count. Tier system already deflates atomization (a swarm of routine cards pays 0.5× each).
6. **Delegation:** handoff should pay **less than completion** (e.g. 0.7×) or split credit with the doer — full $1 for delegating invites hot-potato. ADD a **"blocked / waiting-on-X" state** (the missing sibling of handoff-freeze): one tap freezes the clock + logs the blocker (and shows Mark what's stuck *on him*) — removes the biggest injustice (going negative while waiting on a third party).
7. **Fix responsiveness:** tie the nudge to **progress signals** (status change / note / completion), not to replying to the bot; fold it into a small **monthly responsiveness factor (±5%)** instead of per-incident dings; **exempt declared focus blocks**; remove the cliff cap; P0 nudges uncapped.
8. **Recognition + progress (the biggest omission):** specific verbal praise is the **only** reward type that reliably *raises* intrinsic motivation (Deci–Koestner–Ryan praise d≈+0.31). Add a one-tap "that mattered / thank you" from Mark on a task, surfaced on the dashboard and monthly summary. Reframe the monthly view from a loss-ledger into a **contribution scoreboard** (wins, on-time %, streaks, "biggest save," progress bar with an *earned head-start* framing — endowed-progress effect 19%→34%).
9. **Procedural justice:** every automated deduction must be **transparent, consistent, explained, and contestable** (an appeal path to Mark). Kill arbitrary unappealable penalties. No retroactive mid-period rule changes. This is what makes loss-framing feel *fair* rather than punitive.
10. **Daily focus surface:** the bot proposes a ranked **"Today's Top 3"** from Mark's importance tiers + inferred urgency; the EA executes in order while dependency-blocked items run in parallel in the background (Ivy Lee + OKR rule-of-3 + 4DX scoreboard).

---

## PART 5 — How to change OUR system to mirror it (KEEP / CHANGE / ADD)

**KEEP:** per-task tracking + immediate "done" feedback; deadline as time-salience; handoff-freeze; the decay engine (re-pointed).

**CHANGE:**
- Flat $1 → **$1 × importance tier (0.5/1/3/8)**. (New: a tier field on tasks; default Standard.)
- Linear-to-**negative** decay → decay **floored at $0**, steepness by tier; relocate loss-aversion to a monthly **endowed pool + clawback** with a forgiveness freeze.
- `markTaskDoneLocally` earning → multiply by tier + apply a **QualityGate** (reopen ⇒ $0, no double-pay).
- `nudge_deductions` (reply-or-pay, $5 cap) → progress-based, smoothed into a **monthly ±5% responsiveness factor**, focus-block exempt, no cliff.
- `record_deduction` (arbitrary, unappealable) → **logged, reasoned, contestable** adjustment; add a symmetric **bonus/"excellent" card**.
- Monthly balance = `earned − deductions − debt` → **contribution scoreboard** (no debt; pool draw-down framing; wins/streaks/progress).
- Deadline-as-only-priority → **deadline = true need-by**, importance carried by the tier.

**ADD:**
- **Importance tiers + weekly P0/P1 budget** (Mark's real prioritization lever).
- **WSJF-style ranked "Today's Top 3"** queue surfaced to the EA.
- **"Blocked / waiting-on-X" state** (clock-freeze + blocker log + Mark's stuck-on-me view).
- **Recognition layer** (one-tap thank-you) + the "+15% excellent" star.
- **Quality gate / reopen-no-double-pay + rework-liability + clawback.**
- **Appeal path** for every automated deduction; full per-card + per-month transparency.
- **Temporary SPIF multiplier** Mark can apply for a week.

---

## The one-line version
Replace **"one flat decaying dollar per task, with a debt tail and arbitrary fines"** with **"a tiered, quality-gated, downside-floored bounty pool on top of a stable base — where Mark sets importance (rationed by a weekly budget) separately from urgency, the bot ranks the daily Top-3 by value-per-hour, lateness forfeits upside but never creates debt, quality is gated not assumed, blocked-on-others is protected, and recognition + visible progress carry as much weight as the cash."** Keep the loss-aversion engine; stop pointing it at task-count and at the worker's morale; point it at priority-weighted, quality-gated value.

### Biggest caveats for Mark
- The tier system only works if **Mark uses it honestly** — the weekly P0/P1 budget is a constraint on *him* (a feature: it forces real prioritization).
- Quality gating only works if **Mark actually reopens/stars** tasks — the bot can't manufacture a quality signal he won't give.
- For a *salaried* EA, the highest-ROI move may be to **de-emphasize cash entirely** and lean on tiers-as-priority + recognition + progress visibility, treating the dollar as a scoreboard. At $1/task the money motivates almost nothing; the debt mechanic does real damage.
