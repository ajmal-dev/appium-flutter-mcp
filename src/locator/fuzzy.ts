/**
 * Fuzzy text matching utilities for self-healing locators.
 * Uses Levenshtein distance and token-based similarity.
 */

/** Compute Levenshtein edit distance between two strings */
export function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const dp: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));

  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[la][lb];
}

/** Normalized similarity score (0-1, where 1 is exact match) */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

/** Token-based similarity: split by separators, compare token overlap */
export function tokenSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  // Jaccard similarity
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Combined similarity score (weighted average of string and token similarity) */
export function combinedSimilarity(a: string, b: string): number {
  return 0.6 * similarity(a, b) + 0.4 * tokenSimilarity(a, b);
}

/**
 * Substring-based scoring with word-boundary awareness.
 * Catches cases Levenshtein misses: "book" in "Book Now", "login" in "loginButton".
 */
export function substringScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q === t) return 1;
  if (q.length === 0 || t.length === 0) return 0;

  // Tokenize for word-level checks
  const qWords = tokenize(q);
  const tWords = tokenize(t);

  // Exact word match: any query word (len>=3) matches a target word exactly
  for (const qw of qWords) {
    if (qw.length >= 3 && tWords.has(qw)) return 0.9;
  }

  // Target word contained in query as whole word
  for (const tw of tWords) {
    if (tw.length >= 3 && qWords.has(tw)) return 0.85;
  }

  // Non-boundary substring: one contains the other
  if (t.includes(q) || q.includes(t)) return 0.7;

  // Check if any significant query word is a substring of target or vice versa
  for (const qw of qWords) {
    if (qw.length >= 3 && t.includes(qw)) return 0.65;
  }
  for (const tw of tWords) {
    if (tw.length >= 3 && q.includes(tw)) return 0.65;
  }

  return 0;
}

/** Tokenize a string into a set of lowercase words (splits camelCase, snake_case, etc.) */
function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-./]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 0),
  );
}

/**
 * Enhanced similarity: takes the max of all scoring strategies.
 * Keeps combinedSimilarity intact and adds substring-based signals.
 */
export function enhancedSimilarity(a: string, b: string): number {
  return Math.max(combinedSimilarity(a, b), substringScore(a, b));
}

/** Convert between camelCase and snake_case */
export function toSnakeCase(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

export function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Generate key variants for fuzzy matching */
export function keyVariants(key: string): string[] {
  const variants = new Set<string>();
  variants.add(key);
  variants.add(toSnakeCase(key));
  variants.add(toCamelCase(key));
  // Remove common prefixes/suffixes
  for (const prefix of ['btn_', 'txt_', 'key_', 'input_', 'button_']) {
    if (key.startsWith(prefix)) variants.add(key.slice(prefix.length));
  }
  for (const suffix of ['_btn', '_button', '_input', '_field', '_text', '_key']) {
    if (key.endsWith(suffix)) variants.add(key.slice(0, -suffix.length));
  }
  return [...variants];
}
