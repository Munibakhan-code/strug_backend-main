/** Product cart ownership checks (Phase 7). */

export function canAccessBuyerCart(requestUserId, buyerIdParam) {
  return Number(requestUserId) === Number(buyerIdParam);
}

export function canMutateCartItem(requestUserId, cartRow) {
  if (!cartRow) return false;
  return Number(cartRow.buyer_id) === Number(requestUserId);
}
