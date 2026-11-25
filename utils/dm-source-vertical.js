/** Allowed DM open-source tags (which vertical the user clicked Message from). */
export const ALLOWED_DM_SOURCE_VERTICALS = new Set([
	'jobs',
	'food',
	'social',
	'rideshare',
	'medical',
	'decor',
	'automotive',
	'realestate',
	'hotel',
	'venues',
	'tempstay',
	'shop',
	'ondemand',
	'videos',
	'wedding',
	'equipment',
	'experiences',
	'preconstruct',
	'reservations',
	'rental',
]);

/** Context types set by transactional chat-context routes — never overwrite on DM reopen. */
export const TRANSACTIONAL_CONTEXT_TYPES = new Set([
	'rideshare',
	'food',
	'services',
	'marketplace',
	'shop',
	'ondemand',
	'job_application',
	'support',
	'dating_match',
	'dating_blind_session',
]);

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeDmSourceVertical(raw) {
	if (raw == null || raw === '') return null;
	const key = String(raw).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
	if (!key || !ALLOWED_DM_SOURCE_VERTICALS.has(key)) return null;
	return key;
}

/**
 * @param {string|null|undefined} contextType
 * @param {string|null|undefined} contextId
 * @param {string} sourceVertical
 * @returns {boolean}
 */
export function shouldApplyDmSourceTag(contextType, contextId, sourceVertical) {
	if (!sourceVertical) return false;
	if (contextId) return false;
	if (!contextType) return true;
	if (TRANSACTIONAL_CONTEXT_TYPES.has(contextType)) return false;
	return contextType === sourceVertical;
}
