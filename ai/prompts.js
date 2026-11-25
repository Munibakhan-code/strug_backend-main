import { getAllowedModels } from './vertical-model-map.js'

export function buildClassifyPrompt(userMessage, verticalSlug) {
  return `You are a routing assistant for the Strug platform.

The user is on the "${verticalSlug}" section and sent this message:
"${userMessage}"

Classify this message into exactly one of these three categories:
- "vertical_question": The user is asking something related to the ${verticalSlug} vertical (services, features, data, availability, pricing, orders, status, how things work).
- "general_help": The user needs general help with the Strug platform (navigation, account, payments, general info).
- "off_topic": The message is completely unrelated to Strug or this vertical.

Reply with ONLY one of these three exact strings: vertical_question, general_help, off_topic`
}

export function buildQueryPlanPrompt(userMessage, verticalSlug, allowedModels, userId, profileId, modelSchemas) {
  const userContext = `
Current User Context:
- User ID: ${userId || 'UNKNOWN'}
- Social Profile ID: ${profileId || 'UNKNOWN'}
`.trim();

  const schemaContext = Object.entries(modelSchemas)
    .map(([model, fields]) => `Model ${model}:\n  ${fields.join('\n  ')}`)
    .join('\n\n');

  const schemaHints = verticalSlug === 'rideshare' ? `
Schema Hints for Rideshare:
- active_trip does NOT have passenger_id. To find trips for a passenger, you must query through the relation: { ride_request: { passenger_id: "CURRENT_USER_ID" } }.
- ride_request has passenger_id.
`.trim() : '';

  return `You are a database query planner for the Strug platform.

${userContext}

The user is on the "${verticalSlug}" section and asked:
"${userMessage}"

You have access to these Prisma models and their fields:
${schemaContext}

${schemaHints}

Generate a Prisma query plan as a single JSON object to retrieve data that would help answer the user's question.

Rules:
- Use ONLY models and fields from the context above.
- Only use operations: findMany, findFirst, count.
- Limit results with "take" to a maximum of 10.
- Never include sensitive fields like password, email, otp_code, license_number.
- Use placeholders "CURRENT_USER_ID" or "CURRENT_PROFILE_ID" for where clauses if the query should be filtered by the authenticated user's data.
- If no DB query is needed to answer the question, return: {"model": null}

Return ONLY valid JSON with this structure:
{
  "model": "model_name_or_null",
  "operation": "findMany|findFirst|count",
  "where": {},
  "select": {},
  "take": 5,
  "orderBy": {}
}`
}

export function buildGeneratePrompt(userMessage, verticalSlug, ragContext, dbResults, conversationHistory) {
  const historyText = conversationHistory.length > 0
    ? conversationHistory
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n')
    : 'No previous conversation.'

  const dbText = dbResults && dbResults.length > 0
    ? `\nLive database results:\n${JSON.stringify(dbResults, null, 2)}`
    : ''

  return `You are the Strug AI assistant embedded in the "${verticalSlug}" section of the Strug super-app platform.

## Platform Knowledge
${ragContext}
${dbText}

## Conversation History
${historyText}

## Current User Message
${userMessage}

## Instructions
- Answer the user's question using the platform knowledge and database results above.
- Be concise, friendly, and helpful.
- If you have live DB data, use it to give specific, grounded answers.
- Do not make up features or data not shown above.
- If you cannot answer confidently, say so honestly and suggest the user contact support.
- Keep responses under 200 words unless detail is truly necessary.`
}

export function buildRedirectMessage(verticalSlug) {
  return `I'm the Strug AI assistant for the ${verticalSlug} section. I can best help you with questions related to this service. For anything else, you can explore other sections of the Strug platform or contact our support team.`
}
