// ============================================================
// test_ai_agent.js - Simulate dental patient conversations
// Supports: Gemini Flash (free, default) or OpenAI GPT-4o-mini
// Run: node test_ai_agent.js
// ============================================================
require('dotenv').config();

var AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

var CLINIC_NAME     = process.env.CLINIC_NAME     || 'BrightSmile Dental Clinic';
var CLINIC_LOCATION = process.env.CLINIC_LOCATION || 'BGC, Taguig City';
var CLINIC_HOURS    = process.env.CLINIC_HOURS    || 'Mon-Sat 9AM-6PM';
var CLINIC_SERVICES = process.env.CLINIC_SERVICES || 'Veneers, Dental Implants, Braces, Teeth Whitening, General Dentistry';

function buildSystemPrompt() {
    var loc = CLINIC_LOCATION ? ' located in ' + CLINIC_LOCATION : '';
    return [
        'You are the friendly, professional AI concierge for ' + CLINIC_NAME + loc + '.',
        'Clinic hours: ' + CLINIC_HOURS + '.',
        'Services offered: ' + CLINIC_SERVICES + '.',
        '',
        'Your goals (in priority order):',
        '1. Warmly greet the patient and answer their dental questions naturally.',
        '2. Provide transparent pricing RANGES (never exact quotes).',
        '3. Gently guide the conversation toward booking a FREE consultation / 3D smile assessment.',
        '4. Collect the patient NAME and PHONE NUMBER so the clinic can confirm the appointment.',
        '5. If they ask to speak with a human or the dentist directly, set is_handoff to true.',
        '',
        'Conversation rules:',
        '- Be warm, empathetic, and conversational. Use polite Filipino particles (po, opo) when the patient writes in Tagalog/Taglish.',
        '- NEVER diagnose or give medical advice. Always recommend an in-person assessment.',
        '- Keep replies concise (2-4 sentences max). Do not write essays.',
        '- If you already have their name and phone, do NOT ask again.',
        '- If the patient seems unsure, reassure them that the consultation is free and no-commitment.',
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
        'Always respond with valid JSON matching the required schema. The reply_text field is what will be sent to the patient.',
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
        } else {
            parsed = await callGemini(scenario.messages);
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