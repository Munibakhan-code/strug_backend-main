/**
 * Unit tests for real-estate / precon seller helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeCapabilityMetadata,
  validateCapabilityApplication,
  stripOwnerTrustFields,
  trustLabelForListing,
  isIndividualSeller,
  normalizeSellerType,
  listingHasPublishRequirements,
} from '../../utils/property-authenticity.js';

describe('property authenticity helpers', () => {
  it('normalizes seller types', () => {
    expect(normalizeSellerType('is_realtor', 'agent')).toBe('agent');
    expect(normalizeSellerType('is_realtor', 'weird')).toBe('individual');
    expect(normalizeSellerType('is_precon_developer', 'company')).toBe('company');
  });

  it('does not require license or KYC fields to apply', () => {
    const agent = sanitizeCapabilityMetadata('is_realtor', { seller_type: 'agent' });
    expect(validateCapabilityApplication('is_realtor', agent)).toBeNull();
    const developer = sanitizeCapabilityMetadata('is_precon_developer', { seller_type: 'developer' });
    expect(validateCapabilityApplication('is_precon_developer', developer)).toBeNull();
  });

  it('allows individuals without license', () => {
    const meta = sanitizeCapabilityMetadata('is_realtor', { seller_type: 'individual', phone: '555' });
    expect(validateCapabilityApplication('is_realtor', meta)).toBeNull();
    expect(isIndividualSeller(meta)).toBe(true);
  });

  it('strips trust flags from owner payloads', () => {
    expect(stripOwnerTrustFields({
      city: 'Toronto',
      is_verified: true,
      is_featured: true,
      is_published: true,
    })).toEqual({ city: 'Toronto' });
  });

  it('labels listings correctly', () => {
    expect(trustLabelForListing({ is_verified: true }, null)).toBe('verified');
    expect(trustLabelForListing({ is_verified: false }, { status: 'active', metadata: { seller_type: 'agent' } })).toBe('approved_seller');
    expect(trustLabelForListing({ is_verified: false }, { status: 'active', metadata: { seller_type: 'individual' } })).toBe('unverified');
  });

  it('requires address and a photo before a listing can go live', () => {
    expect(listingHasPublishRequirements({ address: '123 King St', image: 'https://cdn/p.jpg' })).toBe(true);
    expect(listingHasPublishRequirements({ address: '123 King St' }, { imageCount: 1 })).toBe(true);
    expect(listingHasPublishRequirements({ address: '123 King St' })).toBe(false);
    expect(listingHasPublishRequirements({ address: 'x', image: 'https://cdn/p.jpg' })).toBe(false);
  });
});
