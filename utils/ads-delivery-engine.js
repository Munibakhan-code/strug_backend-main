// utils/ads-delivery-engine.js
import prisma from './prisma-client.js';
import redis from './redis-client.js';
import crypto from 'crypto';

const EXCHANGE_RATES_BASE_USD = {
  USD: 1.0,
  LKR: parseFloat(process.env.AD_USD_TO_LKR_RATE || "300.0"),
  CAD: parseFloat(process.env.AD_USD_TO_CAD_RATE || "1.35")
};

export function convertCurrency(amount, from, to) {
  if (from === to) return amount;
  const rateFrom = EXCHANGE_RATES_BASE_USD[from] || 1.0;
  const rateTo = EXCHANGE_RATES_BASE_USD[to] || 1.0;
  const amountInUSD = amount / rateFrom;
  return amountInUSD * rateTo;
}

export async function checkLowBalanceAndNotify(userId, balance, currency) {
  try {
    const thresholdUSD = 5.00;
    const balanceUSD = convertCurrency(balance, currency, "USD");
    if (balanceUSD < thresholdUSD) {
      const user = await prisma.user.findUnique({
        where: { user_id: userId },
        select: { email: true, name: true, language: true }
      });
      if (user && user.email) {
        const { decrypt } = await import('./crypto.js');
        const plainEmail = decrypt(user.email);
        const mailerEvents = (await import('./mailer-event.js')).default;
        mailerEvents.emit('send_email', {
          templateName: 'ads-low-balance',
          variables: {
            name: user.name || 'Advertiser',
            balance: parseFloat(balance).toFixed(2),
            currency
          },
          to: plainEmail,
          subjectKey: 'emails.ads.low_balance_subject',
          user,
        });
      }
    }
  } catch (err) {
    console.error('[checkLowBalance] Notification error:', err.message);
  }
}

export async function enforceNegativeBalanceLock(tx, userId) {
  try {
    const wallet = await tx.ads_wallet.findUnique({
      where: { user_id: userId }
    });
    if (wallet && Number(wallet.balance) <= 0) {
      const campaigns = await tx.ads_campaign.findMany({
        where: { ads_wallet_id: wallet.ads_wallet_id, status: "ACTIVE" }
      });
      for (const campaign of campaigns) {
        await tx.ads_campaign.update({
          where: { campaign_id: campaign.campaign_id },
          data: { status: "OUT_OF_BUDGET" }
        });
        await redis.srem("ads:active:index", String(campaign.campaign_id));
      }
    }
  } catch (err) {
    console.error('[enforceLock] Balance lock failed:', err.message);
  }
}

export async function getOrCreateShadowPost(campaignId, advertiserId, title) {
  try {
    const profile = await prisma.social_profile.findUnique({
      where: { user_id: advertiserId }
    });
    if (!profile) return null;

    const marker = `[Campaign #${campaignId}]`;
    let post = await prisma.social_feed.findFirst({
      where: {
        profile_id: profile.profile_id,
        caption_text: { startsWith: marker }
      }
    });

    if (!post) {
      post = await prisma.social_feed.create({
        data: {
          profile_id: profile.profile_id,
          caption_text: `${marker} ${title}`,
          status: 'published'
        }
      });
    }

    return post.social_post_id;
  } catch (err) {
    console.error('[getShadowPost] Error:', err.message);
    return null;
  }
}

export async function syncCampaignToRedis(campaignId) {
  try {
    const campaign = await prisma.ads_campaign.findUnique({
      where: { campaign_id: campaignId },
      include: { ads_wallet: true }
    });

    if (!campaign) return false;

    const metaKey = `ads:campaign:${campaignId}:meta`;
    const walletKey = `ads:wallet:${campaign.ads_wallet.user_id}:balance`;

    await redis.hset(metaKey, {
      campaign_id: String(campaign.campaign_id),
      ads_wallet_id: String(campaign.ads_wallet_id),
      advertiser_id: String(campaign.ads_wallet.user_id),
      title: campaign.title,
      objective: campaign.objective,
      ad_type: campaign.ad_type,
      vertical: campaign.vertical,
      media_url: campaign.media_url,
      target_url: campaign.target_url || "",
      bid_type: campaign.bid_type,
      bid_amount: String(campaign.bid_amount),
      daily_budget: String(campaign.daily_budget),
      total_budget: String(campaign.total_budget),
      target_countries: JSON.stringify(campaign.target_countries),
      target_cities: JSON.stringify(campaign.target_cities),
      target_interests: JSON.stringify(campaign.target_interests),
      placements: JSON.stringify(campaign.placements || []),
      frequency_cap: String(campaign.frequency_cap || "3"),
      dayparting_schedule: JSON.stringify(campaign.dayparting_schedule || {}),
      pacing_mode: campaign.pacing_mode,
      currency: campaign.ads_wallet.currency
    });

    await redis.set(`ads:campaign:${campaignId}:spent_today`, String(campaign.spent_today));
    await redis.set(`ads:campaign:${campaignId}:total_spent`, String(campaign.total_spent));
    await redis.set(walletKey, String(campaign.ads_wallet.balance));

    if (campaign.status === "ACTIVE" && Number(campaign.ads_wallet.balance) > 0 && Number(campaign.spent_today) < Number(campaign.daily_budget)) {
      await redis.sadd("ads:active:index", String(campaignId));
    } else {
      await redis.srem("ads:active:index", String(campaignId));
    }

    return true;
  } catch (err) {
    console.error('[syncToRedis] Sync failed:', err.message);
    return false;
  }
}

