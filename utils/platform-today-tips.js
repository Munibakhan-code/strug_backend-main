/**
 * Build "Did You Know?" tips from live platform stats.
 * Keeps tip copy on the server so the profile page is not a FE mock list.
 */

function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}

/**
 * @param {{ active_sellers?: number, orders_today?: number, live_streams?: number, videos_watched_today?: number }} stats
 * @returns {{ color: string, text: string }[]}
 */
export function buildPlatformTips(stats = {}) {
  const sellers = Number(stats.active_sellers) || 0;
  const orders = Number(stats.orders_today) || 0;
  const live = Number(stats.live_streams) || 0;
  const watched = Number(stats.videos_watched_today) || 0;

  const tips = [
    {
      color: '#2563eb',
      text: sellers > 0
        ? sellers === 1
          ? '1 seller has listings on Strug right now.'
          : `${formatCount(sellers)} sellers have listings on Strug right now.`
        : 'Strug shop listings are powered by real sellers across the platform.',
    },
    {
      color: '#f59e0b',
      text: orders > 0
        ? orders === 1
          ? '1 paid order was placed on Strug today.'
          : `${formatCount(orders)} paid orders were placed on Strug today.`
        : 'Orders placed on Strug update live — check back as the day goes on.',
    },
    {
      color: '#ef4444',
      text: live > 0
        ? `${formatCount(live)} creator${live === 1 ? ' is' : 's are'} live right now. Jump into Live to watch.`
        : 'When creators go live, they show up here instantly from the Live vertical.',
    },
    {
      color: '#8b5cf6',
      text: watched > 0
        ? `Viewers watched ${formatCount(watched)} video${watched === 1 ? '' : 's'} on Strug today.`
        : 'Video views across Strug are counted as people watch — yours included.',
    },
    {
      color: '#10b981',
      text: 'Earn rewards with your referral code every time a friend joins Strug.',
    },
  ];

  return tips;
}
