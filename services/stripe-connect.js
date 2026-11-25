import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

export function getStripe() {
  return stripe;
}

export const PAYOUT_CURRENCY = (process.env.SUB_CURRENCY || 'CAD').toUpperCase();

export function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

export async function createExpressAccount({ email, metadata } = {}) {
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.accounts.create({
    type: 'express',
    email: email || undefined,
    capabilities: { transfers: { requested: true } },
    business_type: 'individual',
    metadata: metadata || {},
  });
}

export async function createAccountOnboardingLink({ accountId, refreshUrl, returnUrl }) {
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
}

export async function connectStatusByAccountId(accountId) {
  if (!accountId) return { connected: false, payouts_enabled: false };
  if (!stripe) return { connected: true, payouts_enabled: false };
  const acct = await stripe.accounts.retrieve(accountId);
  return {
    connected: true,
    payouts_enabled: !!acct.payouts_enabled,
    charges_enabled: !!acct.charges_enabled,
    details_submitted: !!acct.details_submitted,
  };
}

export async function transferToConnect({ amount, destination, metadata, idempotencyKey }) {
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.transfers.create(
    {
      amount: toCents(amount),
      currency: PAYOUT_CURRENCY.toLowerCase(),
      destination,
      metadata: metadata || {},
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
}
