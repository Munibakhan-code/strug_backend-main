import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

/* GET ALL QUESTION ANSWERS BY USERS */
router.get('/', async (_req, res) => {
    try {
        const answers = await prisma.question_answer_user.findMany({
            orderBy: { question_answer_user_id: 'desc' },
            include: {
                question_option: true,
                question_option_answer: true,
                user: true
            },
        });
        res.json(answers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch user answers' });
    }
});

/* GET USER ANSWERS BY USER ID */
router.get('/user/:user_id', async (req, res) => {
    try {
        const user_id = Number(req.params.user_id);
        if (Number.isNaN(user_id)) return res.status(400).json({ error: 'user_id must be a number' });

        const answers = await prisma.question_answer_user.findMany({
            where: { user_id },
            include: {
                question_option: true,
                question_option_answer: true
            },
        });
        res.json(answers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch answers for user' });
    }
});

/* SUBMIT ANSWER */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { question_option_id, question_option_answer_id, user_id, is_correct } = req.body;

        const answer = await prisma.question_answer_user.create({
            data: {
                question_option_id,
                question_option_answer_id,
                user_id,
                is_correct,
            },
            include: {
                question_option: true,
                question_option_answer: true,
                user: true
            },
        });

        res.status(201).json(answer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to submit answer' });
    }
});

/* DELETE ANSWER RECORD */
router.delete('/:question_answer_user_id', authenticateToken, async (req, res) => {
    try {
        const question_answer_user_id = Number(req.params.question_answer_user_id);
        if (Number.isNaN(question_answer_user_id)) return res.status(400).json({ error: 'question_answer_user_id must be a number' });

        await prisma.question_answer_user.delete({ where: { question_answer_user_id } });
        res.json({ message: 'User answer record deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete user answer record' });
    }
});

export default router;
