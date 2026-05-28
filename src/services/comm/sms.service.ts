import axios from 'axios';

// ═══════════════════════════════════════════════════════════════
// TECHSOFT SMS CONFIG
// ═══════════════════════════════════════════════════════════════

const SMS_API_URL =
    process.env.TECHSOFT_SMS_URL ||
    'https://app.techsoft-sms.com/api/http/sms/send/';

const SMS_API_TOKEN = process.env.TECHSOFT_API_TOKEN;

const SMS_SENDER_ID = process.env.TECHSOFT_SENDER_ID || 'DEPOTFLOW';

const SMS_TIMEOUT = parseInt(process.env.TECHSOFT_SMS_TIMEOUT || '15000', 10);

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function required(name: string, value: string | undefined): string {
    if (!value) {
        const err: any = new Error(`[SMS] Missing ${name} in environment`);
        err.code = 'SMS_CONFIG_MISSING';
        err.status = 500;
        throw err;
    }
    return value;
}

function normalizeRecipient(phone: string): string {
    if (!phone) return '';
    return String(phone).trim().replace(/\s+/g, '').replace(/^\+/, '');
}

function maskToken(token: string): string {
    if (!token) return 'N/A';
    if (token.length <= 10) return '********';
    return `${token.substring(0, 6)}...${token.substring(token.length - 4)}`;
}

// ═══════════════════════════════════════════════════════════════
// INIT / HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

export async function initSms(): Promise<boolean> {
    console.log('\n================= INITIALIZING TECHSOFT SMS =================');
    required('TECHSOFT_API_TOKEN', SMS_API_TOKEN);
    console.log(`[SMS] Provider   : Techsoft`);
    console.log(`[SMS] API URL    : ${SMS_API_URL}`);
    console.log(`[SMS] Sender ID  : ${SMS_SENDER_ID}`);
    console.log(`[SMS] API Token  : ${maskToken(SMS_API_TOKEN!)}`);
    console.log(`[SMS] Timeout    : ${SMS_TIMEOUT}ms`);
    console.log('=============================================================\n');
    return true;
}

// ═══════════════════════════════════════════════════════════════
// SEND GENERIC SMS
// ═══════════════════════════════════════════════════════════════

export async function sendSms(to: string, message: string): Promise<{
    success: boolean;
    provider: string;
    status: number;
    data: any;
}> {
    const apiToken = required('TECHSOFT_API_TOKEN', SMS_API_TOKEN);
    const recipient = normalizeRecipient(to);

    if (!recipient) {
        const err: any = new Error('SMS recipient is required');
        err.code = 'SMS_RECIPIENT_REQUIRED';
        err.status = 400;
        throw err;
    }

    if (!message) {
        const err: any = new Error('SMS message body is required');
        err.code = 'SMS_MESSAGE_REQUIRED';
        err.status = 400;
        throw err;
    }

    const payload = {
        api_token: apiToken,
        recipient,
        sender_id: SMS_SENDER_ID,
        type: 'plain',
        message,
    };

    console.log('\n================= SENDING SMS VIA TECHSOFT =================');
    console.log(`[SMS] Recipient  : ${recipient}`);
    console.log(`[SMS] Sender ID  : ${SMS_SENDER_ID}`);
    console.log(`[SMS] Message    : ${message}`);
    console.log('============================================================');

    try {
        const startedAt = Date.now();

        const response = await axios.post(SMS_API_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            timeout: SMS_TIMEOUT,
            validateStatus: () => true,
        });

        const duration = Date.now() - startedAt;
        console.log(`[SMS] Response in ${duration}ms — HTTP ${response.status}`);
        console.log(`[SMS] Body: ${JSON.stringify(response.data)}`);

        if (response.status >= 200 && response.status < 300) {
            console.log('[SMS] ✅ Sent successfully');
            return {
                success: true,
                provider: 'TECHSOFT',
                status: response.status,
                data: response.data,
            };
        }

        const err: any = new Error(
            response.data?.message ||
            response.data?.error ||
            `Techsoft SMS failed with status ${response.status}`
        );
        err.code = 'SMS_SEND_FAILED';
        err.status = 503;
        err.providerStatus = response.status;
        err.providerResponse = response.data;
        throw err;

    } catch (err: any) {
        console.error('[SMS] ❌ Failed to send SMS');
        console.error('[SMS] Error:', err.message);

        if (!err.status) err.status = 503;
        if (!err.code || err.code === 'ERR_BAD_REQUEST') err.code = 'SMS_SEND_FAILED';
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// SEND OTP
// ═══════════════════════════════════════════════════════════════

export async function sendSmsOtp(to: string, code: string): Promise<{
    success: boolean;
    provider: string;
    status: number;
    data: any;
}> {
    const ttl = process.env.OTP_TTL_MIN || '10';
    const message = `DepotFlow code: ${code}. Expires in ${ttl} minutes. Do not share this code.`;
    return sendSms(to, message);
}

// ═══════════════════════════════════════════════════════════════
// SEND NOTIFICATION
// ═══════════════════════════════════════════════════════════════

export async function sendSmsNotification(to: string, message: string): Promise<{
    success: boolean;
    provider: string;
    status: number;
    data: any;
}> {
    return sendSms(to, message);
}