/**
 * Smoke-test Event Concierge end-to-end against local DB (no HTTP auth).
 * Run: node scripts/smoke-event-concierge.js
 */
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();
const token = () => crypto.randomBytes(16).toString('hex');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const owner = await prisma.user.findFirst({ orderBy: { user_id: 'asc' } });
  assert(owner, 'No user in DB — seed a user first');
  const contributor = await prisma.user.findFirst({
    where: { user_id: { not: owner.user_id } },
    orderBy: { user_id: 'asc' },
  });

  console.log(`Owner #${owner.user_id}, contributor #${contributor?.user_id ?? 'n/a'}`);

  const share = token();
  const invite = token();

  const plan = await prisma.event_plan.create({
    data: {
      owner_id: owner.user_id,
      title: 'Smoke Wedding',
      occasion: 'wedding',
      event_date: new Date('2026-09-20'),
      guests: 80,
      budget: 8000,
      city: 'Toronto',
      vibe: 'garden',
      invite_theme: 'elegant',
      invite_message: 'Join us!',
      share_token: share,
      needs: {
        create: [
          { category: 'venue', title: 'Venue', linked_nav: 'venues', sort_order: 0 },
          { category: 'cake', title: 'Cake', linked_nav: 'catering', sort_order: 1 },
          { category: 'flowers', title: 'Flowers', linked_nav: 'floral', sort_order: 2 },
          { category: 'dress', title: 'Dress / attire', linked_nav: 'wedding', sort_order: 3 },
          { category: 'rental', title: 'Rentals', linked_nav: 'equipment', sort_order: 4 },
          { category: 'staff', title: 'Staff', linked_nav: 'ondemand', sort_order: 5 },
          { category: 'photographer', title: 'Photographer', linked_nav: 'artists', sort_order: 6 },
          { category: 'videographer', title: 'Videographer', linked_nav: 'artists', sort_order: 7 },
          { category: 'gifts', title: 'Gift registry', linked_nav: 'registry', sort_order: 8 },
        ],
      },
      guest_list: {
        create: [{ name: 'Guest One', email: 'guest@example.com', invite_token: invite, status: 'invited' }],
      },
      registry_items: {
        create: [
          { title: 'Honeymoon fund', description: 'Pitch in', price: 100, status: 'active' },
          { title: 'Cake fund', description: 'Help with the cake', price: 50, status: 'active' },
        ],
      },
    },
    include: { needs: true, guest_list: true, registry_items: true },
  });

  assert(plan.needs.length === 9, `expected 9 needs, got ${plan.needs.length}`);
  assert(plan.guest_list.length === 1, 'guest missing');
  assert(plan.registry_items.length === 2, 'registry missing');

  const alfredCats = ['venue', 'cake', 'flowers', 'dress', 'rental', 'staff', 'photographer', 'videographer', 'gifts'];
  for (const c of alfredCats) {
    assert(plan.needs.some((n) => n.category === c), `missing Alfred need: ${c}`);
  }

  // RSVP via same fields the public API writes
  const guest = await prisma.event_guest.update({
    where: { invite_token: invite },
    data: { status: 'accepted', plus_ones: 1, rsvp_note: 'Excited!', responded_at: new Date() },
  });
  assert(guest.status === 'accepted', 'rsvp failed');

  // Wallet contribute path (if second user + wallet exist)
  let walletBefore = null;
  if (contributor) {
    const w = await prisma.strug_wallet.upsert({
      where: { user_id: contributor.user_id },
      create: { user_id: contributor.user_id, balance: 200, currency: 'CAD', status: 'active' },
      update: { balance: 200, status: 'active' },
    });
    walletBefore = Number(w.balance);
    const item = plan.registry_items[0];
    await prisma.$transaction(async (tx) => {
      await tx.strug_wallet.update({
        where: { user_id: contributor.user_id },
        data: { balance: { decrement: 25 } },
      });
      await tx.event_registry_contribution.create({
        data: {
          registry_item_id: item.registry_item_id,
          contributor_id: contributor.user_id,
          amount: 25,
          status: 'completed',
          note: 'Congrats',
        },
      });
    });
    const contribs = await prisma.event_registry_contribution.count({
      where: { registry_item_id: item.registry_item_id },
    });
    assert(contribs === 1, 'contribution missing');
  }

  // Public invite shape check via HTTP
  const res = await fetch(`http://localhost:5000/event-concierge/invite/${invite}`);
  const body = await res.json();
  assert(res.status === 200, `invite HTTP ${res.status}`);
  assert(body.guest?.name === 'Guest One', 'invite guest name');
  assert(body.event?.title === 'Smoke Wedding', 'invite event title');
  assert(Array.isArray(body.registry_items) && body.registry_items.length >= 2, 'invite registry');
  // Public shape must not leak contributor_id
  const pubContrib = body.registry_items.flatMap((i) => i.recent_contributors || []);
  assert(pubContrib.every((c) => c.contributor_id == null), 'public contributor_id leaked');

  const rsvpRes = await fetch(`http://localhost:5000/event-concierge/invite/${invite}/rsvp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'maybe', plus_ones: 0, rsvp_note: 'Traffic concerns' }),
  });
  assert(rsvpRes.status === 200, `rsvp HTTP ${rsvpRes.status}`);
  const rsvpBody = await rsvpRes.json();
  assert(rsvpBody.email == null && rsvpBody.phone == null, 'RSVP must not leak PII');

  const shareRes = await fetch(`http://localhost:5000/event-concierge/share/${share}`);
  assert(shareRes.status === 200, `share HTTP ${shareRes.status}`);

  // Cleanup — restore wallet + delete plan
  if (contributor && walletBefore != null) {
    await prisma.strug_wallet.update({
      where: { user_id: contributor.user_id },
      data: { balance: walletBefore },
    }).catch(() => {});
  }
  await prisma.event_plan.delete({ where: { event_plan_id: plan.event_plan_id } });

  console.log('OK — Event Concierge flow aligned:');
  console.log('  checklist (Alfred wedding needs) ✓');
  console.log('  invitations + RSVP ✓');
  console.log('  contribution registry ✓');
  console.log('  public invite + share pages ✓');
}

main()
  .catch((e) => {
    console.error('FAIL', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
