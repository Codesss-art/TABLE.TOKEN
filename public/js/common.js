// Common Utilities for TableToken Web App

// Escape HTML special characters to prevent XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Format currency in Indian Rupees
function formatCurrency(amount) {
  const num = Number(amount) || 0;
  return '₹' + num.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// Format ISO/SQL date to friendly 12-hour time
function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.replace(' ', 'T'));
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Format date to YYYY-MM-DD
function getTodayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Calculate elapsed minutes from a timestamp
function getElapsedMinutes(dateStr) {
  if (!dateStr) return 0;
  const created = new Date(dateStr.replace(' ', 'T')).getTime();
  const now = Date.now();
  const diffMs = Math.max(0, now - created);
  return Math.floor(diffMs / 60000);
}

// Web Audio API Sound Synthesizer - Zero External Audio Files Required
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

// Pleasant chime for incoming new order (Doorbell / Kitchen Bell)
function playNewOrderSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const playTone = (freq, start, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);

      gain.gain.setValueAtTime(0.3, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + duration);
    };

    // 2-tone chime: C5 -> G5
    playTone(523.25, 0, 0.4);
    playTone(783.99, 0.25, 0.7);
  } catch (e) {
    console.log('Audio playback error:', e);
  }
}

// Celebratory chime when customer order is Ready
function playOrderReadySound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const playTone = (freq, start, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);

      gain.gain.setValueAtTime(0.25, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + duration);
    };

    // Arpeggio: C5 -> E5 -> G5 -> C6
    playTone(523.25, 0, 0.2);
    playTone(659.25, 0.15, 0.2);
    playTone(783.99, 0.3, 0.2);
    playTone(1046.50, 0.45, 0.6);
  } catch (e) {
    console.log('Audio playback error:', e);
  }
}

// Toast Notifications
function showToast(message, type = 'info', duration = 3500) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Offline / Reconnecting Status Banner Manager
let syncStatusBanner = null;

function updateSyncBanner(isConnected) {
  if (!syncStatusBanner) {
    syncStatusBanner = document.createElement('div');
    syncStatusBanner.id = 'syncStatusBanner';
    syncStatusBanner.style.position = 'fixed';
    syncStatusBanner.style.bottom = '16px';
    syncStatusBanner.style.left = '50%';
    syncStatusBanner.style.transform = 'translateX(-50%)';
    syncStatusBanner.style.padding = '8px 18px';
    syncStatusBanner.style.borderRadius = '9999px';
    syncStatusBanner.style.fontSize = '0.82rem';
    syncStatusBanner.style.fontWeight = '700';
    syncStatusBanner.style.zIndex = '999';
    syncStatusBanner.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    syncStatusBanner.style.transition = 'all 0.3s ease';
    syncStatusBanner.style.display = 'none';
    document.body.appendChild(syncStatusBanner);
  }

  if (isConnected) {
    syncStatusBanner.style.display = 'none';
  } else {
    syncStatusBanner.style.display = 'block';
    syncStatusBanner.style.background = '#fee2e2';
    syncStatusBanner.style.color = '#991b1b';
    syncStatusBanner.style.border = '1px solid #fecaca';
    syncStatusBanner.innerHTML = '⚠️ Reconnecting live sync... (Polling backup active)';
  }
}

// Robust Server-Sent Events (SSE) Client with Reconnect Banner & Polling Fallback
function createLiveStream(onEvent, fallbackPollFn, pollInterval = 3500, onStateChange = null) {
  let eventSource = null;
  let isConnected = false;
  let pollTimer = null;

  function connect() {
    try {
      if (eventSource) {
        eventSource.close();
      }

      eventSource = new EventSource('/api/events');

      eventSource.addEventListener('connected', () => {
        isConnected = true;
        updateSyncBanner(true);
        if (typeof onStateChange === 'function') onStateChange(true);
      });

      eventSource.addEventListener('order_created', (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent('order_created', data);
        } catch (err) {
          console.error('Failed to parse order_created', err);
        }
      });

      eventSource.addEventListener('order_status_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent('order_status_updated', data);
        } catch (err) {
          console.error('Failed to parse order_status_updated', err);
        }
      });

      eventSource.addEventListener('menu_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent('menu_updated', data);
        } catch (err) {
          console.error('Failed to parse menu_updated', err);
        }
      });

      eventSource.addEventListener('queue_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent('queue_updated', data);
        } catch (err) {
          console.error('Failed to parse queue_updated', err);
        }
      });

      eventSource.onerror = () => {
        isConnected = false;
        updateSyncBanner(false);
        if (typeof onStateChange === 'function') onStateChange(false);
        // Auto-reconnect in 3s
        setTimeout(() => {
          if (!isConnected) connect();
        }, 3000);
      };
    } catch (e) {
      console.warn('SSE not supported or failed, falling back to polling', e);
      isConnected = false;
      updateSyncBanner(false);
      if (typeof onStateChange === 'function') onStateChange(false);
    }
  }

  // Polling fallback to guarantee 100% sync regardless of network conditions
  if (typeof fallbackPollFn === 'function') {
    pollTimer = setInterval(() => {
      fallbackPollFn();
    }, pollInterval);
  }

  connect();

  return {
    close: () => {
      if (eventSource) eventSource.close();
      if (pollTimer) clearInterval(pollTimer);
    }
  };
}
