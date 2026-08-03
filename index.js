// ============================================================
// Facebook Messenger chatbot — persistent chat + human handoff
// ============================================================
require('dotenv').config();
const express  = require('express');
const mysql    = require('mysql2/promise');
const axios    = require('axios');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// ── DB connection pool ──
const db = mysql.createPool({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT || 3000),
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
});

// ── Email transport (for handoff notifications) ──
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
    'talk to a person', 'live agent',
];

// Command an admin types manually in Messenger to give control back to the bot
const RESUME_COMMAND = '/bot resume';

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

    const conversation = await getOrCreateConversation(senderId);
    await logMessage(conversation.id, 'user', rawText);

    // A human is already handling this thread — bot stays silent.
    if (conversation.status === 'human' || conversation.status === 'pending_human') {
        return;
    }

    // We just asked for name/contact — treat this message as that answer.
    if (conversation.status === 'awaiting_lead_info') {
        await saveLeadInfo(conversation.id, senderId, rawText);
        return;
    }

    // Check if the user is asking for a human.
    if (detectHandoffIntent(text)) {
        await db.query(
            'UPDATE conversations SET status = ? WHERE id = ?',
            ['awaiting_lead_info', conversation.id]
        );
        const reply = "Sure — I can connect you with our team. Could you share your name and the best email or phone number to reach you?";
        await logMessage(conversation.id, 'bot', reply);
        await sendReply(senderId, reply);
        return;
    }

    // Otherwise, normal FAQ keyword reply.
    const reply = await getKeywordReply(text);
    await logMessage(conversation.id, 'bot', reply);
    await sendReply(senderId, reply);
}

// ============================================================
// Handle an "echo" event — a message that came FROM your Page.
// This fires both when the bot replies via the API, and when a
// human manually replies through the Messenger / Page Inbox app.
// We tell them apart using app_id: messages sent through our own
// API call carry our app_id; messages typed by a human in the
// inbox UI don't.
// ============================================================
async function handleEcho(event) {
    const senderId = event.recipient.id; // for echoes, "recipient" is the customer
    const text     = event.message.text || '';
    const sentByOurApp = String(event.message.app_id || '') === String(process.env.FB_APP_ID || '');

    if (sentByOurApp) return; // this is just our own bot reply being echoed back, ignore

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
// Save the lead's name/contact, notify admin, hand off
// ============================================================
async function saveLeadInfo(conversationId, senderId, rawText) {
    const contact = extractContact(rawText);

    await db.query(
        'UPDATE conversations SET status = ?, lead_name = ?, lead_contact = ?, lead_verified = 1 WHERE id = ?',
        ['pending_human', rawText.slice(0, 255), contact, conversationId]
    );

    const ackText = "Thanks! Someone from our team will reach out shortly.";
    await logMessage(conversationId, 'bot', ackText);
    await sendReply(senderId, ackText);

    await notifyAdmin(senderId, rawText, contact);
}

// Very simple email/phone grab; falls back to the raw text.
function extractContact(text) {
    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (emailMatch) return emailMatch[0];
    const phoneMatch = text.match(/\+?\d[\d\s-]{6,}\d/);
    if (phoneMatch) return phoneMatch[0].trim();
    return text.slice(0, 255);
}

function detectHandoffIntent(text) {
    return HANDOFF_KEYWORDS.some(k => text.includes(k));
}

// ============================================================
// FAQ keyword lookup (used only while status = 'bot')
// ============================================================
async function getKeywordReply(message) {
    try {
        const [rows] = await db.query(
            'SELECT reply FROM keywords WHERE ? LIKE CONCAT("%", keyword, "%") LIMIT 1',
            [message]
        );
        if (rows.length > 0) return rows[0].reply;
    } catch (err) {
        console.error('DB error:', err.message);
    }
    return "Sorry, I didn't understand that. You can also type \"agent\" to talk to a real person.";
}

// ============================================================
// Conversation + message helpers
// ============================================================
async function getOrCreateConversation(senderId) {
    const [rows] = await db.query('SELECT * FROM conversations WHERE sender_id = ?', [senderId]);
    if (rows.length > 0) return rows[0];

    const [result] = await db.query(
        'INSERT INTO conversations (sender_id, status) VALUES (?, "bot")',
        [senderId]
    );
    return { id: result.insertId, sender_id: senderId, status: 'bot' };
}

async function logMessage(conversationId, sender, text) {
    await db.query(
        'INSERT INTO messages (conversation_id, sender, message_text) VALUES (?, ?, ?)',
        [conversationId, sender, text]
    );
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
// Email the admin when a verified lead is ready for handoff
// ============================================================
async function notifyAdmin(senderId, rawText, contact) {
    try {
        await mailer.sendMail({
            from: process.env.SMTP_USER,
            to:   process.env.ADMIN_EMAIL,
            subject: `New lead ready for handoff (PSID: ${senderId})`,
            text:
`A visitor asked to talk to a human and left contact info.

Facebook PSID: ${senderId}
Message: ${rawText}
Extracted contact: ${contact}

Reply directly in the Messenger/Page Inbox app to take over.
Type "${RESUME_COMMAND}" in that thread when you're done to hand control back to the bot.`,
        });
    } catch (err) {
        console.error('Email notification failed:', err.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook running on port ${PORT}`));