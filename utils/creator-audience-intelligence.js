function finiteNumber(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shapeCreatorAudienceIntelligence(row = {}, sourceRows = []) {
  const starts = finiteNumber(row.starts);
  const audienceSize = finiteNumber(row.returning_viewers) + finiteNumber(row.new_viewers);
  const isSuppressed = Math.max(starts, audienceSize) < 5;
  return {
    funnel: [
      { label: 'Impressions', value: finiteNumber(row.impressions) },
      { label: 'Video starts', value: starts },
      { label: 'Meaningful watches', value: finiteNumber(row.meaningful_watches) },
      { label: 'Completed', value: finiteNumber(row.completed) },
      { label: 'Engaged', value: finiteNumber(row.engaged) },
    ],
    retention: !isSuppressed && Array.isArray(row.retention) ? row.retention.map(finiteNumber) : [],
    segments: isSuppressed ? [] : [
      { label: 'Returning viewers', value: finiteNumber(row.returning_viewers) },
      { label: 'New viewers', value: finiteNumber(row.new_viewers) },
      { label: 'Subscribers', value: finiteNumber(row.subscribers) },
      { label: 'Non-subscribers', value: finiteNumber(row.non_subscribers) },
    ],
    sources: isSuppressed ? [] : sourceRows.map(source => ({ label: source.label || 'Unknown', value: finiteNumber(source.value) })),
    privacy: { aggregated: true, identities_exposed: false, minimum_audience: 5, suppressed: isSuppressed },
  };
}

export const EMPTY_CREATOR_AUDIENCE_INTELLIGENCE = Object.freeze(
  shapeCreatorAudienceIntelligence(),
);
