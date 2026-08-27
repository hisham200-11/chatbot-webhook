// ============================================================
// test_ai_agent.js - Simulate dental patient conversations
// Supports: Groq Llama 3.3 70B (free, default), Gemini, OpenAI
// Run: node test_ai_agent.js
// ============================================================
require('dotenv').config();

var AI_PROVIDER = (process.env.AI_PROVIDER || 'groq').toLowerCase();

var CLINIC_NAME     = process.env.CLINIC_NAME     || 'BrightSmile Dental Clinic';
var CLINIC_LOCATION = process.env.CLINIC_LOCATION || 'BGC, Taguig City';
var CLINIC_HOURS    = process.env.CLINIC_HOURS    || 'Mon-Sat 9AM-6PM';
var CLINIC_SERVICES = process.env.CLINIC_SERVICES || 'Veneers, Dental Implants, Braces, Teeth Whitening, General Dentistry';

function buildSystemPrompt() {
    var loc = CLINIC_LOCATION ? ' located in ' + CLINIC_LOCATION : '';
    return [
        'You are "Mae", the super friendly, caring, and professional clinic coordinator for ' + CLINIC_NAME + loc + '.',
        'Clinic hours: ' + CLINIC_HOURS + '.',
        'Services offered: ' + CLINIC_SERVICES + '.',
        '',
        'Doctor & Clinic Details:',
        '- Head Dentist: Dr. Juan Santos, DMD (Orthodontics & Aesthetic Dentistry)',
        '- Payment Terms: Braces downpayment starts at P5,000; monthly installment P1,500/month.',
        '- Accepted Payment: Cash, GCash, Maya, Major Credit Cards, HMO (Maxicare, Medicard).',
        '',
        'Your Personality & Tone:',
        '- Sound like a real, cheerful, helpful human receptionist on Facebook Messenger. Use warm Filipino phrasing (po/opo), emojis, and natural conversational Taglish.',
        '- NEVER sound like a stiff robot. Be empathetic, approachable, and encouraging.',
        '',
        'Your goals (in priority order):',
        '1. Warmly greet the patient and answer their questions conversationally.',
        '2. Provide pricing RANGES (never exact quotes - explain that final price depends on assessment).',
        '3. Offer our promo: a FREE consultation & 3D digital smile scan.',
        '4. Naturally ask for their NAME, PHONE NUMBER, and PREFERRED DAY to reserve their consultation.',
        '5. If they want to talk to the dentist or a human directly, set is_handoff to true.',
        '',
        'Conversation Examples (speak naturally like this):',
        '- User: "Hm po braces?"',
        '  Reply: "Hello po! Ang metal braces po natin starts at P35,000 po, with downpayment na P5,000 and P1,500/month installment. May promo po kami this week na FREE consultation & 3D smile scan! What is your name po, and available po ba kayo this week para ma-check ni Doc?"',
        '- User: "Masakit po ba magpa-implant?"',
        '  Reply: "Wag po kayong mag-alala! May local anesthesia po tayo kaya painless po ang procedure. Para po mas maipaliwanag ni Doc, let us book you for a free assessment po. May I have your name and best phone number po?"',
        '',
        'Pricing guide (use as RANGES only):',
        '- Teeth Cleaning: P800 - P2,500',
        '- Teeth Whitening: P5,000 - P15,000',
        '- Braces (Metal): P35,000 - P80,000',
        '- Invisalign / Clear Aligners: P80,000 - P200,000',
        '- Porcelain Veneers: P8,000 - P25,000 per tooth',
        '- Dental Implants: P60,000 - P120,000 per tooth',
        '- Wisdom Tooth Extraction: P5,000 - P15,000',
        '',
        'Always respond with valid JSON matching the required schema: {"reply_text": "string", "patient_name": "string or null", "patient_phone": "string or null", "procedure_interested": "string or null", "preferred_schedule": "string or null", "is_ready_for_booking": true/false, "is_handoff": true/false}',
    ].join('\n');
}

var OPENAI_SCHEMA = {
    type: 'object',
    properties: {
        reply_text:           { type: 'string', description: 'The message to send back to the patient' },
        patient_name:         { type: ['string', 'null'], description: 'Patient name if mentioned' },
        patient_phone:        { type: ['string', 'null'], description: 'Patient phone if mentioned' },
        procedure_interested: { type: ['string', 'null'], description: 'Dental procedure' },
        preferred_schedule:   { type: ['string', 'null'], description: 'When they want to come in' },
        is_ready_for_booking: { type: 'boolean', description: 'True if both name AND phone provided' },
        is_handoff:           { type: 'boolean', description: 'True if patient wants a human' },
    },
    required: ['reply_text', 'patient_name', 'patient_phone', 'procedure_interested', 'preferred_schedule', 'is_ready_for_booking', 'is_handoff'],
    additionalProperties: false,
};

var GEMINI_SCHEMA = {
    type: 'OBJECT',
    properties: {
        reply_text:           { type: 'STRING', description: 'The message to send back to the patient' },
        patient_name:         { type: 'STRING', nullable: true, description: 'Patient name if mentioned' },
        patient_phone:        { type: 'STRING', nullable: true, description: 'Patient phone if mentioned' },
        procedure_interested: { type: 'STRING', nullable: true, description: 'Dental procedure' },
        preferred_schedule:   { type: 'STRING', nullable: true, description: 'When they want to come in' },
        is_ready_for_booking: { type: 'BOOLEAN', description: 'True if both name AND phone provided' },
        is_handoff:           { type: 'BOOLEAN', description: 'True if patient wants a human' },
    },
    required: ['reply_text', 'is_ready_for_booking', 'is_handoff'],
};

