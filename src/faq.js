import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

let warnedMissingEnv = false;
let supabase = null;

function isConfigured() {
    return Boolean(
        process.env.SUPABASE_URL &&
        (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY) &&
        process.env.NOMIC_API_KEY
    );
}

function getThreshold() {
    return Number.parseFloat(process.env.FAQ_SIMILARITY_THRESHOLD || '0.30');
}

export function getSupabase() {
    if (!isConfigured()) return null;
    if (supabase) return supabase;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
    supabase = createClient(process.env.SUPABASE_URL, key, {
        auth: { persistSession: false }
    });
    return supabase;
}

// ===== SUPABASE KEEP-ALIVE (FREE TIER SLEEP PREVENTION) =====
setInterval(async () => {
    try {
        const sb = getSupabase();
        if (!sb) return;

        const { error } = await sb.from('faqs').select('title').limit(1);

        if (error) {
            console.log('Supabase keep-alive error:', error.message);
        } else {
            console.log('Supabase keep-alive ping OK');
        }
    } catch (err) {
        console.log('Supabase keep-alive failed:', err?.message || String(err));
    }
}, 10 * 60 * 1000); // every 10 minutes
// ===== END KEEP-ALIVE =====

export async function embed(textOrArray, inputType = 'search_document') {
    if (!isConfigured()) return null;
    if (!process.env.NOMIC_API_KEY) throw new Error("No Nomic API key found in .env");

    const texts = Array.isArray(textOrArray) ? textOrArray : [textOrArray];
    if (texts.length === 0) return Array.isArray(textOrArray) ? [] : null;

    const allEmbeddings = [];
    for (let i = 0; i < texts.length; i += 90) {
        const batch = texts.slice(i, i + 90);
        try {
            const resp = await axios.post(
                'https://api-atlas.nomic.ai/v1/embedding/text',
                {
                    model: 'nomic-embed-text-v1.5',
                    texts: batch,
                    task_type: inputType,
                    dimensionality: 768
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.NOMIC_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            allEmbeddings.push(...resp.data.embeddings);
        } catch (err) {
            console.error('\n[Nomic API Error]', err.response?.data || err.message);
            throw err;
        }
    }

    return Array.isArray(textOrArray) ? allEmbeddings : allEmbeddings[0];
}

function toVec(raw) {
    if (!raw) return null;
    if (Array.isArray(raw)) return raw;

    if (typeof raw === 'string') {
        try {
            const p = JSON.parse(raw);
            if (Array.isArray(p)) return p;
        } catch { }
        const parts = raw.split(',').map(Number);
        if (parts.every((n) => !Number.isNaN(n))) return parts;
    }

    if (ArrayBuffer.isView(raw)) return Array.from(raw);
    if (raw.embedding && Array.isArray(raw.embedding)) return raw.embedding;
    if (raw.values && Array.isArray(raw.values)) return raw.values;

    for (const k in raw) {
        if (Array.isArray(raw[k])) return raw[k];
    }

    return null;
}

function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let dot = 0,
        na = 0,
        nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (!na || !nb) return -1;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function findFaqAnswer(question) {
    if (!isConfigured()) {
        if (!warnedMissingEnv) {
            warnedMissingEnv = true;
            console.warn(
                'FAQ lookup disabled: missing SUPABASE_URL, SUPABASE_KEY, or NOMIC_API_KEY.'
            );
        }
        return null;
    }

    const sb = getSupabase();
    if (!sb) return null;

    const qVec = await embed(question, 'search_query');
    if (!qVec) return null;

    const { data } = await sb.from('faqs').select('title, content, embedding').limit(1000);
    if (!data || !Array.isArray(data)) {
        console.log('[FAQ Debug] No data returned from Supabase or invalid format.');
        return null;
    }
    console.log(`[FAQ Debug] Fetched ${data.length} rows from Supabase.`);

    const threshold = getThreshold();
    const MAX_FAQ_RESULTS = Number(process.env.FAQ_MAX_RESULTS || 3);

    const matches = [];
    for (const row of data) {
        const v = toVec(row.embedding);
        if (!v) continue;
        if (v.length !== qVec.length) continue;

        const score = cosine(qVec, v);
        if (score >= threshold) {
            matches.push({ title: row.title, content: row.content, score });
        }
    }

    // Sort by score descending, take top N
    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, MAX_FAQ_RESULTS);

    if (top.length === 0) {
        console.log(`[FAQ Debug] No matches above threshold ${threshold}.`);
        return null;
    }

    console.log(`[FAQ Debug] Found ${top.length} match(es) above threshold ${threshold}:`);
    for (const m of top) {
        console.log(`  → "${m.title}" (Score: ${m.score.toFixed(4)})`);
    }

    return top; // Always returns an array
}
