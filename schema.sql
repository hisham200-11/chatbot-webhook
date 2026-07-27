-- ============================================================
-- Chatbot DB schema v2
-- Persistent conversations + human handoff
-- Run this once against your Railway MySQL database.
-- ============================================================

DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS keywords;

-- One row per Facebook user (PSID) you've ever talked to.
CREATE TABLE conversations (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    sender_id       VARCHAR(64) NOT NULL UNIQUE,   -- Facebook PSID
    status          ENUM('bot', 'awaiting_lead_info', 'pending_human', 'human')
                        NOT NULL DEFAULT 'bot',
    lead_name       VARCHAR(255) DEFAULT NULL,
    lead_contact    VARCHAR(255) DEFAULT NULL,      -- email or phone, whatever they gave
    lead_verified   TINYINT(1) NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP
);

-- Full message log, every message either side ever sent.
CREATE TABLE messages (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    sender          ENUM('user', 'bot', 'agent') NOT NULL,
    message_text    TEXT NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        ON DELETE CASCADE
);

-- Your existing FAQ auto-reply table, kept for simple keyword answers
-- (only used while status = 'bot').
CREATE TABLE keywords (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    keyword VARCHAR(255) NOT NULL,
    reply   TEXT NOT NULL
);

-- Example seed data — replace with your real FAQ answers.
INSERT INTO keywords (keyword, reply) VALUES
    ('price', 'Our pricing starts at $99/month. Want me to send the full breakdown?'),
    ('hours', 'We''re open Monday to Saturday, 9am to 6pm.'),
    ('location', 'We''re based in the Philippines and serve clients worldwide.');

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_conversations_status ON conversations(status);