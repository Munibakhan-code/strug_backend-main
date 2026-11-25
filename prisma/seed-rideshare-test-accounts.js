import bcrypt from 'bcrypt';
import crypto from 'crypto';
import 'dotenv/config';

export const RIDESHARE_TEST_LOCATION = { lat: 43.6532, long: -79.3832 };
export const RIDER_TEST_EMAIL = 'rider@strug.ca';
export const DRIVER_TEST_EMAIL = 'driver@strug.ca';
export const RIDESHARE_TEST_PASSWORD = 'Strug2026!';

const ALGORITHM = 'aes-256-cbc';
const IV = Buffer.alloc(16, 0);

function encryptEmail(email, encryptionKey) {
  const secretKey = Buffer.from(encryptionKey || '0'.repeat(64), 'hex');
  const cipher = crypto.createCipheriv(ALGORITHM, secretKey, IV);
  let encrypted = cipher.update(email, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

export async function seedRideshareTestAccounts(prisma, { encryptionKey } = {}) {
  const passwordHash = await bcrypt.hash(RIDESHARE_TEST_PASSWORD, 10);

  const rider = await prisma.user.upsert({
    where: { email: encryptEmail(RIDER_TEST_EMAIL, encryptionKey) },
    update: {
      password: passwordHash,
      has_seen_welcome: true,
      account_status: 'active',
      saved_lat: RIDESHARE_TEST_LOCATION.lat,
      saved_long: RIDESHARE_TEST_LOCATION.long,
    },
    create: {
      name: 'Rideshare Rider',
      email: encryptEmail(RIDER_TEST_EMAIL, encryptionKey),
      password: passwordHash,
      has_seen_welcome: true,
      ref_code: 'RIDESHARE-RIDER',
      account_status: 'active',
      saved_lat: RIDESHARE_TEST_LOCATION.lat,
      saved_long: RIDESHARE_TEST_LOCATION.long,
    },
  });

  await prisma.social_profile.upsert({
    where: { user_id: rider.user_id },
    update: { display_name: 'Rideshare Rider' },
    create: {
      user_id: rider.user_id,
      handle: 'rideshare-rider',
      display_name: 'Rideshare Rider',
      accepted_terms: true,
    },
  });

  const driver = await prisma.user.upsert({
    where: { email: encryptEmail(DRIVER_TEST_EMAIL, encryptionKey) },
    update: {
      password: passwordHash,
      has_seen_welcome: true,
      account_status: 'active',
    },
    create: {
      name: 'Rideshare Driver',
      email: encryptEmail(DRIVER_TEST_EMAIL, encryptionKey),
      password: passwordHash,
      has_seen_welcome: true,
      ref_code: 'RIDESHARE-DRIVER',
      account_status: 'active',
    },
  });

  await prisma.social_profile.upsert({
    where: { user_id: driver.user_id },
    update: { display_name: 'Rideshare Driver' },
    create: {
      user_id: driver.user_id,
      handle: 'rideshare-driver',
      display_name: 'Rideshare Driver',
      accepted_terms: true,
    },
  });

  // driver_profile.user_id is indexed but not unique — treat the lowest existing id as canonical
  // so a rerun updates one row instead of accumulating duplicates.
  const existingDriverProfile = await prisma.driver_profile.findFirst({
    where: { user_id: driver.user_id },
    orderBy: { driver_profile_id: 'asc' },
  });
  const driverProfileData = {
    license_number: 'DEV-DRIVER-001',
    is_online: true,
    current_lat: RIDESHARE_TEST_LOCATION.lat,
    current_long: RIDESHARE_TEST_LOCATION.long,
    last_ping: new Date(),
    booking_type_id: 2, // "On-Demand" — see prisma/seed.js bookingTypes seed order
  };
  const driverProfile = existingDriverProfile
    ? await prisma.driver_profile.update({
        where: { driver_profile_id: existingDriverProfile.driver_profile_id },
        data: driverProfileData,
      })
    : await prisma.driver_profile.create({
        data: { user_id: driver.user_id, ...driverProfileData },
      });

  // vehicle.driver_id is indexed but not unique — same canonical-row approach as above.
  const existingVehicle = await prisma.vehicle.findFirst({
    where: { driver_id: driverProfile.driver_profile_id },
    orderBy: { vehicle_id: 'asc' },
  });
  const vehicleData = {
    plate_number: 'DEV-RIDE-01',
    model: 'Toyota Camry',
    color: 'Silver',
    year: 2022,
    max_passengers: 5,
    vehicle_type_id: 1, // Economy
    booking_type_id: 2,
  };
  const vehicle = existingVehicle
    ? await prisma.vehicle.update({
        where: { vehicle_id: existingVehicle.vehicle_id },
        data: vehicleData,
      })
    : await prisma.vehicle.create({
        data: { driver_id: driverProfile.driver_profile_id, ...vehicleData },
      });

  return { rider, driver, driverProfile, vehicle };
}

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const result = await seedRideshareTestAccounts(prisma, { encryptionKey: process.env.ENCRYPTION_KEY });
    console.log(`Seeded rideshare rider #${result.rider.user_id} (${RIDER_TEST_EMAIL}) and driver #${result.driver.user_id} (${DRIVER_TEST_EMAIL}).`);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
