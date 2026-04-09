import { z } from 'zod';

const ConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  TELEGRAM_API_URL: z.string().optional(),
  BOT_NAME: z.string().default('Alfred'),
  DASHBOARD_PASSWORD: z.string().optional(),
  DASHBOARD_PORT: z.coerce.number().default(8090),
  HEALTH_PORT: z.coerce.number().default(8088),
  TIMEZONE: z.string().default('Pacific/Auckland'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  LUNCH_GROUP_CHAT_ID: z.string().optional(),
  LUNCHDROP_URL: z.string().default('https://raleigh.lunchdrop.com'),
  LUNCHDROP_EMAIL: z.string().optional(),
  LUNCHDROP_PASSWORD: z.string().optional(),
  DAILY_BUDGET: z.coerce.number().default(20),
});

export type Config = z.infer<typeof ConfigSchema>;

let config: Config;

export function loadConfig(): Config {
  config = ConfigSchema.parse(process.env);
  return config;
}

export function getConfig(): Config {
  if (!config) throw new Error('Config not loaded');
  return config;
}

export function getAllowedChatIds(): string[] {
  return getConfig().TELEGRAM_CHAT_ID.split(',').map(s => s.trim());
}
