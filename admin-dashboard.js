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
//   users/{userId}        – client accounts { name, phone, nationalId, pin, limit, dateAdded }
//   loans/{loanId}        – loan records
//   repayments/{repId}    – repayment logs
//   loanTypes/{ltId}      – loan product definitions
//   loanApplications/{id} – client applications

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
const loanTypesCol    = collection(db, 'loanTypes');
const loanAppsCol     = collection(db, 'loanApplications');
const adminsCol       = collection(db, 'admins');
const bootstrapRef    = doc(db, 'meta', 'adminBootstrap');

// ── In-memory cache (refreshed from Firestore on each view switch) ────────────
const cache = {
  users:            [],
  loans:            [],
  repayments:       [],
  loanTypes:        [],
  loanApplications: [],
  currentAdmin:     null, // { uid, email, displayName, role } for the signed-in admin
  settings: { theme: 'light', font: 'sans', scale: 'medium' }
};

// ── Unsub handles for real-time listeners ─────────────────────────────────────
let unsubUsers = null, unsubLoans = null, unsubRepayments = null;
let unsubLoanTypes = null, unsubLoanApps = null;

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
  wireAppFilters();

  // Limit sliders
  wireSliders();

  // Edit modal close
  document.getElementById('btn-close-edit-modal')?.addEventListener('click', () => {
    document.getElementById('edit-customer-modal').style.display = 'none';
  });

  // App-status modal
  document.getElementById('btn-close-app-status-modal')?.addEventListener('click', () => {
    document.getElementById('app-status-modal').style.display = 'none';
  });

  document.querySelectorAll('input[name="app-status-choice"]').forEach(r =>
    r.addEventListener('change', updateDisbursalSection)
  );

  // Loan type penalty fields toggle
  document.querySelectorAll('input[name="lt-penalty-type"]').forEach(r =>
    r.addEventListener('change', updateLoanTypePenaltyFields)
  );

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

  // ── Form submissions ─────────────────────────────────────────────────────────
  wireAddCustomerForm();
  wireEditCustomerForm();
  wireRepaymentForm();
  wireAddLoanTypeForm();
  wireEditCustomerModal();
  wireAppStatusModal();
  wireIssueLoanModal();
  wireAdjustPenaltyModal();

  // ── Clients secondary nav buttons ────────────────────────────────────────────
  document.getElementById('btn-open-add-borrower-modal')?.addEventListener('click', () => openAddBorrowerModal());
  document.getElementById('btn-open-issue-loan-modal')?.addEventListener('click', () => openIssueLoanModal());
  document.getElementById('btn-open-adjust-penalty-modal')?.addEventListener('click', () => openAdjustPenaltyModal());

  // ── Close modals ─────────────────────────────────────────────────────────────
  document.getElementById('btn-close-add-borrower-modal')?.addEventListener('click', () => {
    document.getElementById('add-borrower-modal').style.display = 'none';
    const form = document.getElementById('admin-add-customer-form');
    const successScreen = document.getElementById('borrower-reg-success');
    if (form) form.style.display = '';
    if (successScreen) successScreen.style.display = 'none';
  });

  // ── Issue loan client selector → populate loans for selected client ──────────
  document.getElementById('issue-loan-cust-select')?.addEventListener('change', (e) => {
    const custId = e.target.value;
    const custHidden = document.getElementById('issue-loan-cust-id');
    if (custHidden) custHidden.value = custId;
    const customer = cache.users.find(c => c.id === custId);
    if (customer) {
      document.getElementById('issue-loan-client-desc').textContent =
        `Issue a new loan for ${customer.name} (${custId}). Borrow limit: ${formatCurrency(customer.limit)}.`;
    }
  });

  // ── Bottom nav search inputs ─────────────────────────────────────────────────
  document.getElementById('issue-loan-type-select')?.addEventListener('change', updateIssueLoanPreview);
  document.getElementById('issue-loan-amount')?.addEventListener('input', updateIssueLoanPreview);

  document.getElementById('cust-search')?.addEventListener('input', () => renderAdminCustomersList());
  document.getElementById('loans-search')?.addEventListener('input', () => renderAdminLoansLedger());
  document.getElementById('repayments-search')?.addEventListener('input', () => renderAdminRepaymentsLog());
  document.getElementById('applications-search')?.addEventListener('input', () => renderAdminApplications());

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
  renderAdminView('all');
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

  unsubLoanTypes = onSnapshot(loanTypesCol, snap => {
    cache.loanTypes = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
    refreshCurrentView();
  });

  unsubLoanApps = onSnapshot(loanAppsCol, snap => {
    cache.loanApplications = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
    refreshCurrentView();
  });
}

