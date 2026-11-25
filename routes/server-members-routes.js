import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL SERVER MEMBERS */
router.get('/', /*authenticateToken,*/ async (_req, res) => {
  try {
    const serverMembers = await prisma.server_members.findMany({
      orderBy: { server_member_id: 'desc' },
      include: {
        discord_server: true,
        user: true,
        discord_stream: true,
      },
    });

    res.json(serverMembers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch server members' });
  }
});

/* GET SERVER MEMBER BY ID */
router.get('/:server_member_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const server_member_id = Number(req.params.server_member_id);

    if (Number.isNaN(server_member_id)) {
      return res.status(400).json({ error: 'server_member_id must be a number' });
    }

    const serverMember = await prisma.server_members.findUnique({
      where: { server_member_id },
      include: {
        discord_server: true,
        user: true,
        discord_stream: true,
      },
    });

    if (!serverMember) {
      return res.status(404).json({ error: 'Server member not found' });
    }

    res.json(serverMember);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch server member' });
  }
});

/* GET MEMBERS BY SERVER ID */
router.get('/server/:server_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const server_id = Number(req.params.server_id);

    if (Number.isNaN(server_id)) {
      return res.status(400).json({ error: 'server_id must be a number' });
    }

    const members = await prisma.server_members.findMany({
      where: { server_id },
      include: {
        user: true,
      },
    });

    res.json(members);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch members for server' });
  }
});

/* CREATE SERVER MEMBER */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { user_id, server_id } = req.body;

    const serverMember = await prisma.server_members.create({
      data: {
        user_id,
        server_id,
      },
      include: {
        discord_server: true,
        user: true,
      },
    });

    res.status(201).json(serverMember);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create server member' });
  }
});

/* UPDATE SERVER MEMBER */
router.put('/:server_member_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const server_member_id = Number(req.params.server_member_id);

    if (Number.isNaN(server_member_id)) {
      return res.status(400).json({ error: 'server_member_id must be a number' });
    }

    const { user_id, server_id } = req.body;

    const existing = await prisma.server_members.findUnique({
      where: { server_member_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Server member not found' });
    }

    const updated = await prisma.server_members.update({
      where: { server_member_id },
      data: {
        user_id: user_id ?? existing.user_id,
        server_id: server_id ?? existing.server_id,
      },
      include: {
        discord_server: true,
        user: true,
        discord_stream: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update server member' });
  }
});

/* DELETE SERVER MEMBER */
router.delete('/:server_member_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const server_member_id = Number(req.params.server_member_id);

    if (Number.isNaN(server_member_id)) {
      return res.status(400).json({ error: 'server_member_id must be a number' });
    }

    await prisma.server_members.delete({
      where: { server_member_id },
    });

    res.json({ message: 'Server member deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete server member' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
