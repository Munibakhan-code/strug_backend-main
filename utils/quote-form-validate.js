/**
 * Quote request form validation — required fields + mortgage financial rules.
 *
 * Down payment is free input (any positive amount ≤ price). Country-specific
 * lender rules (e.g. Canadian CMHC mins) are for providers to apply — a US
 * buyer with $10k may still get quotes.
 */

function parseNumber(v) {
  if (v === undefined || v === null || v === '') return { empty: true };
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return { invalid: true };
  return { value: n };
}

function requirePositive(data, key, label, errors) {
  const r = parseNumber(data[key]);
  if (r.empty) return null;
  if (r.invalid) {
    errors.push({ key, message: `${label} must be a valid number` });
    return null;
  }
  if (r.value < 0) {
    errors.push({ key, message: `${label} cannot be negative` });
    return null;
  }
  if (r.value === 0) {
    errors.push({ key, message: `${label} must be greater than 0` });
    return null;
  }
  return r.value;
}

function requireNonNegative(data, key, label, errors) {
  const r = parseNumber(data[key]);
  if (r.empty) return null;
  if (r.invalid) {
    errors.push({ key, message: `${label} must be a valid number` });
    return null;
  }
  if (r.value < 0) {
    errors.push({ key, message: `${label} cannot be negative` });
    return null;
  }
  return r.value;
}

/** Schema presence check + number-type sanity for any vertical. */
export function validateFormSchema(formSchema, formData) {
  if (!Array.isArray(formSchema)) return { ok: true, missing: [], errors: [] };
  const data = formData && typeof formData === 'object' ? formData : {};
  const missing = formSchema
    .filter((f) => f && f.required)
    .filter((f) => data[f.key] === undefined || data[f.key] === null || data[f.key] === '')
    .map((f) => f.key);

  const errors = [];
  for (const f of formSchema) {
    if (!f?.key || f.type !== 'number') continue;
    const r = parseNumber(data[f.key]);
    if (r.empty) continue;
    if (r.invalid) {
      errors.push({ key: f.key, message: `${f.label || f.key} must be a valid number` });
      continue;
    }
    if (r.value < 0) {
      errors.push({ key: f.key, message: `${f.label || f.key} cannot be negative` });
    }
  }

  if (missing.length) return { ok: false, missing, errors };
  if (errors.length) return { ok: false, missing: [], errors };
  return { ok: true, missing: [], errors: [] };
}

/** Cross-field mortgage rules by category slug. */
export function validateMortgageFinancials(slug, formData) {
  const data = formData && typeof formData === 'object' ? formData : {};
  const errors = [];

  switch (slug) {
    case 'mortgage-new-purchase': {
      const price = requirePositive(data, 'property_price', 'Property Price', errors);
      const down = requirePositive(data, 'down_payment', 'Down Payment', errors);
      if (price != null && down != null && down > price) {
        errors.push({ key: 'down_payment', message: 'Down payment cannot exceed property price' });
      }
      break;
    }
    case 'mortgage-refinance': {
      const value = requirePositive(data, 'property_value', 'Current Property Value', errors);
      const balance = requireNonNegative(data, 'current_balance', 'Current Mortgage Balance', errors);
      if (value != null && balance != null && balance > value) {
        errors.push({ key: 'current_balance', message: 'Mortgage balance cannot exceed property value' });
      }
      requireNonNegative(data, 'desired_amount', 'Desired New Amount', errors);
      requireNonNegative(data, 'current_rate', 'Current Interest Rate', errors);
      requirePositive(data, 'amortization_years', 'Remaining Amortization', errors);
      break;
    }
    case 'mortgage-renewal': {
      const value = requirePositive(data, 'property_value', 'Property Value', errors);
      const balance = requireNonNegative(data, 'current_balance', 'Current Balance', errors);
      if (value != null && balance != null && balance > value) {
        errors.push({ key: 'current_balance', message: 'Current balance cannot exceed property value' });
      }
      requireNonNegative(data, 'current_rate', 'Current Rate', errors);
      break;
    }
    case 'mortgage-heloc': {
      const value = requirePositive(data, 'property_value', 'Property Value', errors);
      const balance = requireNonNegative(data, 'mortgage_balance', 'Existing Mortgage Balance', errors);
      const limit = requirePositive(data, 'requested_credit_limit', 'Requested Credit Limit', errors);
      if (value != null && balance != null && balance > value) {
        errors.push({ key: 'mortgage_balance', message: 'Mortgage balance cannot exceed property value' });
      }
      if (value != null && balance != null && limit != null) {
        const equity = value - balance;
        if (limit > equity) {
          errors.push({
            key: 'requested_credit_limit',
            message: `Requested credit limit cannot exceed available equity ($${equity.toLocaleString()})`,
          });
        }
      }
      break;
    }
    default:
      break;
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/**
 * Full validate for create quote-request.
 * @returns {{ ok: true } | { ok: false, missing?: string[], errors?: {key,message}[], message?: string }}
 */
export function validateQuoteForm(category, formData) {
  const schemaCheck = validateFormSchema(category?.form_schema, formData);
  if (!schemaCheck.ok) {
    return {
      ok: false,
      missing: schemaCheck.missing,
      errors: schemaCheck.errors,
      message: schemaCheck.missing.length
        ? 'Missing required fields'
        : (schemaCheck.errors[0]?.message || 'Invalid form data'),
    };
  }

  if (category?.vertical === 'mortgage' || String(category?.slug || '').startsWith('mortgage-')) {
    // Defense-in-depth: require amortization on new purchase even if DB schema isn't migrated yet.
    if (category.slug === 'mortgage-new-purchase') {
      const am = formData?.amortization_years;
      if (am === undefined || am === null || am === '') {
        return {
          ok: false,
          missing: ['amortization_years'],
          errors: [{ key: 'amortization_years', message: 'Amortization (years) is required' }],
          message: 'Missing required fields',
        };
      }
    }
    const fin = validateMortgageFinancials(category.slug, formData);
    if (!fin.ok) {
      return {
        ok: false,
        missing: [],
        errors: fin.errors,
        message: fin.errors[0]?.message || 'Invalid mortgage amounts',
      };
    }
  }

  return { ok: true };
}
