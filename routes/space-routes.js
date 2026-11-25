// #334 Community Spaces — live group-audio room REST API. Audio is exchanged
// peer-to-peer over WebRTC (see sockets/space-socket.js); these endpoints manage the
// room lifecycle and participant roles only.

import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import {
  createSpace,
  listLiveSpaces,
  listPastSpaces,
  getSpace,
  joinSpace,
  leaveSpace,
  endSpace,
  setParticipantRole,
  setHandRaised,
  assertSpaceParticipant,
  sendSpaceError,
} from '../services/space-service.js';

const router = express.Router();

// Broadcast a fresh room snapshot to everyone currently in the space's socket room,
// so listeners see role/hand/participant changes without polling.
function broadcastSpace(req, space) {
  const io = req.app.get('io');
  io?.to(`space_${space.id}`).emit('space-updated', space);
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    res.json({ spaces: await listLiveSpaces({ communityId: req.query.community_id }) });
  } catch (err) {
    sendSpaceError(res, err, 'Failed to list spaces');
  }
});

// #6: previous (ended) spaces hosted by people the viewer follows. Declared before '/:id'
// so 'past' isn't captured as a space id.
router.get('/past', authenticateToken, async (req, res) => {
  try {
    res.json({ spaces: await listPastSpaces({ userId: req.user.user_id, communityId: req.query.community_id }) });
  } catch (err) {
    sendSpaceError(res, err, 'Failed to list past spaces');
  }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const space = await createSpace({
      hostId: req.user.user_id,
      communityId: req.body?.community_id,
      title: req.body?.title,
    });
    res.status(201).json(space);
  } catch (err) {
    sendSpaceError(res, err, 'Failed to create space');
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    // Full roster/details are for current participants only; join first to see who's in.
    await assertSpaceParticipant(req.params.id, req.user.user_id);
    res.json(await getSpace(req.params.id));
  } catch (err) {
    sendSpaceError(res, err, 'Failed to load space');
  }
});

router.post('/:id/join', authenticateToken, async (req, res) => {
  try {
    const space = await joinSpace({ spaceId: req.params.id, userId: req.user.user_id });
    broadcastSpace(req, space);
    res.json(space);
  } catch (err) {
    sendSpaceError(res, err, 'Failed to join space');
  }
});

router.post('/:id/leave', authenticateToken, async (req, res) => {
  try {
    const result = await leaveSpace({ spaceId: req.params.id, userId: req.user.user_id });
    const io = req.app.get('io');
    if (result.ended) io?.to(`space_${result.space_id}`).emit('space-ended', { space_id: result.space_id });
    else {
      // Refresh the snapshot for those who remain.
      try { broadcastSpace(req, await getSpace(result.space_id)); } catch { /* space may be gone */ }
    }
    res.json(result);
  } catch (err) {
    sendSpaceError(res, err, 'Failed to leave space');
  }
});

router.post('/:id/end', authenticateToken, async (req, res) => {
  try {
    const result = await endSpace({ spaceId: req.params.id, actorId: req.user.user_id });
    const io = req.app.get('io');
    io?.to(`space_${result.space_id}`).emit('space-ended', { space_id: result.space_id });
    res.json(result);
  } catch (err) {
    sendSpaceError(res, err, 'Failed to end space');
  }
});

router.patch('/:id/role', authenticateToken, async (req, res) => {
  try {
    const space = await setParticipantRole({
      spaceId: req.params.id,
      actorId: req.user.user_id,
      targetUserId: req.body?.user_id,
      role: req.body?.role,
    });
    broadcastSpace(req, space);
    res.json(space);
  } catch (err) {
    sendSpaceError(res, err, 'Failed to update role');
  }
});

router.patch('/:id/hand', authenticateToken, async (req, res) => {
  try {
    const space = await setHandRaised({
      spaceId: req.params.id,
      userId: req.user.user_id,
      raised: req.body?.raised,
    });
    broadcastSpace(req, space);
    res.json(space);
  } catch (err) {
    sendSpaceError(res, err, 'Failed to update hand');
  }
});

export default router;
