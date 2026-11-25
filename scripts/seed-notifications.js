import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  // Find two social profiles to use as receiver and sender
  const profiles = await prisma.social_profile.findMany({
    take: 2,
    orderBy: { profile_id: 'asc' },
    select: { profile_id: true, handle: true, display_name: true },
  });

  if (profiles.length < 1) {
    console.error('No social profiles found. Run seed-test-user.js first.');
    process.exit(1);
  }

  const receiver = profiles[0];
  const sender = profiles.length > 1 ? profiles[1] : profiles[0];

  console.log(`Seeding notifications for receiver: ${receiver.handle} (id: ${receiver.profile_id})`);
  console.log(`Sender: ${sender.handle} (id: ${sender.profile_id})`);

  // Find a post to use as target_id (or use 1 as fallback)
  let targetId = 1;
  const post = await prisma.social_feed.findFirst({ select: { social_post_id: true } });
  if (post) targetId = post.social_post_id;

  // Clean up any previous test notifications
  await prisma.social_notification.deleteMany({
    where: { receiver_id: receiver.profile_id, sender_id: sender.profile_id },
  });

  // Insert 3 test notifications
  const created = await prisma.social_notification.createMany({
    data: [
      {
        receiver_id: receiver.profile_id,
        sender_id: sender.profile_id,
        type: 'LIKE',
        target_id: targetId,
        is_read: false,
      },
      {
        receiver_id: receiver.profile_id,
        sender_id: sender.profile_id,
        type: 'FOLLOW',
        target_id: receiver.profile_id,
        is_read: false,
      },
      {
        receiver_id: receiver.profile_id,
        sender_id: sender.profile_id,
        type: 'COMMENT',
        target_id: targetId,
        is_read: true,
      },
    ],
  });

  console.log(`Created ${created.count} notifications.`);
  console.log(`\nTest account: receiver profile_id = ${receiver.profile_id}`);
  console.log('Login as that user to see real notifications in the panel.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
