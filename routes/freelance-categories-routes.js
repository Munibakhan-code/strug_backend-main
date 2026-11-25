import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all categories
 * GET /freelance-categories
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const categories = await prisma.freelance_Category.findMany({
      orderBy: {
        name: 'asc',
      },
    });

    return res.json({
      successful: true,
      data: categories,
    });
  } catch (error) {
    console.error('Get Categories Error:', error);
    return res.status(500).json({
      successful: false,
      message: 'Failed to fetch categories.',
    });
  }
});

/**
 * Get a single category with its subcategories
 * GET /freelance-categories/:id
 */
// router.get('/:id', authenticateToken, async (req, res) => {
//   try {
//     const categoryId = parseInt(req.params.id);

//     if (isNaN(categoryId)) {
//       return res.status(400).json({
//         successful: false,
//         message: 'Invalid category ID.',
//       });
//     }

//     const category = await prisma.freelance_Category.findUnique({
//       where: {
//         id: categoryId,
//       },
//       include: {
//         sub_categories: {
//           orderBy: {
//             name: 'asc',
//           },
//         },
//       },
//     });

//     if (!category) {
//       return res.status(404).json({
//         successful: false,
//         message: 'Category not found.',
//       });
//     }

//     return res.json({
//       successful: true,
//       data: category,
//     });
//   } catch (error) {
//     console.error('Get Category Error:', error);
//     return res.status(500).json({
//       successful: false,
//       message: 'Failed to fetch category.',
//     });
//   }
// });

/**
 * Get all subcategories
 * GET /freelance-categories/subcategories
 */
// router.get('/subcategories/all', authenticateToken, async (req, res) => {
//   try {
//     const subcategories = await prisma.freelance_SubCategory.findMany({
//       include: {
//         category: {
//           select: {
//             id: true,
//             name: true,
//           },
//         },
//       },
//       orderBy: {
//         name: 'asc',
//       },
//     });

//     return res.json({
//       successful: true,
//       data: subcategories,
//     });
//   } catch (error) {
//     console.error('Get Subcategories Error:', error);
//     return res.status(500).json({
//       successful: false,
//       message: 'Failed to fetch subcategories.',
//     });
//   }
// });

/**
 * Get subcategories by category ID
 * GET /freelance-categories/:categoryId/subcategories
 */
router.get('/:categoryId/subcategories', authenticateToken, async (req, res) => {
  try {
    const categoryId = parseInt(req.params.categoryId);

    if (isNaN(categoryId)) {
      return res.status(400).json({
        successful: false,
        message: 'Invalid category ID.',
      });
    }

    const subcategories = await prisma.freelance_SubCategory.findMany({
      where: {
        category_id: categoryId,
      },
      orderBy: {
        name: 'asc',
      },
    });

    return res.json({
      successful: true,
      data: subcategories,
    });
  } catch (error) {
    console.error('Get Subcategories by Category Error:', error);
    return res.status(500).json({
      successful: false,
      message: 'Failed to fetch subcategories.',
    });
  }
});

export default router;