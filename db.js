const mongoose = require('mongoose');

const cached = global._mongooseCached || (global._mongooseCached = { conn: null, promise: null });

function hasLocalhostMongoHost(uri) {
    if (!uri || typeof uri !== 'string') return false;
    const trimmed = uri.trim();
    if (!/^mongodb(\+srv)?:\/\//i.test(trimmed)) return false;

    // Strip scheme.
    const afterScheme = trimmed.replace(/^mongodb(\+srv)?:\/\//i, '');
    // Take authority section up to first '/', '?' or '#'.
    const authority = afterScheme.split(/[/?#]/, 1)[0] || '';
    // Drop credentials if present.
    const hostList = authority.includes('@') ? authority.split('@').pop() : authority;

    const hosts = hostList
        .split(',')
        .map((h) => (h || '').trim())
        .filter(Boolean)
        .map((h) => h.replace(/^\[(.*)\]$/, '$1')) // strip IPv6 brackets
        .map((h) => h.split(':', 1)[0].toLowerCase());

    return hosts.some((h) => h === 'localhost' || h === '127.0.0.1' || h === '::1');
}

const connectDB = async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        const err = new Error('MONGODB_URI environment variable is not set');
        err.code = 'MISSING_MONGODB_URI';
        throw err;
    }

    const isVercel = Boolean(process.env.VERCEL);
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production' || isVercel;
    if (isProd && hasLocalhostMongoHost(uri)) {
        const err = new Error(
            'MONGODB_URI points to localhost. This will not work on Vercel/production. Use a hosted MongoDB (e.g. MongoDB Atlas) connection string.'
        );
        err.code = 'INVALID_MONGODB_URI_LOCALHOST';
        throw err;
    }

    if (cached.conn) return cached.conn;

    try {
        mongoose.set('bufferCommands', false);

        if (!cached.promise) {
            cached.promise = mongoose.connect(uri).then((m) => m);
        }

        cached.conn = await cached.promise;
        console.log(`MongoDB Connected: ${cached.conn.connection.host}`);
        return cached.conn;
    } catch (error) {
        cached.promise = null;
        throw error;
    }
};

module.exports = connectDB;
