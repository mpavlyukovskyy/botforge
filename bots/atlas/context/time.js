/**
 * Context builder: current_time
 *
 * Injects current time in Australia/Sydney timezone.
 */
export default {
  type: 'current_time',
  async build(ctx) {
    const now = new Date();
    const options = {
      timeZone: 'Australia/Sydney',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    };
    const formatted = now.toLocaleString('en-AU', options);
    const iso = now.toISOString();
    const dayName = now.toLocaleDateString('en-AU', { weekday: 'long', timeZone: 'Australia/Sydney' });

    return `<current_time>${iso} (${dayName}, ${formatted} AEST)</current_time>`;
  },
};
