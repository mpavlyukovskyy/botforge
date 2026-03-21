const getStatus = {
  name: 'get_status',
  description: 'Get current bot status including name, platform, brain model, uptime, and memory usage',
  schema: {},
  execute: async (_args, ctx) => {
    return JSON.stringify({
      bot_name: ctx.config.name,
      platform: ctx.config.platform.type,
      brain: ctx.config.brain.model,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    }, null, 2);
  },
};

export default getStatus;
