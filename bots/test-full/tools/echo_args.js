import { z } from 'zod';

const echoArgs = {
  name: 'echo_args',
  description: 'Echo a message back, optionally repeated multiple times',
  schema: {
    message: z.string(),
    count: z.number().optional(),
  },
  execute: async ({ message, count = 1 }) => {
    return Array(count).fill(message).join('\n');
  },
};

export default echoArgs;
