import { describe, it, expect } from 'vitest';
import { VIDEO_CATEGORIES, normalizeUploadCategory, coerceCategory, classifyByHeuristic } from '../../ai/video-categories.js';

describe('normalizeUploadCategory', () => {
  it('returns null for the Auto sentinel, empty, and nullish input', () => {
    for (const v of ['auto', 'Auto', 'AUTO', '', '   ', null, undefined]) {
      expect(normalizeUploadCategory(v)).toBeNull();
    }
  });

  it('treats "General" (legacy default) as uncategorised → null', () => {
    expect(normalizeUploadCategory('General')).toBeNull();
    expect(normalizeUploadCategory('general')).toBeNull();
  });

  it('canonicalises a known category regardless of case', () => {
    expect(normalizeUploadCategory('gaming')).toBe('Gaming');
    expect(normalizeUploadCategory('MUSIC')).toBe('Music');
    expect(normalizeUploadCategory(' tech ')).toBe('Tech');
  });

  it('maps unrecognised values to null rather than persisting junk', () => {
    expect(normalizeUploadCategory('vlogs')).toBeNull();
    expect(normalizeUploadCategory('123')).toBeNull();
  });

  it('every canonical category round-trips to itself', () => {
    for (const c of VIDEO_CATEGORIES) expect(normalizeUploadCategory(c)).toBe(c);
  });
});

describe('coerceCategory (model-output parsing)', () => {
  it('extracts a clean single-word answer', () => {
    expect(coerceCategory('Gaming')).toBe('Gaming');
  });

  it('extracts the category from a chatty answer', () => {
    expect(coerceCategory('Category: Sports.')).toBe('Sports');
    expect(coerceCategory('This is clearly Music')).toBe('Music');
  });

  it('is case-insensitive', () => {
    expect(coerceCategory('tech')).toBe('Tech');
  });

  it('returns null when nothing matches (e.g. the model said None)', () => {
    expect(coerceCategory('None')).toBeNull();
    expect(coerceCategory('')).toBeNull();
    expect(coerceCategory(null)).toBeNull();
  });
});

describe('classifyByHeuristic (no-LLM keyword classifier)', () => {
  const confidentCases = [
    ['Drake - Hotline Bling (Official Music Video)', 'Music'],
    ['Minecraft Hardcore Gameplay #14 — no commentary', 'Gaming'],
    ['Lakers vs Celtics Full Game Highlights | NBA', 'Sports'],
    ['Breaking News: election results live coverage', 'News'],
    ['React Tutorial for Beginners — useState explained', 'Education'],
    ['iPhone 16 Pro unboxing + tech review', 'Tech'],
    ['Try Not To Laugh Challenge (stand up comedy)', 'Comedy'],
    ['Travel vlog: road trip across Iceland itinerary', 'Travel'],
    ['Insane prank on my roommate — reaction', 'Entertainment'],
  ];
  it.each(confidentCases)('confidently classifies %j → %s', (title, expected) => {
    const r = classifyByHeuristic(title, '');
    expect(r.confident).toBe(true);
    expect(r.category).toBe(expected);
  });

  it('returns confident=false (defer to LLM) on a vague title', () => {
    const r = classifyByHeuristic('My day yesterday', 'just some thoughts');
    expect(r.confident).toBe(false);
    expect(r.category).toBeNull();
  });

  it('ignores the description (boilerplate there mislabels imported videos)', () => {
    // Title carries no signal; the description is full of gaming words. We must NOT classify off it.
    const r = classifyByHeuristic('Episode 12', 'Full gameplay playthrough, no commentary, boss fight');
    expect(r.confident).toBe(false);
  });

  it('is not confident on a generic single weak hit (e.g. a bare product name)', () => {
    // "iphone" alone (weight 2, no distinctive phrase) → stay General, not a wrong "Tech" label.
    const r = classifyByHeuristic('I Hunted Down 100 iPhone Thieves', '');
    expect(r.confident).toBe(false);
  });

  it('never invents a category outside the canonical set', () => {
    for (const [title] of confidentCases) {
      const { category } = classifyByHeuristic(title, '');
      expect(category === null || VIDEO_CATEGORIES.includes(category)).toBe(true);
    }
  });
});
