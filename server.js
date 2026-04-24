require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mqtt = require('mqtt');

const connectDB = require('./db');
const Ride = require('./models/Ride');
const User = require('./models/User');
const authMiddleware = require('./authMiddleware');
const { normalizePhoneNumberE164, sendRideBookingConfirmationSms } = require('./sms');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = Boolean(process.env.VERCEL);
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-development';

// --- MQTT (HiveMQ Cloud) ---
// Configure via env vars (do not hardcode secrets):
// - MQTT_BROKER_URL=mqtts://<host>:8883
// - MQTT_USERNAME=...
// - MQTT_PASSWORD=...
// - MQTT_TOPIC=esp32/test
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || '';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'esp32/test';

let mqttClient = null;
let mqttConnectPromise = null;

function isMqttConfigured() {
    return Boolean(MQTT_BROKER_URL && MQTT_USERNAME && MQTT_PASSWORD && MQTT_TOPIC);
}

function getMqttClient() {
    if (!isMqttConfigured()) return null;
    if (mqttClient) return mqttClient;

    // Create a single shared client (reused across requests when possible).
    mqttClient = mqtt.connect(MQTT_BROKER_URL, {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD,
        protocolVersion: 4,
        keepalive: 30,
        reconnectPeriod: 2000,
        connectTimeout: 10_000,
        // Ensure proper TLS verification (Node uses system CAs by default).
        rejectUnauthorized: true,
    });

    mqttClient.on('connect', () => {
        console.log('[MQTT] Connected');
    });
    mqttClient.on('reconnect', () => {
        console.log('[MQTT] Reconnecting...');
    });
    mqttClient.on('error', (err) => {
        console.error('[MQTT] Error:', err?.message || err);
    });
    mqttClient.on('close', () => {
        console.log('[MQTT] Closed');
    });

    return mqttClient;
}

function waitForMqttConnected(client) {
    if (!client) return Promise.resolve(false);
    if (client.connected) return Promise.resolve(true);

    if (!mqttConnectPromise) {
        mqttConnectPromise = new Promise((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                resolve(false);
            }, 10_000);

            const onConnect = () => {
                cleanup();
                resolve(true);
            };

            const onError = () => {
                cleanup();
                resolve(false);
            };

            function cleanup() {
                clearTimeout(timeout);
                client.off('connect', onConnect);
                client.off('error', onError);
                mqttConnectPromise = null;
            }

            client.on('connect', onConnect);
            client.on('error', onError);
        });
    }

    return mqttConnectPromise;
}

async function publishMqttCommand(command, meta = {}) {
    const client = getMqttClient();
    if (!client) return false;

    const ok = await waitForMqttConnected(client);
    if (!ok) return false;

    const payload = JSON.stringify({
        command,
        ts: new Date().toISOString(),
        ...meta
    });

    return new Promise((resolve) => {
        client.publish(MQTT_TOPIC, payload, { qos: 0, retain: false }, (err) => {
            if (err) {
                console.error('[MQTT] Publish failed:', err?.message || err);
                return resolve(false);
            }
            console.log(`[MQTT] Published ${command} to ${MQTT_TOPIC}`);
            resolve(true);
        });
    });
}

// In-memory timers (only reliable for long-running servers; not for Vercel serverless)
const rideTimers = new Map(); // rideId -> { activateTimeout, endTimeout }

// Connect to MongoDB (eager connect only for local dev).
if (!IS_VERCEL) {
    connectDB().catch((err) => {
        console.error('MongoDB connection failed:', err);
    });
}

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const ALLOW_SIMULATED_PAYMENT = String(process.env.ALLOW_SIMULATED_PAYMENT || '').toLowerCase() === 'true';

const RAZORPAY_ENABLED = Boolean(
    RAZORPAY_KEY_ID &&
    RAZORPAY_KEY_SECRET &&
    RAZORPAY_KEY_ID !== 'YOUR_RAZORPAY_KEY_ID' &&
    RAZORPAY_KEY_SECRET !== 'YOUR_RAZORPAY_KEY_SECRET'
);

// Global Setup
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let razorpayInstance = null;
if (RAZORPAY_ENABLED) {
    try {
        razorpayInstance = new Razorpay({
            key_id: RAZORPAY_KEY_ID,
            key_secret: RAZORPAY_KEY_SECRET,
        });
        console.log('Razorpay configured successfully');
    } catch(err) {
        console.error("Razorpay initiation error:", err);
    }
} else {
    console.warn(`[WARNING] Razorpay is NOT configured. Ensure ALLOW_SIMULATED_PAYMENT is true to bypass.`);
}

