/**
 * Cron handler: profile_compile
 *
 * Incrementally updates stale person profiles using Sonnet.
 * Processes max 3 stale profiles per run. Runs every 30 min.
 */
import { getStaleProfiles, upsertProfile, markFresh } from '../lib/person-profiles.js';
import { getContactHistory, getAllEmailsForContact } from '../lib/email-intel-db.js';
import { getByPerson } from '../lib/commitments-db.js';
import { compile } from '../lib/claude.js';

const COMPILE_SYSTEM_PROMPT = `You are a profile compiler. Given context about a person's email interactions with Mark, produce a structured JSON profile.

Return ONLY valid JSON with these fields:
{
  "role": "their job title/role or null",
  "company": "their company or null",
  "relationshipToMark": "brief description of how they relate to Mark",
  "formalityLevel": "formal | professional | casual",
  "responseCadence": "description of typical response timing, e.g. 'replies within hours' or 'weekly cadence'",
  "communicationNotes": "any notable communication patterns or preferences",
  "topics": ["array", "of", "topic", "strings"],
  "openItems": ["array of currently open/pending items between them"],
  "lastInteractionSummary": "one sentence summary of the most recent interaction"
}

Be concise. Infer from the data — do not invent facts not supported by the context. If a field cannot be determined, use null (for strings) or empty array (for arrays).`;

