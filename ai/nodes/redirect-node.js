import { buildRedirectMessage } from '../prompts.js'

export async function redirectNode(state) {
  const { verticalSlug } = state
  return { response: buildRedirectMessage(verticalSlug) }
}
