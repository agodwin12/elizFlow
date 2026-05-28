import admin from 'firebase-admin';
import path from 'path';

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(
            path.join(process.cwd(), 'firebase-service-account.json')
        ),
    });
}

export default admin;