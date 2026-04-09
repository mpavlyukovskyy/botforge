import crypto from 'crypto';
import { IncomingMessage } from 'http';
import { getConfig } from '../config.js';

const activeSessions = new Set<string>();

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function createSession(): string {
  const token = generateSessionToken();
  activeSessions.add(token);
  return token;
}

export function destroySession(token: string): void {
  activeSessions.delete(token);
}

export function isAuthenticated(req: IncomingMessage): boolean {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/taskbot_session=([^;]+)/);
  if (!match) return false;
  return activeSessions.has(match[1]);
}

export function validatePassword(password: string): boolean {
  return password === getConfig().DASHBOARD_PASSWORD;
}

export function getSessionCookie(token: string): string {
  return `taskbot_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
}

export function getClearCookie(): string {
  return `taskbot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
