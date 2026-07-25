import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const config = {
    ai: {
        model: process.env.CHAT_MODEL || "gemini-3.1-flash-lite",
        visionModel: process.env.GEMINI_VISION_MODEL || "gemini-3.1-flash-lite",
        fallbackVisionModel: "gemini-3.5-flash",
    }
};

export default config;
