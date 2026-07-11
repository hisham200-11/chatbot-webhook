-- ============================================================
-- Flowstate Automations — Messenger Chatbot Schema
-- Replaces the old flat `keywords` table.
-- ============================================================

-- Drop old table (data will NOT be migrated automatically —
-- export it first if you want to keep any existing keyword/reply pairs)
DROP TABLE IF EXISTS keywords;

-- 1. Intents: one row per topic/response
CREATE TABLE IF NOT EXISTS intents (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    name                  VARCHAR(100) NOT NULL,
    response              TEXT NOT NULL,
    triggers_lead_capture BOOLEAN NOT NULL DEFAULT FALSE,
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_intent_name (name)
);

-- 2. Intent keywords: many trigger phrases -> one intent
CREATE TABLE IF NOT EXISTS intent_keywords (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    intent_id  INT NOT NULL,
    phrase     VARCHAR(255) NOT NULL,
    FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE,
    KEY idx_phrase (phrase)
);

-- 3. Conversations: per-sender state machine (needed for multi-step lead capture)
CREATE TABLE IF NOT EXISTS conversations (
    sender_id        VARCHAR(64) PRIMARY KEY,
    state             ENUM('idle', 'awaiting_name', 'awaiting_contact') NOT NULL DEFAULT 'idle',
    pending_intent_id INT NULL,
    pending_name      VARCHAR(150) NULL,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (pending_intent_id) REFERENCES intents(id) ON DELETE SET NULL
);

-- 4. Leads: captured contact info
CREATE TABLE IF NOT EXISTS leads (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    sender_id     VARCHAR(64) NOT NULL,
    name          VARCHAR(150) NOT NULL,
    contact_info  VARCHAR(255) NOT NULL,
    intent_id     INT NULL,
    status        ENUM('new', 'contacted', 'closed') NOT NULL DEFAULT 'new',
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE SET NULL
);

-- 5. Unmatched messages: log anything the bot couldn't answer, for review
CREATE TABLE IF NOT EXISTS unmatched_messages (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    sender_id   VARCHAR(64) NOT NULL,
    message     TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Seed data — starter FAQ set for Flowstate Automations demo
-- Edit/expand these for the real launch.
-- ============================================================

INSERT INTO intents (name, response, triggers_lead_capture) VALUES
('greeting', 'Hey there! 👋 Welcome to Flowstate Automations. We help businesses automate customer replies, bookings, and workflows. Ask me about our services, pricing, or how to get started!', FALSE),
('services', 'We build custom automation systems — chatbots like this one, booking flows, CRM integrations, and workflow automations tailored to your business.', FALSE),
('pricing', 'Pricing depends on the scope of automation you need. I''d love to get you a quote — can I grab your name and best contact info so our team can follow up?', TRUE),
('get_started', 'Awesome, let''s get you set up! Can I grab your name and best contact info so our team can reach out?', TRUE),
('hours', 'Our team is available Monday to Friday, 9am–6pm. This bot, though, is on 24/7!', FALSE);

INSERT INTO intent_keywords (intent_id, phrase) VALUES
(1, 'hi'), (1, 'hello'), (1, 'hey'), (1, 'good morning'), (1, 'good afternoon'),
(2, 'services'), (2, 'what do you do'), (2, 'what do you offer'), (2, 'automation'),
(3, 'price'), (3, 'pricing'), (3, 'how much'), (3, 'cost'), (3, 'rate'), (3, 'rates'),
(4, 'get started'), (4, 'sign up'), (4, 'interested'), (4, 'i want this'), (4, 'lets go'),
(5, 'hours'), (5, 'open'), (5, 'availability'), (5, 'when are you open');