// --- Helper Functions ---

function parseLocalDate(ymd) {
    if (!ymd || typeof ymd !== 'string') return null;
    const parts = ymd.split('-').map((v) => parseInt(v, 10));
    if (parts.length !== 3) return null;
    const [year, month, day] = parts;
    if (!year || !month || !day) return null;
    const dt = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (Number.isNaN(dt.getTime())) return null;
    // Guard against JS Date overflow quirks
    if (dt.getFullYear() !== year || dt.getMonth() !== (month - 1) || dt.getDate() !== day) return null;
    return dt;
}

function parseTimeHHMM(hhmm) {
    if (!hhmm || typeof hhmm !== 'string') return null;
    const [hStr, mStr] = hhmm.split(':');
    const hours = parseInt(hStr, 10);
    const minutes = parseInt(mStr, 10);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    if (hours < 0 || hours > 23) return null;
    if (minutes < 0 || minutes > 59) return null;
    return { hours, minutes };
}

function buildLocalDateTime(ymd, hhmm) {
    const d = parseLocalDate(ymd);
    const t = parseTimeHHMM(hhmm);
    if (!d || !t) return null;
    d.setHours(t.hours, t.minutes, 0, 0);
    if (Number.isNaN(d.getTime())) return null;
    return d;
}

function buildUtcDateTimeFromLocalAndOffset(ymd, hhmm, tzOffsetMinutes) {
    // tzOffsetMinutes matches JS Date.getTimezoneOffset(): minutes to add to local time to get UTC.
    const d = parseLocalDate(ymd);
    const t = parseTimeHHMM(hhmm);
    const offset = typeof tzOffsetMinutes === 'string' ? parseInt(tzOffsetMinutes, 10) : tzOffsetMinutes;
    if (!d || !t) return null;
    if (typeof offset !== 'number' || Number.isNaN(offset)) return null;

    const utcMs = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), t.hours, t.minutes, 0, 0) + (offset * 60000);
    const dt = new Date(utcMs);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
}

function clearRideTimers(rideId) {
    const key = String(rideId);
    const timers = rideTimers.get(key);
    if (!timers) return;

    if (timers.activateTimeout) clearTimeout(timers.activateTimeout);
    if (timers.endTimeout) clearTimeout(timers.endTimeout);
    rideTimers.delete(key);
}

async function activateRideNow(rideId) {
    try {
        await connectDB();
        const now = new Date();
        const ride = await Ride.findOne({ _id: rideId, status: 'scheduled' });
        if (!ride) return;
        if (ride.start_time <= now && ride.end_time > now) {
            ride.status = 'active';
            await ride.save();
            console.log(`[RIDE] Activated (unlock) rideId=${rideId}`);

            // Notify devices/dashboard via MQTT
            publishMqttCommand('UNLOCK', { rideId: String(rideId), reason: 'scheduled_activation' }).catch(() => {});
        }
    } catch (err) {
        console.error('[RIDE] Activation timer failed:', err);
    }
}

async function endRideNow(rideId) {
    try {
        await connectDB();
        const now = new Date();
        const ride = await Ride.findOne({ _id: rideId, status: 'active' });
        if (!ride) return;
        if (ride.end_time <= now) {
            ride.status = 'ended';
            await ride.save();
            console.log(`[RIDE] Ended (auto) rideId=${rideId}`);

            // Notify devices/dashboard via MQTT
            publishMqttCommand('LOCK', { rideId: String(rideId), reason: 'auto_end' }).catch(() => {});
        }
    } catch (err) {
        console.error('[RIDE] End timer failed:', err);
    }
}

function scheduleRideTimersFor(ride) {
    if (!ride || IS_VERCEL) return;

    const rideId = String(ride._id);
    clearRideTimers(rideId);

    const now = Date.now();
    const startMs = new Date(ride.start_time).getTime() - now;
    const endMs = new Date(ride.end_time).getTime() - now;

    const timers = { activateTimeout: null, endTimeout: null };

    if (startMs > 0 && ride.status === 'scheduled') {
        timers.activateTimeout = setTimeout(() => {
            activateRideNow(rideId).finally(() => {
                const existing = rideTimers.get(rideId);
                if (existing) existing.activateTimeout = null;
            });
        }, startMs);
    }

    if (endMs > 0 && (ride.status === 'active' || ride.status === 'scheduled')) {
        timers.endTimeout = setTimeout(() => {
            endRideNow(rideId).finally(() => {
                const existing = rideTimers.get(rideId);
                if (existing) existing.endTimeout = null;
            });
        }, endMs);
    }

    rideTimers.set(rideId, timers);
}

