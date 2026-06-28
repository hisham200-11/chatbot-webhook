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
                const text     = event.message.text.toLowerCase().trim();

                const reply = await getReply(text);
                await sendReply(senderId, reply);
            }
        }
    }
});

// ── Your keyword logic ──
async function getReply(message) {
    const firstWord = message.split(' ')[0];

    try {
        const [rows] = await db.query(
            'SELECT reply FROM keywords WHERE keyword = ? LIMIT 1',
            [firstWord]
        );
        if (rows.length > 0) return rows[0].reply;
    } catch (err) {
        console.error('DB error:', err.message);
    }

    return "Sorry, I didn't understand that. Can you rephrase?";
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