import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { HumanMessage } from '@langchain/core/messages'
import { retrieveContext } from '../rag.js'
import { buildQueryPlanPrompt } from '../prompts.js'
import { getAllowedModels } from '../vertical-model-map.js'
import { readFileSync } from 'fs'
import { join } from 'path'

const schemaSummary = JSON.parse(readFileSync(join(process.cwd(), 'ai', 'concise-schema.json'), 'utf8'))

let model = null
function getModel() {
  if (!model) {
    model = new ChatGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
      model: process.env.MODEL_NAME || 'gemini-flash-lite-latest',
      temperature: 0,
      maxOutputTokens: 512,
    })
  }
  return model
}



export async function planQueryNode(state) {
  const { messages, verticalSlug, userId, profileId } = state

  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m._getType?.() === 'human' || m.role === 'user')
  const userContent = lastUserMessage?.content ?? ''

  const ragContext = retrieveContext(userContent, verticalSlug)

  const allowedModels = getAllowedModels(verticalSlug)
  
  // Prepare relevant schema info for the prompt
  const modelSchemas = {}
  allowedModels.forEach(model => {
    if (schemaSummary[model]) {
      modelSchemas[model] = schemaSummary[model]
    }
  })

  let queryPlan = null

  if (allowedModels.length > 0) {
    const prompt = buildQueryPlanPrompt(userContent, verticalSlug, allowedModels, userId, profileId, modelSchemas)
    const response = await getModel().invoke([new HumanMessage(prompt)])
    const raw = response.content.toString().trim()

    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      queryPlan = JSON.parse(cleaned)
    } catch {
      queryPlan = { model: null }
    }
  }

  return { queryPlan, ragContext }
}