async function processPaymentAndStartRide(payload) {
    const {
        bookingDate,
        bookingTime,
        bookingStartTime,
        tzOffsetMinutes,
        hours,
        minutes,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        userId
    } = payload || {};

    if (!userId) {
        return { httpStatus: 400, body: { success: false, message: 'Missing userId' } };
    }

    let expectedAmountInINR = 0;
    let totalMinutesRaw = 0;

    if (RAZORPAY_ENABLED && !ALLOW_SIMULATED_PAYMENT) {
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return { httpStatus: 400, body: { success: false, message: 'Missing Razorpay properties' } };
        }

        const generated_signature = crypto
            .createHmac('sha256', RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            return { httpStatus: 400, body: { success: false, message: 'Invalid payment signature' } };
        }
    }

    if (!bookingDate) {
        return { httpStatus: 400, body: { success: false, message: "Booking date is required" } };
    }

    // bookingStartTime is preferred (client-computed ISO to avoid server timezone differences)
    const normalizedBookingStartTime = (typeof bookingStartTime === 'string') ? bookingStartTime.trim() : bookingStartTime;
    if (!normalizedBookingStartTime && !bookingTime) {
        return { httpStatus: 400, body: { success: false, message: "Booking time is required" } };
    }

    totalMinutesRaw = (parseInt(hours || 0) * 60) + parseInt(minutes || 0);

    if (totalMinutesRaw <= 0) {
        return { httpStatus: 400, body: { success: false, message: "Invalid duration" } };
    }

    expectedAmountInINR = Math.ceil(totalMinutesRaw / 30) * 100;

    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const selectedDateMidnight = parseLocalDate(bookingDate);

    if (!selectedDateMidnight) {
        return { httpStatus: 400, body: { success: false, message: 'Invalid booking date' } };
    }

    const diffMs = selectedDateMidnight.getTime() - todayMidnight.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays < 0 || diffDays > 5) {
        return { httpStatus: 400, body: { success: false, message: 'Booking date must be within today and the next 5 days' } };
    }

    let startTimestamp = null;
    if (normalizedBookingStartTime) {
        const parsed = new Date(normalizedBookingStartTime);
        if (!Number.isNaN(parsed.getTime())) startTimestamp = parsed;
    }
    if (!startTimestamp) {
        startTimestamp = buildUtcDateTimeFromLocalAndOffset(bookingDate, bookingTime, tzOffsetMinutes)
            || buildLocalDateTime(bookingDate, bookingTime);
    }
    if (!startTimestamp) {
        return { httpStatus: 400, body: { success: false, message: 'Invalid booking time' } };
    }

    // Allow a small grace window for "now" bookings (time input has no seconds)
    const now = new Date();
    const graceMs = 2 * 60 * 1000;
    if (startTimestamp.getTime() < (now.getTime() - graceMs)) {
        return { httpStatus: 400, body: { success: false, message: 'Booking time must be in the future' } };
    }

    if (startTimestamp.getTime() <= now.getTime() && (now.getTime() - startTimestamp.getTime()) <= graceMs) {
        startTimestamp = now;
    }

    // Extra guard: enforce "within today + next 5 days" as a simple future-window.
    // This avoids timezone-dependent edge cases on serverless (UTC) while still preventing far-future bookings.
    const maxFutureMs = 6 * 24 * 60 * 60 * 1000; // ~6 days window (inclusive date rule)
    if (startTimestamp.getTime() - now.getTime() > maxFutureMs) {
        return { httpStatus: 400, body: { success: false, message: 'Booking date must be within today and the next 5 days' } };
    }

    const endTime = new Date(startTimestamp.getTime() + totalMinutesRaw * 60000);
    const amount = expectedAmountInINR;
    const isFuture = startTimestamp > now;

    const activeExisting = await Ride.findOne({
        status: 'active',
        end_time: { $gt: now }
    });

    if (activeExisting) {
        return { httpStatus: 400, body: { success: false, message: 'A ride is already active. End it first.' } };
    }

    const scheduledExisting = await Ride.findOne({
        status: 'scheduled',
        start_time: { $gt: now }
    });

    if (scheduledExisting) {
        return { httpStatus: 400, body: { success: false, message: 'A booking is already scheduled. Cancel it first.' } };
    }

    const rideStatus = isFuture ? 'scheduled' : 'active';
    const created = await Ride.create({
        userId,
        status: rideStatus,
        start_time: startTimestamp,
        end_time: endTime,
        amount
    });

    // Best-effort SMS (never blocks booking success)
    (async () => {
        try {
            const user = await User.findById(userId, { phoneNumber: 1 });
            const to = user?.phoneNumber;
            if (!to) return;

            const smsResult = await sendRideBookingConfirmationSms({
                to,
                startUtc: startTimestamp,
                endUtc: endTime,
                tzOffsetMinutes
            });

            if (smsResult?.ok) {
                console.log(`[SMS] Booking confirmation sent (sid=${smsResult.sid})`);
            } else if (smsResult?.skipped) {
                console.log(`[SMS] Skipped booking confirmation: ${smsResult.reason}`);
            } else {
                console.warn('[SMS] Failed to send booking confirmation');
            }
        } catch (err) {
            console.error('[SMS] Booking confirmation error:', err?.message || err);
        }
    })();

    // Notify devices/dashboard via MQTT.
    // - If ride is active now: unlock.
    // - If ride is scheduled for future: keep lock.
    publishMqttCommand(isFuture ? 'LOCK' : 'UNLOCK', {
        rideId: String(created._id),
        reason: isFuture ? 'scheduled_booking' : 'payment_unlock',
        startTime: startTimestamp.toISOString(),
        endTime: endTime.toISOString(),
        amount
    }).catch(() => {});

    // For long-running servers, schedule activation/end to be as precise as possible.
    scheduleRideTimersFor(created);

    return {
        httpStatus: 200,
        body: {
            success: true,
            message: isFuture ? 'Booking Scheduled.' : 'Payment Successful. Unlocking...',
            unlock: !isFuture,
            startTime: startTimestamp.toISOString(),
            endTime: endTime.toISOString(),
            durationMinutes: totalMinutesRaw,
            isFuture: isFuture,
            rideId: created._id
        }
    };
}

