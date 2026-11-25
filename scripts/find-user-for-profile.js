import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const profile = await prisma.social_profile.findUnique({
    where: { profile_id: 1 },
    select: { profile_id: true, handle: true, user_id: true },
  });
  console.log('Profile:', profile);

  if (profile?.user_id) {
    const user = await prisma.user.findUnique({
      where: { user_id: profile.user_id },
      select: { user_id: true, email: true, name: true },
    });
    console.log('User:', user);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
