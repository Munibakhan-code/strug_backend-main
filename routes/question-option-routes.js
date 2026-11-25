import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL QUESTION OPTIONS */
router.get('/', /*authenticateToken,*/ async (_req, res) => {
  try {
    const questionOptions = await prisma.question_option.findMany({
      orderBy: { question_option_id: 'desc' },
      include: {
        lesson: true,
        question_answer_user: true,
        question_option_answer: true,
      },
    });

    res.json(questionOptions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch question options' });
  }
});

/* GET QUESTION OPTION BY ID */
router.get('/:question_option_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const question_option_id = Number(req.params.question_option_id);

    if (Number.isNaN(question_option_id)) {
      return res.status(400).json({ error: 'question_option_id must be a number' });
    }

    const questionOption = await prisma.question_option.findUnique({
      where: { question_option_id },
      include: {
        lesson: true,
        question_answer_user: true,
        question_option_answer: true,
      },
    });

    if (!questionOption) {
      return res.status(404).json({ error: 'Question option not found' });
    }

    res.json(questionOption);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch question option' });
  }
});

/* CREATE QUESTION OPTION */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { lesson_id, question } = req.body;

    const questionOption = await prisma.question_option.create({
      data: {
        lesson_id,
        question,
      },
      include: {
        lesson: true,
      },
    });

    res.status(201).json(questionOption);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create question option' });
  }
});

/* UPDATE QUESTION OPTION */
router.put('/:question_option_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const question_option_id = Number(req.params.question_option_id);

    if (Number.isNaN(question_option_id)) {
      return res.status(400).json({ error: 'question_option_id must be a number' });
    }

    const { lesson_id, question } = req.body;

    const existing = await prisma.question_option.findUnique({
      where: { question_option_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Question option not found' });
    }

    const updated = await prisma.question_option.update({
      where: { question_option_id },
      data: {
        lesson_id: lesson_id ?? existing.lesson_id,
        question: question ?? existing.question,
      },
      include: {
        lesson: true,
        question_answer_user: true,
        question_option_answer: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update question option' });
  }
});

/* DELETE QUESTION OPTION */
router.delete('/:question_option_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const question_option_id = Number(req.params.question_option_id);

    if (Number.isNaN(question_option_id)) {
      return res.status(400).json({ error: 'question_option_id must be a number' });
    }

    await prisma.question_option.delete({
      where: { question_option_id },
    });

    res.json({ message: 'Question option deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete question option' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
