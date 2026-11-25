// #334 Community Spaces — WebRTC signaling relay.
//
// The server never touches audio. It only:
//   1. tracks which sockets are in which space room (AFTER authorizing them),
//   2. tells a joining peer who's already there (so it can open peer connections),
//   3. relays SDP offers/answers and ICE candidates between peers IN THE SAME room,
//   4. broadcasts mic/mute state and peer join/leave events.
// Actual audio flows peer-to-peer (mesh) between browsers.
//
// SECURITY: a socket may only join a space room if it has an active participant row
// (created via the authorized REST `POST /spaces/:id/join`, which enforces community
// membership). Signaling is relayed only between sockets that share the space room,
// and payloads are shape- and size-validated — so a socket can neither eavesdrop on a
// space it hasn't joined nor use the relay as an arbitrary socket-to-socket channel.

import { assertSpaceParticipant } from '../services/space-service.js';

export const spaceRoomName = (spaceId) => `space_${spaceId}`;

// SDP/ICE payloads are a few KB; cap well above that but bounded to stop abuse.
const MAX_SIGNAL_BYTES = 24 * 1024;

function respond(socket, ack, event, payload) {
  if (typeof ack === 'function') ack(payload);
  else socket.emit(event, payload);
}

// Is a given socket currently a member of this space's room?
function socketInRoom(io, socketId, room) {
  return Boolean(io.sockets.sockets.get(socketId)?.rooms?.has(room));
}

export function registerSpaceSocketHandlers(io, socket) {
  const uid = socket.user?.user_id;
  if (!socket.data.spaceRooms) socket.data.spaceRooms = new Set();

  socket.on('join_space', async (data, ack) => {
    try {
      if (!uid) throw new Error('unauthenticated');
      const spaceId = Number(data?.space_id);
      if (!Number.isInteger(spaceId) || spaceId <= 0) throw new Error('space_id must be a positive integer');

      // Authorize: must already be an active participant (joined via the REST endpoint,
      // which enforces community membership + that the space is live).
      await assertSpaceParticipant(spaceId, uid);

      const room = spaceRoomName(spaceId);
      const existing = await io.in(room).allSockets();
      const peers = [];
      for (const sid of existing) {
        if (sid === socket.id) continue;
        const s = io.sockets.sockets.get(sid);
        peers.push({ socket_id: sid, user_id: s?.user?.user_id ?? null });
      }

      socket.join(room);
      socket.data.spaceRooms.add(room);
      socket.to(room).emit('space-peer-joined', { socket_id: socket.id, user_id: uid });

      respond(socket, ack, 'space-joined', { ok: true, space_id: spaceId, self_socket_id: socket.id, peers });
    } catch (error) {
      respond(socket, ack, 'space-error', { ok: false, message: error.message || 'Failed to join space' });
    }
  });

  socket.on('leave_space', (data) => {
    const spaceId = Number(data?.space_id);
    if (!Number.isInteger(spaceId) || spaceId <= 0) return;
    const room = spaceRoomName(spaceId);
    if (!socket.rooms.has(room)) return;
    socket.to(room).emit('space-peer-left', { socket_id: socket.id, user_id: uid });
    socket.leave(room);
    socket.data.spaceRooms.delete(room);
  });

  // Relay an SDP offer/answer or ICE candidate to ONE specific peer socket — but only
  // between two sockets that are both in the same space room, and only for a
  // well-formed, size-bounded signaling payload.
  socket.on('space_signal', (data) => {
    const spaceId = Number(data?.space_id);
    const target = data?.to;
    const payload = data?.data;
    if (!Number.isInteger(spaceId) || spaceId <= 0) return;
    if (!target || typeof target !== 'string') return;

    const room = spaceRoomName(spaceId);
    // Sender must be in the room, and so must the target — no cross-room or arbitrary relay.
    if (!socket.rooms.has(room)) return;
    if (!socketInRoom(io, target, room)) return;

    // Only genuine signaling shapes; bound the size.
    if (!payload || typeof payload !== 'object') return;
    if (!('description' in payload) && !('candidate' in payload)) return;
    let size = 0;
    try { size = JSON.stringify(payload).length; } catch { return; }
    if (size > MAX_SIGNAL_BYTES) return;

    io.to(target).emit('space-signal', {
      from: socket.id,
      from_user_id: uid,
      space_id: spaceId,
      data: payload,
    });
  });

  // Broadcast mic/mute state to the room (sender must be in it).
  socket.on('space_mic', (data) => {
    const spaceId = Number(data?.space_id);
    if (!Number.isInteger(spaceId) || spaceId <= 0) return;
    const room = spaceRoomName(spaceId);
    if (!socket.rooms.has(room)) return;
    socket.to(room).emit('space-mic', {
      socket_id: socket.id,
      user_id: uid,
      muted: Boolean(data?.muted),
    });
  });

  socket.on('disconnect', () => {
    for (const room of socket.data.spaceRooms || []) {
      socket.to(room).emit('space-peer-left', { socket_id: socket.id, user_id: uid });
    }
  });
}
