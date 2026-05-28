import admin from './firebase';

interface NotificationPayload {
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
}

export const sendNotification = async ({
                                           token,
                                           title,
                                           body,
                                           data,
                                       }: NotificationPayload): Promise<void> => {
    try {
        await admin.messaging().send({
            token,
            notification: { title, body },
            data: data || {},
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                },
            },
        });
        console.log(`✅ Notification sent: ${title}`);
    } catch (error) {
        console.error('❌ Notification error:', error);
    }
};

export const sendToMultipleTokens = async (
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>
): Promise<void> => {
    if (tokens.length === 0) return;

    try {
        const response = await admin.messaging().sendEachForMulticast({
            tokens,
            notification: { title, body },
            data: data || {},
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                },
            },
        });
        console.log(
            `✅ Sent: ${response.successCount}, Failed: ${response.failureCount}`
        );
    } catch (error) {
        console.error('❌ Multicast error:', error);
    }
};