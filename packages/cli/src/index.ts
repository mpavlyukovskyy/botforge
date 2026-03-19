#!/usr/bin/env node

/**
 * BotForge CLI — manage bots from the command line
 *
 * Usage:
 *   botforge dev <config.yaml>     — run bot locally in dev mode
 *   botforge build <config.yaml>   — build bot for deployment
 *   botforge status                — show fleet status
 *   botforge validate <config.yaml> — validate a config file
 */

import { Command } from 'commander';
import { loadConfig } from '@botforge/core';
import { startBot } from '@botforge/core';
import { createTelegramAdapter } from '@botforge/adapter-telegram';
import { resolve, dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

const program = new Command();

program
  .name('botforge')
  .description('Agent management platform — run, monitor, and manage AI agents at scale')
  .version('0.1.0');

// ─── dev ─────────────────────────────────────────────────────────────────────

program
  .command('dev <config>')
  .description('Run a bot locally in dev mode')
  .option('--echo', 'Force echo mode (no LLM calls)')
  .option('--dry-run', 'Validate config and boot adapter without connecting')
  .action(async (configPath: string, opts: { echo?: boolean; dryRun?: boolean }) => {
    const absPath = resolve(configPath);
    console.log(`Starting bot from ${absPath}...`);

    try {
      // Detect tools directory
      const configDir = dirname(absPath);
      const configName = absPath.replace(/\.ya?ml$/, '').split('/').pop()!;
      const possibleToolsDirs = [
        join(configDir, configName, 'tools'),
        join(configDir, 'tools'),
      ];
      const toolsDir = possibleToolsDirs.find(d => existsSync(d));

      // Default skill loader
      const loadSkill = async (name: string) => {
        const mod = await import(`@botforge/skill-${name}`);
        return mod.default ?? mod.createSkill();
      };

      if (opts.dryRun) {
        const config = loadConfig(absPath);
        console.log(`Config valid: ${config.name} v${config.version}`);
        console.log(`  Platform: ${config.platform.type}`);
        console.log(`  Brain: ${config.brain.provider} / ${config.brain.model}`);
        console.log(`  Tools: ${config.brain.tools.length}`);
        if (toolsDir) console.log(`  Tools dir: ${toolsDir}`);
        return;
      }

      const instance = await startBot(absPath, {
        createAdapter: (config, log) => {
          switch (config.platform.type) {
            case 'telegram':
              return createTelegramAdapter(config, log);
            default:
              throw new Error(`Unsupported platform: ${config.platform.type}`);
          }
        },
        loadSkill,
        toolsDir,
        echo: opts.echo,
      });

      console.log(`Bot "${instance.config.name}" is running. Press Ctrl+C to stop.`);
    } catch (err) {
      console.error('Failed to start bot:', err);
      process.exit(1);
    }
  });

// ─── validate ────────────────────────────────────────────────────────────────

program
  .command('validate <config>')
  .description('Validate a bot config file')
  .action((configPath: string) => {
    const absPath = resolve(configPath);

    try {
      const config = loadConfig(absPath, {
        env: {
          // Provide dummy values for env var validation
          TELEGRAM_BOT_TOKEN: 'test-token',
          TELEGRAM_CHAT_ID: '12345',
          TEST_BOT_TOKEN: 'test-token',
        },
      });
      console.log(`Config valid: ${config.name} v${config.version}`);
      console.log(`  Platform: ${config.platform.type}`);
      console.log(`  Brain: ${config.brain.provider} / ${config.brain.model}`);
      console.log(`  Tools: ${config.brain.tools.length}`);
      if (config.health) console.log(`  Health: :${config.health.port}${config.health.path}`);
      if (config.schedule) console.log(`  Schedules: ${Object.keys(config.schedule).length}`);
      if (config.integrations) console.log(`  Integrations: ${Object.keys(config.integrations).length}`);
    } catch (err) {
      console.error('Validation failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─── status ──────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show fleet status by querying health endpoints')
  .action(async () => {
    // TODO: Read fleet config, query each bot's health endpoint
    console.log('Fleet status (coming soon)');
    console.log('This will query health endpoints of all deployed bots.');
  });

// ─── validate-all ────────────────────────────────────────────────────────────

program
  .command('validate-all')
  .description('Validate all bot configs in the bots/ directory')
  .action(async () => {
    const botsDir = resolve('bots');
    let files: string[];
    try {
      files = readdirSync(botsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch {
      console.error('No bots/ directory found');
      process.exit(1);
    }

    let passed = 0;
    let failed = 0;

    for (const file of files) {
      const configPath = join(botsDir, file);
      try {
        const config = loadConfig(configPath, {
          env: {
            TELEGRAM_BOT_TOKEN: 'test-token',
            TELEGRAM_CHAT_ID: '12345',
            TEST_BOT_TOKEN: 'test-token',
            IMAP_HOST: 'localhost',
            IMAP_USER: 'test',
            IMAP_PASSWORD: 'test',
            ATLAS_SYNC_KEY: 'test',
            SPOK_SYNC_KEY: 'test',
            SPOK_DEFAULT_FUND_ID: 'test',
            SPOK_READ_FUND_IDS: 'test',
            SPOK_API_TOKEN: 'test',
            INSTANTLY_API_URL: 'https://example.com',
            INSTANTLY_API_KEY: 'test',
            BUTTONDOWN_API_KEY: 'test',
            GOOGLE_CALENDAR_TOKEN: 'test',
            TELEGRAM_API_URL: 'http://localhost:8081',
          },
        });
        console.log(`  OK  ${file} (${config.name})`);
        passed++;
      } catch (err) {
        console.log(`  FAIL  ${file}: ${err instanceof Error ? err.message : err}`);
        failed++;
      }
    }

    console.log(`\n${passed} passed, ${failed} failed out of ${files.length} configs`);
    if (failed > 0) process.exit(1);
  });

program.parse();
