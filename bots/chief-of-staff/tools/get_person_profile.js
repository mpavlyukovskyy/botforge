import { z } from 'zod';
import { getProfile } from '../lib/person-profiles.js';

const getPersonProfileTool = {
  name: 'get_person_profile',
  description:
    'Look up a person\'s profile by email address. Returns their role, company, communication ' +
    'style, topics, open items, and last interaction.',
  schema: {
    email: z.string().describe('Email address of the person to look up'),
  },
  permissions: { db: 'read' },
  execute: async (args, ctx) => {
    const { email } = args;

    const profile = getProfile(ctx, email);
    if (!profile) {
      return `No profile found for ${email}. Use search_emails to find their history.`;
    }

    const lines = [];

    lines.push(`=== PERSON PROFILE: ${profile.display_name} ===`);
    lines.push(`Email: ${profile.email}`);
    if (profile.slug) lines.push(`Slug: ${profile.slug}`);
    if (profile.role) lines.push(`Role: ${profile.role}`);
    if (profile.company) lines.push(`Company: ${profile.company}`);
    if (profile.category) lines.push(`Category: ${profile.category}`);
    if (profile.relationship_to_mark) lines.push(`Relationship: ${profile.relationship_to_mark}`);

    // Communication style
    if (profile.formality_level || profile.response_cadence || profile.communication_notes) {
      lines.push('');
      lines.push('--- Communication Style ---');
      if (profile.formality_level) lines.push(`Formality: ${profile.formality_level}`);
      if (profile.response_cadence) lines.push(`Response cadence: ${profile.response_cadence}`);
      if (profile.communication_notes) lines.push(`Notes: ${profile.communication_notes}`);
    }

    // Topics
    const topics = profile.topics || [];
    if (topics.length > 0) {
      lines.push('');
      lines.push('--- Topics ---');
      for (const t of topics) {
        lines.push(`- ${typeof t === 'string' ? t : t.name || JSON.stringify(t)}`);
      }
    }

    // Open items
    const openItems = profile.openItems || [];
    if (openItems.length > 0) {
      lines.push('');
      lines.push('--- Open Items ---');
      for (const item of openItems) {
        lines.push(`- ${typeof item === 'string' ? item : item.description || JSON.stringify(item)}`);
      }
    }

    // Last interaction
    if (profile.last_interaction_summary) {
      lines.push('');
      lines.push('--- Last Interaction ---');
      if (profile.last_interaction_date) lines.push(`Date: ${profile.last_interaction_date}`);
      lines.push(profile.last_interaction_summary);
    }

    // Metadata
    lines.push('');
    lines.push(`Confidence: ${profile.confidence} | Stale: ${profile.stale ? 'yes' : 'no'} | Last compiled: ${profile.last_compiled_at || 'never'}`);

    return lines.join('\n');
  },
};

export default getPersonProfileTool;
