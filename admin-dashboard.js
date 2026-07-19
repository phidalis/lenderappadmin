/* ==========================================================================
   LENDER APP - ADMIN PORTAL ENGINE
   Firebase Auth (admin login) + Firestore (all data)
   ========================================================================== */

// ── Firebase SDK (v9 compat shim via CDN — loaded in HTML before this script) ──
// Collection schema:
//   admins/{uid}          – admin profile { email, displayName, role: 'superadmin'|'admin', createdAt }
//   meta/adminBootstrap   – one-time sentinel { initialized: true, initializedAt, by } written
//                           alongside the very first (superadmin) admin doc; gates further
//                           first-run setup attempts once it exists.
//   users/{userId}        – client accounts { name, phone, nationalId, pin, dateAdded }
//   loans/{loanId}        – loan records
//   repayments/{repId}    – repayment logs

import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  runTransaction,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ─── YOUR FIREBASE CONFIG ────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyC_H3OGktcvRhUsM2g7O_vf4WFQ5ucZ0xw",
  authDomain:        "lovelink-97087.firebaseapp.com",
  projectId:         "lovelink-97087",
  storageBucket:     "lovelink-97087.firebasestorage.app",
  messagingSenderId: "962378928673",
  appId:             "1:962378928673:web:aee8799e9f824afa2fc960"
};
// ─────────────────────────────────────────────────────────────────────────────

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ── Keep admins signed in until they explicitly log out ──────────────────────
// browserLocalPersistence writes the session to IndexedDB, which survives closing
// the tab, the browser, or the installed PWA — the session only ends when
// signOut(auth) is called (i.e. the "Sign out" button).
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.error('Failed to set auth persistence:', err);
});

// Ask the browser not to evict this app's storage (IndexedDB/localStorage) under
// storage pressure — relevant mainly for iOS home-screen PWAs, which can
// otherwise get their local data cleared after long periods of inactivity.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

// ── Firestore collection references ──────────────────────────────────────────
const usersCol        = collection(db, 'users');
const loansCol        = collection(db, 'loans');
const repaymentsCol   = collection(db, 'repayments');
const adminsCol       = collection(db, 'admins');
const bootstrapRef    = doc(db, 'meta', 'adminBootstrap');
const countersCol     = collection(db, 'counters');

// ── Sequential ID Generator ──────────────────────────────────────────────────
// Uses a counter document per collection to issue IDs: 1000, 1001, 1002, ...
async function getNextId(collectionName, prefix) {
  const counterRef = doc(db, 'counters', collectionName);
  return runTransaction(db, async (transaction) => {
    const snap = await transaction.get(counterRef);
    let current = 999;
    if (snap.exists()) {
      current = snap.data().current || 999;
    }
    const next = current + 1;
    transaction.set(counterRef, { current: next }, { merge: true });
    return prefix + next;
  });
}

// ── In-memory cache (refreshed from Firestore on each view switch) ────────────
const cache = {
  users:            [],
  loans:            [],
  repayments:       [],
  currentAdmin:     null, // { uid, email, displayName, role } for the signed-in admin
  settings: { theme: 'light', font: 'sans', scale: 'medium' }
};

// ── Unsub handles for real-time listeners ─────────────────────────────────────
let unsubUsers = null, unsubLoans = null, unsubRepayments = null;

// Track which loans were already known to be overdue, so we only notify on NEW overdues
let knownOverdueIds = new Set();
let hasInitializedOverdueTracking = false;

// ── getDoc helper with timeout — prevents boot-loader hang when offline ──────
function getDocWithTimeout(ref, ms = 8000) {
  return Promise.race([
    getDoc(ref),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

// =============================================================================
// DOMContentLoaded
// =============================================================================
document.addEventListener('DOMContentLoaded', async () => {

  if (typeof lucide !== 'undefined') lucide.createIcons();

  // ── Load saved UI settings (theme/font/scale stored in localStorage — UI prefs only) ──
  const savedSettings = localStorage.getItem('lender_admin_ui_settings');
  if (savedSettings) {
    try { Object.assign(cache.settings, JSON.parse(savedSettings)); } catch (_) {}
  }

  // Apply initial appearance immediately (before auth resolves)
  applyTheme(cache.settings.theme || 'light', true);
  applyFont(cache.settings.font || 'sans');
  applyScale(cache.settings.scale || 'medium');

  // ── First-run check: no administrators exist yet ─────────────────────────────
  // A dedicated /meta/adminBootstrap doc is the source of truth (Firestore rules
  // can't cheaply check "is this collection empty?", so we use a sentinel doc that
  // gets created atomically alongside the very first admin doc).
  let needsSetup = false;
  try {
    const bootstrapSnap = await getDocWithTimeout(bootstrapRef);
    needsSetup = !bootstrapSnap.exists();
  } catch (err) {
    // Fail safe: if this read errors or times out, fall through to the
    // normal login screen rather than trapping the user on a blank page.
    needsSetup = false;
  }

  if (needsSetup) {
    document.getElementById('app-boot-loader')?.classList.remove('active');
    document.getElementById('auth-container')?.classList.remove('active');
    document.getElementById('admin-container')?.classList.remove('active');
    document.getElementById('setup-container')?.classList.add('active');
    wireSetupForm();
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return; // Skip the rest of the app wiring until setup completes (page reloads after).
  }

  // ── Wire UI controls ─────────────────────────────────────────────────────────
  document.querySelectorAll('[data-set-theme]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyTheme(btn.getAttribute('data-set-theme'));
    });
  });

  const fontSelectEl = document.getElementById('font-select');
  if (fontSelectEl) fontSelectEl.addEventListener('change', e => applyFont(e.target.value));

  document.querySelectorAll('[data-scale]').forEach(btn => {
    btn.addEventListener('click', () => applyScale(btn.getAttribute('data-scale')));
  });

  document.getElementById('admin-settings-trigger')?.addEventListener('click', openGlobalSettings);
  document.getElementById('btn-close-global-settings')?.addEventListener('click', () => {
    document.getElementById('global-settings-modal').style.display = 'none';
  });
  document.getElementById('btn-close-global-settings-x')?.addEventListener('click', () => {
    document.getElementById('global-settings-modal').style.display = 'none';
  });

  // Settings tabs (Appearance / Backup / Admins)
  wireSettingsTabs();

  // Backup & Restore
  document.getElementById('btn-download-backup')?.addEventListener('click', downloadBackup);
  document.getElementById('btn-export-pdf')?.addEventListener('click', downloadPDFReport);
  document.getElementById('btn-restore-backup')?.addEventListener('click', () => {
    document.getElementById('backup-restore-input')?.click();
  });
  document.getElementById('backup-restore-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) restoreFromBackup(file);
    e.target.value = '';
  });

  // Admin Users
  wireCreateAdminForm();

  // Toggle password visibility
  document.querySelectorAll('.toggle-pin-visibility').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.parentNode.querySelector('input');
      const icon  = btn.querySelector('i');
      if (!input || !icon) return;
      const type = input.getAttribute('type') === 'password' ? 'text' : 'password';
      input.setAttribute('type', type);
      icon.setAttribute('data-lucide', type === 'password' ? 'eye' : 'eye-off');
      lucide.createIcons();
    });
  });

  // Loan filter / search / repay filters wired later in respective renderers
  wireLoanFilters();
  wireRepayFilters();

  // Client status filters
  wireCustFilters();

  // Overdue notification bell
  document.getElementById('admin-notif-bell')?.addEventListener('click', () => switchView('admin-view-home'));

  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  // ── Firebase Auth state listener ─────────────────────────────────────────────
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      // Verify the logged-in uid has an entry in the admins collection
      let adminSnap;
      try {
        adminSnap = await getDocWithTimeout(doc(db, 'admins', user.uid));
      } catch (_) {
        // Timeout or network error — cannot verify admin, force login
        showToast('Could not verify admin access. Please sign in.', 'error');
        await signOut(auth);
        showLoginScreen();
        return;
      }
      if (!adminSnap.exists()) {
        showToast('Access denied: Not an authorised administrator.', 'error');
        await signOut(auth);
        showLoginScreen();
        return;
      }
      cache.currentAdmin = { uid: user.uid, ...adminSnap.data() };
      applyAdminUiPermissions();
      showAdminPortal();
    } else {
      cache.currentAdmin = null;
      showLoginScreen();
    }
  });

  // ── Admin Login Form ─────────────────────────────────────────────────────────
  const formAdmin = document.getElementById('admin-login-form');
  if (formAdmin) {
    formAdmin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email    = document.getElementById('admin-email').value.trim();
      const password = document.getElementById('admin-password').value;
      const btn      = formAdmin.querySelector('button[type="submit"]');

      btn.disabled = true;
      btn.querySelector('span').textContent = 'Authenticating…';

      try {
        await signInWithEmailAndPassword(auth, email, password);
        // onAuthStateChanged will handle the rest
      } catch (err) {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Sign In as Admin';
        showToast('Invalid administrator credentials.', 'error');
      }
    });
  }

  // ── Admin Logout ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.quick-logout').forEach(btn => {
    btn.addEventListener('click', async () => {
      teardownListeners();
      await signOut(auth);
      applyTheme('light', true);
      showToast('Successfully signed out.', 'info');
    });
  });

  // ── Nav links ────────────────────────────────────────────────────────────────
  document.querySelectorAll('#admin-container .nav-link').forEach(link => {
    link.addEventListener('click', () => {
      switchView(link.getAttribute('data-target-view'));
    });
  });

  // ── Form submissions ─────────────────────────────────────────────────────────
  wireAddCustomerForm();
  wireEditCustomerForm();
  wireRepaymentForm();
  wireEditCustomerModal();
  wireAdjustPenaltyModal();

  // ── Clients secondary nav buttons ────────────────────────────────────────────
  document.getElementById('btn-open-add-borrower-modal')?.addEventListener('click', () => openAddBorrowerModal());
  document.getElementById('btn-open-adjust-penalty-modal')?.addEventListener('click', () => openAdjustPenaltyModal());

  // ── Close modals ─────────────────────────────────────────────────────────────
  document.getElementById('btn-close-add-borrower-modal')?.addEventListener('click', () => {
    document.getElementById('add-borrower-modal').style.display = 'none';
    const p = document.getElementById('cust-penalty-amount'); if (p) p.value = '';
  });
  document.getElementById('btn-close-edit-modal')?.addEventListener('click', () => {
    document.getElementById('edit-customer-modal').style.display = 'none';
  });

  // ── Add borrower form: due date calculation & loan preview ───────────────────
  wireAddBorrowerFormPreview();

  // ── Renew loan form wiring ──────────────────────────────────────────────────
  wireRenewLoanForm();
  document.getElementById('btn-close-renew-loan-modal')?.addEventListener('click', () => {
    document.getElementById('renew-loan-modal').style.display = 'none';
    const p = document.getElementById('renew-penalty-amount'); if (p) p.value = '';
  });

  // ── Edit daily penalty form wiring ──────────────────────────────────────────
  wireEditDailyPenaltyModal();
  document.getElementById('btn-close-edit-daily-penalty-modal')?.addEventListener('click', () => {
    document.getElementById('edit-daily-penalty-modal').style.display = 'none';
  });

  // ── Bottom nav search inputs ─────────────────────────────────────────────────
  document.getElementById('cust-search')?.addEventListener('input', () => renderAdminCustomersList());
  document.getElementById('loans-search')?.addEventListener('input', () => renderAdminLoansLedger());
  document.getElementById('repayments-search')?.addEventListener('input', () => renderAdminRepaymentsLog());

}); // end DOMContentLoaded


