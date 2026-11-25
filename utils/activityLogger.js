export async function logActivity({ team_id, member_id, client_id, subject, type, prismaInstance }) {
    try {
        await prismaInstance.activity.create({
            data: {
                // `Number(undefined)` is NaN, which is not nullish — so `Number(x) ?? null`
                // never yielded null and handed Prisma NaN for these Int columns. Coerce only
                // when a value is actually present.
                team_id: team_id == null ? null : Number(team_id),
                member_id: member_id == null ? null : Number(member_id),
                client_id: client_id == null ? null : Number(client_id),
                subject,
                type,
                date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
                time: new Date().toISOString().split('T')[1].split('.')[0], // HH:MM:SS
            },
        });
    } catch (err) {
        console.error('Failed to log activity:', err);
    }
};