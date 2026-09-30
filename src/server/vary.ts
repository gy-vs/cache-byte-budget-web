/**
 * Canonical cache-key construction for Vary-aware responses.
 *
 * Rules implemented here:
 * - Header field names are case-insensitive (both Vary selectors and request headers).
 * - Comma-list ("mergeable") fields are normalized semantically: tokens are
 *   trimmed, lowercased, de-duplicated and sorted, so "gzip, br" and "br , GZIP"
 *   (including repeated header lines) collapse to the same component.
 * - Every other field is non-mergeable: the sequence of raw header lines is
 *   preserved verbatim (only surrounding OWS trimmed), including case,
 *   duplicates and order. "A" then "B" differs from "B" then "A".
 * - A missing header (present:false) is distinct from a present-but-empty one.
 * - Vary: * means the response is uncacheable by key and is always bypassed.
 */

export type KeyComponent = {
  /** Canonical (lowercase) request header name. */
  field: string;
  /** Whether the request carried at least one line for this header. */
  present: boolean;
  /** True for comma-list fields whose tokens can be semantically merged. */
  mergeable: boolean;
  /** Normalized tokens (mergeable) or the preserved value sequence. */
  values: string[];
};

export type CanonicalKey = {
  resource: string;
  /** Sorted, de-duplicated Vary selectors. Empty for Vary: *. */
  varyFields: string[];
  components: KeyComponent[];
  /** Opaque stable string used as the cache storage key. */
  canonical: string;
  /** True when the response selected Vary: * — never reusable. */
  bypass: boolean;
};

export type VarySelector = string[] | '*';
/** lowercased header name -> raw values in the order they were received. */
export type RawHeaderMap = Map<string, string[]>;

/**
 * RFC 9110 "mergeable" fields: fields defined as comma-separated lists where
 * repeated lines are equivalent to a single comma-joined line. Everything else
 * (including custom request headers) is treated as non-mergeable.
 */
const MERGEABLE_FIELDS = new Set([
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'allow',
  'content-encoding',
  'content-language',
]);

/** Parses a Vary response header into lowercase selectors, or '*' bypass. */
export function parseVary(headerValue: string | null | undefined): VarySelector {
  if (headerValue == null || headerValue === '') return [];
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const token of headerValue.split(',')) {
    const name = token.trim().toLowerCase();
    if (name === '') continue;
    if (name === '*') return '*';
    if (!seen.has(name)) {
      seen.add(name);
      fields.push(name);
    }
  }
  return fields;
}

/**
 * Collects request headers from Node's rawHeaders array so that repeated,
 * non-mergeable fields keep their exact arrival order instead of being joined
 * by the framework's header accessor.
 */
export function collectRawHeaders(rawHeaders: readonly string[]): RawHeaderMap {
  const map: RawHeaderMap = new Map();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    const value = rawHeaders[i + 1];
    const existing = map.get(name);
    if (existing) existing.push(value);
    else map.set(name, [value]);
  }
  return map;
}

function normalizeMergeable(rawLines: string[] | undefined) {
  if (rawLines === undefined) return {present: false, values: [] as string[]};
  const tokens = new Set<string>();
  for (const line of rawLines) {
    for (const part of line.split(',')) {
      const token = part.trim().toLowerCase();
      if (token !== '') tokens.add(token);
    }
  }
  return {present: true, values: [...tokens].sort()};
}

function normalizeNonMergeable(rawLines: string[] | undefined) {
  if (rawLines === undefined) return {present: false, values: [] as string[]};
  // Only surrounding OWS is insignificant; inner content, casing, duplicates
  // and line order all carry semantics and must be preserved.
  return {present: true, values: rawLines.map((line) => line.trim())};
}

export function buildCanonicalKey(input: {
  resource: string;
  vary: VarySelector;
  headers: RawHeaderMap;
}): CanonicalKey {
  const {resource, vary, headers} = input;
  if (vary === '*') {
    return {
      resource,
      varyFields: [],
      components: [],
      canonical: `${resource}*`,
      bypass: true,
    };
  }

  // Sort selectors so Vary: A,B and Vary: B,A select the same cache entries.
  const fields = [...vary].sort();
  const components: KeyComponent[] = fields.map((field) => {
    const rawLines = headers.get(field);
    const mergeable = MERGEABLE_FIELDS.has(field);
    const normalized = mergeable
      ? normalizeMergeable(rawLines)
      : normalizeNonMergeable(rawLines);
    return {field, mergeable, ...normalized};
  });

  // Array-shaped JSON with fixed key order => deterministic string for
  // equivalent requests regardless of wire-level header ordering.
  const canonical = JSON.stringify({
    r: resource,
    v: components.map((c) => [c.field, c.present ? 1 : 0, c.values]),
  });

  return {resource, varyFields: fields, components, canonical, bypass: false};
}
