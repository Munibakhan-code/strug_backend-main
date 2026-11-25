import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { HumanMessage } from '@langchain/core/messages'
import { retrieveContext } from '../rag.js'
import { buildGeneratePrompt } from '../prompts.js'

let model = null
function getModel() {
  if (!model) {
    model = new ChatGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
      model: process.env.MODEL_NAME || 'gemini-flash-lite-latest',
      temperature: 0.4,
      maxOutputTokens: 1024,
    })
  }
  return model
}

export async function generateResponseNode(state) {
  const { messages, verticalSlug, ragContext, dbResults } = state

  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m._getType?.() === 'human' || m.role === 'user')
  const userContent = lastUserMessage?.content ?? ''

  const context = ragContext || retrieveContext(userContent, verticalSlug)

  const history = messages
    .slice(0, -1)
    .map((m) => ({
      role: m._getType?.() === 'human' || m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))

  const prompt = buildGeneratePrompt(userContent, verticalSlug, context, dbResults, history)

  const response = await getModel().invoke([new HumanMessage(prompt)])
  return { response: response.content.toString().trim() }
}
