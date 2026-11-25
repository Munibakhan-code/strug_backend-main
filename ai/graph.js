import { Annotation, StateGraph, END, START } from '@langchain/langgraph'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { planQueryNode } from './nodes/plan-query.js'
import { executeQueryNode } from './nodes/execute-query.js'
import { generateResponseNode } from './nodes/generate-response.js'
import { getAllowedModels } from './vertical-model-map.js'

// ─── State definition ────────────────────────────────────────────────────────

const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, incoming) => {
      if (Array.isArray(incoming)) return [...existing, ...incoming]
      return existing
    },
    default: () => [],
  }),
  verticalSlug: Annotation({
    reducer: (_, incoming) => incoming ?? _,
    default: () => 'home',
  }),
  ragContext: Annotation({
    reducer: (_, incoming) => (incoming !== undefined ? incoming : _),
    default: () => '',
  }),
  queryPlan: Annotation({
    reducer: (_, incoming) => (incoming !== undefined ? incoming : _),
    default: () => null,
  }),
  dbResults: Annotation({
    reducer: (_, incoming) => (incoming !== undefined ? incoming : _),
    default: () => null,
  }),
  response: Annotation({
    reducer: (_, incoming) => incoming ?? _,
    default: () => '',
  }),
  userId: Annotation({
    reducer: (_, incoming) => incoming ?? _,
    default: () => null,
  }),
  profileId: Annotation({
    reducer: (_, incoming) => incoming ?? _,
    default: () => null,
  }),
})

// ─── Routing: decided from verticalSlug alone, zero LLM calls ────────────────

function routeByVertical(state) {
  const allowedModels = getAllowedModels(state.verticalSlug)
  // If this vertical has DB models we can query, go through plan → execute → generate
  return allowedModels.length > 0 ? 'plan_query' : 'generate_response'
}

// ─── Build graph ─────────────────────────────────────────────────────────────

const workflow = new StateGraph(GraphState)

workflow.addNode('plan_query', planQueryNode)
workflow.addNode('execute_query', executeQueryNode)
workflow.addNode('generate_response', generateResponseNode)

workflow.addConditionalEdges(START, routeByVertical, {
  plan_query: 'plan_query',
  generate_response: 'generate_response',
})

workflow.addEdge('plan_query', 'execute_query')
workflow.addEdge('execute_query', 'generate_response')
workflow.addEdge('generate_response', END)

export const chatGraph = workflow.compile()

// ─── Public runner ────────────────────────────────────────────────────────────

/**
 * @param {string} userMessage
 * @param {string} verticalSlug  - slug from the current page (e.g. "rideshare")
 * @param {{ role: 'user'|'assistant', content: string }[]} history
 * @returns {Promise<string>}
 */
export async function runChatGraph(userMessage, verticalSlug, history = [], userId = null, profileId = null) {
  const messages = [
    ...history.map((m) =>
      m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    ),
    new HumanMessage(userMessage),
  ]

  const result = await chatGraph.invoke({
    messages,
    verticalSlug,
    ragContext: '',
    queryPlan: null,
    dbResults: null,
    response: '',
    userId,
    profileId,
  })

  return result.response
}