export async function removeCampaignFromRedis(campaignId) {
  try {
    await redis.srem("ads:active:index", String(campaignId));
    await redis.del(`ads:campaign:${campaignId}:meta`);
    await redis.del(`ads:campaign:${campaignId}:spent_today`);
    await redis.del(`ads:campaign:${campaignId}:total_spent`);
    return true;
  } catch (err) {
    console.error('[removeRedis] Removal failed:', err.message);
    return false;
  }
}

export async function selectBestAd(userContext) {
  const { vertical, country, city, interests, profile_id } = userContext;
  const startTime = Date.now();

  try {
    const activeIds = await redis.smembers("ads:active:index");
    if (activeIds.length === 0) return null;

    const candidateAds = [];

    for (const id of activeIds) {
      // 11.9: Optimize selection query speeds, breaking immediately if exceeding 30ms limit
      if (Date.now() - startTime > 30) {
        console.warn(`⚠️ [Ad Engine] selectBestAd exceeded 30ms latency constraint. Aborting early.`);
        return null;
      }

      const meta = await redis.hgetall(`ads:campaign:${id}:meta`);
      if (!meta || Object.keys(meta).length === 0) continue;

      if (meta.vertical !== vertical) continue;

      const placements = JSON.parse(meta.placements || "[]") || [];
      if (Array.isArray(placements) && placements.length > 0 && !placements.includes(vertical)) continue;

      const countries = JSON.parse(meta.target_countries || "[]") || [];
      if (Array.isArray(countries) && countries.length > 0 && !countries.includes(country)) continue;

      const cities = JSON.parse(meta.target_cities || "[]") || [];
      if (Array.isArray(cities) && cities.length > 0 && !cities.includes(city)) continue;

      const schedule = JSON.parse(meta.dayparting_schedule || "{}") || {};
      if (Object.keys(schedule).length > 0) {
        const currentDay = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getDay()];
        if (schedule[currentDay] === false) continue;
      }

      const dailyBudget = parseFloat(meta.daily_budget);
      const spentToday = parseFloat(await redis.get(`ads:campaign:${id}:spent_today`) || "0");
      const currentHour = new Date().getHours();
      const hourlyCap = (dailyBudget / 24) * (currentHour + 1);

      if (meta.pacing_mode === "STANDARD" && spentToday >= hourlyCap) continue;
      if (spentToday >= dailyBudget) continue;

      if (profile_id) {
        const frequencyKey = `ads:campaign:${id}:user:${profile_id}:impressions`;
        const userImpressions = parseInt(await redis.get(frequencyKey) || "0");
        if (userImpressions >= parseInt(meta.frequency_cap || "3")) continue;
      }

      let relevancy = 1.0;
      const targetInterests = JSON.parse(meta.target_interests || "[]") || [];
      if (interests && Array.isArray(targetInterests) && targetInterests.length > 0) {
        const matches = targetInterests.filter(i => interests.includes(i)).length;
        relevancy += (matches * 0.5);
      }

      candidateAds.push({
        campaign_id: Number(id),
        title: meta.title,
        ad_type: meta.ad_type,
        vertical: meta.vertical,
        media_url: meta.media_url,
        target_url: meta.target_url,
        headline: meta.headline,
        description: meta.description,
        cta_text: meta.cta_text,
        aspect_ratio: meta.aspect_ratio,
        bid_type: meta.bid_type,
        bid_amount: parseFloat(meta.bid_amount),
        ads_wallet_id: Number(meta.ads_wallet_id),
        advertiser_id: Number(meta.advertiser_id),
        currency: meta.currency,
        score: parseFloat(meta.bid_amount) * relevancy
      });
    }

    if (candidateAds.length === 0) return null;
    candidateAds.sort((a, b) => b.score - a.score);

    return candidateAds[0];
  } catch (err) {
    console.error('[selectBestAd] Error:', err.message);
    return null;
  }
}