function teardownListeners() {
  [unsubUsers, unsubLoans, unsubRepayments, unsubLoanTypes, unsubLoanApps].forEach(fn => fn && fn());
  unsubUsers = unsubLoans = unsubRepayments = unsubLoanTypes = unsubLoanApps = null;
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

function switchView(targetViewId) {
  const target = document.getElementById(targetViewId);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function refreshCurrentView() {
  if (document.getElementById('admin-container')?.classList.contains('active')) {
    renderAdminView('all');
  }
}

function renderAdminView(viewId) {
  renderAdminDashboard();
  renderAdminCustomersList();
  renderAdminLoansLedger();
  renderAdminPaymentsPortal();
  renderAdminApplications();
  renderAdminLoanTypes();
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
      loanTypes:        cache.loanTypes,
      loanApplications: cache.loanApplications,
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
    repayments:       repaymentsCol,
    loanTypes:        loanTypesCol,
    loanApplications: loanAppsCol
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
    head: [['ID', 'Name', 'Phone', 'National ID', 'Loans', 'Penalty', 'Limit']],
    body: cache.users.map(c => {
      const cLoans = cache.loans.filter(l => l.customerId === c.id);
      const penalty = cLoans.reduce((s, l) => s + (l.penaltyAccrued || 0), 0);
      return [c.id, c.name, c.phone, c.nationalId || '-', cLoans.length, penalty > 0 ? formatCurrency(penalty) : '-', formatCurrency(c.limit)];
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

  // ── LOAN APPLICATIONS TABLE ──
  if (cache.loanApplications.length > 0) {
    addPageIfNeeded(20);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('Loan Applications', 14, y); y += 3;
    doc.autoTable({
      startY: y,
      head: [['App ID', 'Client', 'Type', 'Amount', 'Status', 'Date']],
      body: cache.loanApplications.map(a => {
        const c = cache.users.find(u => u.id === a.customerId);
        return [a.id, c ? c.name : a.customerId, a.loanTypeName || '-', formatCurrency(a.amount), a.status || 'pending', formatDate(a.dateApplied)];
      }),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [37, 99, 235] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: 14 }
    });
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
function wireSliders() {
  const editSlider = document.getElementById('edit-cust-limit');
  const editVal    = document.getElementById('edit-cust-limit-val');
  if (editSlider && editVal) {
    editSlider.addEventListener('input', () => { editVal.textContent = formatCurrency(editSlider.value); });
  }
}

function wireAddCustomerForm() {
  const form = document.getElementById('admin-add-customer-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name      = document.getElementById('cust-name').value.trim();
    const phone     = document.getElementById('cust-phone').value.trim();
    let   customId  = document.getElementById('cust-id').value.trim();
    const nationalId= document.getElementById('cust-national-id').value.trim();
    const pin       = document.getElementById('cust-pin').value;
    const limit     = parseInt(document.getElementById('cust-limit').value);

    if (!customId) customId = String(Math.floor(10000000 + Math.random() * 90000000));

    if (pin.length < 4 || pin.length > 8 || isNaN(Number(pin))) {
      showToast('PIN must be a 4-8 digit numerical code.', 'error');
      return;
    }

    // Check duplicate in Firestore
    const dup = cache.users.find(c => c.id === customId);
    if (dup) { showToast('Duplicate ID: Customer already registered.', 'error'); return; }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Registering…';

    try {
      await setDoc(doc(db, 'users', customId), {
        id:         customId,
        name,
        phone,
        nationalId: nationalId || '',
        pin,
        limit,
        dateAdded:  Date.now()
      });
      showToast(`Customer registered successfully with ID: ${customId}`, 'success');

      const formEl = document.getElementById('admin-add-customer-form');
      const successScreen = document.getElementById('borrower-reg-success');
      const successId = document.getElementById('borrower-reg-success-id');
      if (formEl) formEl.style.display = 'none';
      if (successId) successId.textContent = `${name} — ID: ${customId}`;
      if (successScreen) successScreen.style.display = 'flex';

      const doneBtn = document.getElementById('borrower-reg-done-btn');
      const issueLoanBtn = document.getElementById('borrower-reg-issue-loan-btn');
      const newDoneHandler = () => {
        document.getElementById('add-borrower-modal').style.display = 'none';
        doneBtn?.removeEventListener('click', newDoneHandler);
      };
      const newIssueHandler = () => {
        document.getElementById('add-borrower-modal').style.display = 'none';
        openIssueLoanModal(customId);
        issueLoanBtn?.removeEventListener('click', newIssueHandler);
      };
      doneBtn?.removeEventListener('click', newDoneHandler);
      issueLoanBtn?.removeEventListener('click', newIssueHandler);
      doneBtn?.addEventListener('click', newDoneHandler);
      issueLoanBtn?.addEventListener('click', newIssueHandler);
      if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [successScreen] });
    } catch (err) {
      showToast('Error registering customer: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Register Borrower';
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
    const matchesSearch = c.name?.toLowerCase().includes(query) || c.id?.toLowerCase().includes(query);
    if (!matchesSearch) return false;
    if (activeCustFilter === 'all') return true;
    return getCustomerStatus(c.id) === activeCustFilter;
  });

  if (filtered.length === 0) {
    listBody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">No matching customers found.</td></tr>`;
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
    const penaltyCell  = totalPenalty > 0
      ? `<span class="loan-count-badge overdue">${formatCurrency(totalPenalty)}</span>`
      : `<span class="text-muted">—</span>`;

    return `
      <tr>
        <td class="font-mono"><strong>${c.id}</strong></td>
        <td>${c.name}</td>
        <td>${c.phone}</td>
        <td class="font-mono">${c.nationalId || '<span class="text-muted">—</span>'}</td>
        <td>${loansBadge}</td>
        <td>${penaltyCell}</td>
        <td><strong>${formatCurrency(c.limit)}</strong></td>
        <td>${formatDate(c.dateAdded)}</td>
        <td>
          <div class="actions-cell-group">
            <button class="btn-action-icon btn-action-issue" data-issue-loan-cust-id="${c.id}" title="Issue Loan to Client">
              <i data-lucide="banknote"></i>
            </button>
            <button class="btn-action-icon btn-action-penalty" data-adjust-penalty-cust-id="${c.id}" title="Increase Penalty">
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
  const editSlider   = document.getElementById('edit-cust-limit');
  const editLimitVal = document.getElementById('edit-cust-limit-val');

  document.querySelectorAll('[data-issue-loan-cust-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      openIssueLoanModal(btn.getAttribute('data-issue-loan-cust-id'));
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
      document.getElementById('edit-cust-pin').value       = customer.pin;

      if (editSlider) {
        editSlider.value = customer.limit;
        if (editLimitVal) editLimitVal.textContent = formatCurrency(customer.limit);
      }
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

        cache.loanApplications.filter(a => a.customerId === id)
          .forEach(a => batch.delete(doc(db, 'loanApplications', a.id)));

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
    const pin       = document.getElementById('edit-cust-pin').value;
    const limit     = parseInt(document.getElementById('edit-cust-limit').value);

    if (pin.length < 4 || pin.length > 8 || isNaN(Number(pin))) {
      showToast('PIN must be a 4-8 digit numerical code.', 'error');
      return;
    }

    try {
      await updateDoc(doc(db, 'users', id), { name, phone, nationalId, pin, limit });
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
  const successScreen = document.getElementById('borrower-reg-success');
  if (form) {
    form.reset();
    document.getElementById('cust-limit').value = 5000;
    form.style.display = '';
  }
  if (successScreen) successScreen.style.display = 'none';
  modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [modal] });
}


// =============================================================================
// ISSUE DIRECT LOAN (Admin-initiated, bypasses client application)
// =============================================================================
function openIssueLoanModal(custId) {
  const modal      = document.getElementById('issue-loan-modal');
  const typeSelect = document.getElementById('issue-loan-type-select');
  const custSelect = document.getElementById('issue-loan-cust-select');
  const custGroup  = document.getElementById('issue-loan-client-group');
  const custHidden = document.getElementById('issue-loan-cust-id');
  if (!modal || !typeSelect) return;

  const customer = custId ? cache.users.find(c => c.id === custId) : null;

  if (customer) {
    custHidden.value = custId;
    if (custGroup) custGroup.style.display = 'none';
    document.getElementById('issue-loan-client-desc').textContent =
      `Issue a new loan for ${customer.name} (${custId}). Borrow limit: ${formatCurrency(customer.limit)}.`;
  } else {
    custHidden.value = '';
    if (custGroup) custGroup.style.display = 'block';
    if (custSelect) {
      custSelect.innerHTML = '<option value="" disabled selected>Choose a client...</option>';
      cache.users.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.name} (${c.id}) — Limit: ${formatCurrency(c.limit)}`;
        custSelect.appendChild(opt);
      });
    }
    document.getElementById('issue-loan-client-desc').textContent =
      'Select a client and disburse a new loan directly.';
  }

  typeSelect.innerHTML = '<option value="" disabled selected>Choose a loan type...</option>';
  cache.loanTypes.forEach(lt => {
    const opt = document.createElement('option');
    opt.value = lt.id;
    opt.textContent = `${lt.name} (${lt.term} mo. • ${lt.interestRate}%)`;
    typeSelect.appendChild(opt);
  });

  document.getElementById('issue-loan-amount').value = '';
  document.getElementById('issue-loan-preview').style.display = 'none';
  document.getElementById('issue-loan-limit-hint').textContent = 'Select a loan type to continue.';

  modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [modal] });
}

