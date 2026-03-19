import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface FleetBotConfig {
  config: string;
  service: string;
  port: number;
}

export interface FleetConfig {
  fleet: {
    server: string;
    ssh_host: string;
    ssh_user: string;
    base_dir: string;
  };
  bots: Record<string, FleetBotConfig>;
}

export function loadFleetConfig(): FleetConfig {
  const configPath = resolve('botforge.yaml');
  if (!existsSync(configPath)) {
    console.error('Fleet config not found: botforge.yaml');
    console.error('Create one at the project root.');
    process.exit(1);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw) as FleetConfig;

  // Interpolate env vars in ssh_host
  if (parsed.fleet.ssh_host.includes('${')) {
    parsed.fleet.ssh_host = parsed.fleet.ssh_host.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName.trim()] ?? '';
    });
  }

  return parsed;
}
