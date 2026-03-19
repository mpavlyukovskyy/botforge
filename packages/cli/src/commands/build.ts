import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { loadFleetConfig } from '../fleet.js';

export function build(botName: string): void {
  const fleet = loadFleetConfig();
  const bot = fleet.bots[botName];
  if (!bot) {
    console.error(`Bot "${botName}" not found in fleet config`);
    process.exit(1);
  }

  console.log(`Building ${botName}...`);

  // 1. Build all workspace packages
  console.log('  Compiling workspace packages...');
  execSync('pnpm -r build', { stdio: 'inherit' });

  // 2. Create dist directory
  const distDir = resolve(`dist/${botName}`);
  mkdirSync(distDir, { recursive: true });

  // 3. Copy config
  copyFileSync(resolve(bot.config), resolve(distDir, 'config.yaml'));

  // 4. Copy prompts directory if it exists
  const configDir = dirname(resolve(bot.config));
  const promptsDir = resolve(configDir, 'prompts');
  if (existsSync(promptsDir)) {
    execSync(`cp -r "${promptsDir}" "${distDir}/prompts"`, { stdio: 'inherit' });
  }

  // 5. Copy tools directory if it exists
  const configName = bot.config.replace(/\.ya?ml$/, '').split('/').pop()!;
  const toolsDir = resolve(configDir, configName, 'tools');
  if (existsSync(toolsDir)) {
    execSync(`cp -r "${toolsDir}" "${distDir}/tools"`, { stdio: 'inherit' });
  }

  console.log(`✓ Built ${botName} → dist/${botName}/`);
}