// =============================================================================
// AUTH SCREEN HELPERS
// =============================================================================
function showLoginScreen() {
  document.getElementById('app-boot-loader')?.classList.remove('active');
  document.getElementById('auth-container').classList.add('active');
  document.getElementById('admin-container').classList.remove('active');
  const form = document.getElementById('admin-login-form');
  if (form) {
    form.reset();
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'Sign In as Admin'; }
  }
}

async function showAdminPortal() {
  document.getElementById('app-boot-loader')?.classList.remove('active');
  document.getElementById('auth-container').classList.remove('active');
  document.getElementById('admin-container').classList.add('active');
  showToast('Welcome back, Administrator.', 'success');
  await setupRealtimeListeners();
  switchView('admin-view-home');
}


// =============================================================================
// FIRESTORE REAL-TIME LISTENERS
// =============================================================================
async function setupRealtimeListeners() {
  teardownListeners();

  unsubUsers = onSnapshot(usersCol, snap => {
    cache.users = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
    refreshCurrentView();
  });

  unsubLoans = onSnapshot(loansCol, snap => {
    cache.loans = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
    runOverdueCheckFirestore();
    refreshCurrentView();
  });

  unsubRepayments = onSnapshot(repaymentsCol, snap => {
    cache.repayments = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
    refreshCurrentView();
  });
}

function teardownListeners() {
  [unsubUsers, unsubLoans, unsubRepayments].forEach(fn => fn && fn());
  unsubUsers = unsubLoans = unsubRepayments = null;
}


// =============================================================================
// OVERDUE CHECK (Firestore) + AUTO PENALTY ACCRUAL
// =============================================================================
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function runOverdueCheckFirestore() {
  const now = Date.now();
  const batch = writeBatch(db);
  let changed = false;

  cache.loans.forEach(loan => {
    const ref = doc(db, 'loans', loan.id);
    const updates = {};

    // Transition active → overdue
    if (loan.status === 'active' && loan.remainingAmount > 0 && loan.dueDate < now) {
      updates.status = 'overdue';
    }

    const isOverdueNow = updates.status === 'overdue' || loan.status === 'overdue';

    if (isOverdueNow && loan.remainingAmount > 0 && loan.penaltyType && loan.penaltyType !== 'none') {
      if (loan.penaltyType === 'flat' && !loan.penaltyApplied) {
        const amt = Number(loan.penaltyAmount) || 0;
        if (amt > 0) {
          updates.remainingAmount = (loan.remainingAmount || 0) + amt;
          updates.totalRepayable  = (loan.totalRepayable || 0) + amt;
          updates.penaltyAccrued  = (loan.penaltyAccrued || 0) + amt;
          updates.penaltyApplied  = true;
        }
      } else if (loan.penaltyType === 'daily') {
        const amt = Number(loan.penaltyAmount) || 0;
        const lastApplied = loan.lastPenaltyDate ? Number(loan.lastPenaltyDate) : loan.dueDate;
        const daysElapsed = Math.floor((now - lastApplied) / MS_PER_DAY);
        if (amt > 0 && daysElapsed >= 1) {
          const totalPenalty = amt * daysElapsed;
          updates.remainingAmount = (loan.remainingAmount || 0) + totalPenalty;
          updates.totalRepayable  = (loan.totalRepayable || 0) + totalPenalty;
          updates.penaltyAccrued  = (loan.penaltyAccrued || 0) + totalPenalty;
          updates.lastPenaltyDate = now;
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      batch.update(ref, updates);
      changed = true;
    }
  });

  if (changed) {
    try { await batch.commit(); } catch (_) {}
  }

  checkForNewOverdueNotifications();
}

function checkForNewOverdueNotifications() {
  const overdueLoans = cache.loans.filter(l => l.status === 'overdue');
  const currentIds = new Set(overdueLoans.map(l => l.id));

  if (!hasInitializedOverdueTracking) {
    // First load — just record state, don't spam notifications for pre-existing overdues
    knownOverdueIds = currentIds;
    hasInitializedOverdueTracking = true;
    return;
  }

  const newlyOverdue = overdueLoans.filter(l => !knownOverdueIds.has(l.id));
  newlyOverdue.forEach(loan => {
    const client = cache.users.find(c => c.id === loan.customerId);
    const name = client ? client.name : `Client ID ${loan.customerId}`;
    showToast(`Loan ${loan.id} for ${name} is now overdue.`, 'error');

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('Loan Overdue', {
          body: `${name}'s loan (${loan.id}) is now overdue — ${formatCurrency(loan.remainingAmount)} outstanding.`,
        });
      } catch (_) {}
    }
  });

  knownOverdueIds = currentIds;
}


// =============================================================================
// VIEW ROUTING
// =============================================================================
let currentViewId = 'admin-view-home';

function switchView(targetViewId) {
  currentViewId = targetViewId;
  document.querySelectorAll('#admin-container .app-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('#admin-container .nav-link').forEach(l => l.classList.remove('active'));

  const target = document.getElementById(targetViewId);
  if (target) target.classList.add('active');

  const link = document.querySelector(`#admin-container [data-target-view="${targetViewId}"]`);
  if (link) {
    link.classList.add('active');
    link.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  renderAdminView(targetViewId);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function refreshCurrentView() {
  if (document.getElementById('admin-container')?.classList.contains('active')) {
    renderAdminView(currentViewId);
  }
}

function renderAdminView(viewId) {
  if (viewId === 'admin-view-home')          renderAdminDashboard();
  else if (viewId === 'admin-view-customers')    renderAdminCustomersList();
  else if (viewId === 'admin-view-loans')        renderAdminLoansLedger();
  else if (viewId === 'admin-view-payments')     renderAdminPaymentsPortal();
}


// =============================================================================
// TOAST & FORMATTERS
// =============================================================================
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const iconName = type === 'success' ? 'check-circle' : type === 'error' ? 'alert-triangle' : 'info';
  toast.innerHTML = `<i data-lucide="${iconName}" style="width:18px;height:18px;flex-shrink:0;"></i><span>${message}</span>`;
  container.appendChild(toast);

  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [toast] });
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function formatCurrency(amount) {
  return 'KSh ' + new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : (ts?.toDate ? ts.toDate() : new Date(ts));
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : (ts?.toDate ? ts.toDate() : new Date(ts));
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (ts?.toDate) return ts.toDate().getTime();
  return Number(ts);
}


// =============================================================================
// APPEARANCE / SETTINGS  (UI prefs only — saved to localStorage)
// =============================================================================
function saveUISettings() {
  localStorage.setItem('lender_admin_ui_settings', JSON.stringify(cache.settings));
}

function applyTheme(theme, silent = false) {
  document.documentElement.setAttribute('data-theme', theme);
  cache.settings.theme = theme;
  saveUISettings();
  document.querySelectorAll('[data-set-theme]').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-set-theme') === theme)
  );
  if (!silent) showToast(`Theme changed to ${theme.charAt(0).toUpperCase() + theme.slice(1)}`, 'info');
}

