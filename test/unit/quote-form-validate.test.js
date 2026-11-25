import { describe, it, expect } from 'vitest';
import {
  validateFormSchema,
  validateMortgageFinancials,
  validateQuoteForm,
} from '../../utils/quote-form-validate.js';

describe('validateFormSchema', () => {
  const schema = [
    { key: 'property_price', label: 'Property Price', type: 'number', required: true },
    { key: 'down_payment', label: 'Down Payment', type: 'number', required: true },
    { key: 'amortization_years', label: 'Amortization', type: 'select', required: true },
  ];

  it('rejects missing required fields', () => {
    const r = validateFormSchema(schema, { property_price: 400000 });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['down_payment', 'amortization_years']));
  });

  it('rejects negatives and non-numeric', () => {
    expect(validateFormSchema(schema, {
      property_price: -1,
      down_payment: 20000,
      amortization_years: '25',
    }).ok).toBe(false);
    expect(validateFormSchema(schema, {
      property_price: 'abc',
      down_payment: 20000,
      amortization_years: '25',
    }).ok).toBe(false);
  });
});

describe('validateMortgageFinancials', () => {
  it('rejects down_payment > price', () => {
    const r = validateMortgageFinancials('mortgage-new-purchase', {
      property_price: 400000,
      down_payment: 500000,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].key).toBe('down_payment');
  });

  it('allows free-input down payment (e.g. US $10k) — providers decide fit', () => {
    const r = validateMortgageFinancials('mortgage-new-purchase', {
      property_price: 400000,
      down_payment: 10000,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts valid purchase', () => {
    const r = validateMortgageFinancials('mortgage-new-purchase', {
      property_price: 400000,
      down_payment: 20000,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects HELOC limit above equity', () => {
    const r = validateMortgageFinancials('mortgage-heloc', {
      property_value: 800000,
      mortgage_balance: 500000,
      requested_credit_limit: 400000,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].key).toBe('requested_credit_limit');
  });

  it('rejects refinance balance > value', () => {
    const r = validateMortgageFinancials('mortgage-refinance', {
      property_value: 500000,
      current_balance: 600000,
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateQuoteForm', () => {
  const category = {
    vertical: 'mortgage',
    slug: 'mortgage-new-purchase',
    form_schema: [
      { key: 'property_price', label: 'Property Price', type: 'number', required: true },
      { key: 'down_payment', label: 'Down Payment', type: 'number', required: true },
      { key: 'amortization_years', label: 'Amortization', type: 'select', required: true },
    ],
  };

  it('passes a complete valid request', () => {
    const r = validateQuoteForm(category, {
      property_price: 750000,
      down_payment: 50000,
      amortization_years: '25',
    });
    expect(r.ok).toBe(true);
  });
});
