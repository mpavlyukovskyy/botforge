import { loadFleetConfig } from '../fleet.js';

export function systemd(botName: string): void {
  const fleet = loadFleetConfig();
  const bot = fleet.bots[botName];
  if (!bot) {
    console.error(`Bot "${botName}" not found in fleet config`);
    process.exit(1);
  }

  const { base_dir } = fleet.fleet;
  const workDir = `${base_dir}/${botName}`;

  const unit = `[Unit]
Description=BotForge - ${botName}
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${workDir}
ExecStart=/usr/bin/node index.js
EnvironmentFile=${workDir}/.env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

  console.log(unit);
  console.log(`# Save to: /etc/systemd/system/${bot.service}.service`);
  console.log(`# Then: systemctl daemon-reload && systemctl enable ${bot.service}`);
}