function applyFont(font) {
  document.documentElement.setAttribute('data-font', font);
  cache.settings.font = font;
  saveUISettings();
  const el = document.getElementById('font-select');
  if (el) el.value = font;
}

function applyScale(scale) {
  document.documentElement.setAttribute('data-scale', scale);
  cache.settings.scale = scale;
  saveUISettings();
  document.querySelectorAll('[data-scale]').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-scale') === scale)
  );
}

function openGlobalSettings() {
  const modal = document.getElementById('global-settings-modal');
  if (!modal) return;
  const fs = document.getElementById('font-select');
  if (fs) fs.value = cache.settings.font || 'sans';
  document.querySelectorAll('[data-scale]').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-scale') === cache.settings.scale)
  );
  modal.style.display = 'flex';
  applyAdminUiPermissions();
  renderAdminUsersList();
}

function wireSettingsTabs() {
  document.querySelectorAll('.settings-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const target = tabBtn.getAttribute('data-settings-tab');

      document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');

      document.querySelectorAll('.settings-tab-panel').forEach(panel => panel.classList.remove('active'));
      document.getElementById(`settings-tab-${target}`)?.classList.add('active');

      if (target === 'admins') renderAdminUsersList();
    });
  });
}


// =============================================================================
// BACKUP & RESTORE  (full Firestore data export/import as JSON)
// =============================================================================
function todayDateStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function downloadBackup() {
  const btn = document.getElementById('btn-download-backup');
  const statusEl = document.getElementById('backup-download-status');
  if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'Preparing backup…'; }
  if (statusEl) statusEl.textContent = '';

  try {
    // Admins aren't kept in the live cache, so fetch fresh for the export
    const adminSnap = await getDocs(adminsCol);
    const admins = adminSnap.docs.map(d => ({ ...d.data(), _docId: d.id }));

    const backupPayload = {
      meta: {
        app: 'LenderApp Admin Portal',
        exportedAt: new Date().toISOString(),
        version: 1
      },
      users:            cache.users,
      loans:            cache.loans,
      repayments:       cache.repayments,
      admins
    };

    const blob = new Blob([JSON.stringify(backupPayload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `lenderapp-backup-${todayDateStamp()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    if (statusEl) statusEl.textContent = `Backup downloaded: lenderapp-backup-${todayDateStamp()}.json`;
    showToast('Backup downloaded successfully.', 'success');
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Backup failed. See error toast.';
    showToast('Error creating backup: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'Download Backup (JSON)'; }
  }
}

async function restoreFromBackup(file) {
  const statusEl = document.getElementById('backup-restore-status');
  const btn = document.getElementById('btn-restore-backup');

  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch (err) {
    showToast('Invalid backup file: could not parse JSON.', 'error');
    return;
  }

  const collectionsMap = {
    users:            usersCol,
    loans:            loansCol,
    repayments:       repaymentsCol
  };

  const summary = Object.keys(collectionsMap)
    .map(k => `${(parsed[k] || []).length} ${k}`)
    .join(', ');

  const confirmed = window.confirm(
    `This will overwrite existing data with the contents of "${file.name}" (${summary}). This cannot be undone. Continue?`
  );
  if (!confirmed) return;

  if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'Restoring…'; }
  if (statusEl) statusEl.textContent = 'Restoring backup, please wait…';

  try {
    for (const [key, colRef] of Object.entries(collectionsMap)) {
      const records = Array.isArray(parsed[key]) ? parsed[key] : [];
      // Chunk into batches of 450 to stay safely under Firestore's 500-op batch limit
      for (let i = 0; i < records.length; i += 450) {
        const chunk = records.slice(i, i + 450);
        const batch = writeBatch(db);
        chunk.forEach(record => {
          const { _docId, ...data } = record;
          const docId = _docId || (colRef === usersCol ? data.id : undefined);
          const ref = docId ? doc(colRef, docId) : doc(colRef);
          batch.set(ref, data);
        });
        await batch.commit();
      }
    }

    if (statusEl) statusEl.textContent = `Restore complete (${summary}).`;
    showToast('Backup restored successfully.', 'success');
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Restore failed. See error toast.';
    showToast('Error restoring backup: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'Choose Backup File & Restore'; }
  }
}


// =============================================================================
// PDF REPORT EXPORT
// =============================================================================
function downloadPDFReport() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('p', 'mm', 'a4');
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 15;

  const addPageIfNeeded = (needed) => {
    if (y + needed > 275) { doc.addPage(); y = 15; }
  };

  // Title
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('Lender Admin - Full Portfolio Report', pageWidth / 2, y, { align: 'center' });
  y += 8;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text(`Generated: ${new Date().toLocaleString()}`, pageWidth / 2, y, { align: 'center' });
  doc.setTextColor(0);
  y += 12;

  // ── SUMMARY ──
  let totalDisbursed = 0, totalCollected = 0, totalOutstanding = 0, totalOverdue = 0;
  cache.loans.forEach(l => { totalDisbursed += (l.amount || 0); totalOutstanding += (l.remainingAmount || 0); if (l.status === 'overdue') totalOverdue += (l.remainingAmount || 0); });
  cache.repayments.forEach(r => totalCollected += (r.amount || 0));
  const recovery = totalDisbursed > 0 ? Math.min(100, Math.round((totalCollected / totalDisbursed) * 100)) : 0;

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Portfolio Summary', 14, y); y += 7;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Total Clients: ${cache.users.length}`, 14, y); y += 6;
  doc.text(`Total Loans: ${cache.loans.length}`, 14, y); y += 6;
  doc.text(`Total Disbursed: ${formatCurrency(totalDisbursed)}`, 14, y); y += 6;
  doc.text(`Total Collected: ${formatCurrency(totalCollected)}`, 14, y); y += 6;
  doc.text(`Outstanding: ${formatCurrency(totalOutstanding)}`, 14, y); y += 6;
  doc.text(`Overdue: ${formatCurrency(totalOverdue)}`, 14, y); y += 6;
  doc.text(`Recovery Rate: ${recovery}%`, 14, y); y += 10;

  // ── ALL LOANS TABLE ──
  if (cache.loans.length > 0) {
    addPageIfNeeded(20);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('All Loans', 14, y); y += 3;
    doc.autoTable({
      startY: y,
      head: [['Loan ID', 'Client', 'Loan Type', 'Amount', 'Remaining', 'Status', 'Due Date']],
      body: cache.loans.map(l => {
        const c = cache.users.find(u => u.id === l.customerId);
        return [l.id, c ? c.name : l.customerId, l.loanTypeName || '-', formatCurrency(l.amount), formatCurrency(l.remainingAmount), l.status, formatDate(l.dueDate)];
      }),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [37, 99, 235] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: 14 }
    });
    y = doc.lastAutoTable.finalY + 10;
  }

  // ── CLIENT PORTFOLIO TABLE ──
  addPageIfNeeded(20);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Client Portfolio', 14, y); y += 3;
  doc.autoTable({
    startY: y,
    head: [['Name', 'Phone', 'National ID', 'Loans', 'Penalty']],
    body: cache.users.map(c => {
      const cLoans = cache.loans.filter(l => l.customerId === c.id);
      const penalty = cLoans.reduce((s, l) => s + (l.penaltyAccrued || 0), 0);
      return [c.name, c.phone, c.nationalId || '-', cLoans.length, penalty > 0 ? formatCurrency(penalty) : '-'];
    }),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [37, 99, 235] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: 14 }
  });
  y = doc.lastAutoTable.finalY + 10;

  // ── REPAYMENTS TABLE ──
  if (cache.repayments.length > 0) {
    addPageIfNeeded(20);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('Repayment History', 14, y); y += 3;
    doc.autoTable({
      startY: y,
      head: [['Repayment ID', 'Client', 'Loan ID', 'Amount', 'Date & Time']],
      body: cache.repayments.map(r => {
        const c = cache.users.find(u => u.id === r.customerId);
        return [r.id, c ? c.name : r.customerId, r.loanId || '-', formatCurrency(r.amount), formatDateTime(r.timestamp || r.date)];
      }),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [37, 99, 235] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: 14 }
    });
    y = doc.lastAutoTable.finalY + 10;
  }

  // Footer on every page
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Page ${i} of ${totalPages} — Lender Admin Report`, pageWidth / 2, 290, { align: 'center' });
  }

  doc.save(`Lender-Report-${new Date().toISOString().slice(0, 10)}.pdf`);
  showToast('PDF report downloaded.', 'success');
}


// =============================================================================
// ADMIN USERS  (create new administrators + list existing ones)
// =============================================================================

// Show/hide the "Create New Admin" form based on the signed-in admin's role.
// Only the Super Admin may create (or remove) other administrators; this is a
// UI-level convenience — the real enforcement lives in the Firestore rules.
function applyAdminUiPermissions() {
  const isSuper = cache.currentAdmin?.role === 'superadmin';
  const createForm = document.getElementById('admin-create-form');
  const restrictedNotice = document.getElementById('admin-create-restricted-notice');
  if (createForm) createForm.style.display = isSuper ? 'flex' : 'none';
  if (restrictedNotice) restrictedNotice.style.display = isSuper ? 'none' : 'flex';
}

async function renderAdminUsersList() {
  const listEl = document.getElementById('admin-users-list');
  if (!listEl) return;

  const isSuper = cache.currentAdmin?.role === 'superadmin';

  try {
    const snap = await getDocs(adminsCol);
    if (snap.empty) {
      listEl.innerHTML = `
        <div class="empty-state">
          <i data-lucide="users"></i>
          <p>No administrators found.</p>
        </div>`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      return;
    }

    listEl.innerHTML = snap.docs.map(d => {
      const a = d.data();
      const isSelf = auth.currentUser && auth.currentUser.uid === d.id;
      const isTargetSuper = a.role === 'superadmin';
      const roleLabel = isTargetSuper ? 'Super Admin' : 'Admin';
      // Only the Super Admin can remove anyone, and the Super Admin account
      // itself can never be removed through this UI.
      const canRemove = isSuper && !isSelf && !isTargetSuper;

      return `
        <div class="admin-list-item">
          <div class="admin-meta">
            <strong>${a.displayName || 'Unnamed Admin'}${isSelf ? ' (You)' : ''}<span class="admin-role-badge${isTargetSuper ? ' superadmin' : ''}">${roleLabel}</span></strong>
            <span>${a.email || ''} · Added ${formatDate(a.createdAt)}</span>
          </div>
          ${canRemove ? `
          <button type="button" class="admin-remove-btn" data-remove-admin="${d.id}" title="Remove Admin">
            <i data-lucide="trash-2"></i>
          </button>` : ''}
        </div>`;
    }).join('');

    listEl.querySelectorAll('[data-remove-admin]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.getAttribute('data-remove-admin');
        const confirmed = window.confirm('Remove this administrator\'s access? Their Firestore profile will be deleted (their login will need to be disabled separately in Firebase Auth).');
        if (!confirmed) return;
        try {
          await deleteDoc(doc(db, 'admins', uid));
          showToast('Administrator removed.', 'success');
          renderAdminUsersList();
        } catch (err) {
          showToast('Error removing administrator: ' + err.message, 'error');
        }
      });
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch (err) {
    listEl.innerHTML = `
      <div class="empty-state">
        <i data-lucide="alert-triangle"></i>
        <p>Could not load administrators.</p>
      </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function wireCreateAdminForm() {
  const form = document.getElementById('admin-create-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Client-side guard (the Firestore rules are the real gate, but this avoids
    // a confusing round-trip if the form was somehow triggered by a non-super admin).
    if (cache.currentAdmin?.role !== 'superadmin') {
      showToast('Only the Super Admin can create new administrators.', 'error');
      return;
    }

    const displayName = document.getElementById('new-admin-name').value.trim();
    const email       = document.getElementById('new-admin-email').value.trim();
    const password    = document.getElementById('new-admin-password').value;

    if (password.length < 6) {
      showToast('Password must be at least 6 characters.', 'error');
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Creating…';

    // Use a secondary Firebase app instance so creating the new admin
    // does not sign the current admin out of their own session.
    const secondaryApp = initializeApp(firebaseConfig, `Secondary-${Date.now()}`);
    const secondaryAuth = getAuth(secondaryApp);

    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      await setDoc(doc(db, 'admins', cred.user.uid), {
        email,
        displayName: displayName || email,
        role: 'admin', // Only the bootstrap flow can create a 'superadmin'
        createdAt: serverTimestamp()
      });

      showToast(`Administrator "${displayName || email}" created successfully.`, 'success');
      form.reset();
      renderAdminUsersList();
    } catch (err) {
      showToast('Error creating administrator: ' + err.message, 'error');
    } finally {
      await signOut(secondaryAuth).catch(() => {});
      await deleteApp(secondaryApp).catch(() => {});
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Create New Admin';
    }
  });
}


