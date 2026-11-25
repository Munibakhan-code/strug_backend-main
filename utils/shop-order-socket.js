/**
 * Product-order socket payloads aligned with FoodTrackingPage (`order-status-update-*`).
 */
import { notify } from '../services/notify.js';

/** Map product_order.status → Food tracking `order_status` key. */
export function foodCompatibleOrderStatus(status) {
  const map = {
    pending: 'confirmed',
    confirmed: 'confirmed',
    driver_assigned: 'preparing',
    shipped: 'preparing',
    picked_up: 'picked_up',
    fulfilled: 'delivered',
    delivered: 'delivered',
  };
  return map[status] ?? status;
}

// Buyer-facing copy per status. Epic 10: this helper was live-emit only, so a buyer who closed the
// tab never learned their order shipped. Every seller/driver route already funnels through here, so
// hooking notify() in one place covers confirmed / shipped / fulfilled / driver_assigned / picked_up
// without touching six handlers.
//
// `pending` is deliberately absent — that's the order's initial state, not a transition worth a ping.
const BUYER_COPY = {
  confirmed:      { title: 'Your order was confirmed',  body: 'The seller is preparing it.' },
  driver_assigned:{ title: 'A driver is on the way',    body: 'Your order will be collected shortly.' },
  shipped:        { title: 'Your order has shipped',    body: null },
  picked_up:      { title: 'Your order is on the way',  body: null },
  fulfilled:      { title: 'Your order was delivered',  body: null },
  delivered:      { title: 'Your order was delivered',  body: null },
  cancelled:      { title: 'Your order was cancelled',  body: null },
};

/** Emit buyer-facing status updates for a product order, and persist a durable notification. */
export function emitProductOrderStatusUpdate(io, order, { status, driver_id = null } = {}) {
  if (!order?.order_id || !status) return;
  const orderId = order.order_id;
  const buyerId = order.buyer_id;
  const payload = {
    order_status: foodCompatibleOrderStatus(status),
    status,
    driver_id,
  };
  if (io && buyerId) {
    io.to(`user-${buyerId}`).emit(`order-status-update-${orderId}`, payload);
    // Legacy product-order channel (FoodTrackingPage Phase 4 listens to both).
    io.to(`user-${buyerId}`).emit(`order-status-${orderId}`, { status, driver_id });
  }

  const copy = BUYER_COPY[status];
  if (buyerId && copy) {
    notify(io, {
      userId: buyerId,
      vertical: 'ecommerce',
      type: `order.${status}`,
      title: copy.title,
      body: copy.body,
      urgency: 'ambient',
      entityType: 'product_order',
      entityId: orderId,
      actionUrl: 'orders',
    });
  }
}
