import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//============================================== LESSON ==============================================
//======================================================================================================

/* GET ALL LESSONS */
router.get('/', async (_req, res) => {
  try {
    const lessons = await prisma.lesson.findMany({
      orderBy: { lesson_id: 'desc' },
      include: {
        language: true,
        lesson_user: {
          include: {
            user: true,
          },
        },
        question_option: {
          include: {
            question_option_answer: true,
          },
        },
      },
    });
    res.json(lessons);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch lessons' });
  }
});

/* GET LESSON BY ID */
router.get('/:id', async (req, res) => {
  try {
    const lessonId = parseInt(req.params.id);
    
    if (!lessonId || isNaN(lessonId)) {
      return res.status(400).json({ error: 'Invalid lesson ID' });
    }
    
    const lesson = await prisma.lesson.findUnique({
      where: { lesson_id: lessonId },
      include: {
        language: true,
        lesson_user: {
          include: {
            user: true,
          },
        },
        question_option: {
          include: {
            question_option_answer: true,
          },
        },
      },
    });
    
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }
    
    res.json(lesson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch lesson' });
  }
});

/* CREATE LESSON */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { lesson_name, language_id, level } = req.body;
    
    const lesson = await prisma.lesson.create({
      data: {
        lesson_name,
        language_id: language_id ? parseInt(language_id) : null,
        level,
      },
    });
    
    res.status(201).json(lesson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create lesson' });
  }
});

/* UPDATE LESSON */
router.put('/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { lesson_name, language_id, level } = req.body;
    
    const lesson = await prisma.lesson.update({
      where: { lesson_id: parseInt(req.params.id) },
      data: {
        lesson_name,
        language_id: language_id ? parseInt(language_id) : undefined,
        level,
      },
    });
    
    res.json(lesson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update lesson' });
  }
});

/* DELETE LESSON */
router.delete('/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.lesson.delete({
      where: { lesson_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Lesson deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete lesson' });
  }
});

//======================================================================================================
//=========================================== LESSON USER ============================================
//======================================================================================================

/* GET ALL LESSON USERS */
router.get('/users', async (_req, res) => {
  try {
    const lessonUsers = await prisma.lesson_user.findMany({
      orderBy: { lesson_user_id: 'desc' },
      include: {
        lesson: {
          include: {
            language: true,
          },
        },
        user: true,
      },
    });
    res.json(lessonUsers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch lesson users' });
  }
});

/* GET LESSON USER BY ID */
router.get('/users/:id', async (req, res) => {
  try {
    const lessonUser = await prisma.lesson_user.findUnique({
      where: { lesson_user_id: parseInt(req.params.id) },
      include: {
        lesson: {
          include: {
            language: true,
          },
        },
        user: true,
      },
    });
    
    if (!lessonUser) {
      return res.status(404).json({ error: 'Lesson user not found' });
    }
    
    res.json(lessonUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch lesson user' });
  }
});

/* CREATE LESSON USER */
router.post('/users', /*authenticateToken,*/ async (req, res) => {
  try {
    const { lesson_id, user_id, is_complete } = req.body;
    
    const lessonUser = await prisma.lesson_user.create({
      data: {
        lesson_id: lesson_id ? parseInt(lesson_id) : null,
        user_id: parseInt(user_id),
        is_complete: is_complete || false,
      },
    });
    
    res.status(201).json(lessonUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create lesson user' });
  }
});

/* UPDATE LESSON USER */
router.put('/users/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    const { lesson_id, is_complete } = req.body;
    
    const lessonUser = await prisma.lesson_user.update({
      where: { lesson_user_id: parseInt(req.params.id) },
      data: {
        lesson_id: lesson_id ? parseInt(lesson_id) : undefined,
        is_complete,
      },
    });
    
    res.json(lessonUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update lesson user' });
  }
});

/* DELETE LESSON USER */
router.delete('/users/:id', /*authenticateToken,*/ async (req, res) => {
  try {
    await prisma.lesson_user.delete({
      where: { lesson_user_id: parseInt(req.params.id) },
    });
    
    res.json({ message: 'Lesson user deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete lesson user' });
  }
});

export default router;