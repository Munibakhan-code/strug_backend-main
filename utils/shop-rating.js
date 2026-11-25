/**
 * Shop buyer rating helpers (Phase 6).
 */

export function validateProductRatingBody(body = {}) {
  const errors = [];
  const seller_id = Number(body.seller_id);
  const buyer_id = Number(body.buyer_id);
  const rating = Number(body.rating);
  const order_id = body.order_id != null ? Number(body.order_id) : null;
  const product_type_id = body.product_type_id != null ? Number(body.product_type_id) : 1;

  if (!Number.isFinite(seller_id)) errors.push('seller_id must be a number');
  if (!Number.isFinite(buyer_id)) errors.push('buyer_id must be a number');
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    errors.push('rating must be a number between 1 and 5');
  }
  if (body.order_id != null && !Number.isFinite(order_id)) {
    errors.push('order_id must be a number');
  }
  if (body.feedback != null && typeof body.feedback !== 'string') {
    errors.push('feedback must be a string');
  }
  if (body.feedback != null && String(body.feedback).length > 2000) {
    errors.push('feedback must be at most 2000 characters');
  }

  return {
    ok: errors.length === 0,
    errors,
    data: {
      seller_id,
      buyer_id,
      rating,
      order_id,
      feedback: body.feedback == null || body.feedback === '' ? null : String(body.feedback),
      product_type_id: Number.isFinite(product_type_id) ? product_type_id : 1,
    },
  };
}
