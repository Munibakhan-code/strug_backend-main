import express from 'express';

// Legacy /decor routes were retired. Décor buyer/seller flows use:
// - booking engine: /booking/* with vertical=decor (services, rentals, seasonal)
// - product catalog: /product-listing with product_type_name=Decor (shop)
const router = express.Router();

router.use((_req, res) => {
  res.status(410).json({
    successful: false,
    message: 'The /decor API has been retired. Use /booking (vertical=decor) or /product-listing (type=Decor).',
  });
});

export default router;