// =============================================================================
// FIRST-RUN SETUP  (creates the one-time Super Admin, before any admin exists)
// =============================================================================
function wireSetupForm() {
  const form = document.getElementById('setup-admin-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const displayName     = document.getElementById('setup-admin-name').value.trim();
    const email           = document.getElementById('setup-admin-email').value.trim();
    const password        = document.getElementById('setup-admin-password').value;
    const passwordConfirm = document.getElementById('setup-admin-password-confirm').value;

    if (password.length < 6) {
      showToast('Password must be at least 6 characters.', 'error');
      return;
    }
    if (password !== passwordConfirm) {
      showToast('Passwords do not match.', 'error');
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Creating Super Admin…';

    try {
      // No one is signed in yet, so this uses the primary auth instance directly.
      const cred = await createUserWithEmailAndPassword(auth, email, password);

      // Create the admin profile (role: superadmin) and the bootstrap sentinel
      // doc together — Firestore rules only allow this combination once, since
      // the admins/{uid} bootstrap rule requires meta/adminBootstrap to not
      // already exist.
      const batch = writeBatch(db);
      batch.set(doc(db, 'admins', cred.user.uid), {
        email,
        displayName: displayName || email,
        role: 'superadmin',
        createdAt: serverTimestamp()
      });
      batch.set(bootstrapRef, {
        initialized: true,
        initializedAt: serverTimestamp(),
        by: cred.user.uid
      });
      await batch.commit();

      showToast('Super Admin account created. Signing you in…', 'success');
      window.location.reload();
    } catch (err) {
      showToast('Error creating Super Admin: ' + err.message, 'error');
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Create Super Admin Account';
    }
  });
}


