-- ============================================================
-- Chatbot DB schema v3
-- AI-powered dental lead qualification + human handoff
-- Run this once against your MySQL database.
-- ============================================================

DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;

-- One row per Facebook user (PSID) you've ever talked to.
CREATE TABLE conversations (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    sender_id             VARCHAR(64) NOT NULL UNIQUE,   -- Facebook PSID
    status                ENUM('bot', 'qualified_lead', 'pending_human', 'human')
                              NOT NULL DEFAULT 'bot',
    patient_name          VARCHAR(255) DEFAULT NULL,
    patient_phone         VARCHAR(64)  DEFAULT NULL,
    procedure_interested  VARCHAR(128) DEFAULT NULL,      -- e.g. Veneers, Implants, Braces
    preferred_schedule    VARCHAR(128) DEFAULT NULL,      -- e.g. Saturday Afternoon
    is_qualified          TINYINT(1) NOT NULL DEFAULT 0,  -- 1 when contact + procedure captured
    ad_id                 VARCHAR(128) DEFAULT NULL,      -- Meta Ad ID if clicked from ad
    ad_title              VARCHAR(255) DEFAULT NULL,      -- Meta Ad title if available
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_conversations_status  ON conversations(status);
CREATE INDEX idx_conversations_qualified ON conversations(is_qualified);