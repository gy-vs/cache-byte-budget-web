import {describe, expect, it} from 'vitest';
import {
  buildCanonicalKey,
  collectRawHeaders,
  parseVary,
} from '../src/server/vary';

function headers(lines: string[]) {
  return collectRawHeaders(lines);
}

describe('parseVary', () => {
  it('splits, trims, lowercases and de-duplicates selectors', () => {
    expect(parseVary('Accept-Encoding, x-locale ,ACCEPT-ENCODING')).toEqual([
      'accept-encoding',
      'x-locale',
    ]);
    expect(parseVary(null)).toEqual([]);
    expect(parseVary('')).toEqual([]);
  });

  it('returns * bypass regardless of other selectors', () => {
    expect(parseVary('Accept-Encoding, *')).toBe('*');
    expect(parseVary('*')).toBe('*');
  });
});

describe('buildCanonicalKey', () => {
  const resource = '/api/experiments/alpha';

  it('marks mergeable fields equivalent under case, whitespace, token order and duplicates', () => {
    const vary = parseVary('Accept-Encoding');
    const key = (raw: string[]) =>
      buildCanonicalKey({resource, vary, headers: headers(raw)}).canonical;

    const baseline = key(['accept-encoding', 'gzip, br']);
    expect(key(['Accept-Encoding', 'br , GZIP'])).toBe(baseline);
    expect(key(['accept-encoding', 'gzip', 'accept-encoding', 'br'])).toBe(baseline);
    expect(key(['ACCEPT-ENCODING', 'br,gzip,gzip'])).toBe(baseline);

    // A different token set is genuinely a different variant.
    expect(key(['accept-encoding', 'gzip'])).not.toBe(baseline);
  });

  it('treats a missing header differently from a present empty header', () => {
    const vary = parseVary('X-Locale');
    const missing = buildCanonicalKey({resource, vary, headers: headers([])});
    const empty = buildCanonicalKey({
      resource,
      vary,
      headers: headers(['x-locale', '']),
    });
    expect(missing.components[0]).toMatchObject({present: false, values: []});
    expect(empty.components[0]).toMatchObject({present: true, values: ['']});
    expect(missing.canonical).not.toBe(empty.canonical);
  });

  it('preserves value sequence for non-mergeable fields, including duplicates', () => {
    const vary = parseVary('X-Locale');
    const key = (raw: string[]) =>
      buildCanonicalKey({resource, vary, headers: headers(raw)}).canonical;

    expect(key(['x-locale', 'en', 'x-locale', 'fr'])).not.toBe(
      key(['x-locale', 'fr', 'x-locale', 'en']),
    );
    expect(key(['x-locale', 'en', 'x-locale', 'en'])).not.toBe(key(['x-locale', 'en']));
    // Inner casing is preserved (only surrounding OWS trimmed).
    expect(key(['x-locale', 'EN'])).not.toBe(key(['x-locale', 'en']));
    expect(key(['x-locale', '  en '])).toBe(key(['x-locale', 'en']));
  });

  it('normalizes multiple Vary fields and is insensitive to selector order', () => {
    const raw = headers([
      'accept-encoding', 'gzip, br',
      'x-locale', 'en',
    ]);
    const ab = buildCanonicalKey({resource, vary: parseVary('Accept-Encoding, X-Locale'), headers: raw});
    const ba = buildCanonicalKey({resource, vary: parseVary('x-locale, accept-encoding'), headers: raw});
    expect(ab.canonical).toBe(ba.canonical);
    expect(ab.varyFields).toEqual(['accept-encoding', 'x-locale']);
    expect(ab.components.map((c) => c.field)).toEqual([
      'accept-encoding',
      'x-locale',
    ]);
  });

  it('resolves request header names case-insensitively', () => {
    const vary = parseVary('X-Locale');
    const a = buildCanonicalKey({resource, vary, headers: headers(['X-LOCALE', 'en'])});
    const b = buildCanonicalKey({resource, vary, headers: headers(['x-locale', 'en'])});
    expect(a.canonical).toBe(b.canonical);
  });

  it('bypasses for Vary: * and never produces a reusable key', () => {
    const first = buildCanonicalKey({
      resource,
      vary: '*',
      headers: headers(['accept-encoding', 'gzip']),
    });
    const second = buildCanonicalKey({
      resource,
      vary: '*',
      headers: headers(['accept-encoding', 'br']),
    });
    expect(first.bypass).toBe(true);
    expect(second.bypass).toBe(true);
    expect(first.canonical).not.toBe(JSON.stringify({r: resource}));
  });

  it('includes all components for an empty Vary (requests share one key)', () => {
    const key = buildCanonicalKey({resource, vary: [], headers: headers([])});
    expect(key.components).toEqual([]);
    expect(key.canonical).toBe(
      buildCanonicalKey({
        resource,
        vary: [],
        headers: headers(['x-locale', 'anything']),
      }).canonical,
    );
  });
});
