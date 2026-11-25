import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const RECEIVER_ID = 16; // testuser (test@strug.ca)
const SENDER_ID = 1;    // Vickie250

async function main() {
  // Find a post to use as target_id
  let targetId = 1;
  const post = await prisma.social_feed.findFirst({ select: { social_post_id: true } });
  if (post) targetId = post.social_post_id;

  // Clean up previous test notifications for this receiver
  await prisma.social_notification.deleteMany({ where: { receiver_id: RECEIVER_ID } });

  const created = await prisma.social_notification.createMany({
    data: [
      { receiver_id: RECEIVER_ID, sender_id: SENDER_ID, type: 'LIKE',    target_id: targetId,   is_read: false },
      { receiver_id: RECEIVER_ID, sender_id: SENDER_ID, type: 'FOLLOW',  target_id: RECEIVER_ID, is_read: false },
      { receiver_id: RECEIVER_ID, sender_id: SENDER_ID, type: 'COMMENT', target_id: targetId,   is_read: true  },
    ],
  });

  console.log(`Seeded ${created.count} notifications for profile_id=${RECEIVER_ID} (testuser).`);
  console.log('2 unread (LIKE + FOLLOW), 1 read (COMMENT).');
  console.log('Login: test@strug.ca / Strug2026!');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
