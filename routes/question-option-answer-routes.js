import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

/* GET ALL OPTION ANSWERS */
router.get('/', async (_req, res) => {
    try {
        const answers = await prisma.question_option_answer.findMany({
            orderBy: { question_option_answer_id: 'asc' },
            include: {
                question_option: true
            },
        });
        res.json(answers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch question option answers' });
    }
});

/* GET OPTION ANSWERS BY QUESTION ID */
router.get('/question/:question_option_id', async (req, res) => {
    try {
        const question_option_id = Number(req.params.question_option_id);
        if (Number.isNaN(question_option_id)) return res.status(400).json({ error: 'question_option_id must be a number' });

        const answers = await prisma.question_option_answer.findMany({
            where: { question_option_id },
        });
        res.json(answers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch answers for question option' });
    }
});

/* CREATE OPTION ANSWER */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { question_option_id, answer, is_correct } = req.body;

        const newAnswer = await prisma.question_option_answer.create({
            data: {
                question_option_id,
                answer,
                is_correct,
            },
            include: {
                question_option: true
            }
        });

        res.status(201).json(newAnswer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create question option answer' });
    }
});

/* UPDATE OPTION ANSWER */
router.put('/:question_option_answer_id', authenticateToken, async (req, res) => {
    try {
        const question_option_answer_id = Number(req.params.question_option_answer_id);
        if (Number.isNaN(question_option_answer_id)) return res.status(400).json({ error: 'question_option_answer_id must be a number' });

        const { question_option_id, answer, is_correct } = req.body;

        const existing = await prisma.question_option_answer.findUnique({ where: { question_option_answer_id } });
        if (!existing) return res.status(404).json({ error: 'Answer option not found' });

        const updated = await prisma.question_option_answer.update({
            where: { question_option_answer_id },
            data: {
                question_option_id: question_option_id ?? existing.question_option_id,
                answer: answer ?? existing.answer,
                is_correct: is_correct ?? existing.is_correct,
            },
            include: {
                question_option: true
            }
        });

        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update question option answer' });
    }
});

/* DELETE OPTION ANSWER */
router.delete('/:question_option_answer_id', authenticateToken, async (req, res) => {
    try {
        const question_option_answer_id = Number(req.params.question_option_answer_id);
        if (Number.isNaN(question_option_answer_id)) return res.status(400).json({ error: 'question_option_answer_id must be a number' });

        await prisma.question_option_answer.delete({ where: { question_option_answer_id } });
        res.json({ message: 'Answer option deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete question option answer' });
    }
});

export default router;
