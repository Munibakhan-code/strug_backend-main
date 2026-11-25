import 'dotenv/config';
import prisma from '../utils/prisma-client.js';
import { decrypt } from '../utils/crypto.js';
(async ()=>{
  try {
    const uid = 1;
    const profiles = await prisma.driver_profile.findMany({ where: { user_id: uid }, select: { driver_profile_id:true, user_id:true, is_online:true, last_ping:true }, orderBy: { driver_profile_id: 'asc' } });
    console.log('PROFILES:', JSON.stringify(profiles, null, 2));

        // include vehicle relation if present
        const vehicles = await prisma.driver_profile.findMany({ where: { user_id: uid }, include: { vehicle: true }, orderBy: { driver_profile_id: 'asc' } }).catch(()=>[]);
        console.log('VEHICLES_REL:', JSON.stringify(vehicles, null, 2));

    // check recent activity events for this user
    const events = await prisma.user_activity_event.findMany({ where: { user_id: uid, type: { in: ['auth.login','auth.login_failed'] } }, orderBy: { created_at: 'desc' }, take: 10 }).catch(()=>[]);
    console.log('RECENT_EVENTS:', JSON.stringify(events, null, 2));

    process.exit(0);
  } catch (e) {
    console.error('ERROR', e?.message || e);
    process.exit(2);
  } finally {
    try { await prisma.$disconnect(); } catch {}
  }
})();