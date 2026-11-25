import prisma from '../utils/prisma-client.js';
import { areUsersBlockedOnPlatform } from '../utils/platform-blocks.js';

function chatError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function uniqueMembers(members) {
  const byUser = new Map();
  members.filter((member) => member.userId).forEach((member) => {
    if (!byUser.has(member.userId)) byUser.set(member.userId, member);
  });
  return [...byUser.values()];
}

async function syncChannelMembers(channelId, members) {
  const safeMembers = uniqueMembers(members);
  const additions = [];

  for (const member of safeMembers) {
    const existing = await prisma.chat_participants.findFirst({
      where: { channel_id: channelId, user_id: member.userId },
    });
    if (existing) continue;

    const participant = await prisma.chat_participants.create({
      data: {
        channel_id: channelId,
        user_id: member.userId,
        role: member.role || 'member',
      },
    });
    additions.push(participant);
  }

  return additions;
}

async function openContextConversation({
  contextType,
  contextId,
  channelType,
  channelName,
  creatorId,
  members,
}) {
  const safeMembers = uniqueMembers(members);
  if (!safeMembers.some((member) => member.userId === creatorId)) {
    throw chatError('You are not permitted to open this conversation', 403);
  }
  if (safeMembers.length < 2) {
    throw chatError('Conversation requires at least two participants', 409);
  }
  for (const member of safeMembers) {
    if (member.userId !== creatorId && await areUsersBlockedOnPlatform(creatorId, member.userId)) {
      throw chatError('Conversation is not available', 403);
    }
  }

  const existing = await prisma.chat_channel.findFirst({
    where: { context_type: contextType, context_id: String(contextId) },
    select: { channel_id: true },
  });
  if (existing) {
    await syncChannelMembers(existing.channel_id, safeMembers);
    return { channel_id: existing.channel_id, created: false };
  }

  const channel = await prisma.$transaction(async (tx) => {
    const created = await tx.chat_channel.create({
      data: {
        type: channelType,
        channel_name: channelName,
        context_type: contextType,
        context_id: String(contextId),
        created_by: creatorId,
      },
    });

    await tx.chat_participants.createMany({
      data: safeMembers.map((member) => ({
        channel_id: created.channel_id,
        user_id: member.userId,
        role: member.userId === creatorId ? 'owner' : member.role,
      })),
    });

    return created;
  });

  return { channel_id: channel.channel_id, created: true };
}

export async function openRideConversation({ rideRequestId, userId }) {
  const ride = await prisma.ride_request.findUnique({
    where: { ride_request_id: Number(rideRequestId) },
    include: {
      active_trip: { include: { driver_profile: true }, take: 1 },
    },
  });
  if (!ride) throw chatError('Ride request not found', 404);

  const driverId = ride.active_trip?.[0]?.driver_profile?.user_id;
  return openContextConversation({
    contextType: 'rideshare',
    contextId: ride.ride_request_id,
    channelType: 'ride',
    channelName: `ride_${ride.ride_request_id}`,
    creatorId: userId,
    members: [
      { userId: ride.passenger_id, role: 'customer' },
      { userId: driverId, role: 'driver' },
    ],
  });
}

export async function openFoodConversation({ orderId, userId }) {
  const order = await prisma.food_order.findUnique({
    where: { food_order_id: Number(orderId) },
    include: { food_vendor: true, driver_profile: true },
  });
  if (!order) throw chatError('Food order not found', 404);

  return openContextConversation({
    contextType: 'food',
    contextId: order.food_order_id,
    channelType: 'order',
    channelName: `food_${order.food_order_id}`,
    creatorId: userId,
    members: [
      { userId: order.user_id, role: 'customer' },
      { userId: order.food_vendor?.owner_id, role: 'vendor' },
      { userId: order.driver_profile?.user_id, role: 'driver' },
    ],
  });
}

export async function openServiceConversation({ orderId, userId }) {
  const order = await prisma.service_order.findUnique({
    where: { order_id: Number(orderId) },
    include: { user_service_provider: true },
  });
  if (!order) throw chatError('Service order not found', 404);

  return openContextConversation({
    contextType: 'services',
    contextId: order.order_id,
    channelType: 'order',
    channelName: `service_${order.order_id}`,
    creatorId: userId,
    members: [
      { userId: order.buyer_id, role: 'customer' },
      { userId: order.user_service_provider?.user_id, role: 'provider' },
    ],
  });
}

export async function openRentalConversation({ orderId, userId }) {
  const order = await prisma.rental_order.findUnique({
    where: { order_id: Number(orderId) },
    include: { rental_listing: true },
  });
  if (!order) throw chatError('Rental order not found', 404);

  return openContextConversation({
    contextType: 'marketplace',
    contextId: order.order_id,
    channelType: 'order',
    channelName: `rental_${order.order_id}`,
    creatorId: userId,
    members: [
      { userId: order.buyer_id, role: 'customer' },
      { userId: order.rental_listing?.owner_id, role: 'vendor' },
    ],
  });
}

export async function openSupportConversation({ ticketId, customerUserId, agentUserId }) {
  return openContextConversation({
    contextType: 'support',
    contextId: ticketId,
    channelType: 'support',
    channelName: `support_${ticketId}`,
    creatorId: agentUserId,
    members: [
      { userId: agentUserId, role: 'support_agent' },
      { userId: Number(customerUserId), role: 'customer' },
    ],
  });
}