// =============================================================================
// DASHBOARD HOME
// =============================================================================
function renderAdminDashboard() {
  let totalDisbursed = 0;
  cache.loans.forEach(l => totalDisbursed += (l.amount || 0));

  let totalCollected = 0;
  cache.repayments.forEach(r => totalCollected += (r.amount || 0));

  const overdueLoans = cache.loans.filter(l => l.status === 'overdue');
  let totalOverdue = 0;
  overdueLoans.forEach(l => totalOverdue += (l.remainingAmount || 0));

  const el = id => document.getElementById(id);
  el('admin-metric-disbursed').textContent    = formatCurrency(totalDisbursed);
  el('admin-metric-loans-count').textContent  = `${cache.loans.length} Loan${cache.loans.length === 1 ? '' : 's'} Disbursed`;
  el('admin-metric-collected').textContent    = formatCurrency(totalCollected);

  const recoveryRate = totalDisbursed > 0 ? Math.min(100, Math.round((totalCollected / totalDisbursed) * 100)) : 0;
  el('admin-metric-recovery-rate').textContent = `Recovery rate: ${recoveryRate}%`;
  el('admin-metric-overdue').textContent       = formatCurrency(totalOverdue);
  el('admin-metric-overdue-count').textContent = `${overdueLoans.length} Overdue Account${overdueLoans.length === 1 ? '' : 's'}`;
  el('admin-portfolio-percent').textContent    = `${recoveryRate}%`;

  const notifBadge = el('admin-notif-badge');
  if (notifBadge) {
    if (overdueLoans.length > 0) {
      notifBadge.textContent = overdueLoans.length > 99 ? '99+' : String(overdueLoans.length);
      notifBadge.style.display = 'flex';
    } else {
      notifBadge.style.display = 'none';
    }
  }

  let totalOutstanding = 0;
  cache.loans.forEach(l => totalOutstanding += (l.remainingAmount || 0));
  el('admin-portfolio-outstanding').textContent = formatCurrency(totalOutstanding);

  const circle = el('admin-portfolio-progress-ring');
  if (circle) {
    const r = circle.r.baseVal.value;
    const c = r * 2 * Math.PI;
    circle.style.strokeDasharray  = `${c} ${c}`;
    circle.style.strokeDashoffset = c - (recoveryRate / 100) * c;
  }

  const alertsFeed = el('admin-overdue-alerts');
  if (!alertsFeed) return;

  if (overdueLoans.length === 0) {
    alertsFeed.innerHTML = `
      <div class="empty-state">
        <i data-lucide="shield-check" class="text-success"></i>
        <p>System healthy. No overdue loans pending.</p>
      </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  alertsFeed.innerHTML = overdueLoans.slice(0, 5).map(loan => {
    const client = cache.users.find(c => c.id === loan.customerId);
    const name = client ? client.name : `Client ID ${loan.customerId}`;
    return `
      <div class="transaction-item" style="border-left: 3px solid var(--color-danger);">
        <div class="tx-left">
          <div class="tx-icon-badge repay" style="background-color:rgba(239,68,68,0.1);color:var(--color-danger);">
            <i data-lucide="alert-triangle"></i>
          </div>
          <div class="tx-details">
            <span class="tx-purpose" style="font-weight:700;">Overdue: ${name}</span>
            <span class="tx-date" style="color:var(--color-danger);">Due date: ${formatDate(loan.dueDate)}</span>
          </div>
        </div>
        <div class="tx-right">
          <span class="tx-amount add" style="color:var(--color-danger);">${formatCurrency(loan.remainingAmount)}</span>
          <span class="tx-status-badge text-danger" style="background-color:rgba(239,68,68,0.1);">Past Due</span>
        </div>
      </div>`;
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}


// =============================================================================
// CUSTOMERS
// =============================================================================

function wireAddCustomerForm() {
  const form = document.getElementById('admin-add-customer-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name           = document.getElementById('cust-name').value.trim();
    const phone          = document.getElementById('cust-phone').value.trim();
    const nationalId     = document.getElementById('cust-national-id').value.trim();
    const loanAmount     = parseFloat(document.getElementById('cust-loan-amount').value);
    const interestRate   = parseFloat(document.getElementById('cust-interest-rate').value);
    const repaymentPeriod = parseInt(document.getElementById('cust-repayment-period').value);
    const periodUnit     = document.getElementById('cust-period-unit').value;
    const issueDateStr   = document.getElementById('cust-issue-date').value;
    const dueDateStr     = document.getElementById('cust-due-date').value;
    const penaltyAmt     = parseFloat(document.getElementById('cust-penalty-amount').value) || 0;

    if (!loanAmount || loanAmount <= 0) {
      showToast('Please enter a valid loan amount.', 'error');
      return;
    }
    if (isNaN(interestRate) || interestRate < 0) {
      showToast('Please enter a valid interest rate.', 'error');
      return;
    }
    if (!repaymentPeriod || repaymentPeriod <= 0) {
      showToast('Please enter a valid repayment period.', 'error');
      return;
    }
    if (!issueDateStr || !dueDateStr) {
      showToast('Please select an issue date.', 'error');
      return;
    }

    const issueDateMs = new Date(issueDateStr).getTime();
    const dueDateMs   = new Date(dueDateStr).getTime();
    const interestDecimal = interestRate / 100;
    const totalRepayable  = parseFloat((loanAmount * (1 + interestDecimal)).toFixed(2));

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Creating Borrower…';

    try {
      const customerId = await getNextId('users', 'C-');
      const newLoanId  = await getNextId('loans', 'L-');
      const batch = writeBatch(db);

      // Create user document
      batch.set(doc(db, 'users', customerId), {
        id:         customerId,
        name,
        phone,
        nationalId: nationalId || '',
        pin:        '1234',
        limit:      10000,
        dateAdded:  Date.now()
      });

      // Create loan document
      batch.set(doc(db, 'loans', newLoanId), {
        id:              newLoanId,
        customerId:      customerId,
        loanTypeName:    'Custom Loan',
        amount:          loanAmount,
        term:            repaymentPeriod,
        termUnit:        periodUnit,
        purpose:         'admin-issued',
        interestRate:    interestDecimal,
        totalRepayable,
        remainingAmount: totalRepayable,
        status:          'active',
        dateCreated:     Date.now(),
        disbursedAt:     issueDateMs,
        dueDate:         dueDateMs,
        issuedByAdmin:   true,
        penaltyType:     penaltyAmt > 0 ? 'daily' : 'none',
        penaltyAmount:   penaltyAmt,
        penaltyAccrued:  0,
        penaltyApplied:  false,
        lastPenaltyDate: null
      });

      await batch.commit();

      showToast(`Borrower ${name} created and loan ${newLoanId} issued successfully.`, 'success');
      form.reset();
      // Reset issue date to today
      const issueDateEl = document.getElementById('cust-issue-date');
      if (issueDateEl) issueDateEl.value = new Date().toISOString().split('T')[0];
      const previewEl = document.getElementById('cust-loan-preview');
      if (previewEl) previewEl.style.display = 'none';
    } catch (err) {
      showToast('Error creating borrower: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Create Borrower';
    }
  });
}

let activeCustFilter = 'all';

function wireCustFilters() {
  document.querySelectorAll('[data-cust-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-cust-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeCustFilter = btn.getAttribute('data-cust-filter');
      renderAdminCustomersList();
    });
  });
}

function getCustomerStatus(custId) {
  const custLoans = cache.loans.filter(l => l.customerId === custId);
  if (custLoans.some(l => l.status === 'overdue')) return 'overdue';
  if (custLoans.some(l => l.status === 'active'))  return 'active';
  if (custLoans.length > 0)                        return 'paid';
  return 'none';
}

function renderAdminCustomersList() {
  const listBody = document.getElementById('admin-customers-table-body');
  if (!listBody) return;

  const query = (document.getElementById('cust-search')?.value || '').toLowerCase().trim();

  const filtered = cache.users.filter(c => {
    const matchesSearch = c.name?.toLowerCase().includes(query) || c.phone?.toLowerCase().includes(query) || c.nationalId?.toLowerCase().includes(query);
    if (!matchesSearch) return false;
    if (activeCustFilter === 'all') return true;
    return getCustomerStatus(c.id) === activeCustFilter;
  });

  if (filtered.length === 0) {
    listBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">No matching customers found.</td></tr>`;
    return;
  }

  listBody.innerHTML = filtered.map(c => {
    const custLoans    = cache.loans.filter(l => l.customerId === c.id);
    const activeCount  = custLoans.filter(l => l.status === 'active').length;
    const overdueCount = custLoans.filter(l => l.status === 'overdue').length;
    const paidCount    = custLoans.filter(l => l.status === 'paid').length;

    let loansBadge = '';
    if (overdueCount > 0) loansBadge = `<span class="loan-count-badge overdue">${overdueCount} overdue</span>`;
    else if (activeCount > 0) loansBadge = `<span class="loan-count-badge active">${activeCount} active</span>`;
    else if (paidCount > 0)   loansBadge = `<span class="loan-count-badge paid">${paidCount} paid</span>`;
    else                       loansBadge = `<span class="loan-count-badge none">No loans</span>`;

    const totalPenalty = custLoans.reduce((sum, l) => sum + (l.penaltyAccrued || 0), 0);
    const activeLoans  = custLoans.filter(l => l.status === 'active' || l.status === 'overdue');
    const dailyRate    = activeLoans.reduce((sum, l) => sum + (l.penaltyAmount || 0), 0);

    let penaltyCell = `<span class="text-muted">—</span>`;
    if (totalPenalty > 0 && dailyRate > 0) {
      penaltyCell = `<span class="loan-count-badge overdue">${formatCurrency(totalPenalty)} accrued</span> <span class="loan-count-badge active" style="font-size:0.75em;">+KSh ${dailyRate}/day</span>`;
    } else if (totalPenalty > 0) {
      penaltyCell = `<span class="loan-count-badge overdue">${formatCurrency(totalPenalty)}</span>`;
    } else if (dailyRate > 0) {
      penaltyCell = `<span class="loan-count-badge active">KSh ${dailyRate}/day</span>`;
    }

    const hasPaidLoans = paidCount > 0 && activeCount === 0 && overdueCount === 0;
    const renewBtn = hasPaidLoans
      ? `<button class="btn-action-icon btn-action-renew" data-renew-loan-cust-id="${c.id}" title="Renew Loan" style="color: var(--color-success);">
           <i data-lucide="refresh-cw"></i>
         </button>`
      : '';

    const hasActiveLoans = activeCount > 0 || overdueCount > 0;
    const editPenaltyBtn = hasActiveLoans
      ? `<button class="btn-action-icon btn-action-penalty" data-edit-daily-penalty-cust-id="${c.id}" title="Edit Daily Penalty" style="color: #b45309;">
           <i data-lucide="timer"></i>
         </button>`
      : '';

    return `
      <tr>
        <td>${c.name}</td>
        <td>${c.phone}</td>
        <td class="font-mono">${c.nationalId || '<span class="text-muted">—</span>'}</td>
        <td>${loansBadge}</td>
        <td>${penaltyCell}</td>
        <td>${formatDate(c.dateAdded)}</td>
        <td>
          <div class="actions-cell-group">
            ${renewBtn}
            ${editPenaltyBtn}
            <button class="btn-action-icon btn-action-penalty" data-adjust-penalty-cust-id="${c.id}" title="Add Manual Penalty">
              <i data-lucide="alert-triangle"></i>
            </button>
            <button class="btn-action-icon btn-action-edit" data-edit-cust-id="${c.id}" title="Edit Customer Details">
              <i data-lucide="edit-3"></i>
            </button>
            <button class="btn-action-icon btn-action-delete" data-delete-cust-id="${c.id}" title="Delete Customer">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
  bindCustomerActionListeners();
}

function bindCustomerActionListeners() {
  const editModal    = document.getElementById('edit-customer-modal');

  document.querySelectorAll('[data-renew-loan-cust-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      openRenewLoanModal(btn.getAttribute('data-renew-loan-cust-id'));
    });
  });

  document.querySelectorAll('[data-edit-daily-penalty-cust-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      openEditDailyPenaltyModal(btn.getAttribute('data-edit-daily-penalty-cust-id'));
    });
  });

  document.querySelectorAll('[data-adjust-penalty-cust-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      openAdjustPenaltyModal(btn.getAttribute('data-adjust-penalty-cust-id'));
    });
  });

  document.querySelectorAll('[data-edit-cust-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id       = btn.getAttribute('data-edit-cust-id');
      const customer = cache.users.find(c => c.id === id);
      if (!customer || !editModal) return;

      document.getElementById('edit-cust-uid').value       = customer.id;
      document.getElementById('edit-cust-name').value      = customer.name;
      document.getElementById('edit-cust-phone').value     = customer.phone;
      document.getElementById('edit-cust-national-id').value = customer.nationalId || '';
      editModal.style.display = 'flex';
    });
  });

  document.querySelectorAll('[data-delete-cust-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id       = btn.getAttribute('data-delete-cust-id');
      const customer = cache.users.find(c => c.id === id);
      if (!customer) return;

      if (!confirm(`CRITICAL WARNING: Delete ${customer.name}? This also removes their loans and repayments permanently.`)) return;

      try {
        const batch = writeBatch(db);
        batch.delete(doc(db, 'users', id));

        cache.loans.filter(l => l.customerId === id)
          .forEach(l => batch.delete(doc(db, 'loans', l.id)));

        cache.repayments.filter(r => r.customerId === id)
          .forEach(r => batch.delete(doc(db, 'repayments', r.id)));

        await batch.commit();
        showToast(`Customer ${customer.name} and all associated records deleted.`, 'success');
      } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
      }
    });
  });
}

function wireEditCustomerModal() {
  const form = document.getElementById('admin-edit-customer-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id        = document.getElementById('edit-cust-uid').value;
    const name      = document.getElementById('edit-cust-name').value.trim();
    const phone     = document.getElementById('edit-cust-phone').value.trim();
    const nationalId= document.getElementById('edit-cust-national-id').value.trim();

    try {
      await updateDoc(doc(db, 'users', id), { name, phone, nationalId });
      showToast(`Customer ${name} updated successfully.`, 'success');
      document.getElementById('edit-customer-modal').style.display = 'none';
    } catch (err) {
      showToast('Update failed: ' + err.message, 'error');
    }
  });
}

function wireEditCustomerForm() {
  // handled via wireEditCustomerModal — kept as no-op for symmetry
}


// =============================================================================
// ADD NEW BORROWER MODAL (Full-screen from secondary nav)
// =============================================================================
function openAddBorrowerModal() {
  const modal = document.getElementById('add-borrower-modal');
  if (!modal) return;
  const form = document.getElementById('admin-add-customer-form');
  if (form) {
    form.reset();
    const issueDateEl = document.getElementById('cust-issue-date');
    if (issueDateEl) issueDateEl.value = new Date().toISOString().split('T')[0];
    const dueDateEl = document.getElementById('cust-due-date');
    if (dueDateEl) dueDateEl.value = '';
    const previewEl = document.getElementById('cust-loan-preview');
    if (previewEl) previewEl.style.display = 'none';
    const penaltyEl = document.getElementById('cust-penalty-amount');
    if (penaltyEl) penaltyEl.value = '';
  }
  modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [modal] });
}

function wireAddBorrowerFormPreview() {
  const issueDateEl = document.getElementById('cust-issue-date');
  const dueDateEl   = document.getElementById('cust-due-date');
  const periodInput = document.getElementById('cust-repayment-period');
  const unitSelect  = document.getElementById('cust-period-unit');
  const amountEl    = document.getElementById('cust-loan-amount');
  const rateEl      = document.getElementById('cust-interest-rate');
  const previewEl   = document.getElementById('cust-loan-preview');

  function recalcDueDate() {
    if (!issueDateEl?.value || !periodInput?.value || !unitSelect?.value) {
      if (dueDateEl) dueDateEl.value = '';
      if (previewEl) previewEl.style.display = 'none';
      return;
    }
    const issueDate = new Date(issueDateEl.value);
    const period    = parseInt(periodInput.value);
    const unit      = unitSelect.value;
    const due       = new Date(issueDate);

    if (unit === 'days') {
      due.setDate(due.getDate() + period);
    } else if (unit === 'weeks') {
      due.setDate(due.getDate() + (period * 7));
    } else {
      due.setMonth(due.getMonth() + period);
    }

    if (dueDateEl) dueDateEl.value = due.toISOString().split('T')[0];

    const amount = parseFloat(amountEl?.value);
    const rate   = parseFloat(rateEl?.value);
    if (amount > 0 && !isNaN(rate) && previewEl) {
      const total = parseFloat((amount * (1 + rate / 100)).toFixed(2));
      document.getElementById('preview-principal').textContent = formatCurrency(amount);
      document.getElementById('preview-total').textContent     = formatCurrency(total);
      document.getElementById('preview-due-date').textContent  = due.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      previewEl.style.display = 'flex';
      if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [previewEl] });
    }
  }

  if (issueDateEl) issueDateEl.addEventListener('change', recalcDueDate);
  if (periodInput) periodInput.addEventListener('input', recalcDueDate);
  if (unitSelect)  unitSelect.addEventListener('change', recalcDueDate);
  if (amountEl)    amountEl.addEventListener('input', recalcDueDate);
  if (rateEl)      rateEl.addEventListener('input', recalcDueDate);
}


// =============================================================================
// RENEW LOAN
// =============================================================================
function openRenewLoanModal(custId) {
  const modal = document.getElementById('renew-loan-modal');
  if (!modal) return;
  const customer = cache.users.find(c => c.id === custId);
  if (!customer) return;

  document.getElementById('renew-loan-cust-id').value = custId;
  document.getElementById('renew-loan-cust-name').value = customer.name;
  document.getElementById('renew-loan-client-desc').textContent =
    `Issue a renewed loan for ${customer.name}. Previous loan has been fully paid.`;

  const form = document.getElementById('admin-renew-loan-form');
  if (form) {
    // Keep the cust-id and cust-name, reset everything else
    document.getElementById('renew-loan-amount').value = '';
    document.getElementById('renew-interest-rate').value = '';
    document.getElementById('renew-repayment-period').value = '';
    document.getElementById('renew-period-unit').value = 'months';
    document.getElementById('renew-issue-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('renew-due-date').value = '';
    document.getElementById('renew-loan-preview').style.display = 'none';
    document.getElementById('renew-penalty-amount').value = '';
  }

  modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [modal] });
}

function wireRenewLoanForm() {
  // Wire due date preview listeners
  const issueDateEl = document.getElementById('renew-issue-date');
  const dueDateEl   = document.getElementById('renew-due-date');
  const periodInput = document.getElementById('renew-repayment-period');
  const unitSelect  = document.getElementById('renew-period-unit');
  const amountEl    = document.getElementById('renew-loan-amount');
  const rateEl      = document.getElementById('renew-interest-rate');
  const previewEl   = document.getElementById('renew-loan-preview');

  function recalcDueDate() {
    if (!issueDateEl?.value || !periodInput?.value || !unitSelect?.value) {
      if (dueDateEl) dueDateEl.value = '';
      if (previewEl) previewEl.style.display = 'none';
      return;
    }
    const issueDate = new Date(issueDateEl.value);
    const period    = parseInt(periodInput.value);
    const unit      = unitSelect.value;
    const due       = new Date(issueDate);

    if (unit === 'days') {
      due.setDate(due.getDate() + period);
    } else if (unit === 'weeks') {
      due.setDate(due.getDate() + (period * 7));
    } else {
      due.setMonth(due.getMonth() + period);
    }

    if (dueDateEl) dueDateEl.value = due.toISOString().split('T')[0];

    const amount = parseFloat(amountEl?.value);
    const rate   = parseFloat(rateEl?.value);
    if (amount > 0 && !isNaN(rate) && previewEl) {
      const total = parseFloat((amount * (1 + rate / 100)).toFixed(2));
      document.getElementById('renew-preview-principal').textContent = formatCurrency(amount);
      document.getElementById('renew-preview-total').textContent     = formatCurrency(total);
      document.getElementById('renew-preview-due-date').textContent  = due.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      previewEl.style.display = 'flex';
      if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [previewEl] });
    }
  }

  if (issueDateEl) issueDateEl.addEventListener('change', recalcDueDate);
  if (periodInput) periodInput.addEventListener('input', recalcDueDate);
  if (unitSelect)  unitSelect.addEventListener('change', recalcDueDate);
  if (amountEl)    amountEl.addEventListener('input', recalcDueDate);
  if (rateEl)      rateEl.addEventListener('input', recalcDueDate);

  // Wire form submission
  const form = document.getElementById('admin-renew-loan-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const custId         = document.getElementById('renew-loan-cust-id').value;
    const loanAmount     = parseFloat(document.getElementById('renew-loan-amount').value);
    const interestRate   = parseFloat(document.getElementById('renew-interest-rate').value);
    const repaymentPeriod = parseInt(document.getElementById('renew-repayment-period').value);
    const periodUnit     = document.getElementById('renew-period-unit').value;
    const issueDateStr   = document.getElementById('renew-issue-date').value;
    const dueDateStr     = document.getElementById('renew-due-date').value;
    const penaltyAmt     = parseFloat(document.getElementById('renew-penalty-amount').value) || 0;

    if (!loanAmount || loanAmount <= 0) {
      showToast('Please enter a valid loan amount.', 'error');
      return;
    }
    if (isNaN(interestRate) || interestRate < 0) {
      showToast('Please enter a valid interest rate.', 'error');
      return;
    }
    if (!repaymentPeriod || repaymentPeriod <= 0) {
      showToast('Please enter a valid repayment period.', 'error');
      return;
    }
    if (!issueDateStr || !dueDateStr) {
      showToast('Please select an issue date.', 'error');
      return;
    }

    const customer = cache.users.find(c => c.id === custId);
    if (!customer) { showToast('Customer not found.', 'error'); return; }

    const issueDateMs      = new Date(issueDateStr).getTime();
    const dueDateMs        = new Date(dueDateStr).getTime();
    const interestDecimal  = interestRate / 100;
    const totalRepayable   = parseFloat((loanAmount * (1 + interestDecimal)).toFixed(2));

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Issuing Loan…';

    try {
      const newLoanId = await getNextId('loans', 'L-');
      await setDoc(doc(db, 'loans', newLoanId), {
        id:              newLoanId,
        customerId:      custId,
        loanTypeName:    'Renewed Loan',
        amount:          loanAmount,
        term:            repaymentPeriod,
        termUnit:        periodUnit,
        purpose:         'renewed',
        interestRate:    interestDecimal,
        totalRepayable,
        remainingAmount: totalRepayable,
        status:          'active',
        dateCreated:     Date.now(),
        disbursedAt:     issueDateMs,
        dueDate:         dueDateMs,
        issuedByAdmin:   true,
        penaltyType:     penaltyAmt > 0 ? 'daily' : 'none',
        penaltyAmount:   penaltyAmt,
        penaltyAccrued:  0,
        penaltyApplied:  false,
        lastPenaltyDate: null
      });

      showToast(`Renewed loan ${newLoanId} issued to ${customer.name}.`, 'success');
      document.getElementById('renew-loan-modal').style.display = 'none';
    } catch (err) {
      showToast('Error issuing renewed loan: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Issue Renewed Loan';
    }
  });
}


// =============================================================================
// EDIT DAILY PENALTY AMOUNT ON ACTIVE LOANS
// =============================================================================
function openEditDailyPenaltyModal(custId) {
  const modal      = document.getElementById('edit-daily-penalty-modal');
  const loanSelect = document.getElementById('edit-daily-penalty-loan-select');
  const hintEl     = document.getElementById('edit-daily-penalty-loan-hint');
  const custHidden = document.getElementById('edit-daily-penalty-cust-id');
  if (!modal || !loanSelect) return;

  const customer = custId ? cache.users.find(c => c.id === custId) : null;
  if (!customer) return;

  custHidden.value = custId;
  document.getElementById('edit-daily-penalty-client-desc').textContent =
    `Change the daily penalty amount for ${customer.name}'s active loans.`;

  const custLoans = cache.loans.filter(l =>
    l.customerId === custId && (l.status === 'active' || l.status === 'overdue')
  );

  loanSelect.innerHTML = '<option value="" disabled selected>Choose a loan...</option>';
  custLoans.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = `${customer.name} — ${l.loanTypeName || 'Loan'} (${formatCurrency(l.remainingAmount)} outstanding, ${l.status}) | Current: KSh ${l.penaltyAmount || 0}/day`;
    loanSelect.appendChild(opt);
  });

  if (hintEl) hintEl.textContent = custLoans.length === 0
    ? 'No active or overdue loans for this client.'
    : '';

  loanSelect.onchange = () => {
    const loan = cache.loans.find(l => l.id === loanSelect.value);
    const amtInput = document.getElementById('edit-daily-penalty-amount');
    if (loan && amtInput) {
      amtInput.value = loan.penaltyAmount || 0;
    }
  };

  document.getElementById('edit-daily-penalty-amount').value = '';
  modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [modal] });
}