export default {
  name: 'profile_compile',
  async execute(ctx) {
    // Register event handler once for reactive profile compilation
    if (!ctx.store.get('_profileEventRegistered')) {
      const bus = ctx.store.get('eventBus');
      if (bus) {
        bus.on('profile.stale', async (event) => {
          ctx.log.info(`Event-triggered profile compile for ${event.email}`);
          try {
            const staleProfiles = getStaleProfiles(ctx, 1);
            const matchingProfile = staleProfiles.find(p => p.email === event.email);
            if (matchingProfile) {
              // The existing cron execute logic will pick it up on next run
              // For immediate processing, we'd need to extract the compile logic
              // For now, just log that we detected the stale profile
              ctx.log.info(`Profile ${event.email} is stale, will be compiled on next cron cycle or via this event`);
            }
          } catch (err) {
            ctx.log.warn(`Event handler profile.stale error: ${err.message}`);
          }
        });
        ctx.store.set('_profileEventRegistered', true);
        ctx.log.info('Profile compile: registered profile.stale event listener');
      }
    }

    // Get up to 3 stale profiles
    const staleProfiles = getStaleProfiles(ctx, 3);

    if (staleProfiles.length === 0) {
      ctx.log.info('Profile compile: no stale profiles');
      return;
    }

    let updated = 0;
    let failed = 0;

    for (const profile of staleProfiles) {
      try {
        // Gather context
        const contactHistory = getContactHistory(profile.email);

        // Get recent emails — if profile was previously compiled, only since then;
        // otherwise get all emails (capped by getAllEmailsForContact's limit)
        let emails = [];
        if (profile.last_compiled_at) {
          // Get emails since last compile (use searchEmails via getContactHistory for recent)
          emails = contactHistory?.recentEmails || [];
        } else {
          // First compile — get full history (capped at 500)
          emails = getAllEmailsForContact(profile.email, 200);
        }

        // Get commitments involving this person
        const commitments = getByPerson(ctx, profile.email);
        const activeCommitments = commitments.filter(c => c.status === 'active');
        const recentFulfilled = commitments.filter(
          c => c.status === 'fulfilled' && c.fulfilled_at
        ).slice(0, 5);

        // Build context string
        const contextParts = [];

        contextParts.push(`=== PERSON ===`);
        contextParts.push(`Email: ${profile.email}`);
        contextParts.push(`Display name: ${profile.display_name}`);
        if (profile.category) contextParts.push(`Category: ${profile.category}`);
        if (profile.company) contextParts.push(`Company: ${profile.company}`);
        contextParts.push('');

        // Contact record from email-intel
        if (contactHistory?.contact) {
          const c = contactHistory.contact;
          contextParts.push(`=== CONTACT RECORD ===`);
          contextParts.push(`Total emails exchanged: ${c.email_count || 0}`);
          if (c.category) contextParts.push(`Category: ${c.category}`);
          if (c.display_name) contextParts.push(`Display name: ${c.display_name}`);
          contextParts.push('');
        }

        // Customer association
        if (contactHistory?.customer) {
          const cust = contactHistory.customer;
          contextParts.push(`=== CUSTOMER ===`);
          contextParts.push(`Name: ${cust.name}`);
          if (cust.customer_type) contextParts.push(`Type: ${cust.customer_type}`);
          if (cust.customer_status) contextParts.push(`Status: ${cust.customer_status}`);
          if (cust.tier != null) contextParts.push(`Tier: ${cust.tier}`);
          if (cust.primary_technology) contextParts.push(`Technology: ${cust.primary_technology}`);
          contextParts.push('');
        }

        // Email history (summarized)
        if (emails.length > 0) {
          contextParts.push(`=== EMAIL HISTORY (${emails.length} messages) ===`);
          // Show last 15 emails with subject + direction + date
          const recent = emails.slice(-15);
          for (const e of recent) {
            const dir = e.direction === 'received' ? 'FROM them' : 'TO them';
            contextParts.push(`[${e.date}] ${dir}: "${e.subject}"`);
            if (e.body_text) {
              contextParts.push(e.body_text.slice(0, 300));
            }
          }
          contextParts.push('');
        }

        // Active commitments
        if (activeCommitments.length > 0) {
          contextParts.push(`=== ACTIVE COMMITMENTS ===`);
          for (const c of activeCommitments.slice(0, 10)) {
            const due = c.due_date ? ` (due ${c.due_date})` : '';
            contextParts.push(`- [${c.type}] ${c.description}${due}`);
          }
          contextParts.push('');
        }

        // Recently fulfilled
        if (recentFulfilled.length > 0) {
          contextParts.push(`=== RECENTLY FULFILLED ===`);
          for (const c of recentFulfilled) {
            contextParts.push(`- [${c.type}] ${c.description} (fulfilled ${c.fulfilled_at})`);
          }
          contextParts.push('');
        }

        // Previous profile data (for incremental update)
        if (profile.last_compiled_at) {
          contextParts.push(`=== PREVIOUS PROFILE (compiled ${profile.last_compiled_at}) ===`);
          if (profile.role) contextParts.push(`Role: ${profile.role}`);
          if (profile.relationship_to_mark) contextParts.push(`Relationship: ${profile.relationship_to_mark}`);
          if (profile.formality_level) contextParts.push(`Formality: ${profile.formality_level}`);
          if (profile.communication_notes) contextParts.push(`Notes: ${profile.communication_notes}`);
          if (profile.topics?.length > 0) contextParts.push(`Topics: ${profile.topics.join(', ')}`);
          if (profile.openItems?.length > 0) contextParts.push(`Open items: ${profile.openItems.join('; ')}`);
          contextParts.push('');
        }

        const context = contextParts.join('\n');

        const instruction = profile.last_compiled_at
          ? 'Update this person\'s profile with any new information from recent interactions. Preserve existing data that is still accurate. Return JSON only.'
          : 'Create this person\'s profile from the available interaction data. Return JSON only.';

        // Call Sonnet via compile()
        const result = await compile(COMPILE_SYSTEM_PROMPT, context, instruction);

        if (result.is_error) {
          ctx.log.warn(`Profile compile failed for ${profile.email}: ${result.text}`);
          failed++;
          continue;
        }

        // Parse the JSON response
        let parsed;
        try {
          // Extract JSON from response (handle possible markdown code fences)
          let jsonText = result.text.trim();
          const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (jsonMatch) {
            jsonText = jsonMatch[1].trim();
          }
          parsed = JSON.parse(jsonText);
        } catch (parseErr) {
          ctx.log.warn(`Profile compile: JSON parse failed for ${profile.email}: ${parseErr.message}`);
          failed++;
          continue;
        }

        // Determine last interaction date from emails
        let lastInteractionDate = profile.last_interaction_date;
        if (emails.length > 0) {
          const lastEmail = emails[emails.length - 1];
          lastInteractionDate = lastEmail.date || lastInteractionDate;
        }

        // Upsert the profile with compiled data
        upsertProfile(ctx, {
          email: profile.email,
          displayName: profile.display_name,
          slug: profile.slug,
          role: parsed.role || profile.role || null,
          company: parsed.company || profile.company || null,
          category: profile.category,
          relationshipToMark: parsed.relationshipToMark || profile.relationship_to_mark || null,
          formalityLevel: parsed.formalityLevel || profile.formality_level || 'professional',
          responseCadence: parsed.responseCadence || profile.response_cadence || null,
          communicationNotes: parsed.communicationNotes || profile.communication_notes || null,
          topics: parsed.topics || profile.topics || [],
          openItems: parsed.openItems || profile.openItems || [],
          lastInteractionSummary: parsed.lastInteractionSummary || profile.last_interaction_summary || null,
          lastInteractionDate,
          confidence: profile.last_compiled_at ? Math.min((profile.confidence || 0.5) + 0.1, 0.95) : 0.7,
        });

        // markFresh is called by upsertProfile internally (sets stale=0, last_compiled_at),
        // but call explicitly to be sure
        markFresh(ctx, profile.email);

        updated++;

        ctx.log.info(
          `Profile compile: updated ${profile.display_name} (${profile.email})`
        );
      } catch (err) {
        ctx.log.error(`Profile compile error for ${profile.email}: ${err.message}`);
        failed++;
      }
    }

    ctx.log.info(
      `Profile compile: updated=${updated}, failed=${failed}, candidates=${staleProfiles.length}`
    );
  },
};
