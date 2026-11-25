import { describe, it, expect } from 'vitest';
import {
  verticalIdentityUserSelect,
  verticalIdentityUserInclude,
  applyVerticalIdentity,
} from '../../utils/vertical-identity.js';

// Public (unauthenticated) routes embed a vendor/host user. They must expose display identity
// only — never the owner's email, KYC review state or moderation history. This test is the
// tripwire: if someone reverts a public route to `include` or adds a sensitive column to the
// select, it fails here before it ships. See routes/food-routes.js GET /vendors[/:id] and
// routes/rental-listing-routes.js GET / and /:rental_listing_id.

const SENSITIVE = [
  'email',
  'password',
  'account_status',
  'status_reason',
  'status_changed_by',
  'sessions_invalidated_at',
  'password_changed_at',
  'saved_lat',
  'saved_long',
  'saved_address',
  'ref_code',
  'document_verification_status',
  'document_verification_type',
  'document_verification_dob',
  'document_verification_document_url',
  'document_verification_rejection_reason',
];

describe('verticalIdentityUserSelect (public embed whitelist)', () => {
  it('is a select whitelist, not an include of every scalar', () => {
    // A select names each field explicitly; the sensitive columns must be absent by omission.
    for (const key of SENSITIVE) {
      expect(verticalIdentityUserSelect[key]).toBeUndefined();
    }
  });

  it('exposes exactly the display fields a public card needs', () => {
    expect(Object.keys(verticalIdentityUserSelect).sort()).toEqual(
      ['name', 'social_profiles', 'user_id', 'username', 'vertical_profiles'].sort(),
    );
  });

  it('carries the same two identity relations applyVerticalIdentity reads', () => {
    expect(verticalIdentityUserSelect.vertical_profiles).toEqual(
      verticalIdentityUserInclude.vertical_profiles,
    );
    expect(verticalIdentityUserSelect.social_profiles).toEqual(
      verticalIdentityUserInclude.social_profiles,
    );
  });

  it('still resolves display identity from a user shaped by the select', () => {
    const user = {
      user_id: 226,
      name: 'Legal Name',
      username: 'legalname',
      vertical_profiles: [
        { vertical: 'food', handle: 'strugsteak', display_name: 'Strug Steak', profile_pic_url: 'p.jpg' },
      ],
      social_profiles: { handle: 'social', profile_pic_url: 's.jpg' },
    };
    applyVerticalIdentity(user, 'food');
    expect(user.name).toBe('Strug Steak');
    expect(user.vertical_handle).toBe('strugsteak');
    expect(user.social_profiles[0].handle).toBe('strugsteak');
    // nothing sensitive was invented onto the object
    expect(user.email).toBeUndefined();
    expect(user.document_verification_status).toBeUndefined();
  });
});
