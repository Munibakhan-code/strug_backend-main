import prisma from '../../utils/prisma-client.js'
import {
  isModelAllowed,
  isOperationAllowed,
  sanitizeSelect,
} from '../vertical-model-map.js'

export async function executeQueryNode(state) {
  const { queryPlan, verticalSlug } = state

  // No query needed
  if (!queryPlan || !queryPlan.model) {
    return { dbResults: null }
  }

  const { model: modelName, operation, where, select, take, orderBy } = queryPlan

  // Security: validate model and operation
  if (!isModelAllowed(verticalSlug, modelName)) {
    console.warn(`[execute-query] Model "${modelName}" not allowed for vertical "${verticalSlug}"`)
    return { dbResults: null }
  }

  if (!isOperationAllowed(operation)) {
    console.warn(`[execute-query] Operation "${operation}" not allowed`)
    return { dbResults: null }
  }

  const prismaModel = prisma[modelName]
  if (!prismaModel) {
    console.warn(`[execute-query] Prisma model "${modelName}" not found`)
    return { dbResults: null }
  }

  try {
    const safeSelect = sanitizeSelect(select)
    const rawWhere = where && typeof where === 'object' ? where : {}
    
    // Replace placeholders in where clause
    const replacePlaceholders = (obj) => {
      if (!obj || typeof obj !== 'object') return obj
      const newObj = Array.isArray(obj) ? [] : {}
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === 'object') {
          newObj[key] = replacePlaceholders(val)
        } else if (val === 'CURRENT_USER_ID') {
          newObj[key] = state.userId
        } else if (val === 'CURRENT_PROFILE_ID') {
          newObj[key] = state.profileId
        } else {
          newObj[key] = val
        }
      }
      return newObj
    }
    
    const safeWhere = replacePlaceholders(rawWhere)
    const safeTake = Math.min(Number(take) || 5, 10)
    const safeOrderBy = orderBy && typeof orderBy === 'object' ? orderBy : undefined

    let dbResults

    if (operation === 'count') {
      const count = await prismaModel.count({ where: safeWhere })
      dbResults = [{ count }]
    } else {
      const args = { where: safeWhere, take: safeTake }
      if (safeSelect && Object.keys(safeSelect).length > 0) args.select = safeSelect
      if (safeOrderBy) args.orderBy = safeOrderBy

      dbResults = await prismaModel[operation](args)
    }

    return { dbResults }
  } catch (err) {
    console.error(`[execute-query] Prisma error for ${modelName}.${operation}:`, err.message)
    return { dbResults: null }
  }
}
