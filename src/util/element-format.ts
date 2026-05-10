/**
 * Compact element formatting utilities.
 * Reduces token consumption by 3-5x compared to JSON output.
 */

import type { InteractiveElement } from '../tree/types.js';

/**
 * Format interactive elements as a compact, token-efficient text summary.
 * Example output:
 *   #0 TextButton "Login" key:loginBtn (120,400 180x44) enabled
 *   #1 TextField "Username" key:usernameField (40,200 300x48) enabled
 */
export function formatElementsCompact(elements: InteractiveElement[]): string {
  if (elements.length === 0) return '(no interactive elements found)';

  return elements.map(el => {
    const parts: string[] = [`#${el.index} ${el.type}`];

    if (el.text) parts.push(`"${el.text}"`);
    // Show key explicitly if present, even if locator uses a different strategy
    if (el.key) {
      parts.push(`key:${el.key}`);
    }
    // Show locator if it's not already the key (avoid duplication)
    if (el.locator && !(el.key && el.locator.by === 'key' && el.locator.value === el.key)) {
      parts.push(`${el.locator.by}:${el.locator.value}`);
    }
    if (el.position) {
      parts.push(`(${el.position.x},${el.position.y} ${el.position.width}x${el.position.height})`);
    }
    if (el.enabled === false) parts.push('disabled');

    return parts.join(' ');
  }).join('\n');
}

/**
 * Extract a summary of available ValueKeys from interactive elements.
 * Returns keys grouped by prefix for quick screen identification.
 */
export function summarizeValueKeys(elements: InteractiveElement[]): string {
  const keys = elements
    .filter(el => el.key)
    .map(el => el.key!);

  if (keys.length === 0) return '';

  // Group by prefix (e.g., "guest_medical_", "left_panel_", "header_")
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const parts = key.split('_');
    const prefix = parts.length >= 3 ? `${parts[0]}_${parts[1]}` : parts[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(key);
  }

  const lines: string[] = [`ValueKeys available: ${keys.length}`];
  for (const [prefix, groupKeys] of groups) {
    if (groupKeys.length <= 3) {
      lines.push(`  ${prefix}: ${groupKeys.join(', ')}`);
    } else {
      lines.push(`  ${prefix}: ${groupKeys.slice(0, 3).join(', ')} (+${groupKeys.length - 3} more)`);
    }
  }
  return lines.join('\n');
}

/**
 * Generate a summary line for element scan results.
 */
export function formatElementsSummaryLine(elements: InteractiveElement[]): string {
  if (elements.length === 0) return 'No interactive elements found on screen.';
  const types = new Map<string, number>();
  for (const el of elements) {
    types.set(el.type, (types.get(el.type) || 0) + 1);
  }
  const typeSummary = [...types.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, c]) => `${c} ${t}`)
    .join(', ');
  return `${elements.length} interactive elements: ${typeSummary}`;
}
