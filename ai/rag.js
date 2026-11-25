import { KNOWLEDGE_BASE_DOCS } from './knowledge-base.js'

// Build a lookup map on startup — no API calls needed
const docsBySlug = new Map()

for (const doc of KNOWLEDGE_BASE_DOCS) {
  const slugs = Array.isArray(doc.verticalSlug) ? doc.verticalSlug : [doc.verticalSlug];
  for (const slug of slugs) {
    if (!docsBySlug.has(slug)) {
      docsBySlug.set(slug, [])
    }
    docsBySlug.get(slug).push(doc.content)
  }
}

const generalDoc = KNOWLEDGE_BASE_DOCS.find((d) => {
  const slugs = Array.isArray(d.verticalSlug) ? d.verticalSlug : [d.verticalSlug];
  return slugs.includes('home');
})

console.log(`[RAG] Knowledge base loaded with ${KNOWLEDGE_BASE_DOCS.length} documents.`)

/**
 * Retrieve context for the current vertical.
 * Since we always know the exact vertical slug from the page,
 * a direct lookup is faster and more accurate than embedding similarity.
 *
 * @param {string} _query      - user message (unused, kept for API compatibility)
 * @param {string} verticalSlug
 * @returns {string}
 */
export function retrieveContext(_query, verticalSlug) {
  const verticalDocs = docsBySlug.get(verticalSlug) ?? []

  const parts = [...verticalDocs]

  // Always append the general platform overview as background context
  if (generalDoc && verticalSlug !== 'home') {
    parts.push(generalDoc.content)
  }

  return parts.join('\n\n---\n\n')
}
