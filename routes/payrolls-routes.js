import express from 'express';
import prisma from '../utils/prisma-client.js';
import mailerEvents from '../utils/mailer-event.js';
import { decrypt } from '../utils/crypto.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';

const router = express.Router();

/* GET ALL PAYROLLS */
router.get('/', authenticateToken, requireAdmin, async (_req, res) => {
    try {
        const payrolls = await prisma.payrolls.findMany({
            orderBy: { payroll_id: 'desc' },
            include: {
                employees: {
                    include: {
                        user: true
                    }
                }
            },
        });
        res.json(payrolls);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch payrolls' });
    }
});

/* GET PAYROLL BY ID */
router.get('/:payroll_id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const payroll_id = Number(req.params.payroll_id);
        if (Number.isNaN(payroll_id)) return res.status(400).json({ error: 'payroll_id must be a number' });

        const payroll = await prisma.payrolls.findUnique({
            where: { payroll_id },
            include: {
                employees: {
                    include: {
                        user: true
                    }
                }
            },
        });

        if (!payroll) return res.status(404).json({ error: 'Payroll record not found' });
        res.json(payroll);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch payroll record' });
    }
});

/* GET PAYROLLS BY EMPLOYEE ID */
router.get('/employee/:employee_id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const employee_id = Number(req.params.employee_id);
        if (Number.isNaN(employee_id)) return res.status(400).json({ error: 'employee_id must be a number' });

        const payrolls = await prisma.payrolls.findMany({
            where: { employee_id },
            include: {
                employees: true
            },
        });
        res.json(payrolls);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch payrolls for employee' });
    }
});

/* CREATE PAYROLL */
/**
 * CREATE PAYROLL & SEND PAYSLIP
 * Production Ready: Dynamic Currency & Background Emailing
 * POST /payrolls
 */
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { employee_id, net_salary, epf_amount, ot, bonus, status } = req.body;

        // Payroll Record 
        const payroll = await prisma.payrolls.create({
            data: {
                employee_id: Number(employee_id),
                net_salary: parseFloat(net_salary),
                epf_amount: parseFloat(epf_amount || 0),
                ot: parseFloat(ot || 0),
                bonus: parseFloat(bonus || 0),
                status: status || 'pending',
            },
            include: {
                employees: {
                    include: {
                        user: {
                            select: { name: true, email: true, currency: true, language: true }
                        }
                    }
                }
            }
        });

        
        if (payroll.employees?.user?.email) {
            try {
                const plainEmail = decrypt(payroll.employees.user.email);
                
                
                const userCurrency = payroll.employees.user.currency || "CAD";

                mailerEvents.emit('send_email', {
                    templateName: 'payslip',
                    variables: {
                        name: payroll.employees.employee_name,
                        currency: userCurrency, 
                        net_salary: parseFloat(net_salary).toFixed(2),
                        ot: parseFloat(ot || 0).toFixed(2),
                        bonus: parseFloat(bonus || 0).toFixed(2),
                        epf_amount: parseFloat(epf_amount || 0).toFixed(2)
                    },
                    to: plainEmail,
                    subjectKey: 'emails.payroll.subject',
                    user: payroll.employees.user,
                });
                
                console.log(`📧 Payslip queued for employee: ${plainEmail} (${userCurrency})`);
            } catch (mailErr) {
                console.error("⚠️ Payslip Email Error:", mailErr.message);
            }
        }

        res.status(201).json({ successful: true, data: payroll });

    } catch (err) {
        console.error("❌ Payroll Error:", err.message);
        res.status(500).json({ successful: false, message: "Failed to process payroll." });
    }
});



/* UPDATE PAYROLL */
router.put('/:payroll_id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const payroll_id = Number(req.params.payroll_id);
        if (Number.isNaN(payroll_id)) return res.status(400).json({ error: 'payroll_id must be a number' });

        const { employee_id, net_salary, epf, etf, epf_amount, etf_amount, status, tax_percentage, ot, bonus } = req.body;

        const existing = await prisma.payrolls.findUnique({ where: { payroll_id } });
        if (!existing) return res.status(404).json({ error: 'Payroll record not found' });

        const updated = await prisma.payrolls.update({
            where: { payroll_id },
            data: {
                employee_id: employee_id ?? existing.employee_id,
                net_salary: net_salary ?? existing.net_salary,
                epf: epf ?? existing.epf,
                etf: etf ?? existing.etf,
                epf_amount: epf_amount ?? existing.epf_amount,
                etf_amount: etf_amount ?? existing.etf_amount,
                status: status ?? existing.status,
                tax_percentage: tax_percentage ?? existing.tax_percentage,
                ot: ot ?? existing.ot,
                bonus: bonus ?? existing.bonus,
            },
            include: {
                employees: true
            }
        });

        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update payroll record' });
    }
});

/* DELETE PAYROLL */
router.delete('/:payroll_id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const payroll_id = Number(req.params.payroll_id);
        if (Number.isNaN(payroll_id)) return res.status(400).json({ error: 'payroll_id must be a number' });

        await prisma.payrolls.delete({ where: { payroll_id } });
        res.json({ message: 'Payroll record deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete payroll record' });
    }
});

export default router;
