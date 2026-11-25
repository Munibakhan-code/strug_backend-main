import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// Loan/borrower records carry financial + PII data. Embedded `user` rows must NEVER be the
// full row (the global Prisma omit strips only password — email/phone/KYC/DOB stay plaintext).
const SAFE_USER_SELECT = { select: { user_id: true, name: true } };

// A prisma `where` that limits a caller to loans they may see: the borrower, the loan
// provider's user, or everything for an admin.
const loanScopeFor = (req) => (isAdmin(req)
  ? {}
  : { OR: [{ user_id: req.user.user_id }, { loan_provider: { user_id: req.user.user_id } }] });

// Loan access = the borrower (loans.user_id), the loan provider's user, or an admin.
// Writes a 404/403 response and returns false when access is denied.
async function assertLoanAccess(loanId, req, res) {
  if (isAdmin(req)) return true;
  if (!loanId) { res.status(403).json({ error: 'Forbidden' }); return false; }
  const loan = await prisma.loans.findUnique({
    where: { loan_id: Number(loanId) },
    include: { loan_provider: { select: { user_id: true } } },
  });
  if (!loan) { res.status(404).json({ error: 'Loan not found' }); return false; }
  if (loan.user_id === req.user.user_id || loan.loan_provider?.user_id === req.user.user_id) return true;
  res.status(403).json({ error: 'Forbidden' });
  return false;
}

//======================================================================================================
//========================================== LOAN PAYMENT ============================================
//======================================================================================================

/* GET ALL LOAN PAYMENTS */
router.get('/payments', authenticateToken, async (req, res) => {
  try {
    const payments = await prisma.loan_payment.findMany({
      where: { loans: loanScopeFor(req) },
      orderBy: { loan_payment_id: 'desc' },
      include: {
        loans: {
          include: {
            user: SAFE_USER_SELECT,
            property: true,
            loan_provider: true,
          },
        },
      },
    });
    res.json(payments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch loan payments' });
  }
});

/* GET LOAN PAYMENT BY ID */
router.get('/payments/:id', authenticateToken, async (req, res) => {
  try {
    const payment = await prisma.loan_payment.findUnique({
      where: { loan_payment_id: parseInt(req.params.id) },
      include: {
        loans: {
          include: {
            user: SAFE_USER_SELECT,
            property: true,
            loan_provider: true,
          },
        },
      },
    });

    if (!payment) {
      return res.status(404).json({ error: 'Loan payment not found' });
    }
    if (!(await assertLoanAccess(payment.loan_id, req, res))) return;

    res.json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch loan payment' });
  }
});

/* CREATE LOAN PAYMENT */
router.post('/payments', authenticateToken, async (req, res) => {
  try {
    const { loan_id, amount_paid } = req.body;
    
    const payment = await prisma.loan_payment.create({
      data: {
        loan_id: loan_id ? parseInt(loan_id) : null,
        amount_paid: amount_paid ? parseFloat(amount_paid) : null,
        date: new Date(),
      },
    });
    
    res.status(201).json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create loan payment' });
  }
});

/* UPDATE LOAN PAYMENT */
router.put('/payments/:id', authenticateToken, async (req, res) => {
  try {
    const { loan_id, amount_paid, date } = req.body;

    const existing = await prisma.loan_payment.findUnique({ where: { loan_payment_id: parseInt(req.params.id) } });
    if (!existing) return res.status(404).json({ error: 'Loan payment not found' });
    if (!(await assertLoanAccess(existing.loan_id, req, res))) return;
    // Reassigning to a different loan requires owning the target loan too.
    if (loan_id && parseInt(loan_id) !== existing.loan_id && !(await assertLoanAccess(parseInt(loan_id), req, res))) return;

    const payment = await prisma.loan_payment.update({
      where: { loan_payment_id: parseInt(req.params.id) },
      data: {
        loan_id: loan_id ? parseInt(loan_id) : undefined,
        amount_paid: amount_paid ? parseFloat(amount_paid) : undefined,
        date: date ? new Date(date) : undefined,
      },
    });

    res.json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update loan payment' });
  }
});

/* DELETE LOAN PAYMENT */
router.delete('/payments/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.loan_payment.findUnique({ where: { loan_payment_id: parseInt(req.params.id) } });
    if (!existing) return res.status(404).json({ error: 'Loan payment not found' });
    if (!(await assertLoanAccess(existing.loan_id, req, res))) return;

    await prisma.loan_payment.delete({
      where: { loan_payment_id: parseInt(req.params.id) },
    });

    res.json({ message: 'Loan payment deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete loan payment' });
  }
});

//======================================================================================================
//========================================== LOAN PROVIDER ===========================================
//======================================================================================================

