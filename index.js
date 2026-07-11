//webhook server
require('dotenv').config();
const express = require('express');
const mysql   = require('mysql2/promise');
const axios   = require('axios');

const app = express();
app.use(express.json());

// DB connection pool
const db = mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
});

// ── Facebook webhook verification ──
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        return res.send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
});

// ── Receive messages from Facebook ──
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // always respond fast so Facebook doesn't retry

    const entries = req.body.entry || [];
    for (const entry of entries) {
        for (const event of entry.messaging || []) {
            if (event.message?.text) {
                const senderId = event.sender.id;
                const text     = event.message.text.trim();

                await handleMessage(senderId, text);
            }
        }
    }
});

// ── Core message handling: checks conversation state first, then intents ──
async function handleMessage(senderId, text) {
    const convo = await getConversation(senderId);

    if (convo.state === 'awaiting_name') {
        await handleNameCapture(senderId, convo, text);
        return;
    }

    if (convo.state === 'awaiting_contact') {
        await handleContactCapture(senderId, convo, text);
        return;
    }

    // idle -> try to match an intent
    const intent = await matchIntent(text);

    if (!intent) {
        await logUnmatched(senderId, text);
        await sendReply(senderId, "Sorry, I didn't understand that. Can you rephrase?");
        return;
    }

    await sendReply(senderId, intent.response);

    if (intent.triggers_lead_capture) {
        await setConversationState(senderId, 'awaiting_name', intent.id);
        await sendReply(senderId, "What's your name?");
    }
}

// ── Lead capture step 1: name ──
async function handleNameCapture(senderId, convo, text) {
    await db.query(
        'UPDATE conversations SET pending_name = ?, state = ? WHERE sender_id = ?',
        [text, 'awaiting_contact', senderId]
    );
    await sendReply(senderId, `Thanks, ${text}! What's the best email or phone number to reach you?`);
}

// ── Lead capture step 2: contact info -> save lead, reset state ──
async function handleContactCapture(senderId, convo, text) {
    await db.query(
        'INSERT INTO leads (sender_id, name, contact_info, intent_id) VALUES (?, ?, ?, ?)',
        [senderId, convo.pending_name, text, convo.pending_intent_id]
    );
    await resetConversation(senderId);
    await sendReply(senderId, "Perfect, thank you! Our team will follow up with you shortly. 🎉");
}

// ── Intent matching against keyword phrases ──
async function matchIntent(message) {
    try {
        const lower = message.toLowerCase();
        const [rows] = await db.query(
            `SELECT i.id, i.response, i.triggers_lead_capture
             FROM intent_keywords k
             JOIN intents i ON i.id = k.intent_id
             WHERE i.is_active = TRUE AND ? LIKE CONCAT('%', k.phrase, '%')
             ORDER BY LENGTH(k.phrase) DESC
             LIMIT 1`,
            [lower]
        );
        return rows[0] || null;
    } catch (err) {
        console.error('DB error (matchIntent):', err.message);
        return null;
    }
}

// ── Conversation state helpers ──
async function getConversation(senderId) {
    const [rows] = await db.query('SELECT * FROM conversations WHERE sender_id = ?', [senderId]);
    if (rows.length > 0) return rows[0];

    await db.query('INSERT INTO conversations (sender_id, state) VALUES (?, ?)', [senderId, 'idle']);
    return { sender_id: senderId, state: 'idle', pending_intent_id: null, pending_name: null };
}

async function setConversationState(senderId, state, pendingIntentId = null) {
    await db.query(
        'UPDATE conversations SET state = ?, pending_intent_id = ? WHERE sender_id = ?',
        [state, pendingIntentId, senderId]
    );
}

async function resetConversation(senderId) {
    await db.query(
        'UPDATE conversations SET state = ?, pending_intent_id = NULL, pending_name = NULL WHERE sender_id = ?',
        ['idle', senderId]
    );
}

// ── Log unmatched messages for later review ──
async function logUnmatched(senderId, message) {
    try {
        await db.query(
            'INSERT INTO unmatched_messages (sender_id, message) VALUES (?, ?)',
            [senderId, message]
        );
    } catch (err) {
        console.error('DB error (logUnmatched):', err.message);
    }
}

// ── Send reply to Facebook ──
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook running on port ${PORT}`));