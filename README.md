# 🚲 Smart Cycle Lock System

A **web-based Smart Bicycle Lock System** that integrates **MongoDB + Razorpay + Simulated Lock Control**.

This project demonstrates a **full-stack architecture**, where users can book a cycle online, pay via Razorpay, and manage their rides seamlessly.

---

## ✨ Features

* 🔐 Smart ride management (Active / Scheduled / Ended)
* 🌐 Web-based booking system
* 💳 Razorpay payment integration
* 🍃 MongoDB-based data persistence
* ⏱️ Scheduled rides + automated ride reconciliation
* ☁️ Cloud-ready (Vercel + MongoDB Atlas)

---

## 🏗️ System Architecture

```
Browser (Frontend)
        ↓ HTTP
Backend (Node.js / Express)
        ↓ 
MongoDB (Database)
```

---

## 🚀 Getting Started

### 1) Install

```bash
npm install
```

### 2) Configure environment

- Copy `.env.example` → `.env` and fill in values.
- Required for core functionality:
  - `MONGODB_URI` (MongoDB connection string)
- Required for payments:
  - `RAZORPAY_KEY_ID`
  - `RAZORPAY_KEY_SECRET`

Health checks:

- `GET /api/razorpay/health`
- `GET /api/db/health`

Notes:

- If you deploy to Vercel, `MONGODB_URI` must point to a hosted MongoDB instance (e.g. MongoDB Atlas). A `mongodb://localhost:27017/...` or `mongodb://127.0.0.1:27017/...` URI will fail in Vercel.

### 3) Run

```bash
npm start
```

Open:

- `http://localhost:3000/` (landing)
- `http://localhost:3000/dashboard.html` (booking + payment)

---

## 🔌 API Endpoints

Your frontend interacts with these endpoints:

* `GET /api/status` - Current ride status and history
* `POST /api/create-order` - Create Razorpay order (requires `bookingDate`, `bookingTime`, `hours`, `minutes`; `bookingStartTime` ISO is preferred)
* `POST /api/payment` - Verify payment and create ride (requires `bookingDate`, `bookingTime`, `hours`, `minutes`; `bookingStartTime` ISO is preferred)
* `POST /api/end-ride` - End an active ride manually
* `POST /api/cancel-booking` - Cancel a scheduled booking
* `GET /api/db/health` - Check database connectivity

---

## ⏱️ Automated Reconciliation

* The system periodically reconciles ride statuses (Scheduled → Active, Active → Ended).
* In production, this can be triggered by a Vercel Cron job calling `/api/cron/tick`.

---

## 💡 Why This Project Matters

* Demonstrates **modern full-stack architecture**
* Combines **payment gateways, real-time status tracking, and persistent storage**
* Follows **secure industry practices** (secrets in environment variables, server-side verification)

---

## 🔮 Future Improvements

* 📱 Mobile app integration
* 📍 GPS tracking of cycles
* 🔐 User authentication (JWT / OAuth)
* 📊 Admin analytics dashboard
