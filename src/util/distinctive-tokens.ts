/**
 * Distinctive-token matching for natural-language element descriptions.
 *
 * WHY
 * Since description-resolution reads from the VM tree, a candidate's
 * `locator.value` is usually a ValueKey. Key strings are boilerplate-heavy
 * ("apb_", "_button", "_day_"), so plain character similarity produces
 * confident WRONG matches: "book button" scores 0.90 against
 * "apb_today_button". Two live wrong taps on 2026-08-01 came from exactly this.
 *
 * The fix is to require agreement on a word that actually identifies the
 * control, ignoring the vocabulary every UI element shares.
 */

/**
 * Words carrying no identifying signal — they appear in nearly every
 * description AND nearly every ValueKey, so agreement on them means nothing.
 * `apb` is included because it is this app's global key prefix.
 */
const GENERIC_UI_TOKENS = new Set([
  'button', 'btn', 'icon', 'field', 'input', 'text', 'label', 'tab', 'menu',
  'item', 'row', 'cell', 'view', 'screen', 'page', 'the', 'a', 'an', 'on',
  'in', 'at', 'to', 'for', 'click', 'tap', 'press', 'select', 'open', 'apb',
]);

/** Split on non-alphanumerics so "apb_today_button" and "today button" compare fairly. */
export function tokenize(s: string): string[] {
  return s.split(/[^a-z0-9]+/i).map(t => t.toLowerCase()).filter(Boolean);
}

/**
 * The identifying words in a description — everything left after removing
 * generic UI vocabulary. Empty when the description is ONLY generic words
 * (e.g. "button"), which is itself meaningful: such a description cannot
 * identify anything and must not be allowed to match everything.
 *
 * Lowercased — for COMPARISON only. To search for these on-device use
 * {@link distinctiveSearchTerms}: Flutter's text finder is case-sensitive.
 */
export function distinctiveTokens(description: string): string[] {
  return tokenize(description).filter(t => !GENERIC_UI_TOKENS.has(t));
}

/**
 * Distinctive words as on-device SEARCH terms, case-variants included.
 *
 * Flutter's `-flutter text` finder is case-sensitive, so searching the
 * lowercased token silently misses the widget: "book" never matches the label
 * "Book". Each distinctive word is therefore expanded to its as-typed form,
 * Capitalised, and lowercase — deduped, original casing first.
 */
export function distinctiveSearchTerms(description: string): string[] {
  const asTyped = description.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const terms: string[] = [];

  for (const raw of asTyped) {
    if (GENERIC_UI_TOKENS.has(raw.toLowerCase())) continue;
    for (const variant of [raw, raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase(), raw.toLowerCase()]) {
      if (!terms.includes(variant)) terms.push(variant);
    }
  }
  return terms;
}

/**
 * True when at least one distinctive word from `description` appears among the
 * given haystacks (an element's text, key, and/or type).
 *
 * Returns false for an all-generic description — deliberately strict, since the
 * alternative is matching arbitrarily.
 */
export function matchesDistinctiveToken(description: string, ...haystacks: (string | undefined)[]): boolean {
  const wanted = distinctiveTokens(description);
  if (wanted.length === 0) return false;

  const have = new Set<string>();
  for (const h of haystacks) {
    if (h) for (const t of tokenize(h)) have.add(t);
  }
  return wanted.some(t => have.has(t));
}
