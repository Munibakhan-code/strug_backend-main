import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyTechSupportOnCustomerMessage } from '../../services/support-email-service.js';
import prisma from '../../utils/prisma-client.js';
import { sendEmail } from '../../services/email-service.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    chat_channel: { findUnique: vi.fn() },
    chat_participants: { findMany: vi.fn() },
    chat_messages: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('../../services/email-service.js', () => ({ sendEmail: vi.fn().mockResolvedValue({}) }));

const CUSTOMER = 5;
const AGENT = 9;

function supportChannel() {
  prisma.chat_channel.findUnique.mockResolvedValue({ context_type: 'support', context_id: 'TICKET-1', channel_name: 'support_TICKET-1' });
  prisma.chat_participants.findMany.mockResolvedValue([
    { user_id: CUSTOMER, role: 'customer' },
    { user_id: AGENT, role: 'support_agent' },
  ]);
  prisma.user.findUnique.mockResolvedValue({ email: 'cust@x.com', social_profiles: [{ display_name: 'Cust', handle: 'cust' }] });
  // The engineer/agent handling the conversation has this email.
  prisma.user.findMany.mockResolvedValue([{ email: 'engineer@strug.ca' }]);
}

describe('notifyTechSupportOnCustomerMessage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT email for a non-support channel', async () => {
    prisma.chat_channel.findUnique.mockResolvedValue({ context_type: 'food', context_id: '1' });
    const sent = await notifyTechSupportOnCustomerMessage({ channelId: 1, senderId: CUSTOMER, content: 'hi', messageId: 100 });
    expect(sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does NOT email when the SUPPORT AGENT sends the message', async () => {
    supportChannel();
    const sent = await notifyTechSupportOnCustomerMessage({ channelId: 1, senderId: AGENT, content: 'reply', messageId: 100 });
    expect(sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('emails tech support when a CUSTOMER opens a new turn (prev message was the agent)', async () => {
    supportChannel();
    prisma.chat_messages.findFirst.mockResolvedValue({ sender_id: AGENT }); // previous = agent
    const sent = await notifyTechSupportOnCustomerMessage({ channelId: 1, senderId: CUSTOMER, content: 'help me', messageId: 101 });
    expect(sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0];
    expect(arg.to).toEqual(['engineer@strug.ca']); // the engineer handling the convo
    expect(arg.to).not.toContain('cust@x.com'); // never the customer
    expect(arg.text).toContain('help me');
  });

  it('falls back to SUPPORT_EMAIL when the agent has no email on file', async () => {
    supportChannel();
    prisma.user.findMany.mockResolvedValue([{ email: null }]); // agent has no email
    prisma.chat_messages.findFirst.mockResolvedValue({ sender_id: AGENT });
    const sent = await notifyTechSupportOnCustomerMessage({ channelId: 1, senderId: CUSTOMER, content: 'x', messageId: 101 });
    expect(sent).toBe(true);
    expect(sendEmail.mock.calls[0][0].to).toEqual([process.env.SUPPORT_EMAIL || 'support@strug.ca']);
  });

  it('emails when there is NO previous message (first message)', async () => {
    supportChannel();
    prisma.chat_messages.findFirst.mockResolvedValue(null);
    const sent = await notifyTechSupportOnCustomerMessage({ channelId: 1, senderId: CUSTOMER, content: 'first', messageId: 100 });
    expect(sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('DEBOUNCES: no email when the previous message was also from the customer', async () => {
    supportChannel();
    prisma.chat_messages.findFirst.mockResolvedValue({ sender_id: CUSTOMER }); // previous = customer
    const sent = await notifyTechSupportOnCustomerMessage({ channelId: 1, senderId: CUSTOMER, content: 'again', messageId: 102 });
    expect(sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('fails open (returns false, no throw) if a lookup errors', async () => {
    prisma.chat_channel.findUnique.mockRejectedValue(new Error('db down'));
    const sent = await notifyTechSupportOnCustomerMessage({ channelId: 1, senderId: CUSTOMER, content: 'x', messageId: 1 });
    expect(sent).toBe(false);
  });
});
