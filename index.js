// ============================================================
// Facebook Messenger — AI Dental Lead Qualification Engine
// Supports: Gemini Flash (free) or OpenAI GPT-4o-mini
// Set AI_PROVIDER=gemini (default) or AI_PROVIDER=openai in .env
// ============================================================
require('dotenv').config();
const express    = require('express');
const mysql      = require('mysql2/promise');
const axios      = require('axios');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// ── AI Provider selection ──
const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

let openai = null;
let gemini = null;

if (AI_PROVIDER === 'openai') {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('AI Provider: OpenAI GPT-4o-mini');
}
// Gemini is initialized asynchronously below (ESM import)

// ── DB connection pool ──
const db = mysql.createPool({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT || 3306),
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
});


// ── Email transport (for lead notifications) ──
const mailer = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

// Phrases that mean "I want to talk to a real person"
const HANDOFF_KEYWORDS = [
    'agent', 'human', 'representative', 'real person',
    'talk to someone', 'speak to someone', 'customer service',
    'talk to a person', 'live agent', 'talk to the dentist',
    'makausap', 'tao', 'real na tao',
];

// Command an admin types manually in Messenger to give control back to the bot
const RESUME_COMMAND = '/bot resume';

// ── Clinic configuration (from .env) ──
const CLINIC_NAME     = process.env.CLINIC_NAME     || 'Our Dental Clinic';
const CLINIC_LOCATION = process.env.CLINIC_LOCATION || '';
const CLINIC_HOURS    = process.env.CLINIC_HOURS    || 'Mon-Sat 9AM-6PM';
const CLINIC_SERVICES = process.env.CLINIC_SERVICES || 'Veneers, Dental Implants, Braces, Teeth Whitening, General Dentistry';

// ── Dental concierge system prompt ──
const SYSTEM_PROMPT = `You are the friendly, professional AI concierge for ${CLINIC_NAME}${CLINIC_LOCATION ? ` located in ${CLINIC_LOCATION}` : ''}.
Clinic hours: ${CLINIC_HOURS}.
Services offered: ${CLINIC_SERVICES}.

Your goals (in priority order):
1. Warmly greet the patient and answer their dental questions naturally.
2. Provide transparent pricing RANGES (never exact quotes — always say "starts from ₱X depending on clinical assessment").
3. Gently guide the conversation toward booking a FREE consultation / 3D smile assessment.
4. Collect the patient's NAME and PHONE NUMBER so the clinic can confirm the appointment.
5. If they ask to speak with a human or the dentist directly, set is_handoff to true.

Conversation rules:
- Be warm, empathetic, and conversational. Use polite Filipino particles (po, opo) when the patient writes in Tagalog/Taglish.
- NEVER diagnose or give medical advice. Always recommend an in-person assessment.
- Keep replies concise (2-4 sentences max). Do not write essays.
- If you already have their name and phone, do NOT ask again — just confirm the booking.
- If the patient seems unsure, reassure them that the consultation is free and no-commitment.

Pricing guide (use as RANGES only):
- Teeth Cleaning: ₱800 – ₱2,500
- Teeth Whitening: ₱5,000 – ₱15,000
- Braces (Metal): ₱35,000 – ₱80,000
- Invisalign / Clear Aligners: ₱80,000 – ₱200,000
- Porcelain Veneers: ₱8,000 – ₱25,000 per tooth
- Dental Implants: ₱60,000 – ₱120,000 per tooth
- Wisdom Tooth Extraction: ₱5,000 – ₱15,000

Always respond with valid JSON matching the required schema. The reply_text field is what will be sent to the patient.`;

// ── JSON response schemas for structured output ──
const OPENAI_SCHEMA = {
    type: 'object',
    properties: {
        reply_text:           { type: 'string', description: 'The message to send back to the patient' },
        patient_name:         { type: ['string', 'null'], description: 'Patient name if mentioned, null otherwise' },
        patient_phone:        { type: ['string', 'null'], description: 'Patient phone number if mentioned, null otherwise' },
        procedure_interested: { type: ['string', 'null'], description: 'Dental procedure they are asking about, null if unclear' },
        preferred_schedule:   { type: ['string', 'null'], description: 'When they want to come in, null if not mentioned' },
        is_ready_for_booking: { type: 'boolean', description: 'True if patient provided both name AND phone number' },
        is_handoff:           { type: 'boolean', description: 'True if patient explicitly wants to talk to a human/dentist' },
    },
    required: ['reply_text', 'patient_name', 'patient_phone', 'procedure_interested', 'preferred_schedule', 'is_ready_for_booking', 'is_handoff'],
    additionalProperties: false,
};

