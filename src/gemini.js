import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import config from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

export const api_key_one = process.env.GEMINI_API_KEY_ONE || "";
export const api_key_two = process.env.GEMINI_API_KEY_TWO || "";
export const api_key_three = process.env.GEMINI_API_KEY_THREE || "";
export const api_key_four = process.env.GEMINI_API_KEY_FOUR || "";
export const api_key_five = process.env.GEMINI_API_KEY_FIVE || "";
export const api_key_six = process.env.GEMINI_API_KEY_SIX || "";
export const api_key_seven = process.env.GEMINI_API_KEY_SEVEN || "";
export const api_key_eight = process.env.GEMINI_API_KEY_EIGHT || "";

const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT || "https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions";

const rawKeys = [
    api_key_one,
    api_key_two,
    api_key_three,
    api_key_four,
    api_key_five,
    api_key_six,
    api_key_seven,
    api_key_eight,
].filter((k) => k);

const keys = rawKeys.map((key, index) => ({
    key,
    index,
    isProcessing: false,
}));

const waiterQueue = [];

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
    const modelToUse = config.ai.visionModel || config.ai.fallbackVisionModel || "gemini-1.5-flash";
    const finalPayload = {
        ...payload,
        model: modelToUse,
    };

    const res = await axios.post(GEMINI_ENDPOINT, finalPayload, {
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        timeout: 30000,
    });
    return res.data;
}

async function acquireFreeKey(triedKeyIndices) {
    const keyObj = keys.find((k) => !k.isProcessing && !triedKeyIndices.has(k.index));
    if (keyObj) {
        keyObj.isProcessing = true;
        return keyObj;
    }

    return new Promise((resolve) => {
        waiterQueue.push({
            triedKeyIndices,
            resolve: (selectedKey) => {
                selectedKey.isProcessing = true;
                resolve(selectedKey);
            },
        });
    });
}

function releaseKey(keyObj) {
    keyObj.isProcessing = false;
    const waiterIndex = waiterQueue.findIndex((w) => !w.triedKeyIndices.has(keyObj.index));
    if (waiterIndex !== -1) {
        const waiter = waiterQueue.splice(waiterIndex, 1)[0];
        waiter.resolve(keyObj);
    }
}

export async function geminiChatCompletion(payload) {
    if (keys.length === 0) {
        console.error("[GeminiClient] No API keys found!");
        throw new Error("Missing Gemini API key(s). Set GEMINI_API_KEY_ONE.");
    }

    let attempts = 0;
    const maxAttempts = keys.length;
    const triedKeyIndices = new Set();

    while (attempts < maxAttempts) {
        const keyObj = await acquireFreeKey(triedKeyIndices);
        triedKeyIndices.add(keyObj.index);
        attempts++;

        try {
            console.log(`[GeminiClient] Attempting request using key index ${keyObj.index}...`);
            const result = await postWithKey(payload, keyObj.key);
            releaseKey(keyObj);
            return result;
        } catch (err) {
            const status = err?.response?.status;
            console.error(`[GeminiClient] Request failed using key index ${keyObj.index}. Status: ${status}`);
            releaseKey(keyObj);

            // Non-retryable errors (model not found, bad request) — throw immediately
            if (status === 404 || status === 400) {
                throw err;
            }

            // 503 (Service Unavailable) and quota/rate-limit errors — retry with next key
            const retryable = isQuotaOrTokenExhaustion(err) || status === 503 || status === 502;
            if (!retryable) {
                throw err;
            }

            if (attempts >= maxAttempts) {
                throw err;
            }
        }
    }
}