async function reconcileRides() {
    const now = new Date();

    // scheduled -> active (unlock)
    const toActivate = await Ride.find(
        { status: 'scheduled', start_time: { $lte: now }, end_time: { $gt: now } },
        { _id: 1 }
    ).limit(50);

    if (toActivate.length) {
        await Ride.updateMany(
            { _id: { $in: toActivate.map((r) => r._id) }, status: 'scheduled' },
            { status: 'active' }
        );

        toActivate.forEach((r) => {
            publishMqttCommand('UNLOCK', { rideId: String(r._id), reason: 'reconcile_activation' }).catch(() => {});
        });
    }

    // active -> ended (lock)
    const toEnd = await Ride.find(
        { status: 'active', end_time: { $lte: now } },
        { _id: 1 }
    ).limit(50);

    if (toEnd.length) {
        await Ride.updateMany(
            { _id: { $in: toEnd.map((r) => r._id) }, status: 'active' },
            { status: 'ended' }
        );

        toEnd.forEach((r) => {
            publishMqttCommand('LOCK', { rideId: String(r._id), reason: 'reconcile_end' }).catch(() => {});
        });
    }
}

async function getStatusPayload(userId) {
    const now = new Date();

    const activeQuery = {
        status: 'active',
        end_time: { $gt: now }
    };

    const scheduledQuery = {
        status: 'scheduled',
        start_time: { $gt: now }
    };

    if (userId) {
        activeQuery.userId = userId;
        scheduledQuery.userId = userId;
    }

    const activeRide = await Ride.findOne(activeQuery).sort({ start_time: -1 });
    const scheduledRide = await Ride.findOne(scheduledQuery).sort({ start_time: 1 });

    let history = [];
    if (userId) {
        history = await Ride.find({
            userId,
            status: { $in: ['active', 'ended', 'scheduled'] }
        }).sort({ created_at: -1 }).limit(10);
    }

    const rideToDisplay = activeRide || scheduledRide;
    const isLocked = !activeRide;
    const isOwner = rideToDisplay && rideToDisplay.userId && userId && rideToDisplay.userId.toString() === userId.toString();

    const endTime = rideToDisplay?.end_time || null;
    const remainingMs = endTime ? new Date(endTime) - now : 0;

    return {
        isLocked,
        isOwner,
        rideActive: !isLocked,
        startTime: (isOwner || !rideToDisplay) ? rideToDisplay?.start_time || null : null,
        endTime: (isOwner || !rideToDisplay) ? endTime : null,
        remainingMinutes: Math.max(0, Math.floor(remainingMs / 60000)),
        remainingSeconds: Math.max(0, Math.floor((remainingMs % 60000) / 1000)),
        rideHistory: history.map((r) => ({
            startTime: r.start_time,
            endTime: r.end_time,
            amount: r.amount,
            status: r.status
        }))
    };
}

