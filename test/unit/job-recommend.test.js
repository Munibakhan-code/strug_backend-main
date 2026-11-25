/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  parseSkills,
  locationsMatch,
  buildRecommendSignals,
  hasRecommendSignals,
  scoreJobForCandidate,
  rankRecommendedJobs,
} from '../../utils/job-recommend.js';

describe('job-recommend', () => {
  it('parses skills and matches locations loosely', () => {
    expect(parseSkills('React, Node.js; TypeScript')).toEqual(['react', 'node.js', 'typescript']);
    expect(locationsMatch('Toronto, ON', 'Downtown Toronto')).toBe(true);
    expect(locationsMatch('Toronto', 'Vancouver')).toBe(false);
  });

  it('boosts skill, location, salary, and recent-app affinity', () => {
    const signals = buildRecommendSignals({
      candidate: {
        skills: 'React, Node',
        location: 'Toronto',
        desired_salary: 100000,
      },
      recentJobs: [{ job_id: 1, job_name: 'Frontend Engineer', job_category_id: 5 }],
    });
    expect(signals.appliedJobIds.has(1)).toBe(true);

    const fit = scoreJobForCandidate({
      job_id: 2,
      job_name: 'React Engineer',
      description: 'Node services',
      location: 'Toronto, ON',
      job_category_id: 5,
      salary_min: 90000,
      salary_max: 120000,
      posted_date: new Date(),
    }, signals);
    const miss = scoreJobForCandidate({
      job_id: 3,
      job_name: 'Warehouse Associate',
      description: 'Lifting',
      location: 'Calgary',
      job_category_id: 9,
      salary_min: 35000,
      salary_max: 40000,
    }, signals);
    expect(fit).toBeGreaterThan(miss);
  });

  it('excludes applied and ads; ranks by score then recency', () => {
    const signals = buildRecommendSignals({
      candidate: { skills: 'python', location: 'Remote-friendly city' },
      recentJobs: [{ job_id: 10, job_name: 'Python Dev', job_category_id: 1 }],
    });
    const ranked = rankRecommendedJobs([
      { job_id: 10, job_name: 'Python Dev', description: 'python', location: 'Toronto' },
      { job_id: 11, job_name: 'Python Backend', description: 'python django', location: 'Toronto', posted_date: '2026-08-01' },
      { job_id: 12, job_name: 'Chef', description: 'kitchen', location: 'Montreal', posted_date: '2026-08-08' },
      { job_id: 13, job_name: 'Ad', is_ad: true, description: 'python' },
    ], signals, { limit: 5 });
    expect(ranked.map((j) => j.job_id)).not.toContain(10);
    expect(ranked.map((j) => j.job_id)).not.toContain(13);
    expect(ranked[0].job_id).toBe(11);
  });
  it('reports no usable signals for an empty candidate, so the rail can hide', () => {
    expect(hasRecommendSignals(buildRecommendSignals({}))).toBe(false);
    expect(hasRecommendSignals(buildRecommendSignals({ candidate: {} }))).toBe(false);
    expect(hasRecommendSignals(buildRecommendSignals({ candidate: { skills: '' }, recentJobs: [] }))).toBe(false);
  });

  it('reports usable signals from any one of skills, location, salary or history', () => {
    expect(hasRecommendSignals(buildRecommendSignals({ candidate: { skills: 'react' } }))).toBe(true);
    expect(hasRecommendSignals(buildRecommendSignals({ candidate: { location: 'Toronto' } }))).toBe(true);
    expect(hasRecommendSignals(buildRecommendSignals({ candidate: { desired_salary: 90000 } }))).toBe(true);
    expect(hasRecommendSignals(buildRecommendSignals({
      recentJobs: [{ job_id: 4, job_name: 'Backend Engineer', job_category_id: 2 }],
    }))).toBe(true);
  });
});
