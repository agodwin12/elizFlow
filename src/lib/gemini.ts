import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export const geminiModel = genAI.getGenerativeModel({
    model: "gemini-2.5-flash"
});

// ── Retry wrapper for transient errors ────────────────────────
export async function generateWithRetry(
    prompt: string,
    maxRetries = 3,
    delayMs = 2000
): Promise<string> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🤖 Gemini attempt ${attempt}/${maxRetries}...`);
            const result = await geminiModel.generateContent(prompt);
            return result.response.text();
        } catch (error: any) {
            const isRetryable =
                error.status === 503 ||
                error.status === 429 ||
                error.status === 500;

            console.error(
                `❌ Gemini attempt ${attempt} failed (${error.status}): ${error.message}`
            );

            if (!isRetryable || attempt === maxRetries) {
                throw error;
            }

            const wait = delayMs * attempt;
            console.log(`⏳ Retrying in ${wait}ms...`);
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
    }
    throw new Error("Max retries exceeded");
}