// --- API Routes ---

app.use('/api', async (req, res, next) => {
    // Allow non-DB endpoint(s) through without blocking.
    if (req.path === '/version') return next();

    try {
        await connectDB();
        return next();
    } catch (err) {
        console.error('Database not ready:', err);
        if (err && err.code === 'MISSING_MONGODB_URI') {
            return res.status(500).json({ success: false, message: 'Database not configured. Set MONGODB_URI in Vercel Environment Variables.' });
        }
        if (err && err.code === 'INVALID_MONGODB_URI_LOCALHOST') {
            return res.status(500).json({ success: false, message: 'Database misconfigured. MONGODB_URI must not point to localhost on Vercel/production.' });
        }
        return res.status(500).json({ success: false, message: 'Database connection failed' });
    }
});

app.post(['/api/register', '/register'], async (req, res) => {
    try {
        const { username, email, password, phoneNumber } = req.body || {};
        if (!username || !email || !password) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }

        if (phoneNumber) {
            const normalized = normalizePhoneNumberE164(phoneNumber);
            if (!normalized) {
                return res.status(400).json({ success: false, message: 'Invalid phoneNumber. Use E.164 format, e.g. +919876543210' });
            }
        }

        const existing = await User.findOne({ $or: [{ username }, { email }] });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Username or email already exists' });
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const user = await User.create({
            username,
            email,
            password: hashedPassword,
            phoneNumber: phoneNumber ? normalizePhoneNumberE164(phoneNumber) : null
        });
        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, username: user.username });
    } catch (error) {
        console.error("Register error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.post(['/api/login', '/login'], async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ success: false, message: "Username and password required" });
        }
        const user = await User.findOne({ username });
        if (!user) return res.status(401).json({ success: false, message: "Invalid credentials" });
        
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Invalid credentials" });
        
        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, username: user.username });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ success: false, message: "Server error during login" });
    }
});

app.get('/api/profile', authMiddleware, (req, res) => {
    res.json({
        success: true,
        user: {
            username: req.user.username,
            email: req.user.email,
            phoneNumber: req.user.phoneNumber || null
        }
    });
});

