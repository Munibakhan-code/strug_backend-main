// utils/recommendation-cron.js
// Background "continuous learning" for the recommendation engine:
//   • every 15 min — recompute interest vectors for recently-active users
//   • every 30 min — recompute the rolling trending-token set
// Mirrors the node-cron pattern used elsewhere (see cron-jobs.js).
import { refreshActiveInterestProfiles, refreshTrendingTopics } from './recommendation-engine.js';
import { logCronError } from './cron-email.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleCron } from './cron-lock.js';

export function initRecommendationCron() {
  // Interest profiles — keep "for you" learning from fresh engagement.
  scheduleCron('reco-interest-profiles', '*/15 * * * *', async () => {
    try {
      const r = await refreshActiveInterestProfiles({ sinceMinutes: 20 });
      if (r.candidates > 0) console.log(`🧠 [Cron Reco] interest profiles refreshed: ${r.refreshed}/${r.candidates}`);
    } catch (err) {
      logCronError('reco-interest-profiles', err);
    }
  });

  // Trending tokens — used to boost "trending within the user's interests".
  scheduleCron('reco-trending-tokens', '*/30 * * * *', async () => {
    try {
      const r = await refreshTrendingTopics({ windowDays: 3 });
      console.log(`🔥 [Cron Reco] trending tokens computed: ${r.tokens}`);
    } catch (err) {
      logCronError('reco-trending-tokens', err);
    }
  });

  // Warm the trending set shortly after boot so the first "for you" calls aren't cold.
  setTimeout(() => {
    refreshTrendingTopics({ windowDays: 3 })
      .then(r => console.log(`🔥 [Reco] initial trending tokens: ${r.tokens}`))
      .catch(() => {});
  }, 20000);

  console.log('🧠 Recommendation engine cron initialized.');
}
