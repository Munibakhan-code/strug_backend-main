import { describe, it, expect } from 'vitest';
import { summarizeServices, overallStatus, STATUS_SERVICES } from '../../routes/status-routes.js';

const inc = (over = {}) => ({
    id: 1, service_id: 'video', title: 'Video processing degraded',
    severity: 'degraded', status: 'ongoing', summary: 'reconciliation sweep stale 50m',
    started_at: new Date('2026-06-21T20:00:00Z'), resolved_at: null, ...over,
});

describe('summarizeServices', () => {
    it('all operational when there are no ongoing incidents', () => {
        const out = summarizeServices(STATUS_SERVICES, []);
        expect(out.every((s) => s.status === 'operational')).toBe(true);
        expect(out.find((s) => s.id === 'video').incidents).toEqual([]);
    });

    it('marks the affected service with its incident severity, others stay operational', () => {
        const out = summarizeServices(STATUS_SERVICES, [inc()]);
        expect(out.find((s) => s.id === 'video').status).toBe('degraded');
        expect(out.find((s) => s.id === 'payments').status).toBe('operational');
    });

    it('takes the worst severity when a service has multiple ongoing incidents', () => {
        const out = summarizeServices(STATUS_SERVICES, [inc({ id: 1, severity: 'degraded' }), inc({ id: 2, severity: 'down' })]);
        expect(out.find((s) => s.id === 'video').status).toBe('down');
    });

    it('hides the internal summary from the public view', () => {
        const out = summarizeServices(STATUS_SERVICES, [inc()], { includeSummary: false });
        expect(out.find((s) => s.id === 'video').incidents[0]).not.toHaveProperty('summary');
    });

    it('includes the internal summary for the admin view', () => {
        const out = summarizeServices(STATUS_SERVICES, [inc()], { includeSummary: true });
        expect(out.find((s) => s.id === 'video').incidents[0].summary).toMatch(/reconciliation sweep stale/);
    });
});

describe('overallStatus', () => {
    it('is operational when everything is operational', () => {
        expect(overallStatus(summarizeServices(STATUS_SERVICES, []))).toBe('operational');
    });

    it('reflects the worst single service', () => {
        expect(overallStatus(summarizeServices(STATUS_SERVICES, [inc({ severity: 'degraded' })]))).toBe('degraded');
        expect(overallStatus(summarizeServices(STATUS_SERVICES, [inc({ severity: 'down' })]))).toBe('down');
    });
});
