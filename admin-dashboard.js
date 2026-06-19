/* ==========================================================================
   LENDER APP - ADMIN PORTAL ENGINE
   Firebase Auth (admin login) + Firestore (all data)
   ========================================================================== */

// ── Firebase SDK (v9 compat shim via CDN — loaded in HTML before this script) ──
// Collection schema:
//   admins/{uid}          – admin profile { email, displayName, createdAt }
//   users/{userId}        – client accounts { name, phone, nationalId, pin, limit, dateAdded }
//   loans/{loanId}        – loan records
//   repayments/{repId}    – repayment logs
//   loanTypes/{ltId}      – loan product definitions
//   loanApplications/{id} – client applications

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
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

// ── Firestore collection references ──────────────────────────────────────────
const usersCol        = collection(db, 'users');
const loansCol        = collection(db, 'loans');
const repaymentsCol   = collection(db, 'repayments');
const loanTypesCol    = collection(db, 'loanTypes');
const loanAppsCol     = collection(db, 'loanApplications');
const adminsCol       = collection(db, 'admins');

// ── In-memory cache (refreshed from Firestore on each view switch) ────────────
const cache = {
  users:            [],
  loans:            [],
  repayments:       [],
  loanTypes:        [],
  loanApplications: [],
  settings: { theme: 'light', font: 'sans', scale: 'medium' }
};

// ── Unsub handles for real-time listeners ─────────────────────────────────────
let unsubUsers = null, unsubLoans = null, unsubRepayments = null;
let unsubLoanTypes = null, unsubLoanApps = null;

// =============================================================================
// DOMContentLoaded
// =============================================================================
document.addEventListener('DOMContentLoaded', () => {

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
    showToast('Style changes applied successfully.', 'success');
  });

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

  // ── Firebase Auth state listener ─────────────────────────────────────────────
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      // Verify the logged-in uid has an entry in the admins collection
      const adminSnap = await getDoc(doc(db, 'admins', user.uid));
      if (!adminSnap.exists()) {
        showToast('Access denied: Not an authorised administrator.', 'error');
        await signOut(auth);
        showLoginScreen();
        return;
      }
      showAdminPortal();
    } else {
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
  wireAddLoanTypeForm();
  wireEditCustomerModal();
  wireAppStatusModal();

  // ── Bottom nav search inputs ─────────────────────────────────────────────────
  document.getElementById('cust-search')?.addEventListener('input', () => renderAdminCustomersList());
  document.getElementById('loans-search')?.addEventListener('input', () => renderAdminLoansLedger());
  document.getElementById('repayments-search')?.addEventListener('input', () => renderAdminRepaymentsLog());
  document.getElementById('applications-search')?.addEventListener('input', () => renderAdminApplications());

}); // end DOMContentLoaded


// =============================================================================
// AUTH SCREEN HELPERS
// =============================================================================
function showLoginScreen() {
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
// OVERDUE CHECK (Firestore)
// =============================================================================
async function runOverdueCheckFirestore() {
  const now = Date.now();
  const batch = writeBatch(db);
  let changed = false;

  cache.loans.forEach(loan => {
    if (loan.status === 'active' && loan.remainingAmount > 0 && loan.dueDate < now) {
      const ref = doc(db, 'loans', loan.id);
      batch.update(ref, { status: 'overdue' });
      changed = true;
    }
  });

  if (changed) {
    try { await batch.commit(); } catch (_) {}
  }
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
  if (link) link.classList.add('active');

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
  else if (viewId === 'admin-view-applications') renderAdminApplications();
  else if (viewId === 'admin-view-loan-settings') renderAdminLoanTypes();
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

  const recoveryRate = totalDisbursed > 0 ? Math.round((totalCollected / totalDisbursed) * 100) : 0;
  el('admin-metric-recovery-rate').textContent = `Recovery rate: ${recoveryRate}%`;
  el('admin-metric-overdue').textContent       = formatCurrency(totalOverdue);
  el('admin-metric-overdue-count').textContent = `${overdueLoans.length} Overdue Account${overdueLoans.length === 1 ? '' : 's'}`;
  el('admin-portfolio-percent').textContent    = `${recoveryRate}%`;

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
  const custSlider = document.getElementById('cust-limit');
  const custVal    = document.getElementById('cust-limit-val');
  if (custSlider && custVal) {
    custSlider.addEventListener('input', () => { custVal.textContent = formatCurrency(custSlider.value); });
  }

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
      form.reset();
      document.getElementById('cust-limit-val').textContent = 'KSh 5,000';
    } catch (err) {
      showToast('Error registering customer: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Register Customer';
    }
  });
}

function renderAdminCustomersList() {
  const listBody = document.getElementById('admin-customers-table-body');
  if (!listBody) return;

  const query = (document.getElementById('cust-search')?.value || '').toLowerCase().trim();

  const filtered = cache.users.filter(c =>
    c.name?.toLowerCase().includes(query) || c.id?.toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    listBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">No matching customers found.</td></tr>`;
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

    return `
      <tr>
        <td class="font-mono"><strong>${c.id}</strong></td>
        <td>${c.name}</td>
        <td>${c.phone}</td>
        <td class="font-mono">${c.nationalId || '<span class="text-muted">—</span>'}</td>
        <td>${loansBadge}</td>
        <td><strong>${formatCurrency(c.limit)}</strong></td>
        <td>${formatDate(c.dateAdded)}</td>
        <td>
          <div class="actions-cell-group">
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
          timestamp:   Date.now()
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
          <span class="repay-log-meta">${formatDate(rep.timestamp)} • Method: ${(rep.method || '').toUpperCase()}</span>
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
            disbursedAt: Date.now()
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
            dueDate
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
function wireAddLoanTypeForm() {
  const form = document.getElementById('admin-add-loan-type-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('lt-name').value.trim();
    const term = parseInt(document.getElementById('lt-term').value);
    const rate = parseFloat(document.getElementById('lt-interest').value);
    const desc = document.getElementById('lt-desc').value.trim();

    if (!name || isNaN(term) || isNaN(rate)) {
      showToast('Please fill in all required fields.', 'error');
      return;
    }

    const newId = 'LT-' + Math.floor(100 + Math.random() * 900);
    try {
      await setDoc(doc(db, 'loanTypes', newId), {
        id: newId, name, term, interestRate: rate, description: desc
      });
      showToast(`Loan type "${name}" added successfully.`, 'success');
      form.reset();
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

  list.innerHTML = cache.loanTypes.map(lt => `
    <div class="repay-log-item" style="align-items:flex-start;gap:8px;">
      <div style="flex:1;">
        <span class="repay-log-title">${lt.name}</span>
        <span class="repay-log-meta" style="display:block;">
          ${lt.term} months &bull; ${lt.interestRate}% interest${lt.description ? ' &bull; ' + lt.description : ''}
        </span>
      </div>
      <button class="btn-action-icon btn-action-delete" data-delete-lt-id="${lt.id}" title="Remove Loan Type">
        <i data-lucide="trash-2"></i>
      </button>
    </div>`).join('');

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