const GEMINI_SCHEMA = {
    type: 'OBJECT',
    properties: {
        reply_text:           { type: 'STRING', description: 'The message to send back to the patient' },
        patient_name:         { type: 'STRING', nullable: true, description: 'Patient name if mentioned, null otherwise' },
        patient_phone:        { type: 'STRING', nullable: true, description: 'Patient phone number if mentioned, null otherwise' },
        procedure_interested: { type: 'STRING', nullable: true, description: 'Dental procedure they are asking about, null if unclear' },
        preferred_schedule:   { type: 'STRING', nullable: true, description: 'When they want to come in, null if not mentioned' },
        is_ready_for_booking: { type: 'BOOLEAN', description: 'True if patient provided both name AND phone number' },
        is_handoff:           { type: 'BOOLEAN', description: 'True if patient explicitly wants to talk to a human/dentist' },
    },
    required: ['reply_text', 'is_ready_for_booking', 'is_handoff'],
};

// ============================================================
// Facebook webhook verification (GET)
// ============================================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        return res.send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
});

// ============================================================
// Receive events from Facebook (POST)
// ============================================================
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // ack fast so Facebook doesn't retry

    const entries = req.body.entry || [];
    for (const entry of entries) {
        for (const event of entry.messaging || []) {
            try {
                if (event.message?.is_echo) {
                    await handleEcho(event);
                } else if (event.message?.text) {
                    await handleUserMessage(event);
                }
            } catch (err) {
                console.error('Error handling event:', err);
            }
        }
    }
});

// ============================================================
// Handle a normal incoming message from the end user
// ============================================================
async function handleUserMessage(event) {
    const senderId = event.sender.id;
    const rawText  = event.message.text;
    const text     = rawText.toLowerCase().trim();

    // Get or create conversation, capturing ad referral if present
    const conversation = await getOrCreateConversation(senderId, event.referral);
    await logMessage(conversation.id, 'user', rawText);

    // A human is already handling this thread — bot stays silent.
    if (conversation.status === 'human' || conversation.status === 'pending_human') {
        return;
    }

    // Check if the user is explicitly asking for a human (before AI).
    if (detectHandoffIntent(text)) {
        await db.query(
            'UPDATE conversations SET status = ? WHERE id = ?',
            ['pending_human', conversation.id]
        );
        const reply = "Sure po — I'll connect you with our clinic team right away. Someone will message you shortly! 😊";
        await logMessage(conversation.id, 'bot', reply);
        await sendReply(senderId, reply);
        await notifyAdmin(senderId, conversation, 'Patient requested to speak with a human/dentist.');
        return;
    }

    // ── AI-powered conversation ──
    const chatHistory = await getRecentChatHistory(conversation.id, 6);
    const aiResponse  = await getAIResponse(chatHistory, rawText);

    // Send the reply to the patient
    await logMessage(conversation.id, 'bot', aiResponse.reply_text);
    await sendReply(senderId, aiResponse.reply_text);

    // If AI detected handoff intent
    if (aiResponse.is_handoff) {
        await db.query('UPDATE conversations SET status = ? WHERE id = ?', ['pending_human', conversation.id]);
        await notifyAdmin(senderId, conversation, 'Patient requested to speak with a human/dentist.');
        return;
    }

    // Update lead info if AI extracted any new data
    await updateLeadInfo(conversation, aiResponse, senderId);
}