app.put('/api/profile', authMiddleware, async (req, res) => {
    try {
        const { phoneNumber } = req.body || {};

        if (!phoneNumber) {
            req.user.phoneNumber = null;
            await req.user.save();
            return res.json({ success: true, user: { phoneNumber: null } });
        }

        const normalized = normalizePhoneNumberE164(phoneNumber);
        if (!normalized) {
            return res.status(400).json({ success: false, message: 'Invalid phoneNumber. Use E.164 format, e.g. +919876543210' });
        }

        req.user.phoneNumber = normalized;
        await req.user.save();
        res.json({ success: true, user: { phoneNumber: normalized } });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get(['/api/version'], (req, res) => {
    res.json({
        name: 'smart-cycle-lock',
        vercel: IS_VERCEL,
        git: {
            commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
            repo: process.env.VERCEL_GIT_REPO_SLUG || null,
            ref: process.env.VERCEL_GIT_COMMIT_REF || null
        }
    });
});

app.get(['/api/cron/tick', '/cron/tick'], async (req, res) => {
    try {
        const cronSecret = process.env.CRON_SECRET;
        if (cronSecret) {
            const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.secret;
            if (provided !== cronSecret) {
                return res.status(401).json({ success: false, message: 'Unauthorized' });
            }
        }

        await reconcileRides();
        res.json({ success: true, ranAt: new Date().toISOString() });
    } catch (error) {
        console.error('Cron tick error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get(['/api/status', '/status'], authMiddleware, async (req, res) => {
    try {
        await reconcileRides();
        const payload = await getStatusPayload(req.user._id);
        res.json(payload);
    } catch (error) {
        console.error('Status error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get(['/api/lock-status', '/lock-status'], async (req, res) => {
    try {
        await reconcileRides();
        const payload = await getStatusPayload(null);
        res.json({
            unlock: !payload.isLocked,
            timeLeft: payload.endTime ? Math.max(0, Math.floor((new Date(payload.endTime) - new Date()) / 1000)) : 0
        });
    } catch (error) {
        console.error('Lock-status error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post(['/api/end-ride', '/end-ride'], authMiddleware, async (req, res) => {
    try {
        const now = new Date();
        const updated = await Ride.findOneAndUpdate(
            { userId: req.user._id, status: 'active', end_time: { $gt: now } },
            { status: 'ended', end_time: now },
            { new: true }
        );

        if (!updated) {
            return res.status(400).json({ success: false, message: 'Ride not active or not yours' });
        }

        console.log('Ride ended manually by user.');
        if (updated?._id) clearRideTimers(updated._id);

        // Notify devices/dashboard via MQTT
        publishMqttCommand('LOCK', { rideId: String(updated._id), reason: 'manual_end' }).catch(() => {});
        res.json({ success: true, message: 'Ride ended successfully' });
    } catch (error) {
        console.error('End-ride error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post(['/api/cancel-booking', '/cancel-booking'], authMiddleware, async (req, res) => {
    try {
        const now = new Date();
        const scheduled = await Ride.findOne({
            userId: req.user._id,
            status: 'scheduled',
            start_time: { $gt: now }
        }).sort({ start_time: 1 });

        if (!scheduled) {
            return res.status(400).json({ success: false, message: 'No scheduled booking to cancel' });
        }

        scheduled.status = 'canceled';
        await scheduled.save();

    clearRideTimers(scheduled._id);

        // Notify devices/dashboard via MQTT
        publishMqttCommand('LOCK', { rideId: String(scheduled._id), reason: 'cancel_booking' }).catch(() => {});

        res.json({ success: true, message: 'Scheduled booking canceled' });
    } catch (error) {
        console.error('Cancel-booking error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post(['/api/create-order', '/create-order'], authMiddleware, async (req, res) => {
    const { bookingDate, bookingTime, bookingStartTime, tzOffsetMinutes, hours, minutes } = req.body;

    if (!RAZORPAY_ENABLED) {
        if (ALLOW_SIMULATED_PAYMENT) {
            return res.status(400).json({
                success: false,
                message: 'Razorpay is not configured. Disable ALLOW_SIMULATED_PAYMENT or set RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET.'
            });
        }
        return res.status(500).json({ success: false, message: 'Razorpay is not configured.' });
    }

    if (!bookingDate) return res.status(400).json({ success: false, message: "Booking date is required" });
    if (!bookingStartTime && !bookingTime) return res.status(400).json({ success: false, message: "Booking time is required" });

    // Early validation for date+time/startTime format (pricing does not depend on time, but we want consistent notes)
    const parsedStart = bookingStartTime ? new Date(bookingStartTime) : null;
    if (bookingStartTime && (Number.isNaN(parsedStart.getTime()))) {
        return res.status(400).json({ success: false, message: "Invalid bookingStartTime" });
    }
    if (!bookingStartTime) {
        const dt = buildLocalDateTime(bookingDate, bookingTime);
        if (!dt) return res.status(400).json({ success: false, message: "Invalid booking date/time" });
    }

    const totalMinutes = (parseInt(hours || 0) * 60) + parseInt(minutes || 0);
    if (totalMinutes <= 0) return res.status(400).json({ success: false, message: "Invalid duration" });

    const amountInINR = Math.ceil(totalMinutes / 30) * 100;
    const amountInPaise = amountInINR * 100;

    try {
        if (!razorpayInstance) return res.status(500).json({ success: false, message: 'Razorpay instance not available' });

        const order = await razorpayInstance.orders.create({
            amount: amountInPaise,
            currency: 'INR',
            receipt: 'receipt_' + Date.now(),
            notes: {
                userId: req.user._id.toString(),
                bookingDate: String(bookingDate),
                bookingTime: String(bookingTime),
                bookingStartTime: bookingStartTime ? String(bookingStartTime) : '',
                tzOffsetMinutes: (tzOffsetMinutes === 0 || tzOffsetMinutes) ? String(tzOffsetMinutes) : '',
                hours: String(parseInt(hours || 0)),
                minutes: String(parseInt(minutes || 0))
            }
        });

        res.json({
            success: true,
            orderId: order.id,
            amount: amountInPaise,
            currency: 'INR',
            key: RAZORPAY_KEY_ID
        });
    } catch (error) {
        console.error("Razorpay order creation error:", error);
        res.status(500).json({ success: false, message: "Error creating order" });
    }
});

function sendCallbackResultPage(res, { ok, isFuture, reason }) {
    const paymentFlag = ok ? (isFuture ? 'scheduled' : 'success') : 'error';
    const redirectUrl = ok
        ? `/dashboard.html?payment=${paymentFlag}`
        : `/dashboard.html?payment=${paymentFlag}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`;

    res.status(200)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send(`<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${redirectUrl}" />
</head>
<body style="font-family: sans-serif; padding: 24px;">
    <h2>${ok ? 'Payment processed' : 'Payment could not be verified'}</h2>
    <p>Redirecting back to dashboard...</p>
</body>
</html>`);
}

async function handleRazorpayCallback(req, res) {
    try {
        const body = req.body || {};
        const query = req.query || {};
        const razorpay_order_id = body.razorpay_order_id || query.razorpay_order_id;
        const razorpay_payment_id = body.razorpay_payment_id || query.razorpay_payment_id;
        const razorpay_signature = body.razorpay_signature || query.razorpay_signature;

        if (!RAZORPAY_ENABLED) return sendCallbackResultPage(res, { ok: false, reason: 'razorpay_not_configured' });
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return sendCallbackResultPage(res, { ok: false, reason: 'missing_fields' });
        if (!razorpayInstance) return sendCallbackResultPage(res, { ok: false, reason: 'razorpay_instance' });

        const order = await razorpayInstance.orders.fetch(razorpay_order_id);
        const bookingDate = order?.notes?.bookingDate;
        const bookingTime = order?.notes?.bookingTime;
        const bookingStartTime = order?.notes?.bookingStartTime;
        const tzOffsetMinutes = order?.notes?.tzOffsetMinutes;
        const hours = order?.notes?.hours;
        const minutes = order?.notes?.minutes;
        const userId = order?.notes?.userId;

        const result = await processPaymentAndStartRide({
            bookingDate,
            bookingTime,
            bookingStartTime,
            tzOffsetMinutes,
            hours,
            minutes,
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            userId
        });

        if (result?.body?.success) {
            return sendCallbackResultPage(res, { ok: true, isFuture: result.body.isFuture });
        }

        return sendCallbackResultPage(res, { ok: false, reason: 'verification_failed' });
    } catch (error) {
        console.error('Razorpay callback error:', error);
        return sendCallbackResultPage(res, { ok: false, reason: 'server_error' });
    }
}

app.post(['/api/razorpay/callback'], handleRazorpayCallback);
app.get(['/api/razorpay/callback'], handleRazorpayCallback);

app.post(['/api/payment', '/payment'], authMiddleware, async (req, res) => {
    try {
        req.body = req.body || {};
        req.body.userId = req.user._id;
        const result = await processPaymentAndStartRide(req.body);
        res.status(result.httpStatus || 500).json(result.body || { success: false, message: 'Unknown error' });
    } catch (error) {
        console.error('Payment error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// For Vercel specific environments
if (IS_VERCEL) {
    console.log("Exporting app for Vercel Serverless Function");
    module.exports = app;
} else if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server is running on port: ${PORT}`);

        // Best-effort: schedule timers for any upcoming rides (local/long-running server only)
        (async () => {
            if (IS_VERCEL) return;
            try {
                await connectDB();
                const now = new Date();
                const rides = await Ride.find({
                    status: { $in: ['scheduled', 'active'] },
                    end_time: { $gt: now }
                }).sort({ start_time: 1 }).limit(50);
                rides.forEach(scheduleRideTimersFor);
                if (rides.length) console.log(`[RIDE] Scheduled timers for ${rides.length} upcoming ride(s)`);
            } catch (err) {
                console.error('[RIDE] Failed to schedule upcoming rides on startup:', err);
            }
        })();
    });
}
