import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    playlist: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    playlist_item: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    video: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    channel: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../utils/azure-storage.js', () => ({
  generateVideoReadSAS: (container, url) => (url ? `${url}?sas=1` : null),
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { user_id: 7 };
    next();
  },
  optionalAuth: (req, res, next) => next(),
}));

const shapedVideo = {
  video_id: 31,
  title: 'Lesson one',
  thumbnail_url: 'https://cdn.test/31.jpg',
  hls_url: 'https://cdn.test/31/master.m3u8',
  raw_video_url: 'https://cdn.test/raw/31.mp4',
  duration_sec: 90,
  views_count: 10,
  video_type: 'long',
  status: 'safe',
  processing_status: 'done',
  created_at: '2026-08-01T00:00:00.000Z',
  category: 'Education',
  channel: { channel_id: 2, user_id: 2, display_name: 'Teacher', handle: 'teacher', profile_pic_url: null },
};

function playlistRow({ playlist_id = 9, name = 'Mix', is_public = false, withVideo = true, video = shapedVideo } = {}) {
  return {
    playlist_id,
    name,
    is_public,
    created_at: '2026-08-01T00:00:00.000Z',
    items: withVideo
      ? [{ added_at: '2026-08-01T00:00:00.000Z', video }]
      : [],
  };
}

/** Assert attach resolution went through the visibility / owner OR (not a bare status !== banned). */
function expectAttachVisibilityWhere(videoId) {
  expect(prisma.video.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        AND: [
          { video_id: videoId },
          {
            OR: [
              expect.objectContaining({ status: 'safe', processing_status: 'done' }),
              expect.objectContaining({ status: { not: 'banned' }, channel: { user_id: 7 } }),
            ],
          },
        ],
      },
    }),
  );
}

let app;
let prisma;

