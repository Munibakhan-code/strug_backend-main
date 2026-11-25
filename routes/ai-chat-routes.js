import express from 'express'
import { z } from 'zod'
import { runChatGraph } from '../ai/graph.js'
import prisma from '../utils/prisma-client.js'
import { rateLimit } from '../middleware/rate-limit.js'

const router = express.Router()

// LLM calls are expensive and this endpoint allows anonymous use — bound abuse per IP/user.
const aiChatLimiter = rateLimit({ windowSec: 60, max: 20, keyPrefix: 'ai-chat' })

const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  verticalSlug: z.string().min(1).max(100),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      })
    )
    .max(20)
    .optional()
    .default([]),
})

router.post('/', aiChatLimiter, async (req, res) => {
  // Optional authentication: try to verify token but don't fail if missing
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  
  let userId = null
  let profileId = null

  if (token) {
    try {
      const jwt = (await import('jsonwebtoken')).default
      const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_KEY)
      userId = decoded.user_id
      
      const userProfile = await prisma.social_profile.findFirst({
        where: { user_id: userId },
        select: { profile_id: true }
      })
      profileId = userProfile?.profile_id
    } catch (err) {
      // Ignore token errors for AI chat — anonymous callers stay userId=null
    }
  }

  try {
    const parsed = chatRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: (parsed.error.issues ?? parsed.error.errors),
      })
    }

    const { message, verticalSlug, history } = parsed.data
    const response = await runChatGraph(message, verticalSlug, history, userId, profileId)

    return res.json({ response })
  } catch (err) {
    console.error('[ai-chat] Error:', err?.message ?? err)

    // Google API rate limit
    if (err?.status === 429 || err?.message?.includes('429')) {
      return res.status(429).json({
        error: 'The AI service is temporarily busy. Please wait a moment and try again.',
      })
    }

    return res.status(500).json({
      error: 'AI service error. Please try again.',
    })
  }
})

export default router
