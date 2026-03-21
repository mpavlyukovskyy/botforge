export interface BotStatus {
  name: string;
  status: 'healthy' | 'online' | 'offline' | 'error' | 'deploying';
  uptime?: number;
  port: number;
  platform?: string;
  brain?: string;
  version?: string;
  memory?: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
}
