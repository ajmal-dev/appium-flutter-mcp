/**
 * Healing Registry — stores healing events and locator aliases
 * for self-healing locator system.
 */

export interface HealingEvent {
  timestamp: string;
  originalLocator: { by: string; value: string };
  healedLocator: { by: string; value: string };
  strategy: string;
  confidence: number;
  screenContext: string;
}

export interface HealingConfig {
  enabled: boolean;
  mode: 'off' | 'passive' | 'active';  // passive = log only, active = auto-heal
  confidenceThreshold: number;           // default 0.8
  fuzzyThreshold: number;               // default 0.7
}

// Singleton state
const healingLog: HealingEvent[] = [];
let config: HealingConfig = {
  enabled: true,
  mode: 'active',
  confidenceThreshold: 0.8,
  fuzzyThreshold: 0.7,
};

export function getHealingConfig(): HealingConfig {
  return { ...config };
}

export function setHealingConfig(updates: Partial<HealingConfig>): HealingConfig {
  config = { ...config, ...updates };
  return { ...config };
}

export function logHealingEvent(event: HealingEvent): void {
  healingLog.push(event);
}

export function getHealingLog(): HealingEvent[] {
  return [...healingLog];
}

export function clearHealingLog(): void {
  healingLog.length = 0;
}

export function isHealingActive(): boolean {
  return config.enabled && config.mode === 'active';
}

export function isHealingEnabled(): boolean {
  return config.enabled && config.mode !== 'off';
}
