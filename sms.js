let twilio = null;
try {
    // Optional dependency until installed.
    // If not present, SMS will be skipped with a clear reason.
    // eslint-disable-next-line global-require
    twilio = require('twilio');
} catch (err) {
    twilio = null;
}

const SMS_ENABLED = String(process.env.SMS_ENABLED || '').toLowerCase() === 'true';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

let _twilioClient = null;

function isTwilioConfigured() {
    return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER && twilio);
}

function getTwilioClient() {
    if (_twilioClient) return _twilioClient;
    if (!twilio) {
        throw new Error('Twilio package is not installed. Run: npm install twilio');
    }
    _twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    return _twilioClient;
}

function normalizePhoneNumberE164(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Allow common formatting characters, keep leading '+' if present.
    const cleaned = trimmed.replace(/[()\-\s]/g, '');

    // Must be E.164 (+ and digits), or digits-only (will be rejected).
    if (/^\+[1-9]\d{6,14}$/.test(cleaned)) return cleaned;

    return null;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatLocalPartsFromUtc(dateUtc, tzOffsetMinutes) {
    if (!(dateUtc instanceof Date) || Number.isNaN(dateUtc.getTime())) return null;

    const offset = (tzOffsetMinutes === 0 || tzOffsetMinutes)
        ? (typeof tzOffsetMinutes === 'string' ? parseInt(tzOffsetMinutes, 10) : tzOffsetMinutes)
        : null;

    const localMs = (typeof offset === 'number' && !Number.isNaN(offset))
        ? (dateUtc.getTime() - offset * 60000)
        : dateUtc.getTime();

    const d = new Date(localMs);
    return {
        y: d.getUTCFullYear(),
        m: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hh: d.getUTCHours(),
        mm: d.getUTCMinutes(),
    };
}

function formatBookingWindow({ startUtc, endUtc, tzOffsetMinutes }) {
    const start = formatLocalPartsFromUtc(startUtc, tzOffsetMinutes);
    const end = formatLocalPartsFromUtc(endUtc, tzOffsetMinutes);
    if (!start || !end) return null;

    const dateStr = `${start.y}-${pad2(start.m)}-${pad2(start.day)}`;
    const startStr = `${pad2(start.hh)}:${pad2(start.mm)}`;
    const endStr = `${pad2(end.hh)}:${pad2(end.mm)}`;

    return { dateStr, startStr, endStr };
}

async function sendSms({ to, body }) {
    if (!SMS_ENABLED) return { ok: false, skipped: true, reason: 'SMS_ENABLED is false' };
    if (!twilio) return { ok: false, skipped: true, reason: 'Twilio package not installed' };
    if (!isTwilioConfigured()) return { ok: false, skipped: true, reason: 'Twilio env vars not configured' };

    const toE164 = normalizePhoneNumberE164(to);
    if (!toE164) return { ok: false, skipped: true, reason: 'Invalid phone number; use E.164 (+countrycode...)' };

    const client = getTwilioClient();
    const msg = await client.messages.create({
        to: toE164,
        from: TWILIO_FROM_NUMBER,
        body
    });

    return { ok: true, sid: msg.sid };
}

async function sendRideBookingConfirmationSms({ to, startUtc, endUtc, tzOffsetMinutes }) {
    const window = formatBookingWindow({ startUtc, endUtc, tzOffsetMinutes });
    if (!window) return { ok: false, skipped: true, reason: 'Invalid booking timestamps' };

    const body = `Your ride has been successfully booked for ${window.dateStr} from ${window.startStr} to ${window.endStr}.`;
    return sendSms({ to, body });
}

module.exports = {
    SMS_ENABLED,
    isTwilioConfigured,
    normalizePhoneNumberE164,
    sendSms,
    sendRideBookingConfirmationSms,
};
