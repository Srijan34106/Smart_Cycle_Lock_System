const mongoose = require('mongoose');

const cached = global._mongooseCached || (global._mongooseCached = { conn: null, promise: null });

const connectDB = async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        const err = new Error('MONGODB_URI environment variable is not set');
        err.code = 'MISSING_MONGODB_URI';
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
