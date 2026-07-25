import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import config from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

export const api_key_one = process.env.GROQ_API_KEY_ONE || "";
export const api_key_two = process.env.GROQ_API_KEY_TWO || process.env.GROQ_API_KEY || "";
export const api_key_three = process.env.GROQ_API_KEY_THREE || "";
export const api_key_four = process.env.GROQ_API_KEY_FOUR || "";
export const api_key_five = process.env.GROQ_API_KEY_FIVE || "";
export const api_key_seven = process.env.GROQ_API_KEY_SEVEN || "";
export const api_key_eight = process.env.GROQ_API_KEY_EIGHT || "";

const GROQ_ENDPOINT = process.env.GROQ_ENDPOINT || "https://api.groq.com/openai/v1/chat/completions";

const keys = [
    api_key_one,
    api_key_two,
    api_key_three,
    api_key_four,
    api_key_five,
    api_key_seven,
    api_key_eight,
].filter((k) => k);

let activeKeyIndex = 0;

function normalizeErrorMessage(err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const code = data?.error?.code || data?.error?.type || "";
    const message = data?.error?.message || err?.message || "";
    return { status, code: String(code), message: String(message) };
}

function isQuotaOrTokenExhaustion(err) {
    const { status, code, message } = normalizeErrorMessage(err);
    const haystack = `${code} ${message}`.toLowerCase();

    const looksLikeQuota =
        haystack.includes("insufficient_quota") ||
        haystack.includes("quota") ||
        haystack.includes("exceeded") ||
        haystack.includes("token") ||
        haystack.includes("billing") ||
        haystack.includes("credits") ||
        haystack.includes("rate limit") ||
        status === 401 ||
        status === 403;

    return (
        (status === 429 || status === 402 || status === 401 || status === 403) &&
        looksLikeQuota
    );
}

async function postWithKey(payload, apiKey) {
    const res = await axios.post(GROQ_ENDPOINT, payload, {
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        timeout: 30000,
    });
    return res.data;
}

export async function groqChatCompletion(payload) {
    console.log(`[GroqClient] Starting request with model: ${payload.model}`);

    if (keys.length === 0) {
        console.error("[GroqClient] No API keys found!");
        throw new Error("Missing Groq API key(s). Set GROQ_API_KEY_ONE.");
    }

    try {
        console.log(`[GroqClient] Attempting request with key index ${activeKeyIndex}...`);
        const result = await postWithKey(payload, keys[activeKeyIndex]);
        console.log(`[GroqClient] Request successful with key index ${activeKeyIndex}.`);
        return result;
    } catch (err) {
        console.error(`[GroqClient] Request failed with key index ${activeKeyIndex}.`);
        const status = err?.response?.status;
        const errorData = err?.response?.data?.error;
        console.error(`[GroqClient] Error details: Status=${status}, Code=${errorData?.code}, Message=${errorData?.message}`);

        if (!isQuotaOrTokenExhaustion(err)) {
            throw err;
        }

        if (keys.length === 1) {
            throw err;
        }

        const startIndex = activeKeyIndex;
        let nextIndex = (activeKeyIndex + 1) % keys.length;

        while (nextIndex !== startIndex) {
            activeKeyIndex = nextIndex;
            try {
                console.log(`[GroqClient] Retrying with key index ${activeKeyIndex}...`);
                const result = await postWithKey(payload, keys[activeKeyIndex]);
                return result;
            } catch (err2) {
                if (!isQuotaOrTokenExhaustion(err2)) {
                    throw err2;
                }
                nextIndex = (activeKeyIndex + 1) % keys.length;
            }
        }
        throw err;
    }
}