function updateIssueLoanPreview() {
  const typeSelect = document.getElementById('issue-loan-type-select');
  const amountEl   = document.getElementById('issue-loan-amount');
  const hintEl      = document.getElementById('issue-loan-limit-hint');
  const preview     = document.getElementById('issue-loan-preview');
  const totalEl     = document.getElementById('issue-loan-total-value');
  const dueEl       = document.getElementById('issue-loan-due-value');

  const loanType = cache.loanTypes.find(lt => lt.id === typeSelect?.value);
  const amount   = parseFloat(amountEl?.value);

  if (!loanType) {
    if (hintEl) hintEl.textContent = 'Select a loan type to continue.';
    if (preview) preview.style.display = 'none';
    return;
  }

  if (hintEl) hintEl.textContent = `${loanType.term}-month term at ${loanType.interestRate}% interest.`;

  if (!amount || amount <= 0) {
    if (preview) preview.style.display = 'none';
    return;
  }

  const total   = parseFloat((amount * (1 + loanType.interestRate / 100)).toFixed(2));
  const dueDate = calcDueDate(loanType.term);

  if (totalEl) totalEl.textContent = formatCurrency(total);
  if (dueEl)   dueEl.textContent   = formatDate(dueDate);
  if (preview) preview.style.display = 'flex';
}