export async function trackAdEvent(campaignId, eventType, profileId, ipAddress, io) {
  try {
    const metaKey = `ads:campaign:${campaignId}:meta`;
    const meta = await redis.hgetall(metaKey);
    if (!meta || Object.keys(meta).length === 0) return false;

    const advertiserId = Number(meta.advertiser_id);
    const walletKey = `ads:wallet:${advertiserId}:balance`;

    // 11.5: Anti-Fraud Window check to block rapid click-bots
    if (profileId) {
      const fraudKey = `ads:fraud:${campaignId}:${profileId}:${eventType}`;
      const isFraud = await redis.get(fraudKey);
      if (isFraud) {
          console.warn(`🛑 [Ad Engine] Fraud detected from Profile #${profileId}. Event blocked.`);
          return false;
      }
      await redis.set(fraudKey, "true", "EX", 600); // 10 minutes lock
    } else if (ipAddress) {
      const fraudKey = `ads:fraud:${campaignId}:${ipAddress}:${eventType}`;
      const isFraud = await redis.get(fraudKey);
      if (isFraud) {
          console.warn(`🛑 [Ad Engine] Fraud detected from IP ${ipAddress}. Event blocked.`);
          return false;
      }
      await redis.set(fraudKey, "true", "EX", 600);
    }

    let costUSD = 0.0;
    const bidAmount = parseFloat(meta.bid_amount);

    if (eventType === "click" && meta.bid_type === "CPC") {
      costUSD = convertCurrency(bidAmount, meta.currency, "USD");
    } else if (eventType === "impression" && (meta.bid_type === "CPM" || meta.bid_type === "CPV")) {
      costUSD = convertCurrency(bidAmount / 1000, meta.currency, "USD");
    }

    if (costUSD <= 0) return false;

    const costLocal = convertCurrency(costUSD, "USD", meta.currency);
    const adsWalletBalance = parseFloat(await redis.get(walletKey) || "0");
    const spentToday = parseFloat(await redis.get(`ads:campaign:${campaignId}:spent_today`) || "0");
    const totalSpent = parseFloat(await redis.get(`ads:campaign:${campaignId}:total_spent`) || "0");

    const newWalletBalance = adsWalletBalance - costLocal;
    const newSpentToday = spentToday + costLocal;
    const newTotalSpent = totalSpent + costLocal;

    if (profileId && eventType === "impression") {
      const frequencyKey = `ads:campaign:${campaignId}:user:${profileId}:impressions`;
      await redis.incr(frequencyKey);
      await redis.expire(frequencyKey, 86400);
    }

    let statusUpdate = null;
    const budgetOverdraftThreshold = parseFloat(meta.daily_budget) * 0.95;
    if (newWalletBalance <= 0) {
      statusUpdate = "OUT_OF_BUDGET";
    } else if (newSpentToday >= budgetOverdraftThreshold) {
      statusUpdate = "OUT_OF_BUDGET";
    } else if (parseFloat(meta.total_budget) > 0 && newTotalSpent >= parseFloat(meta.total_budget)) {
      statusUpdate = "COMPLETED";
    }

    // 11.1 & 11.2: Atomic database write transaction preventing Lost Update concurrency bugs
    let transactionSuccess = false;
    await prisma.$transaction(async (tx) => {
      // Pessimistic locking of the wallet row inside PostgreSQL
      await tx.$executeRaw`SELECT * FROM "ads_wallet" WHERE "user_id" = ${advertiserId} FOR UPDATE`;

      const wallet = await tx.ads_wallet.findUnique({
        where: { user_id: advertiserId }
      });

      if (!wallet || Number(wallet.balance) < costLocal) {
        throw new Error("INSUFFICIENT_FUNDS_IN_LEDGER");
      }

      // 11.3: Revenue sharing split calculations
      const creatorRatio = parseFloat(process.env.AD_CREATOR_SHARE_RATIO || "0.70");
      const isVideoVertical = meta.vertical === 'video';
      
      const creatorShare = isVideoVertical ? costLocal * creatorRatio : 0;
      const platformShare = isVideoVertical ? costLocal * (1 - creatorRatio) : costLocal;

      const receiptPayload = {
        advertiser_id: advertiserId,
        campaign_id: Number(campaignId),
        amount_deducted: costLocal,
        created_at: new Date()
      };
      const ledgerHash = crypto.createHash("sha256").update(JSON.stringify(receiptPayload)).digest("hex");

      // Atomically decrement wallet balance on database level
      await tx.ads_wallet.update({
        where: { user_id: advertiserId },
        data: { balance: { decrement: costLocal } }
      });

      await tx.ads_campaign.update({
        where: { campaign_id: Number(campaignId) },
        data: {
          spent_today: { increment: costLocal },
          total_spent: { increment: costLocal },
          status: statusUpdate || undefined
        }
      });

      // 11.10: Record historical impressions to build CTR metrics
      await tx.ad_impressions.create({
        data: {
          ad_id: Number(campaignId),
          viewer_id: profileId ? Number(profileId) : 0,
          event_type: eventType,
          revenue_generated: costLocal
        }
      });

      // 11.4: Write SHA-256 secure ledger logs to wallet transaction table
      await tx.wallet_transaction.create({
        data: {
          user_id: advertiserId,
          amount: -costLocal,
          type: "debit",
          source: "ad_campaign",
          status: "completed",
          description: `Debit for Campaign #${campaignId}. Ledger Hash: ${ledgerHash}`
        }
      });

      if (isVideoVertical && creatorShare > 0) {
        const video = await tx.video.findFirst({
          where: { video_id: Number(campaignId) },
          include: { channel: true }
        }).catch(() => null);

        if (video?.channel?.user_id) {
          await tx.$executeRaw`SELECT * FROM "strug_wallet" WHERE "user_id" = ${video.channel.user_id} FOR UPDATE`;
          await tx.strug_wallet.update({
            where: { user_id: video.channel.user_id },
            data: { balance: { increment: creatorShare } }
          });

          await tx.wallet_transaction.create({
            data: {
              user_id: video.channel.user_id,
              amount: creatorShare,
              type: "credit",
              source: "ad_revenue",
              status: "completed",
              description: `Live video creator payout share (70%). Ledger Hash: ${ledgerHash}`
            }
          });
        }
      }

      transactionSuccess = true;
    }, { timeout: 30000 }).catch(err => {
      console.error("❌ [LEDGER TRANSACTION ROLLBACK]:", err.message);
      transactionSuccess = false;
    });

    if (!transactionSuccess) {
      return false; // Free ad bypass blocked. Event aborted on failure.
    }

    // Update Redis cache states on successful transaction
    await redis.set(walletKey, String(newWalletBalance));
    await redis.set(`ads:campaign:${campaignId}:spent_today`, String(newSpentToday));
    await redis.set(`ads:campaign:${campaignId}:total_spent`, String(newTotalSpent));

    if (statusUpdate) {
      await redis.srem("ads:active:index", String(campaignId));
      io?.emit(`ad-status-kill-${campaignId}`, { campaign_id: campaignId, status: statusUpdate });
    }

    await checkLowBalanceAndNotify(advertiserId, newWalletBalance, meta.currency);

    return true;
  } catch (err) {
    console.error('[trackAdEvent] Error:', err.message);
    return false;
  }
}

