import { geminiChatCompletion } from './gemini.js';

/**
 * Translates a given text and/or extracted image text to English, resolving any 
 * pronoun references using the raw channel history (Contextual Query Rewriting).
 * @param {string} text - The input text to translate and resolve.
 * @param {string|null} imageUrl - Optional image URL to extract context from.
 * @param {string} rawChannelHistory - Recent conversation history to resolve pronouns.
 * @returns {Promise<string>} Standalone English query for vector matching.
 */
export async function resolveContextualQuery(text, imageUrl = null, rawChannelHistory = '') {
    if ((!text || !text.trim()) && !imageUrl) return '';

    const prompt = `You are an AI search assistant. Your job is to translate the user's message to English AND rewrite it into a single, standalone search query for an FAQ vector database search.

Instructions:
1. Translate any non-English text provided in the user's message to English.
2. If an image is attached, inspect the image, transcribe any text or description, and merge it into the query.
3. Use the raw channel history (including timestamps) to resolve contextual references. If the user refers to something previously discussed (e.g., "give me that list", "how to fix it"), rewrite the query to be specific.
4. IMPORTANT: Pay attention to the timestamps in the history. If there is a large time gap (e.g., 20+ minutes) between messages, treat it as a new conversation session. Do NOT resolve pronouns or context using messages from before the time gap unless the user explicitly references them.
5. Respond ONLY with the final, standalone English query. Do NOT add any notes, headers, explanations, or quotes.

Raw Channel History:
${rawChannelHistory}

User's current message: "${text || ''}"`;

    try {
        let content;
        if (imageUrl) {
            content = [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl } }
            ];
        } else {
            content = prompt;
        }

        const data = await geminiChatCompletion({
            messages: [{ role: 'user', content: content }],
            temperature: 0.1,
            max_tokens: 300,
        });

        const resolved = data?.choices?.[0]?.message?.content?.trim() || text;
        // Strip wrapping quotes if any
        return resolved.replace(/^"|"$/g, '').trim();
    } catch (err) {
        console.error('[Query Resolution Error] Failed to resolve query:', err.message);
        return text || ''; // Fallback to original text on error
    }
}