function wireIssueLoanModal() {
  document.getElementById('btn-close-issue-loan-modal')?.addEventListener('click', () => {
    document.getElementById('issue-loan-modal').style.display = 'none';
  });

  const form = document.getElementById('admin-issue-loan-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    let custId    = document.getElementById('issue-loan-cust-id').value;
    if (!custId) custId = document.getElementById('issue-loan-cust-select').value;
    const typeId    = document.getElementById('issue-loan-type-select').value;
    const amount    = parseFloat(document.getElementById('issue-loan-amount').value);
    const loanType  = cache.loanTypes.find(lt => lt.id === typeId);
    const customer  = cache.users.find(c => c.id === custId);

    if (!customer) { showToast('Please select a client.', 'error'); return; }
    if (!loanType) { showToast('Please select a valid loan type.', 'error'); return; }
    if (!amount || amount <= 0) { showToast('Please enter a valid disbursement amount.', 'error'); return; }

    const interestRate   = loanType.interestRate / 100;
    const totalRepayable = parseFloat((amount * (1 + interestRate)).toFixed(2));
    const dueDate        = calcDueDate(loanType.term);
    const newLoanId       = 'L-' + Math.floor(100000 + Math.random() * 900000);

    const btn = document.getElementById('btn-submit-issue-loan');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Issuing…';

    try {
      await setDoc(doc(db, 'loans', newLoanId), {
        id:              newLoanId,
        customerId:      custId,
        loanTypeName:    loanType.name,
        amount,
        term:            loanType.term,
        purpose:         'admin-issued',
        interestRate,
        totalRepayable,
        remainingAmount: totalRepayable,
        status:          'active',
        dateCreated:     Date.now(),
        disbursedAt:     Date.now(),
        dueDate,
        issuedByAdmin:   true,
        penaltyType:     loanType.penaltyType || 'none',
        penaltyAmount:   loanType.penaltyAmount || 0,
        penaltyAccrued:  0,
        penaltyApplied:  false,
        lastPenaltyDate: null
      });

      showToast(`Loan ${newLoanId} issued to ${customer.name}.`, 'success');
      document.getElementById('issue-loan-modal').style.display = 'none';
      form.reset();
    } catch (err) {
      showToast('Error issuing loan: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Issue Loan';
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
      opt.textContent = `${l.id} — ${formatCurrency(l.remainingAmount)} outstanding (${l.status})`;
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
        opt.textContent = `${l.id} — ${formatCurrency(l.remainingAmount)} outstanding (${l.status})`;
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

        const repId  = 'R-' + Math.floor(100000 + Math.random() * 900000);
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


// =============================================================================
// LOAN APPLICATIONS
// =============================================================================
let activeAppFilter = 'all';

function wireAppFilters() {
  document.querySelectorAll('[data-app-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-app-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeAppFilter = btn.getAttribute('data-app-filter');
      renderAdminApplications();
    });
  });
}

function renderAdminApplications() {
  const tbody = document.getElementById('admin-applications-table-body');
  if (!tbody) return;

  const query = (document.getElementById('applications-search')?.value || '').toLowerCase().trim();

  const filtered = cache.loanApplications.filter(app => {
    const client = cache.users.find(c => c.id === app.customerId);
    const name   = client ? client.name.toLowerCase() : '';
    const matchesSearch = app.id?.toLowerCase().includes(query) || name.includes(query);
    if (!matchesSearch) return false;
    if (activeAppFilter === 'all') return true;
    return app.status === activeAppFilter;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">No applications found.</td></tr>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) => tsToMs(b.appliedAt) - tsToMs(a.appliedAt));

  tbody.innerHTML = sorted.map(app => {
    const client   = cache.users.find(c => c.id === app.customerId);
    const name     = client ? client.name : `Client ID ${app.customerId}`;
    const loanType = cache.loanTypes.find(lt => lt.id === app.loanTypeId);
    const typeName = loanType ? loanType.name : (app.loanTypeName || 'N/A');

    let statusPill;
    if (app.status === 'approved')
      statusPill = `<span class="status-pill paid">Approved</span>`;
    else if (app.status === 'declined')
      statusPill = `<span class="status-pill" style="background:rgba(239,68,68,0.1);color:var(--danger-color);">Declined</span>`;
    else
      statusPill = `<span class="status-pill" style="background:rgba(234,179,8,0.1);color:#b45309;">Pending</span>`;

    return `
      <tr>
        <td class="font-mono"><strong>${app.id}</strong></td>
        <td>${name}</td>
        <td>${typeName}</td>
        <td>${formatCurrency(app.amount)}</td>
        <td>${app.term} mo.</td>
        <td>${formatDate(app.appliedAt)}</td>
        <td>${statusPill}</td>
        <td><button class="btn-action-icon btn-action-edit" data-review-app-id="${app.id}" title="Review">
          <i data-lucide="edit-3"></i></button></td>
      </tr>`;
  }).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
  bindApplicationActionListeners();
}

function bindApplicationActionListeners() {
  document.querySelectorAll('[data-review-app-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const appId = btn.getAttribute('data-review-app-id');
      const app   = cache.loanApplications.find(a => a.id === appId);
      if (!app) return;

      const client = cache.users.find(c => c.id === app.customerId);
      const name   = client ? client.name : app.customerId;

      document.getElementById('app-status-loan-id').value          = appId;
      document.getElementById('app-status-modal-title').textContent = `Review: ${app.id}`;
      document.getElementById('app-status-modal-desc').textContent  = `Client: ${name} — ${formatCurrency(app.amount)} for ${app.term} months`;
      document.getElementById('app-status-reason').value            = app.statusReason || '';

      const disbursalInput = document.getElementById('app-disbursal-amount');
      if (disbursalInput) disbursalInput.value = '';

      if (app.status === 'approved' && app.loanId) {
        const existingLoan = cache.loans.find(l => l.id === app.loanId);
        if (existingLoan && disbursalInput) disbursalInput.value = existingLoan.amount.toFixed(2);
      }

      const radio = document.querySelector(`input[name="app-status-choice"][value="${app.status}"]`);
      if (radio) radio.checked = true;
      else document.querySelectorAll('input[name="app-status-choice"]').forEach(r => r.checked = false);

      updateDisbursalSection();
      document.getElementById('app-status-modal').style.display = 'flex';
    });
  });
}

