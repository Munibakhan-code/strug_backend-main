import prisma from '../utils/prisma-client.js';
import { getPersonalizedFeed } from '../services/townhall-recommender.js';

async function runDiagnostics() {
    try {
        console.log('Running Production Recommender Diagnostic...');
        const user = await prisma.user.findFirst({ select: { user_id: true } });
        if (!user) {
            console.error('No users found in database to test.');
            process.exit(1);
        }
        console.log('Testing recommender for User ID:', user.user_id);
        const ids = await getPersonalizedFeed(user.user_id, 20);
        console.log('Success! Personalized Feed IDs returned:', ids);
        process.exit(0);
    } catch (err) {
        console.error('DIAGNOSTIC FAILED WITH ERROR:', err);
        process.exit(1);
    }
}

runDiagnostics();