function wireEditDailyPenaltyModal() {
  const form = document.getElementById('admin-edit-daily-penalty-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const loanId      = document.getElementById('edit-daily-penalty-loan-select').value;
    const penaltyAmt  = parseFloat(document.getElementById('edit-daily-penalty-amount').value);

    if (!loanId) { showToast('Please select a loan.', 'error'); return; }
    if (isNaN(penaltyAmt) || penaltyAmt < 0) { showToast('Please enter a valid penalty amount.', 'error'); return; }

    const loan = cache.loans.find(l => l.id === loanId);
    if (!loan) { showToast('Loan not found.', 'error'); return; }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Saving…';

    try {
      await updateDoc(doc(db, 'loans', loanId), {
        penaltyType:   penaltyAmt > 0 ? 'daily' : 'none',
        penaltyAmount: penaltyAmt
      });

      showToast(`Daily penalty updated to KSh ${penaltyAmt}/day for loan ${loanId}.`, 'success');
      document.getElementById('edit-daily-penalty-modal').style.display = 'none';
    } catch (err) {
      showToast('Error updating penalty: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Save Penalty';
    }
  });
}


// =============================================================================
// MANUAL PENALTY ADJUSTMENT
// =============================================================================
function openAdjustPenaltyModal(custId) {
  const modal      = document.getElementById('adjust-penalty-modal');
  const loanSelect = document.getElementById('adjust-penalty-loan-select');
  const hintEl     = document.getElementById('adjust-penalty-loan-hint');
  const custSelect = document.getElementById('adjust-penalty-cust-select');
  const custGroup  = document.getElementById('adjust-penalty-client-group');
  const custHidden = document.getElementById('adjust-penalty-cust-id');
  if (!modal || !loanSelect) return;

  const customer = custId ? cache.users.find(c => c.id === custId) : null;

  if (customer) {
    custHidden.value = custId;
    if (custGroup) custGroup.style.display = 'none';
    document.getElementById('adjust-penalty-client-desc').textContent =
      `Add a manual penalty charge to one of ${customer.name}'s loans.`;

    const custLoans = cache.loans.filter(l =>
      l.customerId === custId && (l.status === 'active' || l.status === 'overdue')
    );
    loanSelect.innerHTML = '<option value="" disabled selected>Choose a loan record...</option>';
    custLoans.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = `${customer.name} — ${l.loanTypeName || 'Loan'} (${formatCurrency(l.remainingAmount)} outstanding, ${l.status})`;
      loanSelect.appendChild(opt);
    });
    if (hintEl) hintEl.textContent = custLoans.length === 0
      ? 'No active or overdue loans for this client.'
      : '';
  } else {
    custHidden.value = '';
    if (custGroup) custGroup.style.display = 'block';
    if (custSelect) {
      custSelect.innerHTML = '<option value="" disabled selected>Choose a client...</option>';
      cache.users.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.name} (${c.id})`;
        custSelect.appendChild(opt);
      });
    }
    document.getElementById('adjust-penalty-client-desc').textContent =
      'Select a client and add a manual penalty charge to one of their loans.';
    loanSelect.innerHTML = '<option value="" disabled selected>Choose a loan record...</option>';
    if (hintEl) hintEl.textContent = 'Select a client first to see their loans.';
  }

  document.getElementById('adjust-penalty-amount').value = '';
  modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [modal] });
}

function wireAdjustPenaltyModal() {
  document.getElementById('btn-close-adjust-penalty-modal')?.addEventListener('click', () => {
    document.getElementById('adjust-penalty-modal').style.display = 'none';
  });

  const custSelect = document.getElementById('adjust-penalty-cust-select');
  if (custSelect) {
    custSelect.addEventListener('change', () => {
      const custId = custSelect.value;
      const loanSelect = document.getElementById('adjust-penalty-loan-select');
      const hintEl = document.getElementById('adjust-penalty-loan-hint');
      const custLoans = cache.loans.filter(l =>
        l.customerId === custId && (l.status === 'active' || l.status === 'overdue')
      );
      loanSelect.innerHTML = '<option value="" disabled selected>Choose a loan record...</option>';
      custLoans.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        const client = cache.users.find(c => c.id === l.customerId);
        const name = client ? client.name : l.customerId;
        opt.textContent = `${name} — ${l.loanTypeName || 'Loan'} (${formatCurrency(l.remainingAmount)} outstanding, ${l.status})`;
        loanSelect.appendChild(opt);
      });
      if (hintEl) hintEl.textContent = custLoans.length === 0
        ? 'No active or overdue loans for this client.'
        : '';
      document.getElementById('adjust-penalty-cust-id').value = custId;
    });
  }

  const form = document.getElementById('admin-adjust-penalty-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const loanId = document.getElementById('adjust-penalty-loan-select').value;
    const amount = parseFloat(document.getElementById('adjust-penalty-amount').value);
    const loan   = cache.loans.find(l => l.id === loanId);

    if (!loan)  { showToast('Please select a loan.', 'error'); return; }
    if (!amount || amount <= 0) { showToast('Please enter a valid penalty amount.', 'error'); return; }

    const btn = document.getElementById('btn-submit-adjust-penalty');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Applying…';

    try {
      await updateDoc(doc(db, 'loans', loanId), {
        remainingAmount: (loan.remainingAmount || 0) + amount,
        totalRepayable:  (loan.totalRepayable || 0) + amount,
        penaltyAccrued:  (loan.penaltyAccrued || 0) + amount
      });

      showToast(`Penalty of ${formatCurrency(amount)} added to loan ${loanId}.`, 'success');
      document.getElementById('adjust-penalty-modal').style.display = 'none';
      form.reset();
    } catch (err) {
      showToast('Error applying penalty: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Add Penalty';
    }
  });
}


// =============================================================================
// LOANS LEDGER
// =============================================================================
let activeLoanFilter = 'all';

function wireLoanFilters() {
  document.querySelectorAll('[data-loan-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-loan-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeLoanFilter = btn.getAttribute('data-loan-filter');
      renderAdminLoansLedger();
    });
  });
}

function renderAdminLoansLedger() {
  const listBody = document.getElementById('admin-loans-table-body');
  if (!listBody) return;

  const query = (document.getElementById('loans-search')?.value || '').toLowerCase().trim();

  const filtered = cache.loans.filter(l => {
    const client = cache.users.find(c => c.id === l.customerId);
    const name   = client ? client.name.toLowerCase() : '';
    const matchesSearch = l.id?.toLowerCase().includes(query) || name.includes(query);
    if (!matchesSearch) return false;
    if (activeLoanFilter === 'all') return true;
    return l.status === activeLoanFilter;
  });

  if (filtered.length === 0) {
    listBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">No ledger logs found.</td></tr>`;
    return;
  }

  listBody.innerHTML = filtered.map(l => {
    const client = cache.users.find(c => c.id === l.customerId);
    const name   = client ? client.name : `Client ID ${l.customerId}`;
    const isPaid = l.status === 'paid';
    const statusPill = isPaid
      ? `<span class="status-pill paid">Settled</span>`
      : (l.status === 'overdue'
        ? `<span class="status-pill text-danger" style="background-color:rgba(239,68,68,0.1);">Overdue</span>`
        : `<span class="status-pill active">Outstanding</span>`);

    return `
      <tr>
        <td class="font-mono"><strong>${l.id}</strong></td>
        <td>${name}</td>
        <td>${formatCurrency(l.amount)}</td>
        <td>${formatDate(l.dueDate)}</td>
        <td class="${isPaid ? 'text-success' : 'text-danger'} font-weight-bold">${formatCurrency(l.remainingAmount)}</td>
        <td>${statusPill}</td>
      </tr>`;
  }).join('');
}