function wireAppStatusModal() {
  const btn = document.getElementById('btn-submit-app-status');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const appId       = document.getElementById('app-status-loan-id').value;
    const reason      = document.getElementById('app-status-reason').value.trim();
    const statusChoice= document.querySelector('input[name="app-status-choice"]:checked');

    if (!statusChoice) { showToast('Please select Approve or Decline.', 'error'); return; }

    const newStatus = statusChoice.value;
    const app = cache.loanApplications.find(a => a.id === appId);
    if (!app) return;

    const appRef = doc(db, 'loanApplications', appId);
    const updates = { status: newStatus, statusReason: reason, reviewedAt: Date.now() };

    if (newStatus === 'approved') {
      const disbursalInput = document.getElementById('app-disbursal-amount');
      const disbursedAmt   = parseFloat(disbursalInput?.value || '');

      if (!disbursedAmt || disbursedAmt <= 0) {
        showToast('Please enter the disbursed amount sent to the client.', 'error');
        return;
      }

      const loanType     = cache.loanTypes.find(lt => lt.id === app.loanTypeId);
      const interestRate = loanType ? (loanType.interestRate / 100) : (app.interestRate || 0);
      const totalRepayable = parseFloat((disbursedAmt * (1 + interestRate)).toFixed(2));
      const dueDate        = calcDueDate(app.term);

      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        const batch = writeBatch(db);

        const penaltyType   = loanType ? (loanType.penaltyType || 'none') : 'none';
        const penaltyAmount = loanType ? (loanType.penaltyAmount || 0) : 0;

        if (app.loanId) {
          // Update existing loan
          batch.update(doc(db, 'loans', app.loanId), {
            amount: disbursedAmt,
            totalRepayable,
            remainingAmount: totalRepayable,
            dueDate,
            status: 'active',
            term: app.term,
            interestRate,
            disbursedAt: Date.now(),
            penaltyType,
            penaltyAmount,
            penaltyAccrued: 0,
            penaltyApplied: false,
            lastPenaltyDate: null
          });
        } else {
          // Create new loan
          const newLoanId = 'L-' + Math.floor(100000 + Math.random() * 900000);
          batch.set(doc(db, 'loans', newLoanId), {
            id:              newLoanId,
            customerId:      app.customerId,
            applicationId:   app.id,
            loanTypeName:    loanType ? loanType.name : (app.loanTypeName || 'Loan'),
            amount:          disbursedAmt,
            term:            app.term,
            purpose:         app.purpose || 'general',
            interestRate,
            totalRepayable,
            remainingAmount: totalRepayable,
            status:          'active',
            dateCreated:     Date.now(),
            disbursedAt:     Date.now(),
            dueDate,
            penaltyType,
            penaltyAmount,
            penaltyAccrued:  0,
            penaltyApplied:  false,
            lastPenaltyDate: null
          });
          updates.loanId = newLoanId;
        }

        batch.update(appRef, updates);
        await batch.commit();

        showToast(`Application ${appId} approved. Loan created with ${app.term}-month term.`, 'success');
        document.getElementById('app-status-modal').style.display = 'none';
      } catch (err) {
        showToast('Error processing approval: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save Status';
      }
    } else {
      // Decline path
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await updateDoc(appRef, updates);
        showToast(`Application ${appId} marked as ${newStatus}.`, newStatus === 'declined' ? 'error' : 'success');
        document.getElementById('app-status-modal').style.display = 'none';
      } catch (err) {
        showToast('Error updating status: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save Status';
      }
    }
  });
}

