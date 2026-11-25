import { describe, expect, it } from 'vitest';
import {
	normalizeDmSourceVertical,
	shouldApplyDmSourceTag,
	TRANSACTIONAL_CONTEXT_TYPES,
} from '../../utils/dm-source-vertical.js';

describe('normalizeDmSourceVertical', () => {
	it('accepts allowed vertical slugs', () => {
		expect(normalizeDmSourceVertical('Jobs')).toBe('jobs');
		expect(normalizeDmSourceVertical('medical')).toBe('medical');
	});

	it('rejects unknown and empty values', () => {
		expect(normalizeDmSourceVertical('')).toBeNull();
		expect(normalizeDmSourceVertical(null)).toBeNull();
		expect(normalizeDmSourceVertical('random-vertical')).toBeNull();
		expect(normalizeDmSourceVertical({ vertical: 'food' })).toBeNull();
	});
});

describe('shouldApplyDmSourceTag', () => {
	it('tags when context_type is empty', () => {
		expect(shouldApplyDmSourceTag(null, null, 'jobs')).toBe(true);
	});

	it('does not overwrite transactional contexts', () => {
		for (const type of TRANSACTIONAL_CONTEXT_TYPES) {
			expect(shouldApplyDmSourceTag(type, '42', 'social')).toBe(false);
		}
	});

	it('does not overwrite when context_id is set', () => {
		expect(shouldApplyDmSourceTag('social', '9', 'food')).toBe(false);
	});

	it('allows refresh of the same dm source tag', () => {
		expect(shouldApplyDmSourceTag('medical', null, 'medical')).toBe(true);
	});
});