// ============================================================
// Handle an "echo" event — a message from your Page.
// ============================================================
async function handleEcho(event) {
    const senderId = event.recipient.id; // for echoes, "recipient" is the customer
    const text     = event.message.text || '';
    const sentByOurApp = String(event.message.app_id || '') === String(process.env.FB_APP_ID || '');

    if (sentByOurApp) return; // our own bot reply echoed back, ignore

    // A human manually sent this from the Page Inbox / Messenger app.
    const conversation = await getOrCreateConversation(senderId);
    await logMessage(conversation.id, 'agent', text);

    if (text.trim().toLowerCase() === RESUME_COMMAND) {
        await db.query('UPDATE conversations SET status = ? WHERE id = ?', ['bot', conversation.id]);
        await sendReply(senderId, "Bot re-engaged. I'm back to answering automatically. 🙂");
        return;
    }

    // Any other manual message = human has taken over. Silence the bot.
    if (conversation.status !== 'human') {
        await db.query('UPDATE conversations SET status = ? WHERE id = ?', ['human', conversation.id]);
    }
}

// ============================================================
// AI Response — Dual provider: Gemini Flash (free) or OpenAI
// ============================================================
async function getAIResponse(chatHistory, currentMessage) {
    try {
        if (AI_PROVIDER === 'openai') {
            return await getOpenAIResponse(chatHistory, currentMessage);
        } else {
            return await getGeminiResponse(chatHistory, currentMessage);
        }
    } catch (err) {
        console.error(`${AI_PROVIDER} API error:`, err.message);
        // Graceful fallback if AI is down
        return getFallbackResponse();
    }
}

// ── OpenAI GPT-4o-mini ──
async function getOpenAIResponse(chatHistory, currentMessage) {
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...chatHistory,
        { role: 'user', content: currentMessage },
    ];

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'dental_response',
                strict: true,
                schema: OPENAI_SCHEMA,
            },
        },
        temperature: 0.7,
        max_tokens: 512,
    });

    return JSON.parse(completion.choices[0].message.content);
}

// ── Google Gemini Flash (free tier) ──
async function getGeminiResponse(chatHistory, currentMessage) {
    // Lazy-init Gemini client on first call (ESM dynamic import)
    if (!gemini) {
        const { GoogleGenAI } = await import('@google/genai');
        gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        console.log('AI Provider: Gemini 3.6 Flash (free tier)');
    }

    // Build contents array for Gemini multi-turn format
    const contents = [];

    // Add chat history
    for (const msg of chatHistory) {
        contents.push({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }],
        });
    }

    // Add current message
    contents.push({ role: 'user', parts: [{ text: currentMessage }] });

    const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

    const response = await gemini.models.generateContent({
        model: geminiModel,
        contents,
        config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_SCHEMA,
            temperature: 0.7,
            maxOutputTokens: 1024,
        },
    });

    return JSON.parse(response.text);
}

// ── Fallback when AI is unavailable ──
function getFallbackResponse() {
    return {
        reply_text: "Sorry po, I'm having a brief technical issue. Please try again in a moment, or type \"agent\" to connect with our clinic team directly! 😊",
        patient_name: null,
        patient_phone: null,
        procedure_interested: null,
        preferred_schedule: null,
        is_ready_for_booking: false,
        is_handoff: false,
    };
}


// ============================================================
// Load recent chat history for multi-turn context
// ============================================================
async function getRecentChatHistory(conversationId, limit = 6) {
    const [rows] = await db.query(
        'SELECT sender, message_text FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
        [conversationId, limit]
    );

    // Reverse to chronological order, then map to OpenAI message format
    return rows.reverse().map(row => ({
        role: row.sender === 'user' ? 'user' : 'assistant',
        content: row.message_text,
    }));
}

// ============================================================
// Update lead information when AI extracts new data
// ============================================================
async function updateLeadInfo(conversation, aiResponse, senderId) {
    const updates = [];
    const params  = [];

    if (aiResponse.patient_name && !conversation.patient_name) {
        updates.push('patient_name = ?');
        params.push(aiResponse.patient_name.slice(0, 255));
    }
    if (aiResponse.patient_phone && !conversation.patient_phone) {
        updates.push('patient_phone = ?');
        params.push(aiResponse.patient_phone.slice(0, 64));
    }
    if (aiResponse.procedure_interested && !conversation.procedure_interested) {
        updates.push('procedure_interested = ?');
        params.push(aiResponse.procedure_interested.slice(0, 128));
    }
    if (aiResponse.preferred_schedule && !conversation.preferred_schedule) {
        updates.push('preferred_schedule = ?');
        params.push(aiResponse.preferred_schedule.slice(0, 128));
    }

    // Mark as qualified when both name and phone are captured
    const hasName  = aiResponse.patient_name  || conversation.patient_name;
    const hasPhone = aiResponse.patient_phone || conversation.patient_phone;
    const wasQualified = conversation.is_qualified;

    if (hasName && hasPhone && !wasQualified) {
        updates.push('is_qualified = 1');
        updates.push("status = 'qualified_lead'");
    }

    if (updates.length === 0) return;

    params.push(conversation.id);
    await db.query(
        `UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`,
        params
    );

    // Send instant notification when a lead becomes qualified for the first time
    if (hasName && hasPhone && !wasQualified) {
        const updatedConvo = {
            ...conversation,
            patient_name:        aiResponse.patient_name  || conversation.patient_name,
            patient_phone:       aiResponse.patient_phone || conversation.patient_phone,
            procedure_interested: aiResponse.procedure_interested || conversation.procedure_interested,
            preferred_schedule:  aiResponse.preferred_schedule || conversation.preferred_schedule,
        };
        await notifyAdmin(senderId, updatedConvo, 'NEW QUALIFIED LEAD — Patient provided name and contact info!');
    }
}

