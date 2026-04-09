/**
 * Context builder: current_time
 *
 * Injects current time in America/New_York timezone.
 */
export default {
  type: 'current_time',
  async build(ctx) {
    const now = new Date();
    const options = {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    };
    const formatted = now.toLocaleString('en-US', options);
    const iso = now.toISOString();
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });

    return `<current_time>${iso} (${dayName}, ${formatted} ET)</current_time>`;
  },
};