export async function resetDailyBudgetCron(io) {
  try {
    const expiredCampaigns = await prisma.ads_campaign.findMany({
      where: { status: "OUT_OF_BUDGET" },
      include: { ads_wallet: true }
    });

    for (const campaign of expiredCampaigns) {
      if (Number(campaign.ads_wallet.balance) > 0) {
        await prisma.ads_campaign.update({
          where: { campaign_id: campaign.campaign_id },
          data: { spent_today: 0.00, status: "ACTIVE" }
        });
        await syncCampaignToRedis(campaign.campaign_id);
        io?.emit(`ad-status-restore-${campaign.campaign_id}`, { campaign_id: campaign.campaign_id, status: "ACTIVE" });
      }
    }
  } catch (err) {
    console.error('[resetCron] Failed:', err.message);
  }
}

export async function dbRedisConsistencyHeartbeat() {
  try {
    const activeCampaigns = await prisma.ads_campaign.findMany({
      where: { status: "ACTIVE" }
    });

    const redisActiveIds = await redis.smembers("ads:active:index");
    const dbActiveIds = activeCampaigns.map(c => String(c.campaign_id));

    for (const id of dbActiveIds) {
      if (!redisActiveIds.includes(id)) {
        await syncCampaignToRedis(Number(id));
      }
    }

    for (const id of redisActiveIds) {
      if (!dbActiveIds.includes(id)) {
        await redis.srem("ads:active:index", id);
      }
    }
  } catch (err) {
    console.error('[heartbeat] DB-Redis discrepancy found:', err.message);
  }
}