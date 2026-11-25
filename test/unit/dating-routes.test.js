import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { prismaMock, notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
  prismaMock: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    chat_channel: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    chat_messages: { count: vi.fn() },
    chat_participants: { createMany: vi.fn(), updateMany: vi.fn() },
    dating_profile: { upsert: vi.fn(), update: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    dating_match: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
    dating_swipe: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    dating_crossed_path_event: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    dating_crossed_path_candidate: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    dating_blind_queue: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    dating_blind_session: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    dating_date_plan: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    dating_date_interest: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    dating_date_invite: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    dating_report: { create: vi.fn(), findMany: vi.fn() },
    vendor_type: { findMany: vi.fn() },
    food_vendor: { findUnique: vi.fn(), findMany: vi.fn() },
    product_listing: { findMany: vi.fn() },
    follower: { findMany: vi.fn(), deleteMany: vi.fn() },
    social_profile: { findUnique: vi.fn(), findMany: vi.fn() },
    social_block: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(async (fn) => fn(prismaMock)),
  },
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = { user_id: 42, name: 'Dating User', currency: 'CAD' };
    next();
  },
}));

vi.mock('../../services/notify.js', () => ({
  notify: (...args) => notifyMock(...args),
}));

vi.mock('../../utils/prisma-client.js', () => ({
  default: prismaMock,
}));

const router = (await import('../../routes/dating-routes.js')).default;

const app = express();
app.use(express.json());
app.set('io', { to: vi.fn(() => ({ emit: vi.fn() })) });
app.use('/dating', router);

function futureDateValue(days = 30) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const userRecord = {
  user_id: 42,
  name: 'Dating User',
  city: 'Toronto',
  country: 'Canada',
  saved_address: 'Toronto, Canada',
  saved_lat: 43.6532,
  saved_long: -79.3832,
  currency: 'CAD',
  document_verification_status: 'verified',
  document_verification_submitted_at: new Date('2026-07-30T00:00:00.000Z'),
  document_verified_at: new Date('2026-07-31T00:00:00.000Z'),
  document_verification_dob: null,
  document_verification_rejected_at: null,
  document_verification_rejection_reason: null,
  social_profiles: {
    display_name: 'Dating User',
    bio: null,
    profile_pic_url: null,
    banner_url: null,
  },
};

function profile(overrides = {}) {
  return {
    dating_profile_id: 7,
    user_id: 42,
    status: 'active',
    display_name: 'Dating User',
    birthdate: null,
    age_verified_at: null,
    lat: 43.6532,
    lng: -79.3832,
    radius_km: 25,
    photos: [],
    prompts: [],
    lifestyle_signals: {},
    true_love_opt_in: false,
    is_discoverable: true,
    last_active_at: new Date('2026-07-31T00:00:00.000Z'),
    ...overrides,
  };
}

