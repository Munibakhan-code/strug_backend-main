import prisma from '../utils/prisma-client.js';

// Verifies the authenticated user owns a food vendor record.
// Dashboard access is granted as long as the vendor is not rejected — pending_review
// vendors can set up inventory immediately after registration.
// Only the public customer-facing listings are gated on is_active (see food-routes.js).
export const isFoodVendor = async (req, res, next) => {
    try {
        const vendor_id = req.body.vendor_id ? parseInt(req.body.vendor_id) :
                          req.query.vendor_id ? parseInt(req.query.vendor_id) :
                          req.params.vendor_id ? parseInt(req.params.vendor_id) : null;
        
        const vendor_type_id = req.body.vendor_type_id ? parseInt(req.body.vendor_type_id) :
                               req.query.vendor_type_id ? parseInt(req.query.vendor_type_id) : null;

        let where = { owner_id: req.user.user_id };
        if (vendor_id && !isNaN(vendor_id)) {
            where.vendor_id = vendor_id;
        } else if (vendor_type_id && !isNaN(vendor_type_id)) {
            where.vendor_type_id = vendor_type_id;
        }

        const vendor = await prisma.food_vendor.findFirst({
            where,
        });
        if (!vendor) {
            return res.status(403).json({ successful: false, error: 'Food vendor access required. Register as a vendor first.' });
        }
        req.foodVendor = vendor;
        next();
    } catch (err) {
        res.status(500).json({ successful: false, error: 'Vendor check failed' });
    }
};