function calcDueDate(termMonths) {
  const d = new Date();
  d.setMonth(d.getMonth() + termMonths);
  return d.getTime();
}

function updateDisbursalSection() {
  const disburseSection  = document.getElementById('app-disbursal-section');
  const dueDatePreview   = document.getElementById('app-due-date-preview');
  const dueDateValue     = document.getElementById('app-due-date-value');
  const dueDateTermLabel = document.getElementById('app-due-date-term-label');
  const disbursalInput   = document.getElementById('app-disbursal-amount');
  const hintEl           = document.getElementById('app-disbursal-hint');

  const isApprove = document.querySelector('input[name="app-status-choice"]:checked')?.value === 'approved';
  if (!disburseSection) return;

  if (isApprove) {
    disburseSection.style.display = 'flex';
    if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [disburseSection] });

    const appId = document.getElementById('app-status-loan-id').value;
    const app   = cache.loanApplications.find(a => a.id === appId);
    if (app && dueDateValue && dueDateTermLabel) {
      const dueTs = calcDueDate(app.term);
      dueDateValue.textContent     = formatDate(dueTs);
      dueDateTermLabel.textContent = `(${app.term}-month term)`;
      if (dueDatePreview) dueDatePreview.style.display = 'block';
    }
    if (disbursalInput && hintEl && app) {
      disbursalInput.placeholder = app.amount.toFixed(2);
      hintEl.textContent = `Requested: ${formatCurrency(app.amount)}. Enter the exact amount physically sent to the client.`;
    }
  } else {
    disburseSection.style.display = 'none';
    if (dueDatePreview) dueDatePreview.style.display = 'none';
  }
}


