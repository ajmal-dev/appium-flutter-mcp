/**
 * MCP tool handlers for self-healing locator management.
 */

import { z } from 'zod';
import { getHealingLog, clearHealingLog, getHealingConfig, setHealingConfig } from '../locator/registry.js';
import type { McpToolResponse } from '../types.js';

export const getHealingLogSchema = z.object({});

export const configureHealingSchema = z.object({
  enabled: z.boolean().optional().describe('Enable/disable healing'),
  mode: z.enum(['off', 'passive', 'active']).optional()
    .describe('off = disabled, passive = log only, active = auto-heal'),
  confidenceThreshold: z.number().optional()
    .describe('Min confidence to auto-heal (0-1, default 0.8)'),
  fuzzyThreshold: z.number().optional()
    .describe('Min fuzzy match similarity (0-1, default 0.7)'),
  clearLog: z.boolean().optional()
    .describe('Clear the healing log'),
});

export async function handleGetHealingLog(
  _params: z.infer<typeof getHealingLogSchema>,
): Promise<McpToolResponse> {
  const log = getHealingLog();
  const config = getHealingConfig();

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        config,
        eventCount: log.length,
        events: log.map(e => ({
          timestamp: e.timestamp,
          original: `${e.originalLocator.by}="${e.originalLocator.value}"`,
          healed: `${e.healedLocator.by}="${e.healedLocator.value}"`,
          strategy: e.strategy,
          confidence: e.confidence.toFixed(2),
        })),
      }, null, 2),
    }],
  };
}

export async function handleConfigureHealing(
  params: z.infer<typeof configureHealingSchema>,
): Promise<McpToolResponse> {
  if (params.clearLog) {
    clearHealingLog();
  }

  const config = setHealingConfig({
    ...(params.enabled !== undefined && { enabled: params.enabled }),
    ...(params.mode !== undefined && { mode: params.mode }),
    ...(params.confidenceThreshold !== undefined && { confidenceThreshold: params.confidenceThreshold }),
    ...(params.fuzzyThreshold !== undefined && { fuzzyThreshold: params.fuzzyThreshold }),
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'configured',
        config,
        logCleared: params.clearLog || false,
      }, null, 2),
    }],
  };
}
