
const API_URL = '/api';

async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('token');
    const headers = options.headers || {};
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    options.headers = headers;
    const res = await window.fetch(url, options);
    if (res.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = 'login.html';
    }
    return res;
}

function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const s = (totalSeconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

async function initDashboard() {

    // Fetch user profile
    try {
        const profileRes = await apiFetch(`${API_URL}/profile`);
        if (profileRes.ok) {
            const pd = await profileRes.json();
            if (pd.success && pd.user) {
                const ud = document.getElementById('user-display');
                if (ud) ud.innerText = pd.user.username;
                const ed = document.getElementById('email-display');
                if (ed) ed.innerText = pd.user.email;
                window.currentUserProfile = pd.user;
            }
        }
    } catch (e) {
        console.error("Profile fetch error", e);
    }

    const lockStatusEl = document.getElementById('lock-status');
    const timerEl = document.getElementById('timer');
    const rideInfoEl = document.getElementById('ride-info');
    const bookBtn = document.getElementById('book-btn');
    const cancelBookingBtn = document.getElementById('cancel-booking-btn');
    const endRideBtn = document.getElementById('end-ride-btn');
    const historyList = document.getElementById('history-list');
    const progressBarFill = document.getElementById('progress-bar-fill');

    // Modal elements
    const modal = document.getElementById('booking-modal');
    const closeModal = document.querySelector('.close-modal');

    // Step Elements
    const step1 = document.getElementById('booking-step-1');
    const step2 = document.getElementById('booking-step-2');
    const step3 = document.getElementById('booking-step-3');
    const nextBtn = document.getElementById('next-btn');
    const timeNextBtn = document.getElementById('time-next-btn');
    const timeBackBtn = document.getElementById('time-back-btn');
    const backBtn = document.getElementById('back-btn');

    // Inputs
    const bookingDateInput = document.getElementById('booking-date');
    const bookingTimeInput = document.getElementById('booking-time');
    const hoursInput = document.getElementById('hours-input');
    const minutesInput = document.getElementById('minutes-input');

    const payBtn = document.getElementById('pay-btn');
    const costDisplay = document.getElementById('cost-display');

    // --- UI Timer and State Tracking ---
    let globalStartTime = null;
    let globalEndTime = null;
    let currentUiState = null; // 'SCHEDULED', 'LOCKED', 'UNLOCKED'

    function updateUITimer() {
        if (currentUiState !== 'UNLOCKED') return;
        if (!globalEndTime || !globalStartTime) return;

        const now = new Date();
        let remainingMs = globalEndTime - now;
        if (remainingMs < 0) remainingMs = 0;

        timerEl.innerText = formatTime(remainingMs);

        // Update Progress Bar
        if (progressBarFill) {
            const totalDuration = globalEndTime - globalStartTime;
            const percentage = Math.max(0, Math.min(100, (remainingMs / totalDuration) * 100));
            progressBarFill.style.width = `${percentage}%`;

            if (percentage < 20) {
                progressBarFill.style.backgroundColor = 'var(--danger)';
            } else {
                progressBarFill.style.backgroundColor = 'var(--accent)';
            }
        }
    }

    // Tick the timer every second for smooth UI
    setInterval(updateUITimer, 1000);

    // --- State Polling ---
    async function updateStatus() {
        try {
            const res = await apiFetch(`${API_URL}/status`);
            const data = await res.json();

            // Update Lock Status
            const now = new Date();
            const startTime = data.startTime ? new Date(data.startTime) : null;
            const endTime = data.endTime ? new Date(data.endTime) : null;

            globalStartTime = startTime;
            globalEndTime = endTime;

            const isScheduled = data.isLocked && startTime && startTime > now;

            let newState = 'LOCKED';
            if (isScheduled) newState = 'SCHEDULED';
            else if (!data.isLocked) newState = 'UNLOCKED';

            // Only update DOM structure if state changed
            if (currentUiState !== newState) {
                currentUiState = newState;

                if (newState === 'SCHEDULED') {
                    lockStatusEl.className = 'status-badge status-locked';
                    lockStatusEl.innerHTML = 'SCHEDULED ';
                    lockStatusEl.style.backgroundColor = 'rgba(255, 193, 7, 0.1)';
                    lockStatusEl.style.color = '#FFC107';

                    rideInfoEl.classList.add('hidden');

                    const startStr = startTime.toLocaleString();
                    bookBtn.style.display = 'block';
                    bookBtn.disabled = true;
                    bookBtn.style.opacity = '0.7';
                    bookBtn.innerText = `Booked for ${startStr}`;
                    cancelBookingBtn.style.display = 'block';
                    endRideBtn.style.display = 'none';

                    timerEl.innerText = "00:00:00";
                    if (progressBarFill) progressBarFill.style.width = '0%';

                } else if (newState === 'LOCKED') {
                    lockStatusEl.className = 'status-badge status-locked';
                    lockStatusEl.innerHTML = 'LOCKED ';
                    lockStatusEl.style.backgroundColor = '';
                    lockStatusEl.style.color = '';

                    rideInfoEl.classList.add('hidden');

                    timerEl.innerText = "00:00:00";
                    if (progressBarFill) progressBarFill.style.width = '0%';

                    bookBtn.style.display = 'block';
                    endRideBtn.style.display = 'none';
                    cancelBookingBtn.style.display = 'none';

                    bookBtn.disabled = false;
                    bookBtn.style.opacity = '1';
                    bookBtn.innerText = "Book a Ride";

                } else if (newState === 'UNLOCKED') {
                    lockStatusEl.className = 'status-badge status-unlocked';
                    lockStatusEl.innerHTML = 'UNLOCKED ';
                    lockStatusEl.style.backgroundColor = '';
                    lockStatusEl.style.color = '';

                    rideInfoEl.classList.remove('hidden');

                    bookBtn.style.display = 'none';
                    endRideBtn.style.display = 'block';
                    cancelBookingBtn.style.display = 'none';

                    bookBtn.disabled = true;
                    bookBtn.style.opacity = '0.5';
                    bookBtn.innerText = "Ride in Progress";
                }
            }

            // Always update history
            updateHistory(data.rideHistory);
        } catch (err) {
            console.error("Status fetch error", err);
        }
    }

    function updateHistory(history) {
        if (!history || history.length === 0) return;

        const newHtml = history.map(ride => `
            <div class="history-item">
                <span>${new Date(ride.startTime).toLocaleTimeString()}</span>
                <span style="color: var(--success);">₹${ride.amount}</span>
            </div>
        `).join('');

        // Prevent unnecessary DOM churning which dismisses browser dialogs
        if (historyList.innerHTML !== newHtml) {
            historyList.innerHTML = newHtml;
        }
    }

    // Poll server every 5 seconds
    setInterval(updateStatus, 5000);
    updateStatus(); // Initial call

    // --- End Ride Flow ---
    let confirmEndRideTimer = null;
    endRideBtn.addEventListener('click', async () => {
        if (endRideBtn.innerText === 'End Ride') {
            endRideBtn.innerText = 'Tap again to confirm';
            endRideBtn.style.backgroundColor = 'darkred';
            confirmEndRideTimer = setTimeout(() => {
                endRideBtn.innerText = 'End Ride';
                endRideBtn.style.backgroundColor = 'var(--danger)';
            }, 4000);
            return;
        }

        clearTimeout(confirmEndRideTimer);
        endRideBtn.innerText = 'Ending...';

        try {
            const res = await apiFetch(`${API_URL}/end-ride`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                // Immediate UI update before poll
                timerEl.innerText = "00:00:00";
                if (progressBarFill) progressBarFill.style.width = '0%';
                rideInfoEl.classList.add('hidden');
                updateStatus();
            } else {
                endRideBtn.innerText = 'Error Ending';
                setTimeout(() => {
                    endRideBtn.innerText = 'End Ride';
                    endRideBtn.style.backgroundColor = 'var(--danger)';
                }, 2000);
                console.error("Error ending ride: " + data.message);
            }
        } catch (err) {
            console.error("Error ending ride", err);
            endRideBtn.innerText = 'End Ride';
            endRideBtn.style.backgroundColor = 'var(--danger)';
        }
    });

    // --- Cancel Scheduled Booking Flow ---
    let confirmCancelTimer = null;
    cancelBookingBtn.addEventListener('click', async () => {
        if (cancelBookingBtn.innerText === 'Cancel Booking') {
            cancelBookingBtn.innerText = 'Tap again to confirm';
            cancelBookingBtn.style.color = 'darkred';
            cancelBookingBtn.style.borderColor = 'darkred';
            confirmCancelTimer = setTimeout(() => {
                cancelBookingBtn.innerText = 'Cancel Booking';
                cancelBookingBtn.style.color = '';
                cancelBookingBtn.style.borderColor = '';
            }, 4000);
            return;
        }

        clearTimeout(confirmCancelTimer);
        cancelBookingBtn.innerText = 'Canceling...';

        try {
            const res = await apiFetch(`${API_URL}/cancel-booking`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                updateStatus();
            } else {
                cancelBookingBtn.innerText = 'Error Canceling';
                setTimeout(() => {
                    cancelBookingBtn.innerText = 'Cancel Booking';
                    cancelBookingBtn.style.color = '';
                    cancelBookingBtn.style.borderColor = '';
                }, 2000);
            }
        } catch (err) {
            console.error("Error canceling booking", err);
            cancelBookingBtn.innerText = 'Cancel Booking';
            cancelBookingBtn.style.color = '';
            cancelBookingBtn.style.borderColor = '';
        }
    });

    // --- Booking Flow ---
    bookBtn.addEventListener('click', () => {
        modal.classList.add('active');

        function toLocalYMD(d) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        }

        // Reset to Step 1
        step1.classList.remove('hidden');
        step2.classList.add('hidden');
        step3.classList.add('hidden');

        // Set Min/Max Date
        const today = new Date();
        const maxDate = new Date();
        maxDate.setDate(today.getDate() + 5);

        bookingDateInput.min = toLocalYMD(today);
        bookingDateInput.max = toLocalYMD(maxDate);
        bookingDateInput.value = toLocalYMD(today);

        // Default time = current local time (HH:MM)
        if (bookingTimeInput) {
            const hh = String(today.getHours()).padStart(2, '0');
            const mm = String(today.getMinutes()).padStart(2, '0');
            bookingTimeInput.value = `${hh}:${mm}`;
            bookingTimeInput.min = `${hh}:${mm}`;
        }
    });

    closeModal.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    // Navigation Logic
    nextBtn.addEventListener('click', () => {
        const selectedDate = bookingDateInput.value;
        if (!selectedDate) {
            alert("Please select a date.");
            return;
        }

        // Validation check (double check frontend)
        const dateObj = new Date(selectedDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        dateObj.setHours(0, 0, 0, 0);

        const diffTime = dateObj - today;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays < 0 || diffDays > 5) {
            alert("Please select a date within the next 5 days.");
            return;
        }

        // Move to time selection
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
        step3.classList.add('hidden');

        // If booking for today, don't allow earlier times than now
        if (bookingTimeInput) {
            const now = new Date();
            const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            if (selectedDate === todayStr) {
                const hh = String(now.getHours()).padStart(2, '0');
                const mm = String(now.getMinutes()).padStart(2, '0');
                bookingTimeInput.min = `${hh}:${mm}`;
            } else {
                bookingTimeInput.min = '';
            }
        }
    });

    timeNextBtn.addEventListener('click', () => {
        const dateVal = bookingDateInput.value;
        const timeVal = bookingTimeInput?.value;
        if (!timeVal) {
            alert('Please select a time.');
            return;
        }

        // Validate time not in the past (allow 2 min grace for "now")
        const [hStr, mStr] = String(timeVal).split(':');
        const h = parseInt(hStr, 10);
        const m = parseInt(mStr, 10);
        if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
            alert('Invalid time.');
            return;
        }

        const [yStr, moStr, dStr] = String(dateVal).split('-');
        const y = parseInt(yStr, 10);
        const mo = parseInt(moStr, 10);
        const d = parseInt(dStr, 10);
        if (Number.isNaN(y) || Number.isNaN(mo) || Number.isNaN(d)) {
            alert('Invalid date.');
            return;
        }

        const startTs = new Date(y, mo - 1, d, h, m, 0, 0);
        const now = new Date();
        if (startTs.getTime() < (now.getTime() - (2 * 60 * 1000))) {
            alert('Please select a time in the future.');
            return;
        }

        step2.classList.add('hidden');
        step3.classList.remove('hidden');
        calculateCost();
    });

    timeBackBtn.addEventListener('click', () => {
        step2.classList.add('hidden');
        step1.classList.remove('hidden');
    });

    backBtn.addEventListener('click', () => {
        step3.classList.add('hidden');
        step2.classList.remove('hidden');
    });

    // Cost Calculation
    hoursInput.addEventListener('input', calculateCost);
    minutesInput.addEventListener('input', calculateCost);

    function calculateCost() {
        let h = parseInt(hoursInput.value) || 0;
        let m = parseInt(minutesInput.value) || 0;

        if (h < 0) h = 0;
        if (m < 0) m = 0;

        const totalMins = (h * 60) + m;

        // Pricing Logic: ₹100 per 30 mins or part thereof
        let amount = Math.ceil(totalMins / 30) * 100;
        if (amount === 0 && totalMins > 0) amount = 100;
        if (totalMins === 0) amount = 0; // Display 0 if invalid

        costDisplay.innerText = `₹${amount}`;
    }

    // Payment Logic
    payBtn.addEventListener('click', async () => {
        const dateVal = bookingDateInput.value;
        const timeVal = bookingTimeInput?.value;
        const h = parseInt(hoursInput.value) || 0;
        const m = parseInt(minutesInput.value) || 0;
        const totalMins = (h * 60) + m;

        if (totalMins <= 0) {
            alert("Please enter a valid duration");
            return;
        }

        if (!timeVal) {
            alert('Please select a time.');
            return;
        }

        payBtn.innerText = "Initializing...";
        payBtn.disabled = true;

        try {
            // 1. Create Order on Backend
            const orderRes = await apiFetch(`${API_URL}/create-order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bookingDate: dateVal,
                    bookingTime: timeVal,
                    hours: h,
                    minutes: m
                })
            });
            const orderData = await orderRes.json();

            if (!orderData.success) {
                alert("Failed to initialize payment: " + orderData.message);
                payBtn.innerText = "Pay & Unlock";
                payBtn.disabled = false;
                return;
            }

            // 2. Initialize Razorpay Checkout
            var options = {
                "key": orderData.key,
                "amount": orderData.amount,
                "currency": orderData.currency,
                "name": "Urbanspin",
                "description": "Bicycle Rental",
                "order_id": orderData.orderId,
                // Use redirect callback flow (more reliable across payment methods).
                // Backend verifies payment, publishes MQTT UNLOCK, then redirects back to dashboard.
                "callback_url": `${window.location.origin}${API_URL}/razorpay/callback`,
                "redirect": true,
                "prefill": {
                    "name": document.getElementById('user-display')?.innerText || "User",
                    "email": "user@example.com",
                    "contact": ""
                },
                "theme": {
                    "color": "#33CCCC"
                }
            };
            var rzp = new window.Razorpay(options);

            rzp.on('payment.failed', function (response) {
                alert("Payment Failed: " + response.error.description);
                payBtn.innerText = "Pay & Unlock";
                payBtn.disabled = false;
            });

            rzp.open();

            // Note: on success, Razorpay will redirect via callback_url.
            // Reset button state so the UI doesn't look stuck if user cancels.
            payBtn.innerText = "Pay & Unlock";
            payBtn.disabled = false;

        } catch (err) {
            console.error("Order creation error", err);
            alert("Error communicating with server");
            payBtn.innerText = "Pay & Unlock";
            payBtn.disabled = false;
        }
    });
}

// One-time dashboard alerts after Razorpay callback redirect
try {
    const url = new URL(window.location.href);
    const paymentFlag = url.searchParams.get('payment');
    if (paymentFlag) {
        if (paymentFlag === 'success') alert('Payment Successful! Cycle Unlocked.');
        else if (paymentFlag === 'scheduled') alert('Payment Successful! Booking Scheduled.');
        else alert('Payment status: ' + paymentFlag);

        url.searchParams.delete('payment');
        url.searchParams.delete('reason');
        window.history.replaceState({}, document.title, url.toString());
    }
} catch (_) {
    // ignore
}