// =============================================================================
// REPAYMENTS / COLLECTIONS
// =============================================================================
let activeRepayFilter = 'all';

function wireRepayFilters() {
  document.querySelectorAll('[data-repay-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-repay-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeRepayFilter = btn.getAttribute('data-repay-filter');
      renderAdminRepaymentsLog();
    });
  });
}

function wireRepaymentForm() {
  const form            = document.getElementById('admin-repayment-form');
  const repaySelect     = document.getElementById('admin-repay-loan-select');
  const repayAmt        = document.getElementById('admin-repay-amount');
  const repayMaxHelp    = document.getElementById('admin-repay-max-help');
  const repaySubmitBtn  = document.getElementById('admin-btn-submit-repay');

  if (repaySelect) {
    repaySelect.addEventListener('change', () => {
      const loan = cache.loans.find(l => l.id === repaySelect.value);
      if (loan) {
        if (repayMaxHelp) repayMaxHelp.textContent = `Maximum outstanding: ${formatCurrency(loan.remainingAmount)}`;
        if (repayAmt) { repayAmt.max = loan.remainingAmount; repayAmt.value = loan.remainingAmount.toFixed(2); }
        if (repaySubmitBtn) repaySubmitBtn.disabled = false;
      } else {
        if (repaySubmitBtn) repaySubmitBtn.disabled = true;
      }
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const loanId = repaySelect?.value;
      const amount = parseFloat(repayAmt?.value);
      const loan   = cache.loans.find(l => l.id === loanId);

      if (!loan) return;
      if (amount <= 0 || amount > loan.remainingAmount) {
        showToast('Invalid collection amount.', 'error');
        return;
      }

      if (repaySubmitBtn) {
        repaySubmitBtn.disabled = true;
        repaySubmitBtn.querySelector('span').textContent = 'Recording collection…';
      }

      try {
        const newRemaining = Math.max(0, loan.remainingAmount - amount);
        const newStatus    = newRemaining <= 0.01 ? 'paid' : loan.status;

        const repId  = await getNextId('repayments', 'R-');
        const method = document.querySelector('input[name="admin-pay-method"]:checked')?.value || 'cash';

        const batch = writeBatch(db);
        batch.update(doc(db, 'loans', loanId), {
          remainingAmount: newRemaining <= 0.01 ? 0 : newRemaining,
          status: newStatus
        });
        batch.set(doc(db, 'repayments', repId), {
          id:          repId,
          loanId,
          customerId:  loan.customerId,
          amount,
          method,
          timestamp:   Date.now(),
          date:        Date.now()
        });
        await batch.commit();

        showToast(`Collection recorded: ${formatCurrency(amount)} received.`, 'success');
        form.reset();
        if (repayMaxHelp) repayMaxHelp.textContent = 'Select a loan to view outstanding balance.';
      } catch (err) {
        showToast('Error recording payment: ' + err.message, 'error');
      } finally {
        if (repaySubmitBtn) {
          repaySubmitBtn.disabled = false;
          repaySubmitBtn.querySelector('span').textContent = 'Record Repayment Log';
        }
      }
    });
  }
}

