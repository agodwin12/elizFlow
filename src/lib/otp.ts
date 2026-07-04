import bcrypt from "bcrypt";
import { prisma } from "./prisma";

const OTP_TTL_MIN = parseInt(process.env.OTP_TTL_MIN || "10", 10);
const MAX_ATTEMPTS = 5;

/** Generate a numeric OTP of the given length (default 6). */
export function generateOtp(length = 6): string {
    let code = "";
    for (let i = 0; i < length; i++) {
        // Not cryptographically strong, but adequate for SMS OTP + attempt limits.
        code += Math.floor(Math.random() * 10).toString();
    }
    return code;
}

/** Create & persist a hashed OTP for a phone/purpose, invalidating old ones. */
export async function issueOtp(
    phone: string,
    purpose = "PASSWORD_RESET"
): Promise<string> {
    const code = generateOtp(6);
    const codeHash = await bcrypt.hash(code, 8);
    const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

    // Consume any still-active codes for this phone/purpose.
    await prisma.otpCode.updateMany({
        where: { phone, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
    });

    await prisma.otpCode.create({
        data: { phone, purpose, codeHash, expiresAt },
    });

    return code;
}

/**
 * Verify a submitted OTP. Returns true on success and consumes the code.
 * Enforces expiry and a max-attempt count to resist brute force.
 */
export async function verifyOtp(
    phone: string,
    code: string,
    purpose = "PASSWORD_RESET"
): Promise<boolean> {
    const record = await prisma.otpCode.findFirst({
        where: { phone, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
    });

    if (!record) return false;
    if (record.attempts >= MAX_ATTEMPTS) return false;

    const ok = await bcrypt.compare(String(code), record.codeHash);

    if (!ok) {
        await prisma.otpCode.update({
            where: { id: record.id },
            data: { attempts: { increment: 1 } },
        });
        return false;
    }

    await prisma.otpCode.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
    });
    return true;
}

export function isSmsConfigured(): boolean {
    return !!process.env.TECHSOFT_API_TOKEN;
}
