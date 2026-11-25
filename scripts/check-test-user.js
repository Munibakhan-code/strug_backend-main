import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const prisma = new PrismaClient();

function encryptEmail(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

async function main() {
  const encEmail = encryptEmail('test@strug.ca');
  const user = await prisma.user.findUnique({
    where: { email: encEmail },
    select: { user_id: true, name: true },
  });
  console.log('Test user:', user);

  if (user) {
    const profile = await prisma.social_profile.findFirst({
      where: { user_id: user.user_id },
      select: { profile_id: true, handle: true },
    });
    console.log('Test profile:', profile);
    return { user, profile };
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
