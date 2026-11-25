import prisma from './prisma-client.js';
import { decrypt } from './crypto.js';
import i18next from './i18n.js';
import mailerEvents from './mailer-event.js';
import { emailLngFromUser } from './email-lang.js';

const ORDER_EMAIL_INCLUDE = {
  user_product_order_buyer_idTouser: {
    select: { name: true, email: true, language: true },
  },
  user_product_order_seller_idTouser: {
    select: { name: true, email: true, language: true },
  },
  product_variation: { include: { product_listing: true } },
};

function userEmail(user) {
  if (!user?.email) return null;
  try {
    return decrypt(user.email);
  } catch {
    return user.email;
  }
}

function productName(order) {
  const listing = order.product_variation?.product_listing;
  const variation = order.product_variation;
  return (
    listing?.name ||
    variation?.vname ||
    variation?.description ||
    'Product'
  );
}

function orderPayload(order) {
  return {
    order_id: order.order_id,
    product_name: productName(order),
    qty: order.qty ?? 1,
    total: order.total ?? 0,
    currency: '$',
    buyer_name: order.user_product_order_buyer_idTouser?.name || 'Customer',
    seller_name: order.user_product_order_seller_idTouser?.name || 'Seller',
  };
}

function trackUrl(orderId) {
  const base = process.env.FRONTEND_URL || 'https://strug.ca';
  return `${base.replace(/\/$/, '')}/shop?order=${orderId}`;
}

export function isDigitalOrder(order) {
  const typeName = order?.product_type?.product_type_name || '';
  return /digital/i.test(typeName);
}

function digitalDownloadUrl(order) {
  const base = (process.env.FRONTEND_URL || 'https://strug.ca').replace(/\/$/, '');
  const asset = order?.product_variation?.image_url;
  if (asset && /^https?:\/\//i.test(asset)) return asset;
  return `${base}/shop?order=${order.order_id}`;
}

/** Buyer download link for digital product orders. */
export function queueDigitalDeliveryEmail(order) {
  if (!isDigitalOrder(order)) return;
  const buyer = order.user_product_order_buyer_idTouser;
  const buyerEmail = userEmail(buyer);
  if (!buyerEmail) return;

  mailerEvents.emit('send_email', {
    templateName: 'digital-delivery',
    variables: { download_url: digitalDownloadUrl(order) },
    to: buyerEmail,
    subjectKey: 'emails.digital.subject',
    user: buyer,
  });
}

export async function loadOrderForEmail(orderId) {
  return prisma.product_order.findUnique({
    where: { order_id: Number(orderId) },
    include: ORDER_EMAIL_INCLUDE,
  });
}

/** Buyer + seller receipt after order is created. */
export function queueShopOrderPlacedEmails(order) {
  const base = orderPayload(order);
  const buyer = order.user_product_order_buyer_idTouser;
  const seller = order.user_product_order_seller_idTouser;
  const buyerEmail = userEmail(buyer);
  const sellerEmail = userEmail(seller);

  if (buyerEmail) {
    mailerEvents.emit('send_email', {
      templateName: 'shop-order-receipt',
      variables: { ...base, isVendor: false },
      to: buyerEmail,
      subjectKey: 'emails.shop.subjects.order_confirm_buyer',
      user: buyer,
    });
  }
  if (sellerEmail) {
    mailerEvents.emit('send_email', {
      templateName: 'shop-order-receipt',
      variables: { ...base, isVendor: true },
      to: sellerEmail,
      subjectKey: 'emails.shop.subjects.new_order_seller',
      user: seller,
    });
  }
}

const STATUS_MAIL = {
  confirmed: { sub: 'confirmed', msg: 'confirmed' },
  shipped: { sub: 'shipped', msg: 'shipped' },
  fulfilled: { sub: 'fulfilled', msg: 'fulfilled' },
};

/** Status update email to buyer (confirm / ship / deliver). */
export function queueShopOrderStatusEmail(order, status, extra = {}) {
  const info = STATUS_MAIL[status];
  if (!info) return;

  const buyer = order.user_product_order_buyer_idTouser;
  const buyerEmail = userEmail(buyer);
  if (!buyerEmail) return;

  const lng = emailLngFromUser(buyer);
  const t = i18next.getFixedT(lng);

  mailerEvents.emit('send_email', {
    templateName: 'shop-order-status',
    variables: {
      order_id: order.order_id,
      status_title: t(`emails.shop.status.subjects.${info.sub}`),
      status_message: t(`emails.shop.status.messages.${info.msg}`, {
        tracking_number: extra.tracking_number || '',
      }),
      tracking_number: extra.tracking_number || null,
      track_url: trackUrl(order.order_id),
    },
    to: buyerEmail,
    subjectKey: `emails.shop.status.subjects.${info.sub}`,
    user: buyer,
  });
}
