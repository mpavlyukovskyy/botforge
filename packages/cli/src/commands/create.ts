import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const TEMPLATES: Record<string, string> = {
  echo: `name: {{name}}
version: "1.0"
description: A simple echo bot

platform:
  type: telegram
  token: \${TELEGRAM_BOT_TOKEN}
  mode: polling

brain:
  provider: claude
  model: claude-haiku-4-5-20251001
  system_prompt: "You are {{name}}. Echo back whatever the user says."

health:
  port: 9010
  path: /api/health

env_file: ../.env
`,
  full: `name: {{name}}
version: "1.0"
description: A full-featured bot

platform:
  type: telegram
  token: \${TELEGRAM_BOT_TOKEN}
  mode: polling

brain:
  provider: claude
  model: claude-sonnet-4-6
  system_prompt: "You are {{name}}, a helpful AI assistant."
  max_iterations: 5
  max_budget_usd: 1.00
  tools: []

memory:
  conversation_history:
    enabled: true
    ttl_days: 14
    max_messages: 100

resilience:
  circuit_breaker:
    threshold: 5
    reset_timeout_ms: 30000

schedule:
  conversation_cleanup:
    cron: "0 4 * * *"
    timezone: UTC

health:
  port: 9010
  path: /api/health

env_file: ../.env
`,
};

export function create(name: string, opts: { template?: string }): void {
  const template = opts.template ?? 'echo';
  const templateContent = TEMPLATES[template];
  if (!templateContent) {
    console.error(`Unknown template: ${template}. Available: ${Object.keys(TEMPLATES).join(', ')}`);
    process.exit(1);
  }

  const configContent = templateContent.replace(/\{\{name\}\}/g, name);
  const configPath = resolve(`bots/${name}.yaml`);
  const toolsDir = resolve(`bots/${name}/tools`);

  // Create config file
  writeFileSync(configPath, configContent);
  console.log(`Created config: ${configPath}`);

  // Create tools directory
  mkdirSync(toolsDir, { recursive: true });
  console.log(`Created tools directory: ${toolsDir}`);

  console.log(`\nBot "${name}" scaffolded with "${template}" template.`);
  console.log(`Run with: botforge dev bots/${name}.yaml`);
}
