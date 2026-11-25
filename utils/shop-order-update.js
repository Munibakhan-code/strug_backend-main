/**
 * PUT /product-order/:id must never change what the buyer owes.
 *
 * `total` is priced server-side at creation, from the authoritative variation:
 *
 *     total = effectivePrice(variation.price, variation.discount_pct) * qty + delivery_fee + tax
 *
 * and it is deliberately NOT recomputed on update. Dropping `total` from the update payload stops
 * the client naming its own price — but `qty` and `variation_id` DETERMINE that price, so leaving
 * them writable left the identical underpayment one step to the left: order a single unit of a
 * cheap variation, let it settle (wallet orders are `ispaid: true` the moment they are
 * created), then PUT `{ qty: 100 }`. The row now carries 100 units at the one-unit price, and the
 * buyer is never charged the difference. Swapping `variation_id` to a dearer variant does the same.
 *
 * So price-determining fields are rejected outright rather than re-priced. Re-pricing here would
 * mean re-deriving delivery_fee and tax and settling the delta against a payment that has already
 * been captured — a real re-charge flow this endpoint does not have. Changing what was bought is a
 * cancel-and-reorder.
 */
export const PRICE_DETERMINING_FIELDS = Object.freeze(['variation_id', 'qty', 'product_type_id']);

/**
 * Which price-determining fields is this body actually trying to CHANGE?
 *
 * Echoing the CURRENT value back is not a change and must stay allowed — clients routinely PUT the
 * whole order object back, so rejecting on mere presence would break every honest update.
 */
export function repricingFields(existing, body = {}) {
    return PRICE_DETERMINING_FIELDS.filter((field) => {
        const next = body[field];
        if (next === undefined || next === null) return false;   // absent = not being changed
        return Number(next) !== Number(existing[field]);
    });
}

/**
 * The fields a PUT may actually write. Nothing here can move money: `total` is absent (server-owned)
 * and every price-determining field is refused upstream by repricingFields().
 */
export function buildProductOrderUpdateData(existing, body = {}) {
    const { payment_method, checkout_id } = body;
    return {
        payment_method: payment_method ?? existing.payment_method,
        checkout_id: checkout_id ?? existing.checkout_id,
    };
}
