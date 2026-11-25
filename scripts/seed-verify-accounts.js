/**
 * Seed a rider, a driver, and a courier demo account for manually verifying
 * rideshare/courier flows end to end, each with a saved Stripe test card so
 * payment doesn't block testing.
 *
 * Usage: node scripts/seed-verify-accounts.js
 *
 * All accounts share password: Strug2026!
 */
import bcrypt from 'bcrypt';
import Stripe from 'stripe';
import prisma from '../utils/prisma-client.js';
import { encryptSearch } from '../utils/crypto.js';

const PASSWORD = 'Strug2026!';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// NOTE: driver/courier status is NOT a user column — `is_driver` is derived at
// login from the driver_profile relation (Boolean(driverProfile), PR #998).
// Callers that need a driver make one the sanctioned way by upserting a
// driver_profile row below; this helper never writes an is_driver column.
async function upsertUser({ email, name, handle, is_seller = false }) {
  const encryptedEmail = encryptSearch(email);
  const hashed = await bcrypt.hash(PASSWORD, 10);
  const refCode = `VERIFY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const user = await prisma.user.upsert({
    where: { email: encryptedEmail },
    update: { name, password: hashed, is_seller, has_seen_welcome: true },
    create: {
      name,
      email: encryptedEmail,
      password: hashed,
      ref_code: refCode,
      is_seller,
      has_seen_welcome: true,
    },
  });

  await prisma.social_profile.upsert({
    where: { handle },
    update: { user_id: user.user_id, display_name: name, accepted_terms: true },
    create: { user_id: user.user_id, handle, display_name: name, accepted_terms: true },
  });

  return user;
}

// Attaches a Stripe test card to the user's customer record, mirroring the
// real /payments/setup-intent + confirm flow (routes/payment-routes.js
// getOrCreateStripeCustomer, which keys the Stripe customer by the user's
// *decrypted* email) so GET /payments/payment-methods picks it up exactly
// like a card entered through the app would.
async function attachTestCard(email) {
  if (!stripe) return null;

  const existing = await stripe.customers.search({ query: `email:"${email}"`, limit: 1 });
  const customer = existing.data.length
    ? existing.data[0]
    : await stripe.customers.create({ email });

  const setupIntent = await stripe.setupIntents.create({
    customer: customer.id,
    payment_method_types: ['card'],
    payment_method: 'pm_card_visa',
    confirm: true,
  });

  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: setupIntent.payment_method },
  });

  return { customerId: customer.id, paymentMethodId: setupIntent.payment_method };
}

async function main() {
  console.log('Seeding rider / driver / courier verification accounts...\n');

  // --- Rider ---
  const rider = await upsertUser({ email: 'verify.rider@strug.com', name: 'Verify Rider', handle: 'verifyrider' });
  const riderCard = await attachTestCard('verify.rider@strug.com');
  console.log(`RIDER    verify.rider@strug.com   | password: ${PASSWORD} | user_id: ${rider.user_id}${riderCard ? ` | card: ${riderCard.paymentMethodId}` : ''}`);

  // --- Driver (rideshare) ---
  const driver = await upsertUser({ email: 'verify.driver@strug.com', name: 'Verify Driver', handle: 'verifydriver' });
  let driverProfile = await prisma.driver_profile.findFirst({ where: { user_id: driver.user_id } });
  if (!driverProfile) {
    driverProfile = await prisma.driver_profile.create({
      data: {
        user_id: driver.user_id,
        license_number: 'VERIFY-DL-0001',
        license_expiry: new Date('2030-01-01'),
        is_online: true,
        rating: 4.9,
        booking_type_id: 2, // On-Demand
        accepts_rides: true,
      },
    });
  } else {
    driverProfile = await prisma.driver_profile.update({
      where: { driver_profile_id: driverProfile.driver_profile_id },
      data: { is_online: true, accepts_rides: true },
    });
  }
  const existingVehicle = await prisma.vehicle.findFirst({ where: { driver_id: driverProfile.driver_profile_id } });
  if (!existingVehicle) {
    await prisma.vehicle.create({
      data: {
        driver_id: driverProfile.driver_profile_id,
        user_id: driver.user_id,
        plate_number: 'VRFY-001',
        make: 'Toyota',
        model: 'Camry',
        color: 'Black',
        year: 2022,
        max_passengers: 4,
        vehicle_type_id: 5, // economy
        booking_type_id: 2,
        price: 12.5,
      },
    });
  }
  const driverCard = await attachTestCard('verify.driver@strug.com');
  console.log(`DRIVER   verify.driver@strug.com  | password: ${PASSWORD} | user_id: ${driver.user_id} | driver_profile_id: ${driverProfile.driver_profile_id}${driverCard ? ` | card: ${driverCard.paymentMethodId}` : ''}`);

  // --- Courier ---
  const courier = await upsertUser({ email: 'verify.courier@strug.com', name: 'Verify Courier', handle: 'verifycourier' });
  let courierProfile = await prisma.driver_profile.findFirst({ where: { user_id: courier.user_id } });
  if (!courierProfile) {
    courierProfile = await prisma.driver_profile.create({
      data: {
        user_id: courier.user_id,
        license_number: 'VERIFY-DL-0002',
        license_expiry: new Date('2030-01-01'),
        is_online: true,
        rating: 4.8,
        accepts_rides: false,
        accepts_courier: true,
      },
    });
  } else {
    courierProfile = await prisma.driver_profile.update({
      where: { driver_profile_id: courierProfile.driver_profile_id },
      data: { is_online: true, accepts_courier: true },
    });
  }
  const existingCourierExt = await prisma.driver_courier_profile.findUnique({
    where: { driver_profile_id: courierProfile.driver_profile_id },
  });
  if (!existingCourierExt) {
    await prisma.driver_courier_profile.create({
      data: {
        driver_profile_id: courierProfile.driver_profile_id,
        display_name: 'Verify Courier',
        price_per_km: 50,
      },
    });
  }
  const courierCard = await attachTestCard('verify.courier@strug.com');
  console.log(`COURIER  verify.courier@strug.com | password: ${PASSWORD} | user_id: ${courier.user_id} | driver_profile_id: ${courierProfile.driver_profile_id}${courierCard ? ` | card: ${courierCard.paymentMethodId}` : ''}`);

  console.log('\nLogin: POST http://localhost:5000/auth/login');
  console.log('Body:  { "login": "<email>", "password": "Strug2026!" }');
  console.log('\nIf locked after failed attempts: node scripts/clear-login-lock.js <email>');
  if (!stripe) console.log('\nNOTE: STRIPE_SECRET_KEY not set — skipped attaching test cards.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