describe('dating route age gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue(userRecord);
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.dating_profile.upsert.mockResolvedValue(profile());
    prismaMock.dating_profile.update.mockImplementation(async ({ data }) => profile(data));
    prismaMock.chat_channel.findFirst.mockResolvedValue(null);
    prismaMock.chat_channel.findMany.mockResolvedValue([]);
    prismaMock.chat_channel.create.mockResolvedValue({ channel_id: 99 });
    prismaMock.chat_channel.update.mockResolvedValue({ channel_id: 99, status: 'blocked' });
    prismaMock.chat_channel.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.chat_participants.createMany.mockResolvedValue({ count: 2 });
    prismaMock.chat_participants.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.chat_messages.count.mockResolvedValue(0);
    prismaMock.dating_blind_session.findFirst.mockResolvedValue(null);
    prismaMock.dating_blind_queue.findFirst.mockResolvedValue(null);
    prismaMock.dating_blind_queue.findMany.mockResolvedValue([]);
    prismaMock.dating_blind_queue.create.mockImplementation(async ({ data }) => ({ dating_blind_queue_id: 20, status: 'waiting', ...data }));
    prismaMock.dating_blind_queue.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.dating_blind_queue.update.mockResolvedValue({ dating_blind_queue_id: 21, status: 'matched' });
    prismaMock.dating_report.findMany.mockResolvedValue([]);
    prismaMock.dating_match.findMany.mockResolvedValue([]);
    prismaMock.dating_match.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.dating_swipe.findFirst.mockResolvedValue(null);
    prismaMock.dating_swipe.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.dating_crossed_path_candidate.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.follower.findMany.mockResolvedValue([]);
    prismaMock.follower.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.social_profile.findUnique.mockResolvedValue(null);
    prismaMock.social_profile.findMany.mockResolvedValue([]);
    prismaMock.social_block.findMany.mockResolvedValue([]);
    prismaMock.social_block.findFirst.mockResolvedValue(null);
    prismaMock.social_block.upsert.mockResolvedValue({ block_id: 300 });
    prismaMock.social_block.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.vendor_type.findMany.mockResolvedValue([]);
    prismaMock.food_vendor.findMany.mockResolvedValue([]);
    prismaMock.product_listing.findMany.mockResolvedValue([]);
  });

  it('allows an adult date of birth to be saved during setup', async () => {
    const res = await request(app)
      .put('/dating/profile')
      .send({ birthdate: '1993-12-25', adult_confirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.adult).toBeTruthy();
    expect(prismaMock.dating_profile.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        age_verified_at: expect.any(Date),
      }),
    }));
  });

  it('sanitizes True Love signal controls and drops sensitive matching categories', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
      lifestyle_signals: { true_love_controls: { food: false } },
    }));

    const res = await request(app)
      .put('/dating/profile')
      .send({
        adult_confirmed: true,
        true_love_opt_in: true,
        lifestyle_signals: {
          true_love_controls: { food: true, videos: true, income: true },
          food: ['Sushi', 'Coffee'],
          videos: ['Cooking'],
          income: ['100k+'],
          race: ['Private'],
        },
      });

    expect(res.status).toBe(200);
    const data = prismaMock.dating_profile.update.mock.calls.at(-1)[0].data;
    expect(data.true_love_opt_in).toBe(true);
    expect(data.lifestyle_signals).toMatchObject({
      true_love_controls: expect.objectContaining({ food: true, videos: true, shopping: false }),
      food: ['Sushi', 'Coffee'],
      videos: ['Cooking'],
    });
    expect(data.lifestyle_signals).not.toHaveProperty('income');
    expect(data.lifestyle_signals).not.toHaveProperty('race');
    expect(data.lifestyle_signals.true_love_controls).not.toHaveProperty('income');
  });

  it('saves Dating privacy defaults and user overrides without sensitive categories', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
      lifestyle_signals: {},
    }));

    const res = await request(app)
      .put('/dating/profile')
      .send({
        adult_confirmed: true,
        lifestyle_signals: {
          privacy_settings: {
            hide_from_followers: false,
            hide_from_following: true,
            hide_from_contacts: true,
            private_mode: true,
          },
          income: ['100k+'],
        },
      });

    expect(res.status).toBe(200);
    const data = prismaMock.dating_profile.update.mock.calls.at(-1)[0].data;
    expect(data.lifestyle_signals.privacy_settings).toEqual({
      hide_from_followers: false,
      hide_from_following: true,
      hide_from_contacts: true,
      private_mode: true,
    });
    expect(data.lifestyle_signals).not.toHaveProperty('income');
  });

  it('returns crossed-path privacy settings as explicit opt-ins by default', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
      lifestyle_signals: {},
    }));

    const res = await request(app).get('/dating/me');

    expect(res.status).toBe(200);
    expect(res.body.data.crossed_paths_settings).toMatchObject({
      enabled: false,
      hide_from_followers: false,
      hide_from_following: false,
      hide_from_contacts: false,
      incognito: false,
    });
  });

  it('blocks profile content edits before adult confirmation', async () => {
    const res = await request(app)
      .put('/dating/profile')
      .send({ display_name: 'Blocked until adult' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/18\+/i);
    expect(prismaMock.dating_profile.update).not.toHaveBeenCalled();
  });

  it('blocks protected dating actions before adult confirmation', async () => {
    const res = await request(app).get('/dating/matches');

    expect(res.status).toBe(403);
    expect(prismaMock.dating_match.findMany).not.toHaveBeenCalled();
  });

  it('allows protected dating actions after adult confirmation', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_match.findMany.mockResolvedValue([]);
    prismaMock.dating_profile.findMany.mockResolvedValue([]);

    const res = await request(app).get('/dating/matches');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ successful: true, data: [] });
    expect(prismaMock.dating_match.findMany).toHaveBeenCalled();
  });

  it('does not use document verification date of birth for dating adult access', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      ...userRecord,
      document_verification_status: 'verified',
      document_verification_dob: new Date('1993-12-25T00:00:00.000Z'),
    });
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('2012-01-01'), age_verified_at: null }));
    prismaMock.dating_match.findMany.mockResolvedValue([]);
    prismaMock.dating_profile.findMany.mockResolvedValue([]);

    const res = await request(app).get('/dating/matches');

    expect(res.status).toBe(403);
    expect(prismaMock.dating_match.findMany).not.toHaveBeenCalled();
  });

  it('allows protected dating actions for adults without document verification', async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(userRecord)
      .mockResolvedValueOnce({
        ...userRecord,
        document_verification_status: 'pending',
        document_verified_at: null,
      });
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_match.findMany.mockResolvedValue([]);
    prismaMock.dating_profile.findMany.mockResolvedValue([]);

    const res = await request(app).get('/dating/matches');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ successful: true, data: [] });
    expect(prismaMock.dating_match.findMany).toHaveBeenCalled();
  });

  it('does not return obvious seed or demo dating profiles from discovery', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_swipe.findMany.mockResolvedValue([]);
    prismaMock.dating_profile.findMany.mockResolvedValue([
      profile({
        dating_profile_id: 8,
        user_id: 55,
        display_name: 'Real Person',
        birthdate: new Date('1992-01-01'),
        age_verified_at: new Date('2026-07-31'),
        user: { user_id: 55, name: 'Real Person', document_verification_status: 'verified', document_verified_at: new Date('2026-07-31'), social_profiles: { display_name: 'Real Person', bio: null, profile_pic_url: null, is_verified: false } },
      }),
      profile({
        dating_profile_id: 9,
        user_id: 56,
        display_name: 'Demo Dating User',
        birthdate: new Date('1992-01-01'),
        age_verified_at: new Date('2026-07-31'),
        user: { user_id: 56, name: 'Demo Dating User', document_verification_status: 'verified', document_verified_at: new Date('2026-07-31'), social_profiles: { display_name: 'Demo Dating User', bio: null, profile_pic_url: null, is_verified: false } },
      }),
    ]);

    const res = await request(app).get('/dating/discover');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].display_name).toBe('Real Person');
  });

  it('requires viewer opt-in before True Love discovery uses deep compatibility', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
      true_love_opt_in: false,
    }));

    const res = await request(app).get('/dating/discover?mode=true-love');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TRUE_LOVE_OPT_IN_REQUIRED');
    expect(prismaMock.dating_profile.findMany).not.toHaveBeenCalled();
  });

  it('excludes users the viewer blocked in another dating mode from discovery', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
      true_love_opt_in: true,
    }));
    prismaMock.dating_swipe.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ actor_id: 42, target_id: 55 }]);
    prismaMock.dating_profile.findMany.mockResolvedValue([]);

    const res = await request(app).get('/dating/discover?mode=true-love');

    expect(res.status).toBe(200);
    expect(prismaMock.dating_profile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        user_id: { notIn: expect.arrayContaining([42, 55]) },
      }),
    }));
  });

  it('does not silently hide the viewer social graph by default', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
    }));
    prismaMock.social_profile.findUnique.mockResolvedValue({ profile_id: 420, user_id: 42 });
    prismaMock.follower.findMany.mockResolvedValue([
      { follower_id: 420, following_id: 550 },
      { follower_id: 560, following_id: 420 },
    ]);
    prismaMock.social_profile.findMany.mockResolvedValue([
      { profile_id: 550, user_id: 55 },
      { profile_id: 560, user_id: 56 },
    ]);
    prismaMock.dating_swipe.findMany.mockResolvedValue([]);
    prismaMock.dating_profile.findMany.mockResolvedValue([]);

    const res = await request(app).get('/dating/discover');

    expect(res.status).toBe(200);
    expect(prismaMock.follower.findMany).not.toHaveBeenCalled();
    expect(prismaMock.dating_profile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        user_id: { notIn: [42] },
      }),
    }));
  });

  it('does not silently hide crossed-path social graph settings by default', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
      lifestyle_signals: { crossed_paths: { enabled: true } },
    }));
    prismaMock.dating_crossed_path_event.findMany.mockResolvedValue([]);
    prismaMock.dating_crossed_path_event.upsert.mockResolvedValue({ dating_crossed_path_event_id: 1 });

    const res = await request(app)
      .post('/dating/crossed-paths/events')
      .send({ lat: 43.6532, lng: -79.3832, area_label: 'Downtown' });

    expect(res.status).toBe(201);
    expect(prismaMock.follower.findMany).not.toHaveBeenCalled();
  });

  it('lets privacy settings opt out of hiding social followers from Dating discovery', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
      lifestyle_signals: { privacy_settings: { hide_from_followers: false, hide_from_following: false } },
    }));
    prismaMock.social_profile.findUnique.mockResolvedValue({ profile_id: 420, user_id: 42 });
    prismaMock.follower.findMany.mockResolvedValue([
      { follower_id: 420, following_id: 550 },
      { follower_id: 560, following_id: 420 },
    ]);
    prismaMock.social_profile.findMany.mockResolvedValue([
      { profile_id: 550, user_id: 55 },
      { profile_id: 560, user_id: 56 },
    ]);
    prismaMock.dating_swipe.findMany.mockResolvedValue([]);
    prismaMock.dating_profile.findMany.mockResolvedValue([]);

    const res = await request(app).get('/dating/discover');

    expect(res.status).toBe(200);
    expect(prismaMock.follower.findMany).not.toHaveBeenCalled();
    expect(prismaMock.dating_profile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        user_id: { notIn: [42] },
      }),
    }));
  });

  it('uses only mutually enabled safe True Love controls for match explanations', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
      true_love_opt_in: true,
      lifestyle_signals: {
        true_love_controls: { food: true, videos: false, music: true },
        food: ['sushi'],
        videos: ['travel'],
        music: ['jazz'],
      },
    }));
    prismaMock.dating_swipe.findMany.mockResolvedValue([]);
    prismaMock.dating_profile.findMany.mockResolvedValue([
      profile({
        dating_profile_id: 8,
        user_id: 55,
        display_name: 'Real Person',
        birthdate: new Date('1992-01-01'),
        age_verified_at: new Date('2026-07-31'),
        true_love_opt_in: true,
        lifestyle_signals: {
          true_love_controls: { food: true, videos: true, music: false },
          food: ['sushi'],
          videos: ['travel'],
          music: ['jazz'],
        },
        user: { user_id: 55, name: 'Real Person', document_verification_status: 'verified', document_verified_at: new Date('2026-07-31'), social_profiles: { display_name: 'Real Person', bio: null, profile_pic_url: null, is_verified: false } },
      }),
    ]);

    const res = await request(app).get('/dating/discover?mode=true-love');

    expect(res.status).toBe(200);
    expect(res.body.data[0].match_reasons).toContain('Food match');
    expect(res.body.data[0].match_reasons).not.toContain('Video taste');
    expect(res.body.data[0].match_reasons).not.toContain('Music match');
    expect(res.body.data[0].match_explanations).toEqual([
      expect.objectContaining({ signal: 'food', title: 'Food match' }),
    ]);
  });

  it('supports male and female True Love perspectives with reciprocal preferences', async () => {
    const makeTrueLoveProfile = (overrides = {}) => profile({
      birthdate: new Date('1993-12-25'),
      age_verified_at: new Date('2026-07-31'),
      true_love_opt_in: true,
      bio: 'Looking for an intentional connection.',
      prompts: ['A good evening starts with good conversation.'],
      lifestyle_signals: {
        true_love_controls: { food: true, music: true, lifestyle: true, events: true },
        food: ['sushi', 'coffee'],
        music: ['jazz'],
        availability: ['weekends'],
        lifestyle: ['low-pressure dates'],
      },
      ...overrides,
    });
    const femaleCandidate = makeTrueLoveProfile({
      dating_profile_id: 55,
      user_id: 55,
      display_name: 'Avery',
      gender: 'female',
      interested_in: ['male'],
      user: { user_id: 55, name: 'Avery', document_verification_status: 'verified', document_verified_at: new Date('2026-07-31'), social_profiles: { display_name: 'Avery', bio: null, profile_pic_url: null, is_verified: false } },
    });
    const maleCandidate = makeTrueLoveProfile({
      dating_profile_id: 56,
      user_id: 56,
      display_name: 'Rowan',
      gender: 'male',
      interested_in: ['female'],
      user: { user_id: 56, name: 'Rowan', document_verification_status: 'verified', document_verified_at: new Date('2026-07-31'), social_profiles: { display_name: 'Rowan', bio: null, profile_pic_url: null, is_verified: false } },
    });
    prismaMock.dating_swipe.findMany.mockResolvedValue([]);
    prismaMock.dating_profile.findMany.mockResolvedValue([femaleCandidate, maleCandidate]);
    prismaMock.dating_profile.upsert.mockResolvedValueOnce(makeTrueLoveProfile({
      gender: 'male',
      interested_in: ['female'],
    }));

    const maleView = await request(app).get('/dating/discover?mode=true-love');

    expect(maleView.status).toBe(200);
    expect(maleView.body.data.map((item) => item.display_name)).toEqual(['Avery']);
    expect(maleView.body.data[0].match_reasons).toEqual(expect.arrayContaining(['Food match', 'Music match']));

    prismaMock.dating_profile.upsert.mockResolvedValueOnce(makeTrueLoveProfile({
      gender: 'female',
      interested_in: ['male'],
    }));

    const femaleView = await request(app).get('/dating/discover?mode=true-love');

    expect(femaleView.status).toBe(200);
    expect(femaleView.body.data.map((item) => item.display_name)).toEqual(['Rowan']);
    expect(femaleView.body.data[0].match_reasons).toEqual(expect.arrayContaining(['Food match', 'Music match']));
  });

  it('opens a dedicated chat for a dating match', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_match.findFirst.mockResolvedValue({
      dating_match_id: 12,
      user_a_id: 42,
      user_b_id: 55,
      mode: 'standard',
      status: 'matched',
    });
    prismaMock.dating_match.update.mockResolvedValue({ dating_match_id: 12, chat_channel_id: 99, status: 'matched' });

    const res = await request(app).post('/dating/matches/12/chat');

    expect(res.status).toBe(200);
    expect(prismaMock.chat_channel.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        context_type: 'dating_match',
        context_id: '12',
      }),
    }));
    expect(prismaMock.chat_participants.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({ channel_id: 99, user_id: 42 }),
        expect.objectContaining({ channel_id: 99, user_id: 55 }),
      ]),
    }));
    expect(prismaMock.dating_match.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { chat_channel_id: 99 },
    }));
    expect(res.body.data.channel_id).toBe(99);
  });

  it('returns pending likes-you rows and supports priority interest', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_swipe.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          dating_swipe_id: 88,
          actor_id: 55,
          target_id: 42,
          action: 'super_like',
          created_at: new Date('2026-08-01T00:00:00.000Z'),
          actor: {
            dating_profiles: [profile({
              dating_profile_id: 9,
              user_id: 55,
              display_name: 'Real Liker',
              birthdate: new Date('1994-01-01'),
              age_verified_at: new Date('2026-07-31'),
              user: { user_id: 55, name: 'Real Liker', document_verification_status: 'verified', document_verified_at: new Date('2026-07-31'), social_profiles: { display_name: 'Real Liker', bio: null, profile_pic_url: null, is_verified: true } },
            })],
          },
        },
      ]);

    const likesRes = await request(app).get('/dating/likes-you');

    expect(likesRes.status).toBe(200);
    expect(likesRes.body.data[0]).toMatchObject({ action: 'super_like', profile: { display_name: 'Real Liker' } });

    prismaMock.dating_profile.findUnique.mockResolvedValue(profile({
      user_id: 55,
      birthdate: new Date('1994-01-01'),
      age_verified_at: new Date('2026-07-31'),
      user: { document_verification_status: 'verified', document_verified_at: new Date('2026-07-31') },
    }));
    prismaMock.dating_swipe.upsert.mockResolvedValue({ dating_swipe_id: 89, action: 'super_like' });
    prismaMock.dating_swipe.findFirst.mockResolvedValue(null);

    const swipeRes = await request(app).post('/dating/swipes').send({ target_user_id: 55, action: 'super_like' });

    expect(swipeRes.status).toBe(201);
    expect(notifyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'dating.super_like',
      userId: 55,
    }));
  });

  it('blocks a visible dating profile without creating a match or notification', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_profile.findUnique.mockResolvedValue(profile({
      user_id: 55,
      birthdate: new Date('1994-01-01'),
      age_verified_at: new Date('2026-07-31'),
      user: { document_verification_status: 'verified', document_verified_at: new Date('2026-07-31') },
    }));
    prismaMock.dating_swipe.upsert.mockResolvedValue({ dating_swipe_id: 90, actor_id: 42, target_id: 55, action: 'block', mode: 'standard' });
    prismaMock.social_profile.findMany.mockResolvedValue([
      { profile_id: 420, user_id: 42 },
      { profile_id: 550, user_id: 55 },
    ]);

    const res = await request(app).post('/dating/swipes').send({ target_user_id: 55, action: 'block', mode: 'standard' });

    expect(res.status).toBe(201);
    expect(prismaMock.dating_swipe.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ action: 'block' }),
      create: expect.objectContaining({ actor_id: 42, target_id: 55, action: 'block', mode: 'standard' }),
    }));
    expect(prismaMock.dating_swipe.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.dating_match.updateMany).toHaveBeenCalledWith({
      where: { user_a_id: 42, user_b_id: 55, status: { not: 'blocked' } },
      data: { status: 'blocked', unmatched_at: expect.any(Date) },
    });
    expect(prismaMock.social_block.upsert).toHaveBeenCalledWith({
      where: { blocker_id_blocked_id: { blocker_id: 420, blocked_id: 550 } },
      update: {},
      create: { blocker_id: 420, blocked_id: 550 },
    });
    expect(prismaMock.follower.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { follower_id: 420, following_id: 550 },
          { follower_id: 550, following_id: 420 },
        ],
      },
    });
    expect(prismaMock.dating_match.upsert).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('lists and unblocks accounts blocked from Dating', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_swipe.findMany.mockResolvedValue([
      {
        dating_swipe_id: 90,
        actor_id: 42,
        target_id: 55,
        action: 'block',
        mode: 'standard',
        created_at: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    prismaMock.user.findMany.mockResolvedValue([
      {
        user_id: 55,
        name: 'Blocked Person',
        social_profiles: { display_name: 'Blocked Social', profile_pic_url: 'https://img.test/a.jpg' },
        dating_profiles: [{ display_name: 'Blocked Dating', photos: ['https://img.test/d.jpg'] }],
      },
    ]);

    const listRes = await request(app).get('/dating/blocked');

    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toEqual([
      expect.objectContaining({
        user_id: 55,
        display_name: 'Blocked Dating',
        profile_pic_url: 'https://img.test/d.jpg',
      }),
    ]);

    prismaMock.social_profile.findMany.mockResolvedValue([
      { profile_id: 420, user_id: 42 },
      { profile_id: 550, user_id: 55 },
    ]);

    const unblockRes = await request(app).delete('/dating/blocked/55');

    expect(unblockRes.status).toBe(200);
    expect(prismaMock.dating_swipe.deleteMany).toHaveBeenCalledWith({
      where: { actor_id: 42, target_id: 55, action: 'block' },
    });
    expect(prismaMock.social_block.deleteMany).toHaveBeenCalledWith({
      where: { blocker_id: 420, blocked_id: 550 },
    });
  });

  it('allows block even when the target profile is no longer eligible for discovery', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_profile.findUnique.mockResolvedValue(profile({
      user_id: 55,
      birthdate: null,
      age_verified_at: null,
      user: { document_verification_status: 'pending', document_verified_at: null },
    }));
    prismaMock.dating_swipe.upsert.mockResolvedValue({ dating_swipe_id: 91, actor_id: 42, target_id: 55, action: 'block', mode: 'standard' });

    const res = await request(app).post('/dating/swipes').send({ target_user_id: 55, action: 'block', mode: 'standard' });

    expect(res.status).toBe(201);
    expect(prismaMock.dating_swipe.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ actor_id: 42, target_id: 55, action: 'block' }),
    }));
  });

  it('closes an existing dating chat when blocking directly from a profile card', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_profile.findUnique.mockResolvedValue(profile({
      user_id: 55,
      birthdate: new Date('1994-01-01'),
      age_verified_at: new Date('2026-07-31'),
      user: { document_verification_status: 'verified', document_verified_at: new Date('2026-07-31') },
    }));
    prismaMock.dating_swipe.upsert.mockResolvedValue({ dating_swipe_id: 94, actor_id: 42, target_id: 55, action: 'block', mode: 'standard' });
    prismaMock.dating_match.findMany.mockResolvedValue([{ chat_channel_id: 99 }, { chat_channel_id: 100 }]);

    const res = await request(app).post('/dating/swipes').send({ target_user_id: 55, action: 'block', mode: 'standard' });

    expect(res.status).toBe(201);
    expect(prismaMock.dating_match.findMany).toHaveBeenCalledWith({
      where: { user_a_id: 42, user_b_id: 55, status: { not: 'blocked' } },
      select: { chat_channel_id: true },
    });
    expect(prismaMock.dating_match.updateMany).toHaveBeenCalledWith({
      where: { user_a_id: 42, user_b_id: 55, status: { not: 'blocked' } },
      data: { status: 'blocked', unmatched_at: expect.any(Date) },
    });
    expect(prismaMock.chat_channel.update).toHaveBeenCalledWith({
      where: { channel_id: 99 },
      data: { status: 'blocked' },
    });
    expect(prismaMock.chat_channel.update).toHaveBeenCalledWith({
      where: { channel_id: 100 },
      data: { status: 'blocked' },
    });
  });

  it('does not notify a profile across a dating block boundary', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_profile.findUnique.mockResolvedValue(profile({
      user_id: 55,
      birthdate: new Date('1994-01-01'),
      age_verified_at: new Date('2026-07-31'),
      user: { user_id: 55, document_verification_status: 'verified', document_verification_dob: new Date('1994-01-01') },
    }));
    prismaMock.dating_swipe.findFirst.mockResolvedValue({ dating_swipe_id: 95, action: 'block' });

    const res = await request(app).post('/dating/swipes').send({ target_user_id: 55, action: 'super_like', mode: 'standard' });

    expect(res.status).toBe(404);
    expect(prismaMock.dating_swipe.upsert).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('closes an already opened dating match chat when blocking a match', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_match.findFirst.mockResolvedValue({
      dating_match_id: 12,
      user_a_id: 42,
      user_b_id: 55,
      mode: 'standard',
      status: 'matched',
      chat_channel_id: 99,
    });
    prismaMock.dating_swipe.upsert.mockResolvedValue({ dating_swipe_id: 93, actor_id: 42, target_id: 55, action: 'block', mode: 'standard' });
    prismaMock.dating_match.findMany.mockResolvedValue([{ dating_match_id: 12, chat_channel_id: 99 }, { dating_match_id: 13, chat_channel_id: 100 }]);

    const res = await request(app).post('/dating/matches/12/block');

    expect(res.status).toBe(200);
    expect(prismaMock.dating_match.findMany).toHaveBeenCalledWith({
      where: { user_a_id: 42, user_b_id: 55, status: { not: 'blocked' } },
      select: { dating_match_id: true, chat_channel_id: true },
    });
    expect(prismaMock.dating_match.updateMany).toHaveBeenCalledWith({
      where: { user_a_id: 42, user_b_id: 55, status: { not: 'blocked' } },
      data: { status: 'blocked', unmatched_at: expect.any(Date) },
    });
    expect(prismaMock.chat_channel.update).toHaveBeenCalledWith({
      where: { channel_id: 99 },
      data: { status: 'blocked' },
    });
    expect(prismaMock.chat_channel.update).toHaveBeenCalledWith({
      where: { channel_id: 100 },
      data: { status: 'blocked' },
    });
  });

  it('stores blind queue preferences and icebreakers', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));

    const res = await request(app)
      .post('/dating/blind/join')
      .send({
        preferences: {
          age_min: 24,
          age_max: 36,
          distance_km: 18,
          language: 'English',
          intent: 'Intentional dating',
          vibe: 'Calm conversation',
          reveal_after_messages: 8,
          reveal_after_minutes: 12,
        },
        icebreakers: ['Best coffee order?', 'What is your ideal Friday night?'],
      });

    expect(res.status).toBe(201);
    expect(prismaMock.dating_blind_queue.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        boundaries: expect.objectContaining({
          preferences: expect.objectContaining({ age_min: 24, age_max: 36, distance_km: 18, language: 'English' }),
          icebreakers: ['Best coffee order?', 'What is your ideal Friday night?'],
        }),
      }),
    }));
  });

  it('blocks joining a second active blind chat', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_blind_session.findFirst.mockResolvedValue({
      dating_blind_session_id: 44,
      user_a_id: 42,
      user_b_id: 55,
      status: 'chatting',
    });

    const res = await request(app).post('/dating/blind/join').send({});

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/active blind chat/i);
    expect(prismaMock.dating_blind_queue.create).not.toHaveBeenCalled();
  });

  it('matches compatible blind queue users and persists session guardrails', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_blind_queue.findMany.mockResolvedValue([
      {
        dating_blind_queue_id: 21,
        user_id: 55,
        boundaries: {
          preferences: {
            age_min: 25,
            age_max: 40,
            distance_km: 30,
            language: 'English',
            intent: 'Intentional dating',
            vibe: 'Calm conversation',
            reveal_after_messages: 4,
            reveal_after_minutes: 8,
          },
          icebreakers: ['Coffee or dinner?'],
        },
        user: {
          user_id: 55,
          dating_profiles: [profile({
            dating_profile_id: 8,
            user_id: 55,
            birthdate: new Date('1994-01-01'),
            lat: 43.654,
            lng: -79.384,
          })],
        },
      },
    ]);
    prismaMock.dating_blind_session.create.mockImplementation(async ({ data }) => ({ dating_blind_session_id: 44, status: 'chatting', ...data }));

    const res = await request(app)
      .post('/dating/blind/join')
      .send({
        preferences: {
          age_min: 25,
          age_max: 36,
          distance_km: 20,
          language: 'English',
          intent: 'Intentional dating',
          vibe: 'Calm conversation',
          reveal_after_messages: 6,
          reveal_after_minutes: 10,
        },
        icebreakers: ['Best first-date food?'],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('matched');
    expect(prismaMock.dating_blind_session.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        user_a_id: 55,
        user_b_id: 42,
        icebreakers: ['Best first-date food?', 'Coffee or dinner?'],
        reveal_policy: { min_messages: 6, min_minutes: 10 },
      }),
    }));
    expect(prismaMock.dating_blind_queue.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { dating_blind_queue_id: 21 },
      data: expect.objectContaining({ status: 'matched', matched_session_id: 44 }),
    }));
  });

  it('blocks blind reveal until the configured message or time threshold is met', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_blind_session.findFirst.mockResolvedValue({
      dating_blind_session_id: 44,
      user_a_id: 42,
      user_b_id: 55,
      status: 'chatting',
      reveal_confirmed_by: [],
      reveal_policy: { min_messages: 6, min_minutes: 10 },
      chat_channel_id: 99,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 3600000),
    });
    prismaMock.chat_messages.count.mockResolvedValue(2);

    const res = await request(app).post('/dating/blind/sessions/44/reveal');

    expect(res.status).toBe(409);
    expect(res.body.data).toMatchObject({ message_count: 2, min_messages: 6, can_request_reveal: false });
    expect(prismaMock.dating_blind_session.update).not.toHaveBeenCalled();
  });

  it('allows blind reveal after the message threshold is met', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_blind_session.findFirst.mockResolvedValue({
      dating_blind_session_id: 44,
      user_a_id: 42,
      user_b_id: 55,
      status: 'chatting',
      reveal_confirmed_by: [],
      reveal_policy: { min_messages: 6, min_minutes: 10 },
      chat_channel_id: 99,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 3600000),
    });
    prismaMock.chat_messages.count.mockResolvedValue(6);
    prismaMock.dating_blind_session.update.mockResolvedValue({
      dating_blind_session_id: 44,
      status: 'reveal_requested',
      reveal_confirmed_by: [42],
    });

    const res = await request(app).post('/dating/blind/sessions/44/reveal');

    expect(res.status).toBe(200);
    expect(prismaMock.dating_blind_session.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'reveal_requested',
        reveal_requested_by: 42,
        reveal_confirmed_by: [42],
      }),
    }));
  });

  it('opens, ends, and reports an anonymous blind session', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    const session = {
      dating_blind_session_id: 44,
      user_a_id: 42,
      user_b_id: 55,
      status: 'chatting',
      chat_channel_id: null,
      created_at: new Date('2026-07-31T00:00:00.000Z'),
    };
    prismaMock.dating_blind_session.findFirst.mockResolvedValue(session);
    prismaMock.dating_blind_session.update.mockImplementation(async ({ data }) => ({ ...session, ...data }));
    prismaMock.dating_report.create.mockResolvedValue({ dating_report_id: 5, entity_type: 'dating_blind_session' });

    const chatRes = await request(app).post('/dating/blind/sessions/44/chat');
    expect(chatRes.status).toBe(200);
    expect(chatRes.body.data.channel_id).toBe(99);

    const endRes = await request(app).patch('/dating/blind/sessions/44/end').send({ reason: 'Not a fit' });
    expect(endRes.status).toBe(200);
    expect(prismaMock.dating_blind_session.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'ended', ended_by: 42, ended_reason: 'Not a fit' }),
    }));

    const reportRes = await request(app).post('/dating/blind/sessions/44/report').send({ reason: 'Harassment', details: 'Unsafe comments' });
    expect(reportRes.status).toBe(201);
    expect(prismaMock.dating_report.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        reporter_id: 42,
        reported_user_id: 55,
        entity_type: 'dating_blind_session',
        entity_id: 44,
        reason: 'Harassment',
      }),
    }));
  });

  it('leaves the blind queue', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));

    const res = await request(app).delete('/dating/blind/queue');

    expect(res.status).toBe(200);
    expect(prismaMock.dating_blind_queue.updateMany).toHaveBeenCalledWith({
      where: { user_id: 42, status: 'waiting' },
      data: { status: 'cancelled' },
    });
  });

  it('hides reporter identity from the reported user in safety history', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_report.findMany.mockResolvedValue([
      {
        dating_report_id: 1,
        reporter_id: 42,
        reported_user_id: 55,
        entity_type: 'dating_match',
        entity_id: 12,
        reason: 'No-show',
        details: 'They did not arrive',
        status: 'open',
        created_at: new Date('2026-08-01T00:00:00.000Z'),
      },
      {
        dating_report_id: 2,
        reporter_id: 55,
        reported_user_id: 42,
        entity_type: 'dating_match',
        entity_id: 13,
        reason: 'Harassment',
        details: 'Reporter-identifying private no-show context',
        status: 'open',
        created_at: new Date('2026-08-02T00:00:00.000Z'),
      },
    ]);

    const res = await request(app).get('/dating/safety/history');

    expect(res.status).toBe(200);
    expect(res.body.data.reports).toHaveLength(2);
    expect(res.body.data.reports[0]).toMatchObject({
      dating_report_id: 1,
      reporter_id: 42,
      details: 'They did not arrive',
      viewer_role: 'reporter',
    });
    expect(res.body.data.reports[1]).toMatchObject({
      dating_report_id: 2,
      reported_user_id: 42,
      reason: 'Harassment',
      viewer_role: 'reported',
    });
    expect(res.body.data.no_show_count).toBe(1);
    expect(res.body.data.reports[1]).not.toHaveProperty('reporter_id');
    expect(res.body.data.reports[1]).not.toHaveProperty('details');
  });

  it('rejects invalid Worth It date coordinates before they reach Prisma', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));

    const res = await request(app)
      .post('/dating/worth-it/plans')
      .send({
        restaurant_name: 'Moxies',
        date: futureDateValue(),
        time: '19:00',
        budget_amount: 100,
        lat: 'not-a-number',
        lng: -79.3832,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid date plan coordinates');
    expect(prismaMock.dating_date_plan.create).not.toHaveBeenCalled();
  });

  it('stores Worth It booking, menu, add-ons, and no-show protection policy', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.food_vendor.findUnique.mockResolvedValue({
      vendor_id: 4,
      vendor_name: 'Moxies',
      location: '123 Main St',
      lat: 43.6,
      long: -79.4,
    });
    prismaMock.food_vendor.findMany.mockResolvedValue([
      {
        vendor_id: 9,
        vendor_name: 'Downtown Florals',
        cuisine_type: 'Flowers',
        location: '456 Queen St',
        lat: 43.7,
        long: -79.3,
        logo_url: 'https://cdn.example.com/floral.png',
        cover_url: null,
        vendor_type: { vendor_type: 'Floral' },
      },
    ]);
    prismaMock.dating_date_plan.create.mockImplementation(async ({ data }) => ({
      dating_date_plan_id: 70,
      organizer_id: 42,
      status: data.status,
      visibility: data.visibility,
      interests: [],
      invites: [],
      organizer: { user_id: 42, name: 'Dating User', social_profiles: { display_name: 'Dating User' } },
      ...data,
    }));

    const res = await request(app)
      .post('/dating/worth-it/plans')
      .send({
        vendor_id: 4,
        restaurant_name: 'Moxies',
        date: futureDateValue(),
        time: '19:00',
        budget_amount: 100,
        payment_split: '50',
        deposit_amount: 25,
        cancellation_window_hours: 24,
        attendance_score_required: 85,
        menu_intent: [{ id: 1, name: 'Steak' }],
        add_ons: [{ id: 'flowers', label: 'Flowers', marketplace_source: 'food_vendor', marketplace_ref_id: 9 }],
        publish: true,
      });

    expect(res.status).toBe(201);
    expect(prismaMock.dating_date_plan.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        vendor_id: 4,
        deposit_amount: 25,
        cancellation_window_hours: 24,
        attendance_score_required: 85,
        menu_intent: [{ id: 1, name: 'Steak' }],
        add_ons: [
          expect.objectContaining({
            id: 'flowers',
            label: 'Flowers',
            type: 'scheduled_date_add_on',
            status: 'pending',
            recipient_rule: 'venue',
            payment_owner: 'split',
            delivery_destination: 'date_venue',
            delivery_window_minutes_before: 45,
            scheduled_for: null,
            marketplace_source: 'food_vendor',
            marketplace_ref_id: 9,
            vendor_name: 'Downtown Florals',
          }),
        ],
      }),
    }));
  });

  it('blocks Worth It interest when attendance score is below the organizer requirement', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_date_plan.findFirst.mockResolvedValue({
      dating_date_plan_id: 70,
      organizer_id: 55,
      status: 'published',
      visibility: 'public',
      attendance_score_required: 90,
    });
    prismaMock.dating_report.findMany.mockResolvedValue([
      { reason: 'No-show', details: 'Did not attend' },
      { reason: 'No-show concern', details: '' },
    ]);

    const res = await request(app)
      .post('/dating/worth-it/plans/70/interest')
      .send({ message: 'Interested' });

    expect(res.status).toBe(403);
    expect(prismaMock.dating_date_interest.upsert).not.toHaveBeenCalled();
  });

  it('excludes blocked organizers from public Worth It plan lookup', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_swipe.findMany.mockResolvedValue([{ actor_id: 42, target_id: 55 }]);
    prismaMock.dating_date_plan.findMany.mockResolvedValue([]);

    const res = await request(app).get('/dating/worth-it/plans');

    expect(res.status).toBe(200);
    expect(prismaMock.dating_date_plan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        organizer_id: { notIn: [42, 55] },
      }),
    }));
  });

  it('rejects Worth It interest across a dating block boundary', async () => {
    prismaMock.dating_profile.upsert.mockResolvedValue(profile({ birthdate: new Date('1993-12-25'), age_verified_at: new Date('2026-07-31') }));
    prismaMock.dating_date_plan.findFirst.mockResolvedValue({
      dating_date_plan_id: 70,
      organizer_id: 55,
      status: 'published',
      visibility: 'public',
      attendance_score_required: 0,
    });
    prismaMock.dating_swipe.findFirst.mockResolvedValue({ dating_swipe_id: 92 });

    const res = await request(app)
      .post('/dating/worth-it/plans/70/interest')
      .send({ message: 'Interested' });

    expect(res.status).toBe(404);
    expect(prismaMock.dating_date_interest.upsert).not.toHaveBeenCalled();
  });
});