var TEST_SCENARIOS = [
    {
        name: 'Test 1: Pricing inquiry in Taglish',
        messages: [
            { role: 'user', content: 'Hi doc hm po veneers sa inyo?' },
        ],
    },
    {
        name: 'Test 2: Contact extraction (name + phone)',
        messages: [
            { role: 'user', content: 'Hi interested po ako sa braces' },
            { role: 'assistant', content: 'Hello po! Thank you for your interest in braces. Our metal braces start from P35,000 depending on your case. Would you like to schedule a free consultation so our dentist can assess your smile? May I get your name and contact number po?' },
            { role: 'user', content: 'Maria Santos po, number ko 0917-123-4567, available this Saturday' },
        ],
    },
    {
        name: 'Test 3: Human handoff request (Taglish)',
        messages: [
            { role: 'user', content: 'Gusto ko makausap yung dentist mismo pwede po ba?' },
        ],
    },
    {
        name: 'Test 4: Edge case - vague question',
        messages: [
            { role: 'user', content: 'mahal ba magpadentista?' },
        ],
    },
];

// ── Groq call ──
async function callGroq(scenarioMessages) {
    var Groq = require('groq-sdk');
    var client = new Groq({ apiKey: process.env.GROQ_API_KEY });

    var messages = [{ role: 'system', content: buildSystemPrompt() }].concat(scenarioMessages);

    var completion = await client.chat.completions.create({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: messages,
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 1024,
    });

    return JSON.parse(completion.choices[0].message.content);
}

// ── OpenAI call ──
async function callOpenAI(scenarioMessages) {
    var OpenAI = require('openai');
    var client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    var messages = [{ role: 'system', content: buildSystemPrompt() }].concat(scenarioMessages);

    var completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages,
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'dental_response', strict: true, schema: OPENAI_SCHEMA },
        },
        temperature: 0.7,
        max_tokens: 512,
    });

    return JSON.parse(completion.choices[0].message.content);
}

// ── Gemini call ──
async function callGemini(scenarioMessages) {
    var genaiModule = await import('@google/genai');
    var GoogleGenAI = genaiModule.GoogleGenAI;
    var client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    var contents = [];
    for (var i = 0; i < scenarioMessages.length; i++) {
        var msg = scenarioMessages[i];
        contents.push({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }],
        });
    }

    var geminiModel = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

    var response = await client.models.generateContent({
        model: geminiModel,
        contents: contents,
        config: {
            systemInstruction: buildSystemPrompt(),
            responseMimeType: 'application/json',
            responseSchema: GEMINI_SCHEMA,
            temperature: 0.7,
            maxOutputTokens: 1024,
        },
    });

    return JSON.parse(response.text);
}

async function runTest(scenario) {
    console.log('\n' + '='.repeat(60));
    console.log(scenario.name);
    console.log('='.repeat(60));

    try {
        var parsed;
        if (AI_PROVIDER === 'openai') {
            parsed = await callOpenAI(scenario.messages);
        } else if (AI_PROVIDER === 'gemini') {
            parsed = await callGemini(scenario.messages);
        } else {
            parsed = await callGroq(scenario.messages);
        }

        var lastUserMsg = scenario.messages[scenario.messages.length - 1].content;

        console.log('\nPatient said: "' + lastUserMsg + '"');
        console.log('\nBot reply:    "' + parsed.reply_text + '"');
        console.log('\nExtracted data:');
        console.log('  Name:      ' + (parsed.patient_name || '(none)'));
        console.log('  Phone:     ' + (parsed.patient_phone || '(none)'));
        console.log('  Procedure: ' + (parsed.procedure_interested || '(none)'));
        console.log('  Schedule:  ' + (parsed.preferred_schedule || '(none)'));
        console.log('  Ready:     ' + parsed.is_ready_for_booking);
        console.log('  Handoff:   ' + parsed.is_handoff);
        console.log('  PASS');
        return true;
    } catch (err) {
        console.error('  FAIL:', err.message);
        return false;
    }
}

async function main() {
    console.log('Dental AI Agent - Test Suite');
    console.log('AI Provider: ' + AI_PROVIDER);

    if (AI_PROVIDER === 'openai' && !process.env.OPENAI_API_KEY) {
        console.error('\nERROR: OPENAI_API_KEY not found in .env file.');
        process.exit(1);
    }
    if (AI_PROVIDER === 'gemini' && !process.env.GEMINI_API_KEY) {
        console.error('\nERROR: GEMINI_API_KEY not found in .env file.');
        console.error('Get your FREE key at: https://aistudio.google.com/apikey');
        process.exit(1);
    }
    if (AI_PROVIDER === 'groq' && !process.env.GROQ_API_KEY) {
        console.error('\nERROR: GROQ_API_KEY not found in .env file.');
        console.error('Get your FREE key in 30 seconds at: https://console.groq.com');
        process.exit(1);
    }

    console.log('API Key: Set');

    var passed = 0;
    var failed = 0;

    for (var i = 0; i < TEST_SCENARIOS.length; i++) {
        var ok = await runTest(TEST_SCENARIOS[i]);
        if (ok) passed++; else failed++;
    }

    console.log('\n' + '='.repeat(60));
    console.log('Results: ' + passed + ' passed, ' + failed + ' failed out of ' + TEST_SCENARIOS.length);
    console.log('='.repeat(60));
}

main();