describe('playlist routes', () => {
  beforeAll(async () => {
    ({ default: prisma } = await import('../../utils/prisma-client.js'));
    const { default: router } = await import('../../routes/playlist-routes.js');
    app = express();
    app.use(express.json());
    app.use('/playlist', router);
    app.use((err, _req, res, _next) => {
      res.status(500).json({ successful: false, message: err?.message || String(err) });
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists the signed-in user\'s playlists', async () => {
    prisma.playlist.findMany.mockResolvedValue([playlistRow()]);
    const res = await request(app).get('/playlist');
    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data[0].name).toBe('Mix');
    expect(res.body.data[0].videos[0].video_id).toBe(31);
    expect(res.body.data[0].videos[0].raw_video_url).toBeUndefined();
    expect(prisma.playlist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 7 } }),
    );
  });

  it('hides private videos the caller does not own (no SAS leak)', async () => {
    const privateOther = {
      ...shapedVideo,
      video_id: 99,
      status: 'private',
      processing_status: 'done',
      hls_url: null,
      raw_video_url: 'https://cdn.test/raw/secret.mp4',
      channel: { ...shapedVideo.channel, user_id: 999 },
    };
    prisma.playlist.findMany.mockResolvedValue([playlistRow({ video: privateOther })]);

    const res = await request(app).get('/playlist');

    expect(res.status).toBe(200);
    expect(res.body.data[0].videos).toHaveLength(0);
  });

  it('still lists the caller\'s own unpublished video', async () => {
    const ownPrivate = {
      ...shapedVideo,
      video_id: 44,
      status: 'private',
      processing_status: 'pending',
      hls_url: null,
      channel: { ...shapedVideo.channel, user_id: 7 },
    };
    prisma.playlist.findMany.mockResolvedValue([playlistRow({ video: ownPrivate })]);

    const res = await request(app).get('/playlist');

    expect(res.status).toBe(200);
    expect(res.body.data[0].videos).toHaveLength(1);
    expect(res.body.data[0].videos[0].video_id).toBe(44);
    expect(res.body.data[0].videos[0].raw_video_url).toBeUndefined();
  });

  it('defaults an empty name to Mix and attaches the video', async () => {
    prisma.video.findFirst.mockResolvedValue({ video_id: 31 });
    prisma.playlist.findFirst.mockResolvedValue(null);
    prisma.playlist.count.mockResolvedValue(0);
    prisma.playlist.create.mockResolvedValue({ playlist_id: 9, name: 'Mix' });
    prisma.playlist_item.upsert.mockResolvedValue({});
    prisma.playlist.findUnique.mockResolvedValue(playlistRow({ name: 'Mix' }));

    const res = await request(app).post('/playlist').send({ name: '  ', video_id: 31 });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Mix');
    expect(res.body.data.videos).toHaveLength(1);
    expect(prisma.playlist.create).toHaveBeenCalledWith({ data: { user_id: 7, name: 'Mix', is_public: false } });
    expect(prisma.playlist_item.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { playlist_id: 9, video_id: 31 },
      }),
    );
    expectAttachVisibilityWhere(31);
  });

  it('reuses an existing Mix instead of creating another', async () => {
    prisma.video.findFirst.mockResolvedValue({ video_id: 31 });
    prisma.playlist.findFirst.mockResolvedValue({ playlist_id: 9, user_id: 7, name: 'Mix' });
    prisma.playlist_item.upsert.mockResolvedValue({});
    prisma.playlist.findUnique.mockResolvedValue(playlistRow({ name: 'Mix' }));

    const res = await request(app).post('/playlist').send({ name: 'Mix', video_id: 31 });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Mix');
    expect(prisma.playlist.create).not.toHaveBeenCalled();
    expect(prisma.playlist_item.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { playlist_id: 9, video_id: 31 } }),
    );
  });

  it('does not create an empty list when the video id is bogus', async () => {
    prisma.video.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/playlist').send({ name: 'Mix', video_id: 999 });
    expect(res.status).toBe(404);
    expect(prisma.playlist.create).not.toHaveBeenCalled();
  });

  it('adds a video to an existing playlist', async () => {
    prisma.video.findFirst.mockResolvedValue({ video_id: 31 });
    prisma.playlist.findFirst.mockResolvedValue({ playlist_id: 9, user_id: 7, name: 'Study' });
    prisma.playlist_item.upsert.mockResolvedValue({});
    prisma.playlist.findUnique.mockResolvedValue(playlistRow({ name: 'Study' }));

    const res = await request(app).post('/playlist/9/items').send({ video_id: 31 });

    expect(res.status).toBe(200);
    expect(res.body.data.videos[0].video_id).toBe(31);
    expect(prisma.playlist_item.upsert).toHaveBeenCalled();
    expectAttachVisibilityWhere(31);
  });

  it('resolves a public_id when adding a video', async () => {
    prisma.video.findFirst.mockResolvedValue({ video_id: 31 });
    prisma.playlist.findFirst.mockResolvedValue({ playlist_id: 9, user_id: 7, name: 'Mix' });
    prisma.playlist_item.upsert.mockResolvedValue({});
    prisma.playlist.findUnique.mockResolvedValue(playlistRow());

    const res = await request(app).post('/playlist/9/items').send({ video_id: 'p31abc' });

    expect(res.status).toBe(200);
    expect(prisma.video.findFirst).toHaveBeenCalled();
    expect(prisma.playlist_item.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { playlist_id: 9, video_id: 31 } }),
    );
  });

  it('404s when attaching a private video the caller does not own', async () => {
    // Visibility / owner gate returns no row — same as a missing video to the attach path.
    prisma.video.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/playlist/9/items').send({ video_id: 99 });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Video not found.');
    expect(prisma.playlist_item.upsert).not.toHaveBeenCalled();
    expectAttachVisibilityWhere(99);
  });

  it('404s when adding to a playlist the caller does not own', async () => {
    prisma.video.findFirst.mockResolvedValue({ video_id: 31 });
    prisma.playlist.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/playlist/9/items').send({ video_id: 31 });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Playlist not found.');
    expect(prisma.playlist_item.upsert).not.toHaveBeenCalled();
    expect(prisma.playlist.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { playlist_id: 9, user_id: 7 } }),
    );
  });

  it('404s when deleting a playlist the caller does not own', async () => {
    prisma.playlist.findFirst.mockResolvedValue(null);

    const res = await request(app).delete('/playlist/9');

    expect(res.status).toBe(404);
    expect(prisma.playlist.delete).not.toHaveBeenCalled();
    expect(prisma.playlist.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { playlist_id: 9, user_id: 7 } }),
    );
  });

  it('404s when removing a video from a playlist the caller does not own', async () => {
    prisma.playlist.findFirst.mockResolvedValue(null);

    const res = await request(app).delete('/playlist/9/items/31');

    expect(res.status).toBe(404);
    expect(prisma.playlist_item.deleteMany).not.toHaveBeenCalled();
    expect(prisma.playlist.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { playlist_id: 9, user_id: 7 } }),
    );
  });

  it('rejects a non-numeric playlist id on DELETE', async () => {
    const res = await request(app).delete('/playlist/abc');
    expect(res.status).toBe(400);
    expect(prisma.playlist.findFirst).not.toHaveBeenCalled();
  });

  it('rejects creating more Mix lists once the cap is reached', async () => {
    prisma.playlist.findFirst.mockResolvedValue(null);
    prisma.playlist.count.mockResolvedValue(50);

    const res = await request(app).post('/playlist').send({ name: 'Mix' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Too many Mix playlists.');
    expect(prisma.playlist.create).not.toHaveBeenCalled();
  });

  it('GET /playlist/channel/:channel_id rejects a non-integer id', async () => {
    const res = await request(app).get('/playlist/channel/abc');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid channel_id');
    expect(prisma.channel.findUnique).not.toHaveBeenCalled();
  });

  it('GET /playlist/channel/:channel_id 404s when the channel is missing', async () => {
    prisma.channel.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/playlist/channel/4');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Channel not found');
    expect(prisma.playlist.findMany).not.toHaveBeenCalled();
  });

  it('GET /playlist/channel/:channel_id lists only public non-Mix playlists', async () => {
    prisma.channel.findUnique.mockResolvedValue({ user_id: 22 });
    const noHls = {
      ...shapedVideo,
      video_id: 50,
      hls_url: null,
      raw_video_url: 'https://cdn.test/raw/50.mp4',
    };
    prisma.playlist.findMany.mockResolvedValue([
      playlistRow({ playlist_id: 5, name: 'Gym Hits', is_public: true, withVideo: true, video: noHls }),
      playlistRow({ playlist_id: 2, name: 'Safe Hits', is_public: true, withVideo: true }),
    ]);

    const res = await request(app).get('/playlist/channel/4');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data.map((p) => p.name)).toEqual(['Gym Hits', 'Safe Hits']);
    expect(res.body.data[0].videos).toHaveLength(0);
    expect(res.body.data[1].videos).toHaveLength(1);
    expect(res.body.data[1].videos[0].raw_video_url).toBeUndefined();
    expect(res.body.data[1].videos[0].processed_video_url).toBe('https://cdn.test/31/master.m3u8');
    expect(prisma.channel.findUnique).toHaveBeenCalledWith({
      where: { channel_id: 4 },
      select: { user_id: true },
    });
    expect(prisma.playlist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user_id: 22,
          is_public: true,
        }),
      }),
    );
  });

  it('creates a public playlist when is_public is true', async () => {
    prisma.playlist.findFirst.mockResolvedValue(null);
    prisma.playlist.create.mockResolvedValue({ playlist_id: 11, name: 'Gym Hits', is_public: true });
    prisma.playlist.findUnique.mockResolvedValue(playlistRow({ playlist_id: 11, name: 'Gym Hits', is_public: true, withVideo: false }));

    const res = await request(app).post('/playlist').send({ name: 'Gym Hits', is_public: true });

    expect(res.status).toBe(201);
    expect(res.body.data.is_public).toBe(true);
    expect(prisma.playlist.create).toHaveBeenCalledWith({ data: { user_id: 7, name: 'Gym Hits', is_public: true } });
  });

  it('ignores is_public when creating a Mix playlist', async () => {
    prisma.playlist.findFirst.mockResolvedValue(null);
    prisma.playlist.count.mockResolvedValue(0);
    prisma.playlist.create.mockResolvedValue({ playlist_id: 9, name: 'Mix', is_public: false });
    prisma.playlist.findUnique.mockResolvedValue(playlistRow({ name: 'Mix', is_public: false, withVideo: false }));

    const res = await request(app).post('/playlist').send({ name: 'Mix', is_public: true });

    expect(res.status).toBe(201);
    expect(prisma.playlist.create).toHaveBeenCalledWith({ data: { user_id: 7, name: 'Mix', is_public: false } });
  });

  it('PATCH /playlist/:playlist_id toggles is_public for owned playlists', async () => {
    prisma.playlist.findFirst.mockResolvedValue({ playlist_id: 9, user_id: 7, name: 'Gym Hits', is_public: false });
    prisma.playlist.update.mockResolvedValue({});
    prisma.playlist.findUnique.mockResolvedValue(playlistRow({ playlist_id: 9, name: 'Gym Hits', is_public: true, withVideo: false }));

    const res = await request(app).patch('/playlist/9').send({ is_public: true });

    expect(res.status).toBe(200);
    expect(res.body.data.is_public).toBe(true);
    expect(prisma.playlist.update).toHaveBeenCalledWith({ where: { playlist_id: 9 }, data: { is_public: true } });
  });

  it('PATCH /playlist/:playlist_id rejects making a Mix playlist public', async () => {
    prisma.playlist.findFirst.mockResolvedValue({ playlist_id: 9, user_id: 7, name: 'Mix', is_public: false });

    const res = await request(app).patch('/playlist/9').send({ is_public: true });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Mix playlists cannot be public.');
    expect(prisma.playlist.update).not.toHaveBeenCalled();
  });
});
