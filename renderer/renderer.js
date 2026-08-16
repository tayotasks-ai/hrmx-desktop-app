// Renderer process — plain JS, talks to the backend only through
// window.hrmsAgent (see preload.js). No Node/Electron APIs here directly.

const views = {
  login: document.getElementById('view-login'),
  otp: document.getElementById('view-otp'),
  consent: document.getElementById('view-consent'),
  status: document.getElementById('view-status'),
};

function showView(name) {
  Object.entries(views).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
}

function setError(elId, message) {
  const el = document.getElementById(elId);
  if (!message) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = message;
  el.classList.remove('hidden');
}

let pendingOtpToken = null;

// ── Login ────────────────────────────────────────────────────────────────
document.getElementById('login-submit').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  setError('login-error', null);

  if (!email || !password) {
    setError('login-error', 'Enter your email and password.');
    return;
  }

  try {
    const result = await window.hrmsAgent.login(email, password);
    if (result?.data?.requiresOtp) {
      pendingOtpToken = result.data.pendingToken;
      showView('otp');
      return;
    }
    await afterLogin();
  } catch (err) {
    setError('login-error', err.message || 'Sign in failed.');
  }
});

// ── OTP ──────────────────────────────────────────────────────────────────
document.getElementById('otp-submit').addEventListener('click', async () => {
  const code = document.getElementById('otp-code').value.trim();
  setError('otp-error', null);
  if (!code) { setError('otp-error', 'Enter the code from your email.'); return; }

  try {
    await window.hrmsAgent.verifyOtp(pendingOtpToken, code);
    await afterLogin();
  } catch (err) {
    setError('otp-error', err.message || 'Verification failed.');
  }
});

// ── Post-login routing: consent screen (if applicable) then status ────────
async function afterLogin() {
  const session = await window.hrmsAgent.getSession();
  if (!session) { showView('login'); return; }

  try {
    const settings = await window.hrmsAgent.getMonitoringSettings();
    const screenshotsEnabled = !!settings?.data?.screenshotsEnabled;
    const alreadyAnswered = session.monitoringConsent && session.monitoringConsent.accepted !== undefined
      && session.monitoringConsent.acceptedAt; // has explicitly answered at least once (accept OR decline)

    if (screenshotsEnabled && !alreadyAnswered) {
      showView('consent');
      return;
    }
  } catch {
    // If we can't reach the settings endpoint, don't block sign-in on it —
    // just go to status and let the background loop retry later.
  }

  await renderStatus();
}

// ── Consent ──────────────────────────────────────────────────────────────
document.getElementById('consent-accept').addEventListener('click', async () => {
  try {
    await window.hrmsAgent.setMonitoringConsent(true);
    await renderStatus();
  } catch (err) {
    setError('consent-error', err.message || 'Could not save your choice.');
  }
});

document.getElementById('consent-decline').addEventListener('click', async () => {
  try {
    await window.hrmsAgent.setMonitoringConsent(false);
    await renderStatus();
  } catch (err) {
    setError('consent-error', err.message || 'Could not save your choice.');
  }
});

// ── Status ───────────────────────────────────────────────────────────────
async function renderStatus() {
  const session = await window.hrmsAgent.getSession();
  if (!session) { showView('login'); return; }

  document.getElementById('status-user').textContent =
    `${session.user.name} • ${session.tenantName || 'your organisation'}`;

  try {
    const activity = await window.hrmsAgent.getMyActivity();
    const today = (activity?.data || [])[0];
    const minutes = today?.activeMinutes || 0;
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    document.getElementById('status-active-time').textContent =
      `Active time today: ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
  } catch {
    document.getElementById('status-active-time').textContent = '';
  }

  const valueEl = document.getElementById('status-screenshot-value');
  const toggleEl = document.getElementById('status-screenshot-toggle');
  try {
    const settings = await window.hrmsAgent.getMonitoringSettings();
    const screenshotsEnabled = !!settings?.data?.screenshotsEnabled;
    const consented = !!session.monitoringConsent?.accepted;

    if (!screenshotsEnabled) {
      valueEl.textContent = 'Not enabled by your organisation';
      toggleEl.classList.add('hidden');
    } else if (consented) {
      valueEl.textContent = 'On — you consented';
      toggleEl.textContent = 'Turn off';
      toggleEl.classList.remove('hidden');
      toggleEl.onclick = async () => {
        await window.hrmsAgent.setMonitoringConsent(false);
        await renderStatus();
      };
    } else {
      valueEl.textContent = 'Available — you have not agreed';
      toggleEl.textContent = 'Review';
      toggleEl.classList.remove('hidden');
      toggleEl.onclick = () => showView('consent');
    }
  } catch {
    valueEl.textContent = 'Unavailable';
    toggleEl.classList.add('hidden');
  }

  showView('status');
}

// ── Logout ───────────────────────────────────────────────────────────────
document.getElementById('logout-submit').addEventListener('click', async () => {
  await window.hrmsAgent.logout();
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  showView('login');
});

window.hrmsAgent.onSessionCleared(() => showView('login'));

// ── Boot ─────────────────────────────────────────────────────────────────
(async function init() {
  const session = await window.hrmsAgent.getSession();
  if (session) {
    await afterLogin();
  } else {
    showView('login');
  }
})();
