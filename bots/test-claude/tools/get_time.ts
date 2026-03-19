import type { ToolImplementation } from '@botforge/core';

const getTime: ToolImplementation = {
  name: 'get_time',
  description: 'Get the current date and time in ISO format',
  schema: {},  // no parameters
  execute: async () => new Date().toISOString(),
};

export default getTime;