// =============================================================================
// LOAN TYPES
// =============================================================================
function updateLoanTypePenaltyFields() {
  const choice   = document.querySelector('input[name="lt-penalty-type"]:checked')?.value || 'none';
  const group    = document.getElementById('lt-penalty-amount-group');
  const label    = document.getElementById('lt-penalty-amount-label');
  const hint     = document.getElementById('lt-penalty-amount-hint');
  const amountEl = document.getElementById('lt-penalty-amount');
  if (!group) return;

  if (choice === 'none') {
    group.style.display = 'none';
    if (amountEl) amountEl.required = false;
  } else {
    group.style.display = 'block';
    if (amountEl) amountEl.required = true;
    if (choice === 'daily') {
      if (label) label.textContent = 'Daily Penalty Amount (KSh)';
      if (hint)  hint.textContent  = 'Charged every day the loan stays overdue, until fully cleared.';
    } else {
      if (label) label.textContent = 'One-Time Penalty Amount (KSh)';
      if (hint)  hint.textContent  = 'Charged once, the moment a loan of this type becomes overdue.';
    }
  }
}

function wireAddLoanTypeForm() {
  const form = document.getElementById('admin-add-loan-type-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('lt-name').value.trim();
    const term = parseInt(document.getElementById('lt-term').value);
    const rate = parseFloat(document.getElementById('lt-interest').value);
    const desc = document.getElementById('lt-desc').value.trim();
    const penaltyType   = document.querySelector('input[name="lt-penalty-type"]:checked')?.value || 'none';
    const penaltyAmount = penaltyType === 'none' ? 0 : parseFloat(document.getElementById('lt-penalty-amount').value);

    if (!name || isNaN(term) || isNaN(rate)) {
      showToast('Please fill in all required fields.', 'error');
      return;
    }

    if (penaltyType !== 'none' && (isNaN(penaltyAmount) || penaltyAmount <= 0)) {
      showToast('Please enter a valid penalty amount.', 'error');
      return;
    }

    const newId = 'LT-' + Math.floor(100 + Math.random() * 900);
    try {
      await setDoc(doc(db, 'loanTypes', newId), {
        id: newId, name, term, interestRate: rate, description: desc,
        penaltyType, penaltyAmount: penaltyAmount || 0
      });
      showToast(`Loan type "${name}" added successfully.`, 'success');
      form.reset();
      updateLoanTypePenaltyFields();
    } catch (err) {
      showToast('Error adding loan type: ' + err.message, 'error');
    }
  });
}

