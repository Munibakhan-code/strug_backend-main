import prisma from './prisma-client.js';
import { stockAfterOrder } from './shop-availability.js';

/**
 * Decrement listing stock after a product order is paid.
 * No-op when availability is null (untracked stock).
 */
export async function decrementListingStockForOrder(listingId, qty, db = prisma) {
  if (!listingId) return;
  const listing = await db.product_listing.findUnique({
    where: { listing_id: Number(listingId) },
    select: { listing_id: true, availability: true },
  });
  if (!listing || listing.availability == null) return;

  const next = stockAfterOrder(listing.availability, qty);
  await db.product_listing.update({
    where: { listing_id: listing.listing_id },
    data: { availability: next },
  });
}

/**
 * Load variation + listing + seller store profile for order guards.
 */
export async function loadVariationForShopOrder(variationId, db = prisma) {
  return db.product_variation.findUnique({
    where: { variation_id: Number(variationId) },
    include: {
      product_listing: {
        include: {
          seller: {
            select: {
              user_id: true,
              storeProfile: true,
            },
          },
        },
      },
    },
  });
}
