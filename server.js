require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const connectDB = require('./db');
const Ride = require('./models/Ride');
const User = require('./models/User');
const authMiddleware = require('./authMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = Boolean(process.env.VERCEL);
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-development';

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

async function processPaymentAndStartRide(payload) {
    const {
        bookingDate,
        hours,
        minutes,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        userId
    } = payload || {};

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

    totalMinutesRaw = (parseInt(hours || 0) * 60) + parseInt(minutes || 0);

    if (totalMinutesRaw <= 0) {
        return { httpStatus: 400, body: { success: false, message: "Invalid duration" } };
    }

    expectedAmountInINR = Math.ceil(totalMinutesRaw / 30) * 100;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const selectedDate = new Date(bookingDate);
    selectedDate.setHours(0, 0, 0, 0);

    if (Number.isNaN(selectedDate.getTime())) {
        return { httpStatus: 400, body: { success: false, message: 'Invalid booking date' } };
    }

    const diffMs = selectedDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays < 0 || diffDays > 5) {
        return { httpStatus: 400, body: { success: false, message: 'Booking date must be within today and the next 5 days' } };
    }

    let startTimestamp = new Date();
    if (diffDays > 0) {
        const bookingTime = new Date(bookingDate);
        const current = new Date();
        bookingTime.setHours(current.getHours(), current.getMinutes(), current.getSeconds(), 0);
        startTimestamp = bookingTime;
    }

    const endTime = new Date(startTimestamp.getTime() + totalMinutesRaw * 60000);
    const amount = expectedAmountInINR;
    const now = new Date();
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

    await Ride.updateMany(
        { status: 'scheduled', start_time: { $lte: now }, end_time: { $gt: now } },
        { status: 'active' }
    );

    await Ride.updateMany(
        { status: 'active', end_time: { $lte: now } },
        { status: 'ended' }
    );
}

async function getStatusPayload(userId) {
    const now = new Date();

    const activeRide = await Ride.findOne({
        status: 'active',
        end_time: { $gt: now }
    }).sort({ start_time: -1 });

    const scheduledRide = await Ride.findOne({
        status: 'scheduled',
        start_time: { $gt: now }
    }).sort({ start_time: 1 });

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
        const { username, email, password } = req.body || {};
        if (!username || !email || !password) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }
        const existing = await User.findOne({ $or: [{ username }, { email }] });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Username or email already exists' });
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const user = await User.create({ username, email, password: hashedPassword });
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
    res.json({ success: true, user: { username: req.user.username, email: req.user.email } });
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

        res.json({ success: true, message: 'Scheduled booking canceled' });
    } catch (error) {
        console.error('Cancel-booking error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post(['/api/create-order', '/create-order'], authMiddleware, async (req, res) => {
    const { bookingDate, hours, minutes } = req.body;

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
        const hours = order?.notes?.hours;
        const minutes = order?.notes?.minutes;
        const userId = order?.notes?.userId;

        const result = await processPaymentAndStartRide({
            bookingDate,
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
    });
}
