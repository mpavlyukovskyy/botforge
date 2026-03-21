const getTime = {
  name: 'get_time',
  description: 'Get the current date and time in ISO format',
  schema: {},
  execute: async () => new Date().toISOString(),
};

export default getTime;
