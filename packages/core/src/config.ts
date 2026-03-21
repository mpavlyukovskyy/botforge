/**
 * Config Loader — parses YAML, interpolates env vars, validates with Zod
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BotConfigSchema, type BotConfig } from './schema.js';

/**
 * Interpolate ${ENV_VAR} references in strings.
 * Supports ${ENV_VAR} and ${ENV_VAR:-default} syntax.
 */
function interpolateEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const [varName, ...defaultParts] = expr.split(':-');
      const defaultValue = defaultParts.join(':-');
      const envValue = process.env[varName!.trim()];
      if (envValue !== undefined) return envValue;
      if (defaultParts.length > 0) return defaultValue;
      throw new Error(`Environment variable ${varName} is not set and has no default`);
    });
  }

  if (Array.isArray(value)) {
    return value.map(interpolateEnvVars);
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = interpolateEnvVars(val);
    }
    return result;
  }

  return value;
}

/**
 * Load .env file into process.env (simple key=value parser)
 */
function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let val = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/**
 * Normalize config: migrate deprecated `passive_detection` to `behavior.reception`.
 * Merges old → new (only sets fields not already present in behavior.reception).
 */
export function normalizeConfig(raw: Record<string, any>): Record<string, any> {
  if (raw.passive_detection) {
    raw.behavior = raw.behavior || {};
    raw.behavior.reception = raw.behavior.reception || {};
    const r = raw.behavior.reception;
    const pd = raw.passive_detection;
    // Merge: only set fields not already present in behavior.reception
    if (!r.keywords?.length && pd.keywords?.length) r.keywords = pd.keywords;
    if (!r.patterns?.length && pd.patterns?.length) r.patterns = pd.patterns;
    if (r.case_sensitive === undefined && pd.case_sensitive !== undefined) r.case_sensitive = pd.case_sensitive;
    // Don't delete passive_detection yet — schema still allows it for backward compat
    console.warn('[botforge] DEPRECATED: passive_detection moved to behavior.reception');
  }
  return raw;
}

export interface LoadConfigOptions {
  /** Override env vars for interpolation (useful for testing) */
  env?: Record<string, string>;
  /** Skip Zod validation (returns raw parsed+interpolated object) */
  skipValidation?: boolean;
}

/**
 * Load and validate a bot config from a YAML file.
 *
 * 1. Load .env file if specified or found adjacent to config
 * 2. Parse YAML
 * 3. Interpolate ${ENV_VAR} references
 * 4. Validate with Zod schema
 */
export function loadConfig(configPath: string, options: LoadConfigOptions = {}): BotConfig {
  const absPath = resolve(configPath);

  if (!existsSync(absPath)) {
    throw new Error(`Config file not found: ${absPath}`);
  }

  const raw = readFileSync(absPath, 'utf-8');
  const parsed = parseYaml(raw) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid YAML in ${absPath}: expected an object`);
  }

  // Load env file if specified
  const configDir = dirname(absPath);
  if (typeof parsed['env_file'] === 'string') {
    const envPath = resolve(configDir, parsed['env_file']);
    loadEnvFile(envPath);
  }

  // Apply override env vars
  if (options.env) {
    for (const [key, val] of Object.entries(options.env)) {
      process.env[key] = val;
    }
  }

  // Interpolate env vars
  const interpolated = interpolateEnvVars(parsed) as Record<string, unknown>;

  // Normalize deprecated config paths
  normalizeConfig(interpolated as Record<string, any>);

  if (options.skipValidation) {
    return interpolated as unknown as BotConfig;
  }

  // Validate
  const result = BotConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const errors = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid bot config in ${absPath}:\n${errors}`);
  }

  return result.data;
}

/**
 * Validate a config object without loading from file.
 */
export function validateConfig(config: unknown): BotConfig {
  const result = BotConfigSchema.safeParse(config);
  if (!result.success) {
    const errors = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid bot config:\n${errors}`);
  }
  return result.data;
}
