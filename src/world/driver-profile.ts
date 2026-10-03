import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROFILES_DIR = join(homedir(), '.appium-flutter-mcp', 'driver-profiles');
const STALE_DAYS = 30;

export interface DriverProfile {
  vmDriverCommands: 'broken' | 'ok';
  evidence: string;
  firstSeen: string;
  lastConfirmed: string;
  sessions: number;
}

function ensureDir(): void {
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });
}

function profileKey(appId: string, platform: string): string {
  return `${appId.replace(/[^a-zA-Z0-9._-]/g, '_')}-${platform}`;
}

function profilePath(appId: string, platform: string): string {
  return join(PROFILES_DIR, `${profileKey(appId, platform)}.json`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadDriverProfile(appId: string, platform: string): DriverProfile | null {
  try {
    const p = profilePath(appId, platform);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as DriverProfile;

    const lastMs = new Date(raw.lastConfirmed).getTime();
    const ageDays = (Date.now() - lastMs) / 86_400_000;
    if (ageDays > STALE_DAYS) return null; // treat as hint only; stale profiles are ignored

    return raw;
  } catch {
    return null;
  }
}

export function persistDriverProfile(
  appId: string,
  platform: string,
  update: Pick<DriverProfile, 'vmDriverCommands' | 'evidence'>,
): void {
  try {
    ensureDir();
    const p = profilePath(appId, platform);
    const existing = loadDriverProfile(appId, platform);
    const next: DriverProfile = {
      vmDriverCommands: update.vmDriverCommands,
      evidence: update.evidence.slice(0, 300),
      firstSeen: existing?.firstSeen ?? today(),
      lastConfirmed: today(),
      sessions: (existing?.sessions ?? 0) + 1,
    };
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // fire-and-forget — never let profile I/O fail a tool call
  }
}