// ============================================================
// Conversation + message helpers
// ============================================================
async function getOrCreateConversation(senderId, referral) {
    const [rows] = await db.query('SELECT * FROM conversations WHERE sender_id = ?', [senderId]);
    if (rows.length > 0) {
        // If this is an ad click and we haven't stored ad info yet, update it
        if (referral && referral.ad_id && !rows[0].ad_id) {
            await db.query(
                'UPDATE conversations SET ad_id = ?, ad_title = ? WHERE id = ?',
                [referral.ad_id, referral.ad_title || null, rows[0].id]
            );
            rows[0].ad_id    = referral.ad_id;
            rows[0].ad_title = referral.ad_title || null;
        }
        return rows[0];
    }

    const [result] = await db.query(
        'INSERT INTO conversations (sender_id, status, ad_id, ad_title) VALUES (?, "bot", ?, ?)',
        [senderId, referral?.ad_id || null, referral?.ad_title || null]
    );
    return {
        id: result.insertId, sender_id: senderId, status: 'bot',
        patient_name: null, patient_phone: null, procedure_interested: null,
        preferred_schedule: null, is_qualified: 0,
        ad_id: referral?.ad_id || null, ad_title: referral?.ad_title || null,
    };
}

async function logMessage(conversationId, sender, text) {
    await db.query(
        'INSERT INTO messages (conversation_id, sender, message_text) VALUES (?, ?, ?)',
        [conversationId, sender, text]
    );
}

function detectHandoffIntent(text) {
    return HANDOFF_KEYWORDS.some(k => text.includes(k));
}

// ============================================================
// Send a reply back to the user via the Send API
// ============================================================
async function sendReply(recipientId, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/me/messages`,
            {
                recipient: { id: recipientId },
                message:   { text }
            },
            {
                params:  { access_token: process.env.PAGE_ACCESS_TOKEN },
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (err) {
        console.error('Facebook API error:', err.response?.data || err.message);
    }
}

// ============================================================
// Email the admin when a qualified lead or handoff request arrives
// ============================================================
async function notifyAdmin(senderId, conversation, subject) {
    try {
        const adInfo = conversation.ad_id
            ? `\nAd ID: ${conversation.ad_id}\nAd Title: ${conversation.ad_title || 'N/A'}`
            : '\nSource: Organic (no ad click)';

        await mailer.sendMail({
            from: process.env.SMTP_USER,
            to:   process.env.ADMIN_EMAIL,
            subject: `🦷 ${subject} (PSID: ${senderId})`,
            text:
`${subject}

──────────────────────────
Patient Details:
  Name:      ${conversation.patient_name || 'Not yet provided'}
  Phone:     ${conversation.patient_phone || 'Not yet provided'}
  Procedure: ${conversation.procedure_interested || 'Not yet specified'}
  Schedule:  ${conversation.preferred_schedule || 'Not yet specified'}
${adInfo}
──────────────────────────

Facebook PSID: ${senderId}

Reply directly in the Messenger / Page Inbox app to take over.
Type "${RESUME_COMMAND}" in that thread when you're done to hand control back to the bot.`,
        });
    } catch (err) {
        console.error('Email notification failed:', err.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🦷 Dental AI Webhook running on port ${PORT}`));