function renderAdminPaymentsPortal() {
  const repaySelect    = document.getElementById('admin-repay-loan-select');
  const repaySubmitBtn = document.getElementById('admin-btn-submit-repay');
  const repayMaxHelp   = document.getElementById('admin-repay-max-help');

  if (!repaySelect) return;

  const activeLoans = cache.loans.filter(l => l.status === 'active' || l.status === 'overdue');
  repaySelect.innerHTML = '<option value="" disabled selected>Choose a loan record…</option>';
  activeLoans.forEach(l => {
    const client = cache.users.find(c => c.id === l.customerId);
    const name   = client ? client.name : `ID: ${l.customerId}`;
    const opt    = document.createElement('option');
    opt.value       = l.id;
    opt.textContent = `${l.id} - ${name} (${formatCurrency(l.remainingAmount)} balance)`;
    repaySelect.appendChild(opt);
  });

  if (repayMaxHelp) repayMaxHelp.textContent = 'Select a loan to view outstanding balance.';
  if (repaySubmitBtn) repaySubmitBtn.disabled = true;
  renderAdminRepaymentsLog();
}

function renderAdminRepaymentsLog() {
  const list = document.getElementById('admin-repayments-log-list');
  if (!list) return;

  const query = (document.getElementById('repayments-search')?.value || '').toLowerCase().trim();

  const filtered = cache.repayments.filter(r => {
    const client = cache.users.find(c => c.id === r.customerId);
    const name   = client ? client.name.toLowerCase() : '';
    const matchesSearch = r.loanId?.toLowerCase().includes(query) || name.includes(query);
    if (!matchesSearch) return false;

    if (activeRepayFilter !== 'all') {
      const loan = cache.loans.find(l => l.id === r.loanId);
      if (!loan || loan.status !== activeRepayFilter) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <i data-lucide="history"></i>
        <p>No collections found in logs.</p>
      </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  const sorted = [...filtered].sort((a, b) => tsToMs(b.timestamp) - tsToMs(a.timestamp));
  list.innerHTML = sorted.map(rep => {
    const client = cache.users.find(c => c.id === rep.customerId);
    const name   = client ? client.name : `Client ID ${rep.customerId}`;
    return `
      <div class="repay-log-item">
        <div class="repay-log-details">
          <span class="repay-log-title">Payment: ${name} (Loan ${rep.loanId})</span>
          <span class="repay-log-meta">${formatDateTime(rep.timestamp || rep.date)} • Method: ${(rep.method || '').toUpperCase()}</span>
        </div>
        <span class="repay-log-amount">+${formatCurrency(rep.amount)}</span>
      </div>`;
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