function renderAdminLoanTypes() {
  const list = document.getElementById('admin-loan-types-list');
  if (!list) return;

  if (cache.loanTypes.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <i data-lucide="package"></i>
        <p>No loan types configured yet.</p>
      </div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  list.innerHTML = cache.loanTypes.map(lt => {
    let penaltyText = 'No penalty';
    if (lt.penaltyType === 'daily') penaltyText = `${formatCurrency(lt.penaltyAmount || 0)}/day penalty until cleared`;
    else if (lt.penaltyType === 'flat') penaltyText = `${formatCurrency(lt.penaltyAmount || 0)} one-time penalty`;

    return `
    <div class="repay-log-item" style="align-items:flex-start;gap:8px;">
      <div style="flex:1;">
        <span class="repay-log-title">${lt.name}</span>
        <span class="repay-log-meta" style="display:block;">
          ${lt.term} months &bull; ${lt.interestRate}% interest${lt.description ? ' &bull; ' + lt.description : ''}
        </span>
        <span class="repay-log-meta" style="display:block; color:${lt.penaltyType && lt.penaltyType !== 'none' ? 'var(--color-danger)' : 'inherit'};">
          ${penaltyText}
        </span>
      </div>
      <button class="btn-action-icon btn-action-delete" data-delete-lt-id="${lt.id}" title="Remove Loan Type">
        <i data-lucide="trash-2"></i>
      </button>
    </div>`;
  }).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
  bindLoanTypeDeleteListeners();
}

function bindLoanTypeDeleteListeners() {
  document.querySelectorAll('[data-delete-lt-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-lt-id');
      const lt = cache.loanTypes.find(t => t.id === id);
      if (!lt || !confirm(`Remove loan type "${lt.name}"?`)) return;

      try {
        await deleteDoc(doc(db, 'loanTypes', id));
        showToast(`Loan type "${lt.name}" removed.`, 'success');
      } catch (err) {
        showToast('Error removing loan type: ' + err.message, 'error');
      }
    });
  });
}