/* GET ALL LOAN PROVIDERS */
router.get('/providers', authenticateToken, async (req, res) => {
  try {
    // Non-admins only see their own provider profile; admins see all. Embedded borrower loans
    // are scoped so a provider never sees another provider's borrowers' PII.
    const providers = await prisma.loan_provider.findMany({
      where: isAdmin(req) ? {} : { user_id: req.user.user_id },
      orderBy: { loan_provider_id: 'desc' },
      include: {
        user: SAFE_USER_SELECT,
        loans: {
          include: {
            user: SAFE_USER_SELECT,
            property: true,
          },
        },
      },
    });
    res.json(providers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch loan providers' });
  }
});

/* GET LOAN PROVIDER BY ID */
router.get('/providers/:id', authenticateToken, async (req, res) => {
  try {
    const provider = await prisma.loan_provider.findUnique({
      where: { loan_provider_id: parseInt(req.params.id) },
      include: {
        user: SAFE_USER_SELECT,
        loans: {
          include: {
            user: SAFE_USER_SELECT,
            property: true,
          },
        },
      },
    });

    if (!provider) {
      return res.status(404).json({ error: 'Loan provider not found' });
    }
    // Only the provider's own user or an admin may view a provider's borrower book.
    if (!isAdmin(req) && provider.user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(provider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch loan provider' });
  }
});

/* CREATE LOAN PROVIDER */
router.post('/providers', authenticateToken, async (req, res) => {
  try {
    const { user_id, description } = req.body;
    
    const provider = await prisma.loan_provider.create({
      data: {
        description,
        user_id: parseInt(user_id),
      },
    });
    
    res.status(201).json(provider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create loan provider' });
  }
});

/* UPDATE LOAN PROVIDER */
router.put('/providers/:id', authenticateToken, async (req, res) => {
  try {
    const { description } = req.body;

    const existing = await prisma.loan_provider.findUnique({ where: { loan_provider_id: parseInt(req.params.id) } });
    if (!existing) return res.status(404).json({ error: 'Loan provider not found' });
    if (existing.user_id !== req.user.user_id && !isAdmin(req))
      return res.status(403).json({ error: 'Forbidden' });

    const provider = await prisma.loan_provider.update({
      where: { loan_provider_id: parseInt(req.params.id) },
      data: {
        description,
      },
    });

    res.json(provider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update loan provider' });
  }
});

/* DELETE LOAN PROVIDER */
router.delete('/providers/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.loan_provider.findUnique({ where: { loan_provider_id: parseInt(req.params.id) } });
    if (!existing) return res.status(404).json({ error: 'Loan provider not found' });
    if (existing.user_id !== req.user.user_id && !isAdmin(req))
      return res.status(403).json({ error: 'Forbidden' });

    await prisma.loan_provider.delete({
      where: { loan_provider_id: parseInt(req.params.id) },
    });

    res.json({ message: 'Loan provider deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete loan provider' });
  }
});

//======================================================================================================
//=============================================== LOANS ===============================================
//======================================================================================================

/* GET ALL LOANS */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const loans = await prisma.loans.findMany({
      where: loanScopeFor(req),
      orderBy: { loan_id: 'desc' },
      include: {
        property: true,
        user: SAFE_USER_SELECT,
        loan_provider: {
          include: {
            user: SAFE_USER_SELECT,
          },
        },
        loan_payment: true,
      },
    });
    res.json(loans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch loans' });
  }
});

/* GET LOAN BY ID */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const loan = await prisma.loans.findUnique({
      where: { loan_id: parseInt(req.params.id) },
      include: {
        property: true,
        user: SAFE_USER_SELECT,
        loan_provider: {
          include: {
            user: SAFE_USER_SELECT,
          },
        },
        loan_payment: true,
      },
    });

    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }
    if (!(await assertLoanAccess(loan.loan_id, req, res))) return;

    res.json(loan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch loan' });
  }
});

/* CREATE LOAN */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { user_id, property_id, loan_provider_id, loan_amount, loan_term, interest_rate, status } = req.body;

    // Owner from JWT; only an admin may create a loan on behalf of another user.
    const ownerId = isAdmin(req) && user_id ? parseInt(user_id) : req.user.user_id;

    const loan = await prisma.loans.create({
      data: {
        property_id: property_id ? parseInt(property_id) : null,
        user_id: ownerId,
        loan_provider_id: loan_provider_id ? parseInt(loan_provider_id) : null,
        loan_amount: loan_amount ? parseFloat(loan_amount) : null,
        loan_term: loan_term ? parseInt(loan_term) : null,
        interest_rate: interest_rate ? parseFloat(interest_rate) : null,
        status,
        created_at: new Date(),
      },
    });
    
    res.status(201).json(loan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create loan' });
  }
});

/* UPDATE LOAN */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { property_id, loan_provider_id, loan_amount, loan_term, interest_rate, status } = req.body;

    const existing = await prisma.loans.findUnique({ where: { loan_id: parseInt(req.params.id) } });
    if (!existing) return res.status(404).json({ error: 'Loan not found' });
    if (existing.user_id !== req.user.user_id && !isAdmin(req))
      return res.status(403).json({ error: 'Forbidden' });

    const loan = await prisma.loans.update({
      where: { loan_id: parseInt(req.params.id) },
      data: {
        property_id: property_id ? parseInt(property_id) : undefined,
        loan_provider_id: loan_provider_id ? parseInt(loan_provider_id) : undefined,
        loan_amount: loan_amount ? parseFloat(loan_amount) : undefined,
        loan_term: loan_term ? parseInt(loan_term) : undefined,
        interest_rate: interest_rate ? parseFloat(interest_rate) : undefined,
        status,
      },
    });
    
    res.json(loan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update loan' });
  }
});

/* DELETE LOAN */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.loans.findUnique({ where: { loan_id: parseInt(req.params.id) } });
    if (!existing) return res.status(404).json({ error: 'Loan not found' });
    if (existing.user_id !== req.user.user_id && !isAdmin(req))
      return res.status(403).json({ error: 'Forbidden' });

    await prisma.loans.delete({
      where: { loan_id: parseInt(req.params.id) },
    });

    res.json({ message: 'Loan deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete loan' });
  }
});

export default router;