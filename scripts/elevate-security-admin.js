import 'dotenv/config';
import prisma from '../utils/prisma-client.js';
import { emailSearchCiphertexts, normalizeEmail } from '../utils/crypto.js';

async function main() {
    const targetEmail = process.argv[2];

    if (!targetEmail || !targetEmail.includes('@')) {
        console.error('Error: Please provide a valid registered email address.');
        console.log('Usage: node scripts/elevate-security-admin.js <email>');
        process.exit(1);
    }

    const normalized = normalizeEmail(targetEmail);
    const searchKeys = emailSearchCiphertexts(normalized);

    console.log(`[AUTH-ELEVATION] Locating user account: ${normalized}...`);

    const user = await prisma.user.findFirst({
        where: { email: { in: searchKeys } },
        select: {
            user_id: true,
            name: true,
            username: true,
            email: true,
            account_status: true,
            security_admin: true,
        },
    });

    if (!user) {
        console.error(`Error: User with email ${normalized} was not found in the platform database.`);
        process.exit(1);
    }

    if (user.account_status !== 'active') {
        console.error(`Error: User #${user.user_id} account status is '${user.account_status}'. Inactive accounts cannot be elevated.`);
        process.exit(1);
    }

    await prisma.user.update({
        where: { user_id: user.user_id },
        data: { security_admin: true },
    });

    console.log('-------------------------------------------------------------');
    console.log(`SUCCESS: User #${user.user_id} (${normalized}) elevated to Security Admin.`);
    console.log('Flag: user.security_admin = true');
    console.log('-------------------------------------------------------------');
}

main()
    .catch((err) => {
        console.error('Elevation Failure:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
