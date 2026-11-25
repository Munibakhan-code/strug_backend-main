// community-post-comments-route.js
import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

// DELETE /api/community-post-comments/:id
router.delete('/:id', authenticateToken, async (req, res) => {
    const commentId = parseInt(req.params.id);
    if (isNaN(commentId)) return res.status(400).json({ message: "Invalid comment id." });

    try {
        const comment = await prisma.community_post_comment.findUnique({
            where: { comment_id: commentId }, 
        });

        if (!comment) return res.status(404).json({ message: "Comment not found." });
        if (comment.user_id !== req.user.user_id)
            return res.status(403).json({ message: "Unauthorized." });

        await prisma.community_post_comment.delete({ where: { comment_id: commentId } });
        res.json({ success: true });
    } catch (err) {
        console.error("Delete Comment Error:", err);
        res.status(500).json({ message: "Failed to delete comment." });
    }
});

export default router;