export async function syncFoodOrderChatMembers(orderId) {
  const order = await prisma.food_order.findUnique({
    where: { food_order_id: Number(orderId) },
    include: { food_vendor: true, driver_profile: true },
  });
  if (!order) return [];

  const channel = await prisma.chat_channel.findFirst({
    where: { context_type: 'food', context_id: String(order.food_order_id) },
    select: { channel_id: true },
  });
  if (!channel) return [];

  return syncChannelMembers(channel.channel_id, [
    { userId: order.user_id, role: 'customer' },
    { userId: order.food_vendor?.owner_id, role: 'vendor' },
    { userId: order.driver_profile?.user_id, role: 'driver' },
  ]);
}

export async function openProductOrderConversation({ orderId, userId }) {
  const order = await prisma.product_order.findUnique({
    where: { order_id: Number(orderId) },
  });
  if (!order) throw chatError('Order not found', 404);
  const isBuyer = order.buyer_id === userId;
  const isSeller = order.seller_id === userId;
  if (!isBuyer && !isSeller) {
    throw chatError('You are not permitted to open this conversation', 403);
  }
  if (!order.buyer_id || !order.seller_id) {
    throw chatError('Conversation requires buyer and seller', 409);
  }

  return openContextConversation({
    contextType: 'shop',
    contextId: order.order_id,
    channelType: 'order',
    channelName: `shop_${order.order_id}`,
    creatorId: userId,
    members: [
      { userId: order.buyer_id, role: 'customer' },
      { userId: order.seller_id, role: 'vendor' },
    ],
  });
}

export async function openWorkJobConversation({ jobId, userId }) {
  const job = await prisma.work_job.findUnique({
    where: { work_job_id: Number(jobId) },
  });
  if (!job) throw chatError('Work job not found', 404);

  const workerProfile = job.assigned_worker_id
    ? await prisma.worker_profile.findUnique({
        where: { worker_profile_id: job.assigned_worker_id },
      })
    : null;
  const workerUserId = workerProfile?.user_id;

  const isHirer = job.hirer_id === userId;
  const isWorker = workerUserId === userId;
  if (!isHirer && !isWorker) {
    throw chatError('You are not permitted to open this conversation', 403);
  }
  if (!job.hirer_id || !workerUserId) {
    throw chatError('No worker assigned yet', 409);
  }

  return openContextConversation({
    contextType: 'ondemand',
    contextId: job.work_job_id,
    channelType: 'order',
    channelName: `work_${job.work_job_id}`,
    creatorId: userId,
    members: [
      { userId: job.hirer_id, role: 'customer' },
      { userId: workerUserId, role: 'provider' },
    ],
  });
}

/** Job board application thread — only hiring agent owner ↔ applicant. */
export async function openJobApplicationConversation({ applicationId, userId }) {
  const application = await prisma.job_application.findUnique({
    where: { job_application_id: Number(applicationId) },
    include: {
      jobs: { include: { agents: true } },
      candidate: true,
    },
  });
  if (!application) throw chatError('Job application not found', 404);

  const employerUserId = application.jobs?.agents?.agent_user_id;
  const applicantUserId = application.candidate?.candidate_user_id;
  const isEmployer = employerUserId === Number(userId);
  const isApplicant = applicantUserId === Number(userId);
  if (!isEmployer && !isApplicant) {
    throw chatError('You are not permitted to open this conversation', 403);
  }
  if (!employerUserId || !applicantUserId) {
    throw chatError('Conversation requires employer and applicant', 409);
  }

  return openContextConversation({
    contextType: 'job_application',
    contextId: application.job_application_id,
    channelType: 'order',
    channelName: `job_app_${application.job_application_id}`,
    creatorId: Number(userId),
    members: [
      { userId: employerUserId, role: 'employer' },
      { userId: applicantUserId, role: 'applicant' },
    ],
  });
}

export async function syncWorkJobChatMembers(jobId) {
  const job = await prisma.work_job.findUnique({
    where: { work_job_id: Number(jobId) },
  });
  if (!job?.assigned_worker_id) return [];

  const workerProfile = await prisma.worker_profile.findUnique({
    where: { worker_profile_id: job.assigned_worker_id },
  });
  if (!workerProfile?.user_id || !job.hirer_id) return [];

  const channel = await prisma.chat_channel.findFirst({
    where: { context_type: 'ondemand', context_id: String(job.work_job_id) },
    select: { channel_id: true },
  });
  if (!channel) return [];

  return syncChannelMembers(channel.channel_id, [
    { userId: job.hirer_id, role: 'customer' },
    { userId: workerProfile.user_id, role: 'provider' },
  ]);
}

export async function syncRideChatMembers(rideRequestId) {
  const ride = await prisma.ride_request.findUnique({
    where: { ride_request_id: Number(rideRequestId) },
    include: {
      active_trip: { include: { driver_profile: true }, take: 1 },
    },
  });
  if (!ride) return [];

  const channel = await prisma.chat_channel.findFirst({
    where: { context_type: 'rideshare', context_id: String(ride.ride_request_id) },
    select: { channel_id: true },
  });
  if (!channel) return [];

  const driverId = ride.active_trip?.[0]?.driver_profile?.user_id;
  return syncChannelMembers(channel.channel_id, [
    { userId: ride.passenger_id, role: 'customer' },
    { userId: driverId, role: 'driver' },
  ]);
}
