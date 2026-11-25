import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// HR PII (bank, payroll, salary). Admin-only — any logged-in user previously dumped the table (#1285).
router.use(authenticateToken, requireAdmin);

const LIST_INCLUDE = {
  user: { select: { user_id: true, name: true } },
};

const DETAIL_INCLUDE = {
  user: { select: { user_id: true, name: true } },
  bank_info: true,
  emergency_contact: true,
  employee_attendance: true,
  leave: true,
  payrolls: true,
  shift: true,
};

/**
 * Get all employees (summary — no bank/payroll embeds on list)
 */
router.get('/', async (_req, res) => {
  try {
    const employees = await prisma.employees.findMany({
      orderBy: { employee_id: 'asc' },
      include: LIST_INCLUDE,
      take: 500,
    });
    res.json(employees);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

/**
 * Get single employee (full HR includes for admin)
 */
router.get('/:employee_id', async (req, res) => {
  try {
    const employee_id = Number(req.params.employee_id);
    if (Number.isNaN(employee_id)) return res.status(400).json({ error: 'employee_id must be a number' });

    const employee = await prisma.employees.findUnique({
      where: { employee_id },
      include: DETAIL_INCLUDE,
    });

    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    res.json(employee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch employee' });
  }
});

/**
 * Create employee
 */
router.post('/', async (req, res) => {
  try {
    const {
      employee_user_id,
      employee_name,
      employee_dob,
      employee_email,
      employee_gender,
      employee_phone_number,
      employee_address,
      employee_city,
      employee_state,
      employee_province,
      employee_zip_code,
      employee_job_title,
      employee_employment_status,
      employee_salary,
    } = req.body;

    if (!employee_name || !employee_email) {
      return res.status(400).json({ error: 'employee_name and employee_email are required' });
    }

    const newEmployee = await prisma.employees.create({
      data: {
        employee_user_id,
        employee_name,
        employee_dob: employee_dob ? new Date(employee_dob) : null,
        employee_email,
        employee_gender,
        employee_phone_number,
        employee_address,
        employee_city,
        employee_state,
        employee_province,
        employee_zip_code,
        employee_job_title,
        employee_employment_status,
        employee_salary,
      },
    });

    // No unscoped io.emit of HR PII (salary, DOB, address).

    res.status(201).json(newEmployee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

/**
 * Update employee
 */
router.put('/:employee_id', async (req, res) => {
  try {
    const employee_id = Number(req.params.employee_id);
    if (Number.isNaN(employee_id)) return res.status(400).json({ error: 'employee_id must be a number' });

    const {
      employee_user_id,
      employee_name,
      employee_dob,
      employee_email,
      employee_gender,
      employee_phone_number,
      employee_address,
      employee_city,
      employee_state,
      employee_province,
      employee_zip_code,
      employee_job_title,
      employee_employment_status,
      employee_salary,
    } = req.body;

    const existing = await prisma.employees.findUnique({
      where: { employee_id },
    });

    if (!existing) return res.status(404).json({ error: 'Employee not found' });

    const updatedEmployee = await prisma.employees.update({
      where: { employee_id },
      data: {
        employee_user_id,
        employee_name,
        employee_dob: employee_dob ? new Date(employee_dob) : existing.employee_dob,
        employee_email,
        employee_gender,
        employee_phone_number,
        employee_address,
        employee_city,
        employee_state,
        employee_province,
        employee_zip_code,
        employee_job_title,
        employee_employment_status,
        employee_salary,
      },
    });

    res.json(updatedEmployee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

/**
 * Delete employee
 */
router.delete('/:employee_id', async (req, res) => {
  try {
    const employee_id = Number(req.params.employee_id);
    if (Number.isNaN(employee_id)) return res.status(400).json({ error: 'employee_id must be a number' });

    await prisma.employees.delete({
      where: { employee_id },
    });

    res.json({ message: 'Employee deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete employee' });
  }
});

export default router;
