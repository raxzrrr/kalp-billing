// ===== KALP Billing App - Application Logic =====

// --- Data Store (localStorage) ---
const STORAGE_KEYS = {
  bills: 'kalp_bills',
  inventory: 'kalp_inventory',
  barcodes: 'kalp_barcodes',
  orders: 'kalp_orders',
  adjustments: 'kalp_adjustments',
  billCounter: 'kalp_bill_counter',
  barcodeCounter: 'kalp_barcode_counter',
  shopDetails: 'kalp_shop_details',
  theme: 'kalp_theme',
  deletedBills: 'kalp_deleted_bills',
  staff: 'kalp_staff',
  attendance: 'kalp_attendance',
  consignments: 'kalp_consignments'
};

// --- Global Cache for Performance
const appCache = {};
const viewCache = {
  cashLedger: '',
  bankLedger: ''
};

// --- Supabase Cloud Sync Setup ---
const DEFAULT_SUPABASE_URL = 'https://hrdirkxtydyprrqexnln.supabase.co';
const DEFAULT_SUPABASE_KEY = 'sb_publishable_ES0G9ef3bF6Ht217PGHDWg_2uWd1jFB';

let supabaseClient = null;
let realtimeChannel = null;

function initSupabase() {
  const url = localStorage.getItem('kalp_supabase_url') || DEFAULT_SUPABASE_URL;
  const key = localStorage.getItem('kalp_supabase_key') || DEFAULT_SUPABASE_KEY;
  if (url && key && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(url, key);
      console.log('⚡ Supabase cloud sync initialized');
      initRealtimeSubscriptions();
    } catch (err) {
      console.error('Failed to initialize Supabase client:', err);
    }
  }
}

// --- Realtime WebSocket Subscriptions ---
function initRealtimeSubscriptions() {
  if (!supabaseClient || realtimeChannel) return;
  try {
    realtimeChannel = supabaseClient
      .channel('kalp-bills-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'kalp_bills' },
        payload => handleRealtimeBillInsert(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'kalp_bills' },
        payload => handleRealtimeBillUpdate(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'kalp_bills' },
        payload => handleRealtimeBillDelete(payload.old)
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('⚡ Realtime WebSockets connected: Listening for live bills from all devices!');
        }
      });
  } catch (err) {
    console.warn('Realtime subscription error:', err);
  }
}

function handleRealtimeBillInsert(newRow) {
  if (!newRow || !newRow.raw_data) return;
  const bill = newRow.raw_data;
  const bills = getData(STORAGE_KEYS.bills);

  // Avoid duplicating if bill was created on this same device
  const exists = bills.some(b => b.id === bill.id || b.billNumber === bill.billNumber);
  if (exists) return;

  bills.push(bill);
  appCache[STORAGE_KEYS.bills] = bills;
  localStorage.setItem(STORAGE_KEYS.bills, JSON.stringify(bills));

  // Advance counter if higher
  if (bill.billNumber > getBillCounter()) {
    appCache[STORAGE_KEYS.billCounter] = bill.billNumber;
    localStorage.setItem(STORAGE_KEYS.billCounter, bill.billNumber.toString());
  }

  rebuildLedgerCache();
  if (typeof refreshDashboard === 'function') refreshDashboard();
  if (typeof renderRecentBillsTable === 'function') renderRecentBillsTable();
  
  showToast(`⚡ Live Update: Bill #KALP-${String(bill.billNumber).padStart(4, '0')} added from another device!`, 'info');
}

function handleRealtimeBillUpdate(newRow) {
  if (!newRow || !newRow.raw_data) return;
  const bill = newRow.raw_data;
  const bills = getData(STORAGE_KEYS.bills);

  const idx = bills.findIndex(b => b.id === bill.id);
  if (idx !== -1) {
    bills[idx] = bill;
    appCache[STORAGE_KEYS.bills] = bills;
    localStorage.setItem(STORAGE_KEYS.bills, JSON.stringify(bills));
    rebuildLedgerCache();
    if (typeof refreshDashboard === 'function') refreshDashboard();
    if (typeof renderRecentBillsTable === 'function') renderRecentBillsTable();
  }
}

function handleRealtimeBillDelete(oldRow) {
  if (!oldRow || !oldRow.id) return;
  const bills = getData(STORAGE_KEYS.bills);
  const updated = bills.filter(b => b.id !== oldRow.id);
  if (updated.length !== bills.length) {
    appCache[STORAGE_KEYS.bills] = updated;
    localStorage.setItem(STORAGE_KEYS.bills, JSON.stringify(updated));
    rebuildLedgerCache();
    if (typeof refreshDashboard === 'function') refreshDashboard();
    if (typeof renderRecentBillsTable === 'function') renderRecentBillsTable();
  }
}

// --- Offline Queue & Sync Status Management ---
const OFFLINE_QUEUE_KEY = 'kalp_offline_queue';

function getOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveOfflineQueue(queue) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  updateSyncUI();
}

function addToOfflineQueue(key, data) {
  const queue = getOfflineQueue();
  const existingIdx = queue.findIndex(item => item.key === key);
  if (existingIdx >= 0) {
    queue[existingIdx] = { key, data, timestamp: Date.now() };
  } else {
    queue.push({ key, data, timestamp: Date.now() });
  }
  saveOfflineQueue(queue);
  console.log(`📥 Added ${key} to offline queue. Total pending:`, queue.length);
}

function updateSyncUI(forceState = null, forceText = null) {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-text');
  if (!dot || !text) return;

  const queue = getOfflineQueue();
  const isOnline = navigator.onLine;

  if (forceState) {
    dot.className = `sync-dot ${forceState}`;
    text.textContent = forceText || (forceState === 'synced' ? 'Cloud Synced' : forceState === 'syncing' ? 'Syncing...' : 'Offline');
    return;
  }

  if (!isOnline) {
    dot.className = 'sync-dot offline';
    text.textContent = queue.length > 0 ? `Offline (${queue.length} pending)` : 'Offline';
  } else if (queue.length > 0) {
    dot.className = 'sync-dot syncing';
    text.textContent = `Pending (${queue.length})`;
  } else {
    dot.className = 'sync-dot synced';
    text.textContent = 'Cloud Synced';
  }
}

async function flushOfflineQueue() {
  if (!navigator.onLine || !supabaseClient) {
    updateSyncUI();
    return;
  }

  const queue = getOfflineQueue();
  if (queue.length === 0) {
    updateSyncUI('synced', 'Cloud Synced');
    return;
  }

  updateSyncUI('syncing', `Syncing ${queue.length}...`);

  const remainingQueue = [];
  for (const item of queue) {
    try {
      if (item.data && item.data.type === 'single_bill') {
        const b = item.data.bill;
        const row = {
          id: b.id,
          bill_number: b.billNumber,
          customer_name: b.customerName || 'Walk-in Customer',
          phone: b.phone || '',
          date: b.date || new Date().toISOString().split('T')[0],
          grand_total: b.grandTotal || 0,
          raw_data: b,
          updated_at: new Date(item.timestamp).toISOString()
        };
        const { error } = await supabaseClient.from('kalp_bills').upsert(row);
        if (error) remainingQueue.push(item);
      } else {
        const { error } = await supabaseClient
          .from('kalp_store')
          .upsert({ key: item.key, value: item.data, updated_at: new Date(item.timestamp).toISOString() });

        if (error) {
          console.error('Failed to flush offline queue item:', item.key, error);
          remainingQueue.push(item);
        }
      }
    } catch (err) {
      console.error('Network exception flushing item:', item.key, err);
      remainingQueue.push(item);
    }
  }

  saveOfflineQueue(remainingQueue);
  if (remainingQueue.length === 0) {
    updateSyncUI('synced', 'Cloud Synced');
    showToast('All offline changes synced to cloud!', 'success');
  } else {
    updateSyncUI('offline', `${remainingQueue.length} pending`);
  }
}

async function triggerManualSync() {
  if (!navigator.onLine) {
    showToast('You are currently offline. Changes are saved locally.', 'warning');
    updateSyncUI();
    return;
  }
  if (!supabaseClient) {
    showToast('Supabase not connected. Check Shop Details.', 'error');
    return;
  }

  updateSyncUI('syncing', 'Syncing...');
  showToast('Syncing with Supabase cloud...', 'info');

  // 1. Flush any pending offline queue
  await flushOfflineQueue();

  // 2. Pull latest from cloud
  const pulled = await pullFromCloud();
  if (pulled) {
    updateSyncUI('synced', 'Cloud Synced');
    showToast('Cloud database in sync!', 'success');
    rebuildLedgerCache();
    handleRoute();
  } else {
    updateSyncUI('offline', 'Sync Error');
    showToast('Cloud sync encountered an issue.', 'error');
  }
}

// Network state listeners
window.addEventListener('online', () => {
  showToast('Network restored! Syncing offline queue...', 'info');
  flushOfflineQueue();
});

window.addEventListener('offline', () => {
  updateSyncUI('offline', 'Offline');
  showToast('Operating offline. Changes will queue and sync when reconnected.', 'warning');
});

// --- Individual Bills Table Sync Helpers ---
async function saveSingleBillToCloud(bill) {
  if (!supabaseClient || !navigator.onLine) {
    addToOfflineQueue('single_bill_' + bill.id, { type: 'single_bill', bill });
    return;
  }
  try {
    const row = {
      id: bill.id,
      bill_number: bill.billNumber,
      customer_name: bill.customerName || 'Walk-in Customer',
      phone: bill.phone || '',
      date: bill.date || new Date().toISOString().split('T')[0],
      grand_total: bill.grandTotal || 0,
      raw_data: bill,
      updated_at: new Date().toISOString()
    };
    await supabaseClient.from('kalp_bills').upsert(row);
  } catch (err) {
    console.warn('saveSingleBillToCloud exception:', err);
    addToOfflineQueue('single_bill_' + bill.id, { type: 'single_bill', bill });
  }
}

async function deleteSingleBillFromCloud(billId) {
  if (!supabaseClient || !navigator.onLine) return;
  try {
    await supabaseClient.from('kalp_bills').delete().eq('id', billId);
  } catch (err) {
    console.warn('deleteSingleBillFromCloud exception:', err);
  }
}

async function syncToCloud(key, data) {
  if (!supabaseClient || !navigator.onLine) {
    addToOfflineQueue(key, data);
    return;
  }

  updateSyncUI('syncing', 'Syncing...');

  try {
    const { error } = await supabaseClient
      .from('kalp_store')
      .upsert({ key: key, value: data, updated_at: new Date().toISOString() });

    if (error) {
      console.error('Cloud sync error for key', key, error);
      addToOfflineQueue(key, data);
    } else {
      const queue = getOfflineQueue();
      if (queue.length === 0) {
        updateSyncUI('synced', 'Cloud Synced');
      } else {
        flushOfflineQueue();
      }
    }
  } catch (err) {
    console.error('Cloud sync exception:', err);
    addToOfflineQueue(key, data);
  }
}

async function pullFromCloud() {
  if (!supabaseClient) return false;
  let success = false;
  try {
    // 1. Pull key-value store (inventory, staff, settings, barcodes, etc.)
    const { data, error } = await supabaseClient
      .from('kalp_store')
      .select('key, value');
    if (error) {
      console.error('kalp_store pull error:', error);
    }
    if (data && data.length > 0) {
      data.forEach(row => {
        if (!row.key || row.value === undefined) return;
        let val = row.value;
        if (typeof val === 'string') {
          try { val = JSON.parse(val); } catch (e) { /* keep string */ }
        }

        appCache[row.key] = val;

        // Scalars (theme, counters) are stored as plain strings in localStorage
        if (row.key === STORAGE_KEYS.theme ||
            row.key === STORAGE_KEYS.billCounter ||
            row.key === STORAGE_KEYS.barcodeCounter) {
          localStorage.setItem(row.key, String(val));
        } else {
          localStorage.setItem(row.key, JSON.stringify(val));
        }
      });
      success = true;
    }

    // 2. Pull dedicated bills table if available (individual rows)
    const billsResult = await supabaseClient
      .from('kalp_bills')
      .select('raw_data, bill_number')
      .order('id', { ascending: true });

    if (billsResult.error) {
      console.error('kalp_bills pull error:', billsResult.error);
    }

    if (billsResult.data && billsResult.data.length > 0) {
      const bills = billsResult.data.map(r => r.raw_data).filter(Boolean);
      appCache[STORAGE_KEYS.bills] = bills;
      localStorage.setItem(STORAGE_KEYS.bills, JSON.stringify(bills));

      // Automatically sync bill counter to highest cloud bill number to avoid collisions
      const maxBillNum = Math.max(...billsResult.data.map(r => parseInt(r.bill_number) || 0));
      const currentCounter = getBillCounter();
      if (maxBillNum > currentCounter) {
        appCache[STORAGE_KEYS.billCounter] = maxBillNum;
        localStorage.setItem(STORAGE_KEYS.billCounter, maxBillNum.toString());
      }
      success = true;
    }

    return success;
  } catch (err) {
    console.error('Pull from cloud failed:', err);
    return false;
  }
}

function saveCloudSettings() {
  const url = document.getElementById('cloud-supabase-url')?.value.trim();
  const key = document.getElementById('cloud-supabase-key')?.value.trim();
  if (!url || !key) {
    showToast('Please enter both Supabase URL and Key', 'error');
    return;
  }
  localStorage.setItem('kalp_supabase_url', url);
  localStorage.setItem('kalp_supabase_key', key);
  initSupabase();
  showToast('Cloud database settings saved! Syncing data...', 'info');
  
  // Push all existing local data keys to cloud
  let synced = 0;
  for (const storageKey of Object.values(STORAGE_KEYS)) {
    const localVal = getData(storageKey);
    if (localVal) {
      syncToCloud(storageKey, localVal);
      synced++;
    }
  }
  showToast(`Successfully connected! ${synced} data stores queued for cloud sync.`, 'success');
}

async function pullCloudData() {
  if (!supabaseClient) {
    showToast('Supabase is not configured yet. Enter credentials above.', 'error');
    return;
  }
  showToast('Fetching latest data from Supabase cloud...', 'info');
  const success = await pullFromCloud();
  if (success) {
    showToast('Cloud data synced! Reloading app UI...', 'success');
    setTimeout(() => window.location.reload(), 1000);
  } else {
    showToast('Failed to pull data from Supabase. Check RLS or credentials.', 'error');
  }
}

// Auto-initialize cloud sync on script load
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  const savedUrl = localStorage.getItem('kalp_supabase_url') || DEFAULT_SUPABASE_URL;
  const savedKey = localStorage.getItem('kalp_supabase_key') || DEFAULT_SUPABASE_KEY;
  if (document.getElementById('cloud-supabase-url')) {
    document.getElementById('cloud-supabase-url').value = savedUrl;
  }
  if (document.getElementById('cloud-supabase-key')) {
    document.getElementById('cloud-supabase-key').value = savedKey;
  }
});

function getData(key) {
  if (appCache[key]) return appCache[key];
  try { 
    const data = JSON.parse(localStorage.getItem(key)) || [];
    appCache[key] = data;
    return data;
  }
  catch { return []; }
}

function setData(key, data) {
  appCache[key] = data; // Sync cache
  localStorage.setItem(key, JSON.stringify(data));
  
  // Sync asynchronously to Supabase cloud
  syncToCloud(key, data);

  // Rebuild relevant view caches if data changes
  if (key === STORAGE_KEYS.bills || key === STORAGE_KEYS.adjustments) {
    setTimeout(rebuildLedgerCache, 0);
  }
  setTimeout(updateStorageMeter, 50);
}

function updateStorageMeter() {
  try {
    let totalBytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) {
        const val = localStorage.getItem(k) || '';
        totalBytes += (k.length + val.length) * 2;
      }
    }
    const totalMB = totalBytes / (1024 * 1024);
    const maxMB = 5.0;
    const pct = Math.min(100, Math.round((totalMB / maxMB) * 100));

    const textEl = document.getElementById('storage-text');
    const barEl = document.getElementById('storage-bar');
    const mbEl = document.getElementById('storage-mb');

    if (textEl) textEl.textContent = `${pct}%`;
    if (mbEl) mbEl.textContent = totalMB.toFixed(2);
    if (barEl) {
      barEl.style.width = `${pct}%`;
      if (pct > 80) barEl.style.background = '#ef4444';
      else if (pct > 60) barEl.style.background = '#f59e0b';
      else barEl.style.background = '#4caf50';
    }
  } catch (e) {
    console.warn('Storage meter notice:', e);
  }
}

function getBillCounter() {
  const val = appCache[STORAGE_KEYS.billCounter] || localStorage.getItem(STORAGE_KEYS.billCounter) || '0';
  return parseInt(val);
}

function incrementBillCounter() {
  const next = getBillCounter() + 1;
  appCache[STORAGE_KEYS.billCounter] = next;
  localStorage.setItem(STORAGE_KEYS.billCounter, next.toString());
  syncToCloud(STORAGE_KEYS.billCounter, next);
  return next;
}

function getBarcodeCounter() {
  const val = appCache[STORAGE_KEYS.barcodeCounter] || localStorage.getItem(STORAGE_KEYS.barcodeCounter) || '1000';
  return parseInt(val);
}

function incrementBarcodeCounter() {
  const next = getBarcodeCounter() + 1;
  appCache[STORAGE_KEYS.barcodeCounter] = next;
  localStorage.setItem(STORAGE_KEYS.barcodeCounter, next.toString());
  syncToCloud(STORAGE_KEYS.barcodeCounter, next);
  return next;
}

// --- Toast Notifications ---
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️' };
  toast.innerHTML = `<span>${icons[type] || '✅'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// --- SPA Routing ---
function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`[data-page="${page}"]`);
  if (navItem) navItem.classList.add('active');

  document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
  const section = document.getElementById(`page-${page}`);
  if (section) section.classList.add('active');

  if (page === 'dashboard') refreshDashboard();
  if (page === 'dailybook') initDailyBook();
  if (page === 'billing') initBillingPage();
  if (page === 'inventory') renderInventoryTable();
  if (page === 'analytics') renderAnalytics();
  if (page === 'barcodes') {
    renderBarcodeList();
    initBarcodeNavigation();
  }
  if (page === 'orders') {
    const lockScreen = document.getElementById('order-ledger-lock');
    const contentScreen = document.getElementById('order-ledger-content');
    if (lockScreen && contentScreen) {
      lockScreen.style.display = 'flex';
      contentScreen.style.display = 'none';
      currentPasscode = '';
    }
    renderOrdersTable();
  }
  if (page === 'consignment') renderConsignments();
  if (page === 'staff') renderStaffPage();
  if (page === 'shopdetails') loadShopDetails();
}

function handleRoute() {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  navigateTo(hash);
}

window.addEventListener('hashchange', handleRoute);
function setTheme(theme) {
  if (theme === 'dark') {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
  localStorage.setItem(STORAGE_KEYS.theme, theme);
  
  // Update button active states in Shop Details if currently on that page
  const lightBtn = document.getElementById('theme-light-btn');
  const darkBtn = document.getElementById('theme-dark-btn');
  if (lightBtn && darkBtn) {
    lightBtn.classList.toggle('active', theme === 'light');
    darkBtn.classList.toggle('active', theme === 'dark');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const savedTheme = localStorage.getItem(STORAGE_KEYS.theme) || 'light';
  setTheme(savedTheme);

  const bootEl = document.getElementById('cloud-boot-overlay');
  const bootText = document.getElementById('cloud-boot-text');
  const showBoot = (msg) => {
    if (bootEl) bootEl.style.display = 'flex';
    if (bootText) bootText.textContent = msg || 'Connecting to cloud…';
  };
  const hideBoot = () => {
    if (bootEl) bootEl.style.display = 'none';
  };

  // Initialize cloud sync & visual sync status
  initSupabase();
  updateSyncUI();

  const hasLocalBills = (getData(STORAGE_KEYS.bills) || []).length > 0;

  if (supabaseClient && navigator.onLine) {
    showBoot('Syncing with Supabase…');
    updateSyncUI('syncing', 'Syncing...');
    await flushOfflineQueue();
    const pulled = await pullFromCloud();
    if (pulled) {
      updateSyncUI('synced', 'Cloud Synced');
    } else if (hasLocalBills) {
      updateSyncUI('synced', 'Local + Cloud');
    } else {
      updateSyncUI('offline', 'Cloud empty / error');
      showToast('Cloud has no data yet. Import a backup or push seed data.', 'warning');
    }
  } else if (!navigator.onLine) {
    updateSyncUI('offline', 'Offline');
    if (!hasLocalBills) {
      showToast('Offline and no local data. Connect to the internet once to load from Supabase.', 'warning');
    }
  } else {
    updateSyncUI('offline', 'Not connected');
    showToast('Supabase not connected. Check Shop Details → Cloud Database Sync.', 'warning');
  }

  hideBoot();
  rebuildLedgerCache();
  seedDefaultStaff(); // Ensure default staff exist
  populateStaffDropdown(); // Populate billing dropdown
  updateStorageMeter();
  handleRoute();
});

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    window.location.hash = item.getAttribute('data-page');
  });
});


// ===================================================================
// DASHBOARD
// ===================================================================

let currentDashboardRange = 7;

function updateDashboardRange(days) {
  currentDashboardRange = days;
  refreshDashboard();
}

function refreshDashboard() {
  const bills = getData(STORAGE_KEYS.bills);
  const adjustments = getData(STORAGE_KEYS.adjustments);
  const today = new Date().toISOString().split('T')[0];
  const now = new Date();
  
  // Update UI range buttons and title
  const range7Btn = document.getElementById('range-7-btn');
  const range15Btn = document.getElementById('range-15-btn');
  const range30Btn = document.getElementById('range-30-btn');
  const rangeMonthBtn = document.getElementById('range-month-btn');
  const chartTitle = document.getElementById('sales-chart-title');
  if (range7Btn) range7Btn.classList.toggle('active', currentDashboardRange === 7);
  if (range15Btn) range15Btn.classList.toggle('active', currentDashboardRange === 15);
  if (range30Btn) range30Btn.classList.toggle('active', currentDashboardRange === 30);
  if (rangeMonthBtn) rangeMonthBtn.classList.toggle('active', currentDashboardRange === 'month');
  
  if (chartTitle) {
    if (currentDashboardRange === 7) chartTitle.textContent = 'Sales — Last 7 Days';
    else if (currentDashboardRange === 15) chartTitle.textContent = 'Sales — Last 15 Days';
    else if (currentDashboardRange === 30) chartTitle.textContent = 'Sales — Last 30 Days';
    else if (currentDashboardRange === 'month') chartTitle.textContent = `Sales — ${now.getFullYear()} (Month-wise)`;
  }

  // Time range setup for chart
  const days = [];
  const chartDataMap = {};
  const chartBillCountMap = {};
  
  if (currentDashboardRange === 'month') {
    const currentMonth = now.getMonth(); // 0-indexed
    const year = now.getFullYear();
    for (let m = 0; m <= currentMonth; m++) {
      const monthKey = `${year}-${String(m + 1).padStart(2, '0')}`;
      days.push(monthKey);
      chartDataMap[monthKey] = 0;
      chartBillCountMap[monthKey] = 0;
    }
  } else {
    for (let i = currentDashboardRange - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const day = d.toISOString().split('T')[0];
      days.push(day);
      chartDataMap[day] = 0;
      chartBillCountMap[day] = 0;
    }
  }

  // Stats to calculate in ONE pass
  let totalSales = 0;
  let todaySales = 0;
  let cashTotal = 0;
  let bankTotal = 0;
  const uniqueCustomers = new Set();

  // 1. Single pass over adjustment entries for starting balance
  adjustments.forEach(a => {
    const amt = parseFloat(a.amount) || 0;
    if (a.method === 'Cash') cashTotal += amt;
    else if (a.method === 'Bank') bankTotal += amt;
  });

  // 2. Single high-speed pass over all bills
  for (let i = 0, len = bills.length; i < len; i++) {
    const b = bills[i];
    const amt = b.grandTotal || 0;
    
    totalSales += amt;
    
    // Today's Sales
    if (b.date === today) todaySales += amt;
    
    // Cash vs Bank Accumulation
    if (b.paymentMethod === 'Split') {
      cashTotal += (parseFloat(b.splitCash) || 0);
      bankTotal += (parseFloat(b.splitPhonepe) || 0);
    } else {
      const isCash = (b.paymentMethod === 'Cash' || !b.paymentMethod);
      if (isCash) cashTotal += amt;
      else bankTotal += amt;
    }
    
    // Chart collection
    if (currentDashboardRange === 'month') {
      const billMonth = b.date.substring(0, 7); // YYYY-MM
      if (chartDataMap[billMonth] !== undefined) {
        chartDataMap[billMonth] += amt;
        chartBillCountMap[billMonth]++;
      }
    } else {
      if (chartDataMap[b.date] !== undefined) {
        chartDataMap[b.date] += amt;
        chartBillCountMap[b.date]++;
      }
    }
    
    // Unique Customers tracking
    const customerKey = (b.phone || b.email || b.customerName || 'walkin').toLowerCase();
    if (customerKey !== 'walk-in customer' && customerKey !== 'walkin') {
      uniqueCustomers.add(customerKey);
    }
  }

  // Update DOM
  document.getElementById('stat-total-sales').textContent = formatCurrency(totalSales);
  document.getElementById('stat-today-sales').textContent = formatCurrency(todaySales);
  document.getElementById('stat-total-bills').textContent = bills.length;
  document.getElementById('stat-cash-hand').textContent = formatCurrency(cashTotal);
  document.getElementById('stat-bank-balance').textContent = formatCurrency(bankTotal);
  
  // Pending orders
  const orders = getData(STORAGE_KEYS.orders) || [];
  let totalPendingOrders = 0;
  orders.forEach(o => {
    const p = parseFloat(o.pending) || 0;
    if (p > 0) totalPendingOrders += p;
  });
  const pendingStatEl = document.getElementById('stat-pending-amount');
  if (pendingStatEl) pendingStatEl.textContent = formatCurrency(totalPendingOrders);

  const customersEl = document.getElementById('stat-total-customers');
  if (customersEl) customersEl.textContent = uniqueCustomers.size;

  renderRecentBills(bills);
  updateDeliveriesDashboard();
  updateDeletedBillsDashboard();
  
  // Calculate average for the chart period
  let salesSum = 0;
  days.forEach(d => salesSum += chartDataMap[d]);
  const divisor = currentDashboardRange === 'month' ? days.length : currentDashboardRange;
  const avgSales = salesSum / Math.max(divisor, 1);

  renderSalesChartFromData(days, chartDataMap, avgSales, chartBillCountMap);
}

function togglePrivacy(element, event) {
  if (event) event.stopPropagation();
  const valueEl = element.classList.contains('stat-value') ? element : element.querySelector('.stat-value');
  if (valueEl) {
    if (valueEl.classList.contains('privacy-blur')) {
      valueEl.classList.remove('privacy-blur');
      valueEl.classList.add('privacy-revealed');
    } else {
      valueEl.classList.add('privacy-blur');
      valueEl.classList.remove('privacy-revealed');
    }
  }
}

function showPeriodDetails(period, amount, count) {
  openChartDetailModal(period);
}

function openChartDetailModal(period) {
  const bills = getData(STORAGE_KEYS.bills);
  const orders = getData(STORAGE_KEYS.orders);
  const tbody = document.getElementById('chart-detail-tbody');
  const title = document.getElementById('chart-detail-title');
  
  if (!tbody || !title) return;

  // 1. Set Title and Filter Bills
  let filteredBills = [];
  let displayLabel = period;
  
  if (period === 'all') {
    displayLabel = 'All Time History';
    filteredBills = [...bills].reverse();
  } else if (currentDashboardRange === 'month') {
    const [y, m] = period.split('-');
    displayLabel = new Date(y, m - 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    filteredBills = bills.filter(b => b.date.substring(0, 7) === period);
  } else {
    displayLabel = formatDate(period);
    filteredBills = bills.filter(b => b.date === period);
  }
  
  title.textContent = `Bills for ${displayLabel}`;

  // 2. Map Orders to Bills for Tailor/Advance
  const orderMap = {};
  orders.forEach(o => {
    if (o.billId) orderMap[o.billId] = o;
  });

  // 3. Render Table
  if (filteredBills.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="ta-c">No bills found for this period</td></tr>';
  } else {
    tbody.innerHTML = filteredBills.map(bill => {
      const order = orderMap[bill.id] || {};
      const tailor = parseFloat(order.tailor) || 0;
      const advance = parseFloat(order.advance) || 0;
      const cls = bill.totalPending > 0 ? 'badge-warning' : 'badge-success';
      const txt = bill.totalPending > 0 ? 'Pending' : 'Paid';

      return `<tr>
        <td style="font-weight:600;color:var(--text-accent)">#${bill.billNumber}</td>
        <td>${esc(bill.customerName || 'Walk-in')}</td>
        <td>${formatDate(bill.date)}</td>
        <td style="text-align: right; font-weight: 500;">${tailor > 0 ? formatCurrency(tailor) : '-'}</td>
        <td style="text-align: right; font-weight: 500;">${advance > 0 ? formatCurrency(advance) : '-'}</td>
        <td style="text-align: right; font-weight: 600;">${formatCurrency(bill.grandTotal)}</td>
        <td><span class="badge ${cls}">${txt}</span></td>
        <td class="ta-c">
          <button class="btn-icon btn-edit" onclick="closeChartDetailModal(); editBill(${bill.id})" title="Edit Bill">📝</button>
          <button class="btn-icon btn-delete" onclick="closeChartDetailModal(); deleteBill(${bill.id})" title="Delete Bill">🗑️</button>
        </td>
      </tr>`;
    }).join('').trim();
  }

  document.getElementById('chart-detail-modal').classList.add('active');
}

function closeChartDetailModal() {
  document.getElementById('chart-detail-modal').classList.remove('active');
}

function openAllBillsModal() {
  openChartDetailModal('all');
}

function renderSalesChartFromData(days, chartDataMap, avgSales, chartBillCountMap) {
  const chart = document.getElementById('sales-chart');
  if (!chart) return;
  
  const salesByDay = days.map(day => {
    let label;
    if (currentDashboardRange === 'month') {
      const [y, m] = day.split('-');
      label = new Date(y, m - 1).toLocaleDateString('en-IN', { month: 'short' });
    } else {
      label = currentDashboardRange === 7 ? 
        new Date(day).toLocaleDateString('en-IN', { weekday: 'short' }) : 
        new Date(day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    }
    return { date: day, total: chartDataMap[day], label };
  });

  const max = Math.max(...salesByDay.map(d => d.total), avgSales, 1);
  const chartHtml = salesByDay.map(d => {
    const count = chartBillCountMap[d.date] || 0;
    const h = (d.total / max) * 100;
    const isDense = currentDashboardRange === 15 || currentDashboardRange === 30;
    const isVeryDense = currentDashboardRange === 30;
    const valueStyle = isVeryDense 
      ? 'font-size: 0.5rem; writing-mode: vertical-rl; transform: rotate(180deg); margin-bottom: 2px; line-height: 1;' 
      : (isDense ? 'font-size: 0.6rem;' : '');
    const labelStyle = isVeryDense 
      ? 'font-size: 0.5rem; writing-mode: vertical-rl; transform: rotate(180deg); margin-top: 2px; line-height: 1; white-space: nowrap;' 
      : (isDense ? 'font-size: 0.6rem;' : '');
    return `
      <div class="bar-chart-item" style="${isDense ? 'gap: 2px;' : ''}" onclick="showPeriodDetails('${d.date}', ${d.total}, ${count})">
        <div class="bar-chart-value" style="${valueStyle}">${formatCurrencyShort(d.total)}</div>
        <div class="bar-chart-bar" style="height:${Math.max(h, 2)}%" title="${formatDate(d.date)}: ${formatCurrency(d.total)} (${count} bills)"></div>
        <div class="bar-chart-label" style="${labelStyle}">${d.label}</div>
      </div>`;
  }).join('');

  // Add average line and label
  const avgH = (avgSales / max) * 100;
  const avgHtml = `
    <div class="avg-line" style="bottom: ${avgH}%"></div>
    <div class="avg-label" style="bottom: ${avgH}%">Avg: ${formatCurrencyShort(avgSales)}</div>
  `;

  chart.innerHTML = chartHtml + avgHtml;
  
  // Adjust gap for different ranges
  if (currentDashboardRange === 30) chart.style.gap = '2px';
  else if (currentDashboardRange === 15) chart.style.gap = '8px';
  else if (currentDashboardRange === 7) chart.style.gap = '16px';
  else chart.style.gap = '12px';
}

function renderRecentBills(bills, filter = '') {
  const body = document.getElementById('recent-bills-body');
  let filteredBills = bills;
  if (filter) {
    const lf = filter.toLowerCase();
    filteredBills = bills.filter(b => 
      String(b.billNumber).includes(lf) ||
      (b.customerName || 'Walk-in').toLowerCase().includes(lf) ||
      (b.phone || '').includes(lf) ||
      String(b.grandTotal).includes(lf)
    );
  }

  if (filteredBills.length === 0) {
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state">
      <div class="empty-icon">📄</div><div class="empty-text">${filter ? 'No bills match search' : 'No bills yet'}</div>
      <div class="empty-sub">${filter ? 'Try a different search term' : 'Create your first bill to see it here'}</div>
    </div></td></tr>`;
    return;
  }
  const recent = filter ? filteredBills.slice(-50).reverse() : filteredBills.slice(-10).reverse();
  body.innerHTML = recent.map(bill => {
    const cls = bill.totalPending > 0 ? 'badge-warning' : 'badge-success';
    const txt = bill.totalPending > 0 ? 'Pending' : 'Paid';
    return `<tr>
      <td style="font-weight:600;color:var(--text-accent)">#${bill.billNumber}</td>
      <td>${esc(bill.customerName || 'Walk-in')}</td>
      <td>${formatDate(bill.date)}</td>
      <td style="font-weight:600">${formatCurrency(bill.grandTotal)}</td>
      <td><span class="badge ${cls}">${txt}</span></td>
      <td class="ta-c">
        <button class="btn-icon btn-edit" onclick="editBill(${bill.id})" title="Edit Bill">📝</button>
        <button class="btn-icon btn-delete" onclick="deleteBill(${bill.id})" title="Delete Bill">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

function filterRecentBills() {
  const bills = getData(STORAGE_KEYS.bills);
  const filter = document.getElementById('recent-bills-search') ? document.getElementById('recent-bills-search').value : '';
  renderRecentBills(bills, filter);
}

// --- Ledger Logic ---
let currentLedgerMethod = 'Cash';
let showingAllLedger = false;

function openLedgerModal(method) {
  currentLedgerMethod = method; // 'Cash' or 'Bank'
  showingAllLedger = false; // Reset to limited view
  document.getElementById('ledger-modal-title').textContent = `${method} Transaction Ledger`;
  document.getElementById('ledger-modal').classList.add('active');
  hideAdjustmentForm();
  
  // INSTANT RENDER: Use the pre-built view cache
  const body = document.getElementById('ledger-body');
  const totalDisplay = document.getElementById('ledger-total-display');
  
  const dashboardStat = method === 'Cash' ? 
    document.getElementById('stat-cash-hand').textContent : 
    document.getElementById('stat-bank-balance').textContent;
  
  if (totalDisplay) totalDisplay.textContent = dashboardStat;
  if (body) body.innerHTML = method === 'Cash' ? viewCache.cashLedger : viewCache.bankLedger;

  // We still trigger a background render if they want "All history" later
}

function closeLedgerModal() {
  document.getElementById('ledger-modal').classList.remove('active');
}

function showAdjustmentForm() {
  document.getElementById('adjustment-form').style.display = 'block';
}

function hideAdjustmentForm() {
  document.getElementById('adjustment-form').style.display = 'none';
  document.getElementById('adj-desc').value = '';
  document.getElementById('adj-amount').value = '';
  setAdjustmentType('add');
}

function setAdjustmentType(type) {
  document.getElementById('adj-type').value = type;
  document.querySelectorAll('[data-adj-type]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-adj-type') === type);
  });
  
  const saveBtn = document.getElementById('adj-save-btn');
  if (type === 'sub') {
    saveBtn.textContent = '📉 Save Withdrawal';
    saveBtn.classList.replace('btn-success', 'btn-danger');
  } else {
    saveBtn.textContent = '📉 Save Transaction';
    saveBtn.classList.replace('btn-danger', 'btn-success');
    saveBtn.textContent = '📈 Save Addition';
  }
}

function saveManualAdjustment() {
  const desc = document.getElementById('adj-desc').value.trim();
  let amount = parseFloat(document.getElementById('adj-amount').value);
  const type = document.getElementById('adj-type').value;

  if (!desc || isNaN(amount)) {
    showToast('Please enter description and amount', 'error');
    return;
  }

  // If withdrawal, make it negative
  if (type === 'sub') {
    amount = -Math.abs(amount);
  } else {
    amount = Math.abs(amount);
  }

  const adjustments = getData(STORAGE_KEYS.adjustments);
  adjustments.push({
    id: Date.now(),
    date: new Date().toISOString(),
    desc,
    amount,
    method: currentLedgerMethod,
    type: 'Manual'
  });

  setData(STORAGE_KEYS.adjustments, adjustments);
  showToast('Adjustment saved!', 'success');
  hideAdjustmentForm();
  renderLedgerTable();
  refreshDashboard();
  renderTailorSummary(); // Update tailor stats if payment was made
}

function deleteAdjustment(id) {
  if (!confirm('Delete this manual adjustment?')) return;
  const adjs = getData(STORAGE_KEYS.adjustments);
  setData(STORAGE_KEYS.adjustments, adjs.filter(a => a.id !== id));
  renderLedgerTable();
  refreshDashboard();
  renderTailorSummary(); // Update tailor stats if payment was deleted
  showToast('Adjustment deleted', 'warning');
}

// Pre-builds the HTML for the ledger so it opens in 0ms
function rebuildLedgerCache() {
  const bills = getData(STORAGE_KEYS.bills);
  const adjustments = getData(STORAGE_KEYS.adjustments);
  
  const build = (method) => {
    const all = [];
    // Adjustments
    adjustments.filter(a => a.method === method).forEach(a => {
      all.push({ date: a.date.split('T')[0], desc: a.desc, type: 'Manual', amount: a.amount, isManual: true, id: a.id });
    });
    // Last 100 relevant bills
    let found = 0;
    for (let i = bills.length - 1; i >= 0 && found < 100; i--) {
      const b = bills[i];
      if (b.paymentMethod === 'Split') {
         if (method === 'Cash' && b.splitCash > 0) {
            all.push({ date: b.date, desc: `Bill #KALP-${String(b.billNumber).padStart(4,'0')} (${b.customerName}) - Split Cash`, type: 'Bill', amount: parseFloat(b.splitCash), isManual: false });
            found++;
         } else if (method === 'Bank' && b.splitPhonepe > 0) {
            all.push({ date: b.date, desc: `Bill #KALP-${String(b.billNumber).padStart(4,'0')} (${b.customerName}) - Split PhonePe`, type: 'Bill', amount: parseFloat(b.splitPhonepe), isManual: false });
            found++;
         }
      } else {
        const isRelevant = (method === 'Cash') ? (b.paymentMethod === 'Cash' || !b.paymentMethod) : (b.paymentMethod === 'PhonePe' || b.paymentMethod === 'Card');
        if (isRelevant) {
          all.push({ date: b.date, desc: `Bill #KALP-${String(b.billNumber).padStart(4,'0')} (${b.customerName})`, type: 'Bill', amount: b.grandTotal, isManual: false });
          found++;
        }
      }
    }
    all.sort((a,b) => b.date.localeCompare(a.date));
    
    if (all.length === 0) return '<tr><td colspan="5" class="ta-c">No transactions found</td></tr>';
    
    return all.slice(0, 100).map(e => `
      <tr>
        <td>${formatDate(e.date)}</td>
        <td>${esc(e.desc)}</td>
        <td><span class="badge ${e.isManual ? 'badge-warning' : 'badge-success'}">${e.type}</span></td>
        <td style="text-align: right; font-weight: 600; color: ${e.amount < 0 ? 'var(--danger-color)' : 'var(--success-color)'}">
          ${e.amount < 0 ? '-' : '+'}${formatCurrency(Math.abs(e.amount))}
        </td>
        <td style="text-align: center;">
          ${e.isManual ? `<button class="btn-icon btn-delete" onclick="deleteAdjustment(${e.id})">🗑️</button>` : ''}
        </td>
      </tr>
    `).join('');
  };

  viewCache.cashLedger = build('Cash');
  viewCache.bankLedger = build('Bank');
}

function renderLedgerTable() {
  const bills = getData(STORAGE_KEYS.bills);
  const adjustments = getData(STORAGE_KEYS.adjustments);
  const body = document.getElementById('ledger-body');
  const totalDisplay = document.getElementById('ledger-total-display');

  // 1. FAST TOTAL DISPLAY: Reuse the pre-calculated totals from the dashboard!
  const dashboardStat = currentLedgerMethod === 'Cash' ? 
    document.getElementById('stat-cash-hand').textContent : 
    document.getElementById('stat-bank-balance').textContent;
  
  if (totalDisplay && dashboardStat) {
    totalDisplay.textContent = dashboardStat;
  }

  // If showingAllLedger is true, we re-render everything (slow but intentional)
  if (!showingAllLedger) {
    body.innerHTML = currentLedgerMethod === 'Cash' ? viewCache.cashLedger : viewCache.bankLedger;
    if (bills.length > 100) {
      const loadMoreRow = document.createElement('tr');
      loadMoreRow.innerHTML = `<td colspan="5" style="text-align: center; padding: 20px;"><button class="btn btn-ghost" onclick="loadAllLedger()">📂 Load Full History</button></td>`;
      body.appendChild(loadMoreRow);
    }
    return;
  }

  // Full History rendering (same as before but only when explicitely requested)
  const allEntries = [];
  const adjEntries = adjustments.filter(a => a.method === currentLedgerMethod).map(a => ({
    id: a.id, date: a.date.split('T')[0], desc: a.desc, type: 'Manual', amount: a.amount, isManual: true
  }));
  
  for (let i = bills.length - 1; i >= 0; i--) {
    const b = bills[i];
    if (b.paymentMethod === 'Split') {
      if (currentLedgerMethod === 'Cash' && b.splitCash > 0) {
        allEntries.push({ date: b.date, desc: `Bill #KALP-${String(b.billNumber).padStart(4,'0')} (${b.customerName}) - Split Cash`, type: 'Bill', amount: parseFloat(b.splitCash), isManual: false });
      } else if (currentLedgerMethod === 'Bank' && b.splitPhonepe > 0) {
        allEntries.push({ date: b.date, desc: `Bill #KALP-${String(b.billNumber).padStart(4,'0')} (${b.customerName}) - Split PhonePe`, type: 'Bill', amount: parseFloat(b.splitPhonepe), isManual: false });
      }
    } else {
      const isRelevant = (currentLedgerMethod === 'Cash') ? (b.paymentMethod === 'Cash' || !b.paymentMethod) : (b.paymentMethod === 'PhonePe' || b.paymentMethod === 'Card');
      if (isRelevant) {
        allEntries.push({ date: b.date, desc: `Bill #KALP-${String(b.billNumber).padStart(4,'0')} (${b.customerName})`, type: 'Bill', amount: b.grandTotal, isManual: false });
      }
    }
  }

  const sortedEntries = [...allEntries, ...adjEntries].sort((a,b) => b.date.localeCompare(a.date));
  
  if (sortedEntries.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="ta-c">No transactions found</td></tr>`;
    return;
  }

  // Limit rendering to the small set
  const limit = 100;
  const entriesToShow = showingAllLedger ? sortedEntries : sortedEntries.slice(0, limit);
  
  body.innerHTML = entriesToShow.map(e => `
    <tr>
      <td>${formatDate(e.date)}</td>
      <td>${esc(e.desc)}</td>
      <td><span class="badge ${e.isManual ? 'badge-warning' : 'badge-success'}">${e.type}</span></td>
      <td style="text-align: right; font-weight: 600; color: ${e.amount < 0 ? 'var(--danger-color)' : 'var(--success-color)'}">
        ${e.amount < 0 ? '-' : '+'}${formatCurrency(Math.abs(e.amount))}
      </td>
      <td style="text-align: center;">
        ${e.isManual ? `<button class="btn-icon btn-delete" onclick="deleteAdjustment(${e.id})">🗑️</button>` : ''}
      </td>
    </tr>
  `).join('');

  if (!showingAllLedger && (allEntries.length >= 100 || (bills.length > 300))) {
    const loadMoreRow = document.createElement('tr');
    loadMoreRow.innerHTML = `
      <td colspan="5" style="text-align: center; padding: 20px;">
        <button class="btn btn-ghost" onclick="loadAllLedger()">📂 Load Full History</button>
      </td>
    `;
    body.appendChild(loadMoreRow);
  }
}

function loadAllLedger() {
  showingAllLedger = true;
  renderLedgerTable();
}

function deleteBill(id) {
  const bills = getData(STORAGE_KEYS.bills);
  const bill = bills.find(b => b.id === id);
  if (!bill) return;

  if (confirm(`Are you sure you want to delete bill #KALP-${String(bill.billNumber).padStart(4, '0')}?`)) {
    // Return stock
    bill.items.forEach(item => {
      incrementStock(item.itemName, item.qty);
      incrementBarcodeStock(item.itemName, item.qty, item.barcodeId);
    });

    // Remove from orders tracking if exists
    const orders = getData(STORAGE_KEYS.orders);
    const linkedOrder = orders.find(o => o.billId === id) || null;
    const updatedOrders = orders.filter(o => o.billId !== id);
    if (orders.length !== updatedOrders.length) {
      setData(STORAGE_KEYS.orders, updatedOrders);
    }

    // Save to Recycle Bin
    const deletedDb = getData(STORAGE_KEYS.deletedBills) || [];
    deletedDb.push({
      ...bill,
      deletedAt: new Date().toISOString(),
      savedOrder: linkedOrder
    });
    setData(STORAGE_KEYS.deletedBills, deletedDb);

    const updated = bills.filter(b => b.id !== id);
    setData(STORAGE_KEYS.bills, updated);
    deleteSingleBillFromCloud(id);
    showToast('Bill moved to Recycle Bin', 'success');
    refreshDashboard();
  }
}

function editBill(id) {
  const bills = getData(STORAGE_KEYS.bills);
  const bill = bills.find(b => b.id === id);
  if (!bill) return;

  editingBillId = id;
  isManualTotalOverride = false;

  // Fill form
  document.getElementById('bill-customer-name').value = bill.customerName === 'Walk-in Customer' ? '' : bill.customerName;
  document.getElementById('bill-phone').value = bill.phone || '';
  document.getElementById('bill-email').value = bill.email || '';
  document.getElementById('bill-date').value = bill.date || '';
  document.getElementById('bill-number').value = `KALP-${String(bill.billNumber).padStart(4, '0')}`;
  document.getElementById('bill-discount-percent').value = bill.discountPercent || 0;
  
  if (bill.paymentMethod) {
    setPaymentMethod(bill.paymentMethod);
    if (bill.paymentMethod === 'Split') {
      document.getElementById('split-cash').value = bill.splitCash || '';
      document.getElementById('split-phonepe').value = bill.splitPhonepe || '';
    }
  } else {
    document.getElementById('bill-payment-method').value = '';
    document.querySelectorAll('#payment-method-toggle button').forEach(btn => btn.classList.remove('active'));
    const splitFields = document.getElementById('split-payment-fields');
    if (splitFields) splitFields.style.display = 'none';
  }

  const noDeliveryCb = document.getElementById('bill-no-delivery');
  const deliveryDateEl = document.getElementById('bill-delivery-date');
  if (noDeliveryCb) noDeliveryCb.checked = !!bill.noDelivery;
  if (deliveryDateEl) {
    deliveryDateEl.disabled = !!bill.noDelivery;
    deliveryDateEl.value = bill.deliveryDate || '';
  }

  const orderNumberEl = document.getElementById('bill-order-number');
  if (orderNumberEl) orderNumberEl.value = bill.orderNumber || '';

  const advancePaidEl = document.getElementById('bill-advance-paid');
  if (advancePaidEl) advancePaidEl.value = bill.advancePaid || 0;

  const noTailorCb = document.getElementById('bill-no-tailor');
  const tailorAmountEl = document.getElementById('bill-tailor-amount');
  if (noTailorCb) {
    noTailorCb.checked = !!bill.noTailor;
    toggleTailoringSection(!!bill.noTailor);
  }
  if (tailorAmountEl) {
    tailorAmountEl.value = bill.tailorAmount || '';
  }

  const accEl = document.getElementById('tailor-accessories');
  if (accEl) accEl.value = bill.tailorAccessories || '';
  const handEl = document.getElementById('tailor-handwork');
  if (handEl) handEl.value = bill.tailorHandwork || '';
  const embEl = document.getElementById('tailor-embroidery');
  if (embEl) embEl.value = bill.tailorEmbroidery || '';
  const discEl = document.getElementById('tailor-discount');
  if (discEl) discEl.value = bill.tailorDiscount || '';
  const prioEl = document.getElementById('tailor-priority');
  if (prioEl) prioEl.checked = !!bill.tailorPriority;

  const stitchList = document.getElementById('stitching-items-list');
  if (stitchList) {
    stitchList.innerHTML = '';
    if (Array.isArray(bill.tailoringItems) && bill.tailoringItems.length > 0) {
      bill.tailoringItems.forEach(item => addStitchingItemRow(item));
    }
  }
  calculateTailorAmount();
  updatePendingAmount();

  // Outfit Details
  const instructionsEl = document.getElementById('bill-outfit-instructions');
  if (instructionsEl) instructionsEl.value = bill.outfitInstructions || '';
  const selectedOptions = bill.outfitOptions || [];
  const savedQuantities = bill.outfitQuantities || {};
  document.querySelectorAll('.outfit-checkbox').forEach(cb => {
    const isChecked = selectedOptions.includes(cb.value);
    cb.checked = isChecked;
    const row = cb.closest('.outfit-item-row');
    const qtyInput = row ? row.querySelector('.outfit-qty') : null;
    if (qtyInput) {
      if (isChecked) {
        qtyInput.style.display = 'block';
        qtyInput.value = savedQuantities[cb.value] || 1;
      } else {
        qtyInput.style.display = 'none';
        qtyInput.value = '';
      }
    }
  });

  // Staff, event date, fabric cut
  const staffSel = document.getElementById('bill-staff-id');
  if (staffSel) staffSel.value = bill.staffId || '';
  const evDateEl = document.getElementById('bill-event-date');
  if (evDateEl) evDateEl.value = bill.eventDate || '';
  const fabCutEl = document.getElementById('bill-fabric-cut');
  if (fabCutEl) fabCutEl.checked = !!bill.fabricCut;

  setGstMode(bill.gstMode || 'including'); setGstMode(bill.gstMode);

  // Load items
  lineItems = bill.items.map(item => ({
    id: Date.now() + Math.random(),
    itemName: item.itemName,
    qty: item.qty.toString(),
    price: item.price.toString(),
    total: item.total,
    barcodeId: item.barcodeId || null // Ensure barcode gets linked
  }));

  // Update UI and change button text
  renderLineItems();
  const saveBtn = document.getElementById('btn-save-print-bill');
  if (saveBtn) {
    saveBtn.innerHTML = '🔄 Update & Print 🖨️';
    saveBtn.classList.replace('btn-primary', 'btn-secondary');
  }

  // Navigate to billing
  window.location.hash = 'billing';
  showToast('Editing bill...', 'info');
}

function renderSalesChart(bills) {
  const chart = document.getElementById('sales-chart');
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }
  const salesByDay = days.map(day => {
    const db = bills.filter(b => b.date === day);
    return { date: day, total: db.reduce((s, b) => s + (b.grandTotal || 0), 0),
      label: new Date(day).toLocaleDateString('en-IN', { weekday: 'short' }) };
  });
  const max = Math.max(...salesByDay.map(d => d.total), 1);
  chart.innerHTML = salesByDay.map(d => {
    const h = (d.total / max) * 100;
    return `<div class="bar-chart-item">
      <div class="bar-chart-value">${formatCurrencyShort(d.total)}</div>
      <div class="bar-chart-bar" style="height:${Math.max(h, 2)}%"></div>
      <div class="bar-chart-label">${d.label}</div>
    </div>`;
  }).join('');
}

// ===================================================================
// DAILY BOOK
// ===================================================================

function initDailyBook() {
  const dateInput = document.getElementById('dailybook-date');
  if (!dateInput.value) {
    const today = new Date().toISOString().split('T')[0];
    dateInput.value = today;
  }
  renderDailyBook(dateInput.value);
}

function renderDailyBook(dateStr) {
  if (!dateStr) return;
  
  const bills = getData(STORAGE_KEYS.bills);
  const adjustments = getData(STORAGE_KEYS.adjustments);
  const tbody = document.getElementById('dailybook-table-body');
  
  // Date formatting for display
  const displayDate = new Date(dateStr).toLocaleDateString('en-IN', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  document.getElementById('dailybook-display-date').textContent = displayDate;
  
  // Filtering
  const todaysBills = bills.filter(b => b.date === dateStr);
  const todaysAdjs = adjustments.filter(a => a.date.split('T')[0] === dateStr);
  
  // Variables for totals
  let cashIn = 0;
  let bankIn = 0;
  let expenses = 0; // Total out
  
  // Prepare combined entries for table
  const entries = [];
  
  // 1. Process Bills
  todaysBills.forEach(b => {
    let method = b.paymentMethod || 'Cash';
    let bCash = 0;
    let bBank = 0;
    
    if (method === 'Split') {
      bCash = parseFloat(b.splitCash) || 0;
      bBank = parseFloat(b.splitPhonepe) || 0;
    } else if (method === 'Cash') {
      bCash = b.grandTotal;
    } else {
      bBank = b.grandTotal;
    }
    
    cashIn += bCash;
    bankIn += bBank;
    
    // Add to table entries
    if (bCash > 0) {
      entries.push({ type: 'Sale', desc: `Bill #${b.billNumber} - ${b.customerName || 'Walk-in'}`, method: 'Cash', amountIn: bCash, amountOut: 0, id: b.id, isBill: true });
    }
    if (bBank > 0) {
      entries.push({ type: 'Sale', desc: `Bill #${b.billNumber} - ${b.customerName || 'Walk-in'}`, method: 'Bank/UPI', amountIn: bBank, amountOut: 0, id: b.id, isBill: true });
    }
  });
  
  // 2. Process Adjustments
  todaysAdjs.forEach(a => {
    const amt = parseFloat(a.amount) || 0;
    const isOut = amt < 0;
    const absAmt = Math.abs(amt);
    
    if (isOut) {
      expenses += absAmt;
      entries.push({ type: 'Expense', desc: a.desc, method: a.method, amountIn: 0, amountOut: absAmt, id: a.id, isBill: false });
    } else {
      if (a.method === 'Cash') cashIn += absAmt;
      else bankIn += absAmt;
      entries.push({ type: 'Income', desc: a.desc, method: a.method, amountIn: absAmt, amountOut: 0, id: a.id, isBill: false });
    }
  });
  
  // Update UI Stats
  document.getElementById('daily-stat-cash-in').textContent = formatCurrency(cashIn);
  document.getElementById('daily-stat-bank-in').textContent = formatCurrency(bankIn);
  document.getElementById('daily-stat-expenses').textContent = formatCurrency(expenses);
  document.getElementById('daily-stat-net-cash').textContent = formatCurrency(cashIn - expenses);
  
  // Render Table
  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">📓</div><div class="empty-text">No transactions for this date</div></div></td></tr>';
  } else {
    tbody.innerHTML = entries.map(e => {
      const typeClass = e.type === 'Sale' ? 'badge-success' : (e.type === 'Expense' ? 'badge-warning' : 'badge-primary');
      const actionHtml = e.isBill 
        ? `<button class="btn-icon btn-edit" onclick="editBill(${e.id})" title="Edit Bill">📝</button>`
        : `<button class="btn-icon btn-delete" onclick="deleteDailyExpense(${e.id}, '${dateStr}')" title="Delete Entry">🗑️</button>`;
        
      return `<tr>
        <td><span class="badge ${typeClass}">${e.type}</span></td>
        <td>${esc(e.desc)}</td>
        <td>${e.method}</td>
        <td style="text-align: right; color: var(--success-color); font-weight: 500;">${e.amountIn > 0 ? '+' + formatCurrency(e.amountIn) : '-'}</td>
        <td style="text-align: right; color: var(--danger-color); font-weight: 500;">${e.amountOut > 0 ? '-' + formatCurrency(e.amountOut) : '-'}</td>
        <td style="text-align: center;">${actionHtml}</td>
      </tr>`;
    }).join('');
  }
}

// Daily Expense Modal functions
function openDailyExpenseModal() {
  document.getElementById('daily-expense-type').value = 'out';
  document.getElementById('btn-expense-type-out').classList.add('active');
  document.getElementById('btn-expense-type-in').classList.remove('active');
  document.getElementById('daily-expense-desc').value = '';
  document.getElementById('daily-expense-amount').value = '';
  document.getElementById('daily-expense-modal').classList.add('active');
}

function closeDailyExpenseModal() {
  document.getElementById('daily-expense-modal').classList.remove('active');
}

function setDailyExpenseType(type) {
  document.getElementById('daily-expense-type').value = type;
  document.getElementById('btn-expense-type-out').classList.toggle('active', type === 'out');
  document.getElementById('btn-expense-type-in').classList.toggle('active', type === 'in');
}

function saveDailyExpense() {
  const type = document.getElementById('daily-expense-type').value;
  const method = document.getElementById('daily-expense-method').value;
  const desc = document.getElementById('daily-expense-desc').value.trim();
  let amount = parseFloat(document.getElementById('daily-expense-amount').value);
  
  if (!desc || isNaN(amount) || amount <= 0) {
    showToast('Please enter a valid description and amount', 'error');
    return;
  }
  
  // If it's an expense (out), the adjustment should be negative
  if (type === 'out') {
    amount = -amount;
  }
  
  const dateStr = document.getElementById('dailybook-date').value;
  // Use the selected date, but keep current time for ordering if today, else just use the date + midnight
  const now = new Date();
  const selectedDate = new Date(dateStr);
  let isoDate;
  
  if (now.toISOString().split('T')[0] === dateStr) {
    isoDate = now.toISOString();
  } else {
    selectedDate.setHours(12, 0, 0); // Noon
    isoDate = selectedDate.toISOString();
  }
  
  const adjustments = getData(STORAGE_KEYS.adjustments);
  adjustments.push({
    id: Date.now(),
    date: isoDate,
    desc,
    amount,
    method,
    type: 'Manual'
  });
  
  setData(STORAGE_KEYS.adjustments, adjustments);
  showToast('Entry saved successfully!', 'success');
  closeDailyExpenseModal();
  renderDailyBook(dateStr);
  refreshDashboard();
}

function deleteDailyExpense(id, dateStr) {
  if (!confirm('Are you sure you want to delete this entry?')) return;
  
  const adjustments = getData(STORAGE_KEYS.adjustments);
  setData(STORAGE_KEYS.adjustments, adjustments.filter(a => a.id !== id));
  
  showToast('Entry deleted', 'warning');
  renderDailyBook(dateStr);
  refreshDashboard();
}

// --- Customer Data Management ---
function getUniqueCustomers() {
  const bills = getData(STORAGE_KEYS.bills);
  const customersMap = {};
  
  bills.forEach(b => {
    const isWalkin = (!b.customerName || b.customerName === 'Walk-in Customer') && !b.phone && !b.email;
    if (isWalkin) return;
    
    const key = (b.phone && b.phone.trim() !== '-') ? b.phone.trim() : (b.email || b.customerName);
    if (!key) return;

    const grand = parseFloat(b.grandTotal) || 0;

    if (!customersMap[key]) {
      customersMap[key] = {
        name: b.customerName && b.customerName !== 'Walk-in Customer' ? b.customerName : 'Unknown',
        phone: b.phone || '-',
        email: b.email || '-',
        lastVisit: b.date,
        totalSpent: grand,
        totalPurchases: 1
      };
    } else {
      customersMap[key].totalSpent += grand;
      customersMap[key].totalPurchases += 1;
      if (b.date > customersMap[key].lastVisit) {
        customersMap[key].lastVisit = b.date;
      }
      if (b.customerName && b.customerName !== 'Walk-in Customer') {
        customersMap[key].name = b.customerName;
      }
    }
  });

  return Object.values(customersMap).sort((a,b) => (b.lastVisit || '').localeCompare(a.lastVisit || ''));
}

function openCustomerModal() {
  const modal = document.getElementById('customer-modal');
  if (modal) {
    modal.classList.add('active');
    renderCustomerModal();
  }
}

function closeCustomerModal() {
  const modal = document.getElementById('customer-modal');
  if (modal) modal.classList.remove('active');
}

function renderCustomerModal() {
  const customers = getUniqueCustomers();
  const searchInput = document.getElementById('customer-search');
  const sortSelect = document.getElementById('customer-sort');
  const filterText = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const sortBy = sortSelect ? sortSelect.value : 'recent';

  let filtered = customers.filter(c => {
    if (!filterText) return true;
    return (
      (c.name && c.name.toLowerCase().includes(filterText)) ||
      (c.phone && c.phone.toLowerCase().includes(filterText)) ||
      (c.email && c.email.toLowerCase().includes(filterText))
    );
  });

  if (sortBy === 'value_desc') {
    filtered.sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0));
  } else if (sortBy === 'freq_desc') {
    filtered.sort((a, b) => (b.totalPurchases || 0) - (a.totalPurchases || 0));
  } else {
    filtered.sort((a, b) => (b.lastVisit || '').localeCompare(a.lastVisit || ''));
  }

  const countEl = document.getElementById('customer-modal-count');
  if (countEl) countEl.textContent = `${filtered.length} customer${filtered.length === 1 ? '' : 's'} found`;

  const body = document.getElementById('customer-table-body');
  if (!body) return;
  
  if (filtered.length === 0) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state">
      <div class="empty-icon">👥</div><div class="empty-text">No Customers Found</div>
      <div class="empty-sub">Customers added to bills will appear here</div>
    </div></td></tr>`;
  } else {
    body.innerHTML = filtered.map((c, idx) => {
      let waLink = '';
      if (c.phone && c.phone !== '-') {
        const waPhone = c.phone.replace(/[^\d+]/g, '');
        if (waPhone) {
          waLink = `<a href="https://wa.me/${waPhone}" target="_blank" title="WhatsApp Customer" style="display:inline-flex; align-items:center; gap:4px; padding:4px 8px; background-color:#25D366; color:white; border-radius:4px; text-decoration:none; font-size:12px; font-weight:bold;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
              <path d="M13.601 2.326A7.85 7.85 0 0 0 7.994 0C3.627 0 .068 3.558.064 7.926c0 1.399.366 2.76 1.057 3.965L0 16l4.204-1.102a7.9 7.9 0 0 0 3.79.965h.004c4.368 0 7.926-3.558 7.93-7.93A7.9 7.9 0 0 0 13.6 2.326zM7.994 14.521a6.6 6.6 0 0 1-3.356-.92l-.24-.144-2.494.654.666-2.433-.156-.251a6.56 6.56 0 0 1-1.007-3.505c0-3.626 2.957-6.584 6.591-6.584a6.56 6.56 0 0 1 4.66 1.931 6.56 6.56 0 0 1 1.928 4.66c-.004 3.639-2.961 6.592-6.592 6.592m3.615-4.934c-.197-.099-1.17-.578-1.353-.646-.182-.065-.315-.099-.445.099-.133.197-.513.646-.627.775-.114.133-.232.148-.43.05-.197-.1-.836-.308-1.592-.985-.59-.525-.985-1.175-1.103-1.372-.114-.198-.011-.304.088-.403.087-.088.197-.232.296-.346.1-.114.133-.198.198-.33.065-.134.034-.248-.015-.347-.05-.099-.445-1.076-.612-1.47-.16-.389-.323-.335-.445-.34-.114-.007-.247-.007-.38-.007a.73.73 0 0 0-.529.247c-.182.198-.691.677-.691 1.654s.71 1.916.81 2.049c.098.133 1.394 2.132 3.383 2.992.47.205.84.326 1.129.418.475.152.904.129 1.246.08.38-.058 1.171-.48 1.338-.943.164-.464.164-.86.114-.943-.049-.084-.182-.133-.38-.232"/>
            </svg> WhatsApp
          </a>`;
        }
      }
      return `<tr>
        <td style="text-align:center;color:var(--text-muted);">${idx + 1}</td>
        <td style="font-weight:600;"><a href="javascript:void(0)" onclick="openCustomerProfileModal('${esc(c.phone)}', '${esc(c.name)}')" style="color:var(--accent-primary);text-decoration:none;">${esc(c.name)}</a></td>
        <td>${esc(c.phone)}</td>
        <td>${esc(c.email)}</td>
        <td>${formatDate(c.lastVisit)}</td>
        <td style="text-align:right;font-weight:700;">${formatCurrency(c.totalSpent || 0)}</td>
        <td style="text-align:center;">
          <div style="display:flex;gap:6px;justify-content:center;align-items:center;">
            ${waLink}
            <button class="btn btn-outline btn-sm" onclick="openCustomerProfileModal('${esc(c.phone)}', '${esc(c.name)}')" style="padding:4px 8px;font-size:0.75rem;">👤 Profile</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }
}

function openCustomerProfileModal(phone, name) {
  const modal = document.getElementById('customer-profile-modal');
  if (!modal) return;
  const bills = getData(STORAGE_KEYS.bills);

  const cleanPhone = (phone && phone !== '-') ? phone.trim() : '';
  const matchBills = bills.filter(b => {
    if (cleanPhone && b.phone) {
      return b.phone.trim() === cleanPhone;
    }
    return b.customerName && b.customerName.trim().toLowerCase() === (name || '').trim().toLowerCase();
  });

  matchBills.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  let totalSpent = 0;
  const namesUsedSet = new Set();

  matchBills.forEach(b => {
    totalSpent += (parseFloat(b.grandTotal) || 0);
    if (b.customerName && b.customerName !== 'Walk-in Customer') {
      namesUsedSet.add(b.customerName);
    }
  });

  const nameEl = document.getElementById('profile-name');
  const phoneEl = document.getElementById('profile-phone');
  const emailEl = document.getElementById('profile-email');
  const spentEl = document.getElementById('profile-total-spent');
  const purchasesEl = document.getElementById('profile-total-purchases');
  const namesUsedEl = document.getElementById('profile-names-used');
  const tbody = document.getElementById('profile-purchases-body');

  if (nameEl) nameEl.textContent = name || (matchBills[0]?.customerName) || 'Customer Profile';
  if (phoneEl) phoneEl.textContent = cleanPhone || (matchBills[0]?.phone) || '-';
  if (emailEl) emailEl.textContent = (matchBills[0]?.email) || '-';
  if (spentEl) spentEl.textContent = formatCurrency(totalSpent);
  if (purchasesEl) purchasesEl.textContent = `${matchBills.length} Purchase${matchBills.length === 1 ? '' : 's'}`;
  if (namesUsedEl) namesUsedEl.textContent = namesUsedSet.size > 0 ? Array.from(namesUsedSet).join(', ') : (name || '-');

  if (tbody) {
    if (matchBills.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:15px;color:var(--text-muted);">No purchases recorded for this customer</td></tr>`;
    } else {
      tbody.innerHTML = matchBills.map(b => `
        <tr>
          <td>${formatDate(b.date)}</td>
          <td><strong>#KALP-${String(b.billNumber).padStart(4, '0')}</strong></td>
          <td>${esc(b.customerName || 'Walk-in')}</td>
          <td style="text-align:right;font-weight:700;">${formatCurrency(b.grandTotal || 0)}</td>
        </tr>
      `).join('');
    }
  }

  modal.classList.add('active');
}

function closeCustomerProfileModal() {
  const modal = document.getElementById('customer-profile-modal');
  if (modal) modal.classList.remove('active');
}

function openPendingDetailsModal() {
  const modal = document.getElementById('pending-details-modal');
  if (!modal) return;

  const orders = getData(STORAGE_KEYS.orders) || [];
  let totalFabricPending = 0;
  let totalTailorPending = 0;
  const pendingOrders = [];

  orders.forEach(order => {
    const total = parseFloat(order.total) || 0;
    const advance = parseFloat(order.advance) || 0;
    const pending = parseFloat(order.pending) !== undefined ? parseFloat(order.pending) : (total - advance);
    const fabric = parseFloat(order.fabric) || 0;
    const tailor = parseFloat(order.tailor) || 0;

    if (pending > 0.01) {
      let fabricPending = 0;
      let tailorPending = 0;
      if (advance <= fabric) {
        fabricPending = fabric - advance;
        tailorPending = tailor;
      } else {
        fabricPending = 0;
        tailorPending = Math.max(0, (fabric + tailor) - advance);
      }
      totalFabricPending += fabricPending;
      totalTailorPending += tailorPending;
      pendingOrders.push({
        ...order,
        total,
        advance,
        pending,
        fabricPending,
        tailorPending
      });
    }
  });

  const fabEl = document.getElementById('modal-fabric-pending');
  const tailEl = document.getElementById('modal-tailor-pending');
  if (fabEl) fabEl.textContent = formatCurrency(totalFabricPending);
  if (tailEl) tailEl.textContent = formatCurrency(totalTailorPending);

  const tbody = document.getElementById('pending-details-tbody');
  if (tbody) {
    if (pendingOrders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted);">🎉 No pending payments! All orders settled.</td></tr>`;
    } else {
      tbody.innerHTML = pendingOrders.map(order => `
        <tr>
          <td><strong>#KALP-${String(order.billNumber || '').padStart(4, '0')}</strong></td>
          <td>${esc(order.customerName || 'Walk-in')}</td>
          <td style="text-align:right">${formatCurrency(order.total)}</td>
          <td style="text-align:right;color:#15803d">${formatCurrency(order.advance)}</td>
          <td style="text-align:right;color:#3b82f6;font-weight:600">${formatCurrency(order.fabricPending)}</td>
          <td style="text-align:right;color:#f59e0b;font-weight:600">${formatCurrency(order.tailorPending)}</td>
          <td style="text-align:center">
            <button class="btn btn-sm btn-outline" onclick="settlePendingOrder('${order.id}', ${order.pending})" title="Quick Settle">✅ Settle</button>
          </td>
        </tr>
      `).join('');
    }
  }

  modal.classList.add('active');
}

function closePendingDetailsModal() {
  const modal = document.getElementById('pending-details-modal');
  if (modal) modal.classList.remove('active');
}

function settlePendingOrder(orderId, currentPending) {
  if (!confirm(`Mark this order as fully settled (₹${(parseFloat(currentPending) || 0).toFixed(2)})?`)) return;
  const orders = getData(STORAGE_KEYS.orders) || [];
  const order = orders.find(o => String(o.id) === String(orderId));
  if (!order) return;

  order.advance = order.total;
  order.pending = 0;
  setData(STORAGE_KEYS.orders, orders);

  const bills = getData(STORAGE_KEYS.bills) || [];
  const bill = bills.find(b => b.id === order.billId || String(b.billNumber) === String(order.billNumber));
  if (bill) {
    bill.advancePaid = (parseFloat(bill.grandTotal) || 0) + (parseFloat(bill.tailorAmount) || 0);
    bill.totalPending = 0;
    setData(STORAGE_KEYS.bills, bills);
    saveSingleBillToCloud(bill);
  }

  showToast('Order marked as settled!', 'success');
  if (typeof renderOrdersTable === 'function') renderOrdersTable();
  refreshDashboard();
  openPendingDetailsModal();
}

function exportCustomersCSV() {
  const customers = getUniqueCustomers();
  if (customers.length === 0) {
    showToast('No customer data to export', 'error');
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Customer Name,Phone Number,Email,Last Visit\n";
  
  customers.forEach(c => {
    const name = `"${c.name.replace(/"/g, '""')}"`;
    const phone = `"${c.phone.replace(/"/g, '""')}"`;
    const email = `"${c.email.replace(/"/g, '""')}"`;
    const lastVisit = `"${c.lastVisit}"`;
    
    csvContent += `${name},${phone},${email},${lastVisit}\n`;
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `customers_export_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Customers exported to CSV', 'success');
}

// --- Deliveries Dashboard & Modal ---
function updateDeliveriesDashboard() {
  const orders = getData(STORAGE_KEYS.orders);
  let pendingCount = 0;
  
  orders.forEach(o => {
    if (o.deliveryDate && String(o.deliveryDate).trim() !== '' && !o.isDelivered) {
      pendingCount++;
    }
  });
  
  const target = document.getElementById('stat-upcoming-deliveries');
  if (target) {
    target.textContent = pendingCount;
  }
}

let currentDeliveriesTab = 'pending';

function switchDeliveriesTab(tab) {
  currentDeliveriesTab = tab;
  document.getElementById('tab-del-pending').style.borderBottomColor = tab === 'pending' ? 'var(--primary-color)' : 'transparent';
  document.getElementById('tab-del-pending').style.color = tab === 'pending' ? 'var(--primary-color)' : 'var(--text-muted)';
  
  document.getElementById('tab-del-completed').style.borderBottomColor = tab === 'completed' ? 'var(--primary-color)' : 'transparent';
  document.getElementById('tab-del-completed').style.color = tab === 'completed' ? 'var(--primary-color)' : 'var(--text-muted)';
  
  document.getElementById('deliveries-action-header').textContent = tab === 'pending' ? 'Delivered' : 'Undo';
  
  openDeliveriesModal();
}

function openDeliveriesModal() {
  const orders = getData(STORAGE_KEYS.orders);
  const today = new Date().toISOString().split('T')[0];
  const body = document.getElementById('deliveries-table-body');
  
  // Filter based on active tab
  let deliveries = [];
  if (currentDeliveriesTab === 'pending') {
    deliveries = orders.filter(o => o.deliveryDate && String(o.deliveryDate).trim() !== '' && !o.isDelivered);
    deliveries.sort((a, b) => new Date(a.deliveryDate) - new Date(b.deliveryDate));
  } else {
    deliveries = orders.filter(o => o.deliveryDate && String(o.deliveryDate).trim() !== '' && o.isDelivered);
    deliveries.sort((a, b) => new Date(b.deliveryDate) - new Date(a.deliveryDate)); // closest past date first
  }
  
  if (deliveries.length === 0) {
    const emptyMsg = currentDeliveriesTab === 'pending' ? 'No pending fabric deliveries.' : 'No completed deliveries yet.';
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state">
      <div class="empty-icon">🎉</div><div class="empty-text">All Clear</div>
      <div class="empty-sub">${emptyMsg}</div>
    </div></td></tr>`;
  } else {
    body.innerHTML = deliveries.map(d => {
      const todayTime = Math.floor(new Date(today).getTime() / 86400000);
      const deliveryTime = Math.floor(new Date(d.deliveryDate).getTime() / 86400000);
      const diffTime = todayTime - deliveryTime;
      
      let dateLabel = formatDate(d.deliveryDate);
      
      if (currentDeliveriesTab === 'pending') {
        if (diffTime > 0) {
          dateLabel = `<span style="color:var(--danger-color);font-weight:700;">${diffTime} day${diffTime > 1 ? 's' : ''} ago</span>`;
        } else if (diffTime === 0) {
          dateLabel = `<span style="color:var(--warning-color);font-weight:700;">★ Today</span>`;
        } else if (diffTime === -1) {
          dateLabel = `<span style="font-weight:700;">Tomorrow</span>`;
        }
      } else {
        // For completed, keep it grayed out slightly
        dateLabel = `<span style="color:var(--text-muted);">${dateLabel}</span>`;
      }

      const actionHtml = currentDeliveriesTab === 'pending' 
        ? `<input type="checkbox" onchange="toggleDeliveryStatus('${d.billId}', this.checked)" style="transform: scale(1.5); cursor: pointer;">`
        : `<button class="btn btn-outline btn-sm" onclick="toggleDeliveryStatus('${d.billId}', false)">Undo</button>`;

      const tailorPaidHtml = `<input type="checkbox" onchange="toggleTailorPaid('${d.billId}', this.checked)" style="transform: scale(1.5); cursor: pointer;" ${d.isTailorPaid ? 'checked' : ''}>`;

      return `<tr style="${currentDeliveriesTab === 'completed' ? 'opacity: 0.8;' : ''}">
        <td>${dateLabel}</td>
        <td style="font-weight:600; color:var(--text-accent);">#${esc(String(d.billNumber))}</td>
        <td>${esc(d.customerName)}</td>
        <td style="text-align: right; font-weight: 600; color: ${d.pending > 0 ? 'var(--danger-color)' : 'var(--success-color)'};">${d.pending <= 0 ? 'Paid' : formatCurrency(d.pending)}</td>
        <td style="text-align: center;">${tailorPaidHtml}</td>
        <td style="text-align: center;">${actionHtml}</td>
      </tr>`;
    }).join('');
  }
  
  document.getElementById('deliveries-modal').classList.add('active');
}

function toggleTailorPaid(billId, isPaid) {
  const orders = getData(STORAGE_KEYS.orders);
  const orderIndex = orders.findIndex(o => o.billId == billId);
  if (orderIndex > -1) {
    orders[orderIndex].isTailorPaid = isPaid;
    setData(STORAGE_KEYS.orders, orders);
    showToast(isPaid ? 'Tailor amount marked as paid' : 'Tailor amount marked as unpaid', 'success');
  }
}

function toggleDeliveryStatus(billId, isDelivered) {
  const orders = getData(STORAGE_KEYS.orders);
  const orderIndex = orders.findIndex(o => o.billId == billId);
  if (orderIndex > -1) {
    orders[orderIndex].isDelivered = isDelivered;
    setData(STORAGE_KEYS.orders, orders);
    updateDeliveriesDashboard();
    openDeliveriesModal(); // Refresh modal
    showToast(isDelivered ? 'Marked as Delivered!' : 'Moved back to Pending', 'success');
  }
}

function closeDeliveriesModal() {
  document.getElementById('deliveries-modal').classList.remove('active');
}

async function syncDeliveriesToMS() {
  const orders = getData(STORAGE_KEYS.orders) || [];
  const pending = orders.filter(o => o.deliveryDate && !o.isDelivered);
  
  if (pending.length === 0) {
    showToast('No pending deliveries to sync', 'info');
    return;
  }

  const lines = pending.map(o => {
    return `• KALP Order #${o.billNumber} - ${o.customerName || 'Customer'} (Due: ${formatDate(o.deliveryDate)}, Pending: ₹${o.pending || 0})`;
  });
  const textToCopy = `KALP Pending Deliveries (${new Date().toLocaleDateString()}):\n` + lines.join('\n');

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(textToCopy);
      showToast(`Synced ${pending.length} pending deliveries! Copied task list to clipboard for MS To Do.`, 'success');
    } else {
      showToast(`Found ${pending.length} pending deliveries to sync.`, 'success');
    }
  } catch (e) {
    showToast(`Found ${pending.length} pending deliveries to sync.`, 'info');
  }
}

// --- Recycle Bin Logic ---
function updateDeletedBillsDashboard() {
  const deletedDb = getData(STORAGE_KEYS.deletedBills) || [];
  const target = document.getElementById('stat-deleted-bills');
  if (target) {
    target.textContent = deletedDb.length;
  }
}

function openDeletedBillsModal() {
  const deletedDb = getData(STORAGE_KEYS.deletedBills) || [];
  const body = document.getElementById('deleted-bills-table-body');
  
  if (deletedDb.length === 0) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty-state">
      <div class="empty-icon">🗑️</div><div class="empty-text">Recycle Bin is Empty</div>
      <div class="empty-sub">Deleted bills will appear here</div>
    </div></td></tr>`;
  } else {
    // Sort by deletedAt descending (newest deleted first)
    deletedDb.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
    
    body.innerHTML = deletedDb.map(d => `<tr>
      <td style="font-weight:600; color:var(--danger-color);">#KALP-${String(d.billNumber).padStart(4, '0')}</td>
      <td>${esc(d.customerName)}</td>
      <td>${formatDate(d.deletedAt.split('T')[0])}</td>
      <td style="text-align: right; font-weight: 500;">${formatCurrency(d.grandTotal)}</td>
      <td style="text-align: center;">
        <button class="btn btn-success btn-sm" onclick="restoreBill(${d.id})" title="Restore">♻️ Restore</button>
        <button class="btn btn-danger btn-sm" onclick="permanentDeleteBill(${d.id})" title="Delete Permanently">❌</button>
      </td>
    </tr>`).join('');
  }
  
  document.getElementById('deleted-bills-modal').classList.add('active');
}

function closeDeletedBillsModal() {
  document.getElementById('deleted-bills-modal').classList.remove('active');
}

function restoreBill(id) {
  const deletedDb = getData(STORAGE_KEYS.deletedBills) || [];
  const index = deletedDb.findIndex(b => b.id === id);
  if (index === -1) return;
  
  const billToRestore = deletedDb[index];
  if (!confirm(`Restore bill #KALP-${String(billToRestore.billNumber).padStart(4, '0')}?`)) return;
  
  // 1. Return stock (bill was restored, so stock goes out)
  billToRestore.items.forEach(item => {
    decrementStock(item.itemName, item.qty);
    decrementBarcodeStock(item.itemName, item.qty, item.barcodeId);
  });
  
  // 2. Restore Order if existed
  const orderObj = billToRestore.savedOrder;
  if(orderObj) {
      const orders = getData(STORAGE_KEYS.orders);
      orders.push(orderObj);
      setData(STORAGE_KEYS.orders, orders);
  }
  
  // 3. Clean up object and add to bills
  delete billToRestore.deletedAt;
  delete billToRestore.savedOrder;
  
  const bills = getData(STORAGE_KEYS.bills);
  bills.push(billToRestore);
  bills.sort((a,b) => a.id - b.id);
  setData(STORAGE_KEYS.bills, bills);
  saveSingleBillToCloud(billToRestore);
  
  // 4. Remove from deletedDb
  deletedDb.splice(index, 1);
  setData(STORAGE_KEYS.deletedBills, deletedDb);
  
  showToast(`Bill #KALP-${String(billToRestore.billNumber).padStart(4, '0')} restored successfully!`, 'success');
  openDeletedBillsModal();
  refreshDashboard();
  if (typeof renderOrdersTable === 'function') renderOrdersTable();
}

function permanentDeleteBill(id) {
  if (!confirm('Permanently delete this bill? This cannot be undone!')) return;
  
  const deletedDb = getData(STORAGE_KEYS.deletedBills) || [];
  const updatedDb = deletedDb.filter(b => b.id !== id);
  setData(STORAGE_KEYS.deletedBills, updatedDb);
  
  showToast('Bill permanently deleted', 'warning');
  openDeletedBillsModal();
  refreshDashboard();
}

function emptyRecycleBin() {
  const deletedDb = getData(STORAGE_KEYS.deletedBills) || [];
  if (deletedDb.length === 0) {
    showToast('Recycle Bin is already empty', 'info');
    return;
  }
  
  if (!confirm('🚨 Are you sure you want to permanently delete ALL bills in the Recycle Bin?')) return;
  
  setData(STORAGE_KEYS.deletedBills, []);
  showToast('Recycle Bin emptied', 'warning');
  closeDeletedBillsModal();
  refreshDashboard();
}


// ===================================================================
// BILLING (with barcode scanner support)
// ===================================================================

let lineItems = [];
let gstMode = 'including'; // 'including' or 'excluding'
let editingBillId = null; // ID of the bill currently being edited
let isManualTotalOverride = false; 

function handleManualTotalChange(value) {
  const newTotal = parseFloat(value);
  if (isNaN(newTotal) || lineItems.length === 0) return;

  // 1. Get current calculation factors
  const discountPercent = parseFloat(document.getElementById('bill-discount-percent').value) || 0;
  const discountFactor = (1 - discountPercent / 100);
  const gstFactor = 1.05; // Total 5% GST (2.5% + 2.5%)
  
  // Calculate total target subtotal before taxes/discounts
  // TargetSubtotal * DiscountFactor * GSTFactor = NewTotal (if excluding)
  // TargetSubtotal * DiscountFactor = NewTotal (if including)
  const targetItemsTotal = gstMode === 'including' ? 
    (newTotal / discountFactor) : 
    (newTotal / (discountFactor * gstFactor));

  // 2. Current state
  const currentItemsTotal = lineItems.reduce((s, i) => s + (parseFloat(i.qty) * parseFloat(i.price) || 0), 0);
  if (currentItemsTotal <= 0) return;

  // 3. Scale prices proportionally
  const ratio = targetItemsTotal / currentItemsTotal;
  let runningItemsTotal = 0;

  lineItems.forEach((item, i) => {
    if (i === lineItems.length - 1) {
      // Last item absorbs rounding difference to ensure perfect final total
      const remainingTarget = targetItemsTotal - runningItemsTotal;
      const finalPrice = remainingTarget / (parseFloat(item.qty) || 1);
      item.price = finalPrice.toFixed(2);
    } else {
      const scaledPrice = (parseFloat(item.price) || 0) * ratio;
      item.price = scaledPrice.toFixed(2);
    }
    
    const actualPrice = parseFloat(item.price);
    item.total = (parseFloat(item.qty) || 0) * actualPrice;
    runningItemsTotal += item.total;
    
    // Update UI fields
    const priceInput = document.querySelector(`.line-item-row[data-index="${i}"] .line-item-price`);
    if (priceInput) priceInput.value = item.price;

    const rowTotalInput = document.querySelector(`.line-item-row[data-index="${i}"] .col-total .form-input`);
    if (rowTotalInput) rowTotalInput.value = fmtRaw(item.total);
  });

  // 4. Update the summary summary display
  isManualTotalOverride = true; 
  updateBillSummary();
}


function initBillingPage() {
  const dateInput = document.getElementById('bill-date');
  if (!dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];

  const billNumInput = document.getElementById('bill-number');
  if (!billNumInput.value || billNumInput.value === 'Auto-generated') {
    billNumInput.value = `KALP-${String(getBillCounter() + 1).padStart(4, '0')}`;
  }

  // --- Initialize navigation for static fields (once only) ---
  if (!window.billingNavInitialized) {
    const navigations = [
      { id: 'bill-date', next: 'bill-number' },
      { id: 'bill-number', action: () => { const btn = document.querySelector('[data-method="Cash"]'); if (btn) btn.focus(); } },
      { id: 'split-cash', next: 'split-phonepe' },
      { id: 'split-phonepe', action: () => {
          const dd = document.getElementById('bill-delivery-date');
          if (dd) {
            dd.focus();
            try { dd.showPicker(); } catch(e) {}
          }
        }
      },
      { id: 'bill-delivery-date', next: 'bill-tailor-amount' },
      { id: 'bill-tailor-amount', next: 'bill-customer-name' },
      { id: 'bill-customer-name', next: 'bill-phone' },
      { id: 'bill-phone', next: 'bill-email' },
      { id: 'bill-email', next: '.barcode-scan-input' },
      { id: 'bill-grand-total-input', action: () => { const btn = document.getElementById('btn-save-print-bill'); if (btn) btn.focus(); } }
    ];

    navigations.forEach(nav => {
      const input = document.getElementById(nav.id);
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (nav.action) {
              nav.action();
            } else if (nav.next) {
              if (nav.next.startsWith('.')) {
                const nextEl = document.querySelector(nav.next);
                if (nextEl) nextEl.focus();
              } else {
                const nextEl = document.getElementById(nav.next);
                if (nextEl) nextEl.focus();
              }
            }
          }
        });
      }
    });

    // Handle Enter on Discount field -> Grand Total Input
    const discountInput = document.getElementById('bill-discount-percent');
    if (discountInput) {
      discountInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const gtInput = document.getElementById('bill-grand-total-input');
          if (gtInput) gtInput.focus();
        }
      });
    }

    window.billingNavInitialized = true;
  }

  if (lineItems.length === 0) addLineItem();
  else renderLineItems();
}

function addLineItem() {
  lineItems.push({
    id: Date.now() + Math.random(),
    itemName: '', qty: '', price: '',
    total: 0,
    barcodeId: null
  });
  isManualTotalOverride = false;
  renderLineItems();
  setTimeout(() => {
    const rows = document.querySelectorAll('.line-item-row');
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      const input = lastRow.querySelector('.col-item .form-input');
      if (input) input.focus();
    }
  }, 50);
}

function renderLineItems() {
  const body = document.getElementById('line-items-body');
  body.innerHTML = lineItems.map((item, i) => {
    const scannedBadge = item.barcodeId
      ? `<span class="scanned-indicator">✓ Scanned</span>` : '';
    return `<div class="line-item-row" data-index="${i}">
      <div class="col-sno">${i + 1}</div>
      <div class="col-item">
        <input type="text" class="form-input input-sm barcode-scan-input" value="${esc(item.itemName)}"
          placeholder="Scan barcode or type name" data-index="${i}"
          onchange="updateLineItem(${i}, 'itemName', this.value)">
        ${scannedBadge}
      </div>
      <div class="col-qty">
        <input type="number" class="form-input input-sm line-item-qty" value="${fmtQty(item.qty)}"
          placeholder="0" min="0" data-index="${i}"
          oninput="updateLineItem(${i}, 'qty', this.value)">
      </div>
      <div class="col-price">
        <input type="number" class="form-input input-sm line-item-price" value="${item.price}"
          placeholder="0.00" min="0" step="0.01" data-index="${i}" oninput="updateLineItem(${i}, 'price', this.value)"
          ${item.barcodeId ? 'readonly style="background:var(--accent-light);font-weight:600;"' : ''}>
      </div>
      <div class="col-total">
        <input type="text" class="form-input input-sm readonly" value="${fmtRaw(item.total)}" readonly>
      </div>
      <div class="col-action">
        ${lineItems.length > 1 ? `<button class="btn-remove-row" onclick="removeLineItem(${i})" title="Remove">×</button>` : ''}
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('.barcode-scan-input').forEach(input => {
    attachBarcodeScanListener(input);
  });
  
  // Attach Enter key navigation for newly rendered fields
  document.querySelectorAll('.line-item-qty').forEach(input => {
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const idx = parseInt(this.getAttribute('data-index'));
        const row = document.querySelector(`.line-item-row[data-index="${idx}"]`);
        if (row) {
          const nextInput = row.querySelector('.line-item-price');
          if (nextInput) nextInput.focus();
        }
      }
    });
  });

  document.querySelectorAll('.line-item-price').forEach(input => {
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const idx = parseInt(this.getAttribute('data-index'));
        const nextIdx = idx + 1;
        
        // Try to focus next item row's name field
        const nextInput = document.querySelector(`.line-item-row[data-index="${nextIdx}"] .barcode-scan-input`);
        if (nextInput) {
          nextInput.focus();
        } else {
          // If no next row, add a new one
          addLineItem();
        }
      }
    });
  });

  updateBillSummary();
}

// --- Barcode Scanner Detection ---
// Barcode scanners type rapidly and press Enter. We detect this pattern.
function attachBarcodeScanListener(input) {
  let buffer = '';
  let lastKeyTime = 0;

  input.addEventListener('keydown', function(e) {
    const now = Date.now();

    if (e.key === 'Enter') {
      e.preventDefault();
      const idx = parseInt(this.getAttribute('data-index'));
      const value = this.value.trim();

      // If empty -> jump to discount
      if (!value) {
        const discountInput = document.getElementById('bill-discount-percent');
        if (discountInput) {
          discountInput.focus();
          discountInput.select();
        }
        return;
      }

      // Try to look up as barcode
      const barcodeItem = lookupBarcode(value);
      if (barcodeItem) {
        applyBarcodeToLine(idx, barcodeItem);
        showToast(`Scanned: ${barcodeItem.name}`, 'success');
      } else {
        // If not found as barcode, focus the qty field of the current row (manual entry)
        const row = document.querySelector(`.line-item-row[data-index="${idx}"]`);
        if (row) {
          const qtyInput = row.querySelector('.col-qty .form-input');
          if (qtyInput) { qtyInput.focus(); qtyInput.select(); }
        }
      }

      buffer = '';
      return;
    }

    // Track rapid typing (scanner types < 50ms between keys)
    if (now - lastKeyTime > 200) {
      buffer = ''; // Reset if too slow (manual typing)
    }
    lastKeyTime = now;
  });
}

function lookupBarcode(value) {
  const barcodes = getData(STORAGE_KEYS.barcodes);
  // Look up by barcode value
  return barcodes.find(b =>
    b.barcodeValue === value ||
    b.barcodeValue === value.trim()
  );
}

function applyBarcodeToLine(index, barcodeItem) {
  lineItems[index].itemName = barcodeItem.name;
  lineItems[index].price = barcodeItem.price;
  lineItems[index].barcodeId = barcodeItem.id;

  // Auto-set qty to 1 if empty
  if (!lineItems[index].qty) {
    lineItems[index].qty = '1';
  }

  // Recalculate
  const qty = parseFloat(lineItems[index].qty) || 0;
  const price = parseFloat(lineItems[index].price) || 0;
  lineItems[index].total = qty * price;
  isManualTotalOverride = false;
  renderLineItems();

  // Focus qty field so user can change quantity
  setTimeout(() => {
    const row = document.querySelector(`.line-item-row[data-index="${index}"]`);
    if (row) {
      const qtyInput = row.querySelector('.col-qty .form-input');
      if (qtyInput) { qtyInput.focus(); qtyInput.select(); }
    }
  }, 50);
}

function updateLineItem(index, field, value) {
  lineItems[index][field] = value;

  const qty = parseFloat(lineItems[index].qty) || 0;
  const price = parseFloat(lineItems[index].price) || 0;
  const total = qty * price;

  lineItems[index].total = total;
  isManualTotalOverride = false;
  const row = document.querySelector(`.line-item-row[data-index="${index}"]`);
  if (row) {
    row.querySelector('.col-total .form-input').value = fmtRaw(total);
  }

  updateBillSummary();
}

function removeLineItem(index) {
  lineItems.splice(index, 1);
  isManualTotalOverride = false;
  renderLineItems();
}

function updateBillSummary() {
  const itemsTotal = lineItems.reduce((s, i) => s + (i.total || 0), 0);
  const discountPercent = parseFloat(document.getElementById('bill-discount-percent').value) || 0;
  const discountAmount = itemsTotal * (discountPercent / 100);
  const discountedTotal = itemsTotal - discountAmount;

  let baseAmount, cgst, sgst, grandTotal;

  if (gstMode === 'including') {
    // Price already includes GST — back-calculate
    grandTotal = discountedTotal;
    baseAmount = discountedTotal / 1.05;
    cgst = baseAmount * 0.025;
    sgst = baseAmount * 0.025;
  } else {
    // Price is before GST — add on top
    baseAmount = discountedTotal;
    cgst = baseAmount * 0.025;
    sgst = baseAmount * 0.025;
    grandTotal = baseAmount + cgst + sgst;
  }

  document.getElementById('summary-subtotal').textContent = formatCurrency(baseAmount);
  document.getElementById('summary-cgst').textContent = formatCurrency(cgst);
  document.getElementById('summary-sgst').textContent = formatCurrency(sgst);
  
  const totalInput = document.getElementById('bill-grand-total-input');
  if (totalInput && !isManualTotalOverride) {
    totalInput.value = grandTotal.toFixed(2);
  }
  updatePendingAmount();
}

function updatePendingAmount() {
  const totalInput = document.getElementById('bill-grand-total-input');
  const grandTotal = totalInput ? (parseFloat(totalInput.value) || 0) : 0;
  const noTailor = document.getElementById('bill-no-tailor')?.checked;
  const tailorAmt = noTailor ? 0 : (parseFloat(document.getElementById('bill-tailor-amount')?.value) || 0);
  const totalPayable = grandTotal + tailorAmt;

  const advanceInput = document.getElementById('bill-advance-paid');
  const advance = advanceInput ? (parseFloat(advanceInput.value) || 0) : 0;
  const pending = Math.max(0, totalPayable - advance);

  const pendingEl = document.getElementById('summary-pending');
  if (pendingEl) {
    pendingEl.textContent = formatCurrency(pending);
  }
}

function toggleTailoringVisibility() {
  const container = document.getElementById('tailoring-details-container');
  const btn = document.getElementById('btn-toggle-tailoring');
  if (!container) return;
  const isHidden = container.style.display === 'none' || !container.style.display;
  container.style.display = isHidden ? 'block' : 'none';
  if (btn) {
    btn.innerHTML = isHidden ? '🔼 Collapse Tailoring Options' : '✂️ Expand Tailoring Options';
  }
}

function toggleTailoringSection(isNoTailor) {
  const container = document.getElementById('tailoring-details-container');
  const btn = document.getElementById('btn-toggle-tailoring');
  const tailorAmtEl = document.getElementById('bill-tailor-amount');
  if (isNoTailor) {
    if (container) container.style.display = 'none';
    if (btn) {
      btn.style.display = 'none';
      btn.innerHTML = '✂️ Expand Tailoring Options';
    }
    if (tailorAmtEl) {
      tailorAmtEl.value = '0.00';
      tailorAmtEl.disabled = true;
    }
  } else {
    if (btn) btn.style.display = 'block';
    if (tailorAmtEl) tailorAmtEl.disabled = false;
    calculateTailorAmount();
  }
  updatePendingAmount();
}

function addStitchingItemRow(item = { name: '', qty: 1, rate: 0 }) {
  const list = document.getElementById('stitching-items-list');
  if (!list) return;
  const rowId = 'stitch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
  const row = document.createElement('div');
  row.className = 'stitching-item-row';
  row.id = rowId;
  const initialTotal = ((parseFloat(item.qty) || 1) * (parseFloat(item.rate) || 0)).toFixed(2);
  row.innerHTML = `
    <input type="text" class="form-input input-sm stitching-name" placeholder="Garment (e.g. Kurta, Pant, Blouse)" value="${esc(item.name || '')}" oninput="calculateTailorAmount()">
    <input type="number" class="form-input input-sm stitching-qty" placeholder="Qty" min="1" step="1" value="${item.qty || 1}" oninput="updateStitchingRowTotal('${rowId}')">
    <input type="number" class="form-input input-sm stitching-rate" placeholder="Rate (₹)" min="0" step="1" value="${item.rate || ''}" oninput="updateStitchingRowTotal('${rowId}')">
    <input type="text" class="form-input input-sm stitching-total" placeholder="0.00" readonly value="${initialTotal}">
    <button type="button" class="btn btn-ghost btn-sm" onclick="removeStitchingItemRow('${rowId}')" title="Remove" style="padding:4px 8px;color:#ef4444;">✕</button>
  `;
  list.appendChild(row);
  calculateTailorAmount();
}

function updateStitchingRowTotal(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const qty = parseFloat(row.querySelector('.stitching-qty').value) || 0;
  const rate = parseFloat(row.querySelector('.stitching-rate').value) || 0;
  row.querySelector('.stitching-total').value = (qty * rate).toFixed(2);
  calculateTailorAmount();
}

function removeStitchingItemRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) row.remove();
  calculateTailorAmount();
}

function calculateTailorAmount() {
  const noTailor = document.getElementById('bill-no-tailor')?.checked;
  if (noTailor) {
    const el = document.getElementById('bill-tailor-amount');
    if (el) el.value = '0.00';
    updatePendingAmount();
    return;
  }

  let itemsSum = 0;
  document.querySelectorAll('.stitching-item-row').forEach(row => {
    const qty = parseFloat(row.querySelector('.stitching-qty').value) || 0;
    const rate = parseFloat(row.querySelector('.stitching-rate').value) || 0;
    itemsSum += (qty * rate);
  });

  const accessories = parseFloat(document.getElementById('tailor-accessories')?.value) || 0;
  const handwork = parseFloat(document.getElementById('tailor-handwork')?.value) || 0;
  const embroidery = parseFloat(document.getElementById('tailor-embroidery')?.value) || 0;
  const discountPct = parseFloat(document.getElementById('tailor-discount')?.value) || 0;
  const isPriority = document.getElementById('tailor-priority')?.checked || false;

  let baseTotal = itemsSum + accessories + handwork + embroidery;
  if (isPriority) {
    baseTotal = baseTotal * 1.15;
  }
  const discountAmt = baseTotal * (discountPct / 100);
  const finalTailor = Math.max(0, baseTotal - discountAmt);

  const tailorAmountEl = document.getElementById('bill-tailor-amount');
  if (tailorAmountEl) {
    tailorAmountEl.value = finalTailor.toFixed(2);
  }
  updatePendingAmount();
}

function setGstMode(mode) {
  gstMode = mode;
  isManualTotalOverride = false;
  document.querySelectorAll('.gst-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
  // Update label
  const label = document.getElementById('summary-subtotal-label');
  if (mode === 'including') {
    label.textContent = 'Subtotal (excl. GST)';
  } else {
    label.textContent = 'Subtotal';
  }
  updateBillSummary();
}

function setPaymentMethod(method, autoFocus = false) {
  document.getElementById('bill-payment-method').value = method;
  document.querySelectorAll('#payment-method-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-method') === method);
  });
  
  const splitFields = document.getElementById('split-payment-fields');
  if (splitFields) {
    if (method === 'Split') {
      splitFields.style.display = 'block';
    } else {
      splitFields.style.display = 'none';
    }
  }
  
  if (autoFocus) {
    setTimeout(() => {
      if (method === 'Split') {
        const sc = document.getElementById('split-cash');
        if (sc) sc.focus();
      } else {
        const dd = document.getElementById('bill-delivery-date');
        if (dd) {
          dd.focus();
          try { dd.showPicker(); } catch (e) {}
        }
      }
    }, 50);
  }
}

function calculateSplitRemaining(source) {
  const manualTotalField = document.getElementById('bill-grand-total-input');
  if (!manualTotalField) return;
  
  const grandTotal = parseFloat(manualTotalField.value) || 0;
  if (grandTotal <= 0) return;

  const cashInput = document.getElementById('split-cash');
  const phonepeInput = document.getElementById('split-phonepe');
  
  if (source === 'cash') {
    const cashVal = parseFloat(cashInput.value) || 0;
    if (cashVal <= grandTotal) {
       phonepeInput.value = (grandTotal - cashVal).toFixed(2);
    }
  } else if (source === 'phonepe') {
    const phonepeVal = parseFloat(phonepeInput.value) || 0;
    if (phonepeVal <= grandTotal) {
       cashInput.value = (grandTotal - phonepeVal).toFixed(2);
    }
  }
}

function toggleGarmentQty(checkbox) {
  const row = checkbox.closest('.outfit-item-row');
  if (!row) return;
  const qtyInput = row.querySelector('.outfit-qty');
  if (!qtyInput) return;
  if (checkbox.checked) {
    qtyInput.style.display = 'block';
    qtyInput.value = qtyInput.value || '1';
    qtyInput.focus();
  } else {
    qtyInput.style.display = 'none';
    qtyInput.value = '';
  }
}

function saveAndPrintBill(printSide = 'both') {
  const customerName = document.getElementById('bill-customer-name').value.trim();
  const phone = document.getElementById('bill-phone').value.trim();
  const email = document.getElementById('bill-email').value.trim();
  const date = document.getElementById('bill-date').value;
  const paymentMethod = document.getElementById('bill-payment-method').value;
  const orderNumber = document.getElementById('bill-order-number') ? document.getElementById('bill-order-number').value.trim() : '';
  const advancePaid = parseFloat(document.getElementById('bill-advance-paid')?.value) || 0;

  const outfitInstructions = document.getElementById('bill-outfit-instructions') ? document.getElementById('bill-outfit-instructions').value.trim() : '';
  // Collect checked garments with optional quantities
  const outfitOptions = [];
  const outfitQuantities = {};
  document.querySelectorAll('.outfit-checkbox:checked').forEach(cb => {
    outfitOptions.push(cb.value);
    const row = cb.closest('.outfit-item-row');
    const qtyInput = row ? row.querySelector('.outfit-qty') : null;
    const qty = qtyInput ? (parseInt(qtyInput.value) || 1) : 1;
    outfitQuantities[cb.value] = qty;
  });

  // Staff, event date, fabric cut
  const staffSelect = document.getElementById('bill-staff-id');
  const selectedStaffId = staffSelect ? staffSelect.value : '';
  const eventDateEl = document.getElementById('bill-event-date');
  const billEventDate = eventDateEl ? eventDateEl.value : '';
  const fabricCutEl = document.getElementById('bill-fabric-cut');
  const fabricCut = fabricCutEl ? fabricCutEl.checked : false;

  // Find staff name
  let staffName = '';
  let staffCommissionRate = 0;
  if (selectedStaffId) {
    const allStaff = getData(STORAGE_KEYS.staff);
    const staffMember = allStaff.find(s => s.id == selectedStaffId);
    if (staffMember) {
      staffName = staffMember.name;
      staffCommissionRate = parseFloat(staffMember.commissionRate) || 0;
    }
  }

  if (!paymentMethod) { showToast('Please select a Payment Method before saving', 'error'); return; }
  if (!date) { showToast('Please select a date', 'error'); return; }

  const deliveryDateInput = document.getElementById('bill-delivery-date') ? document.getElementById('bill-delivery-date').value : '';
  const noDelivery = document.getElementById('bill-no-delivery') ? document.getElementById('bill-no-delivery').checked : false;

  if (!noDelivery && !deliveryDateInput) {
    showToast('Please enter Delivery Date or select No Delivery', 'error');
    return;
  }

  const tailorAmountInput = document.getElementById('bill-tailor-amount') ? document.getElementById('bill-tailor-amount').value : '';
  const noTailor = document.getElementById('bill-no-tailor') ? document.getElementById('bill-no-tailor').checked : false;

  if (!noTailor && !tailorAmountInput) {
    showToast('Please enter Tailor Amount or select No Tailor', 'error');
    return;
  }

  // Collect Tailoring details
  const tailoringItems = [];
  document.querySelectorAll('.stitching-item-row').forEach(row => {
    const name = row.querySelector('.stitching-name')?.value.trim() || '';
    const qty = parseFloat(row.querySelector('.stitching-qty')?.value) || 1;
    const rate = parseFloat(row.querySelector('.stitching-rate')?.value) || 0;
    const total = parseFloat(row.querySelector('.stitching-total')?.value) || (qty * rate);
    if (name || rate > 0) {
      tailoringItems.push({ name, qty, rate, total });
    }
  });

  const tailorAccessories = parseFloat(document.getElementById('tailor-accessories')?.value) || 0;
  const tailorHandwork = parseFloat(document.getElementById('tailor-handwork')?.value) || 0;
  const tailorEmbroidery = parseFloat(document.getElementById('tailor-embroidery')?.value) || 0;
  const tailorDiscount = parseFloat(document.getElementById('tailor-discount')?.value) || 0;
  const tailorPriority = document.getElementById('tailor-priority')?.checked || false;

  const validItems = lineItems.filter(i => i.itemName && i.qty && i.price);
  if (validItems.length === 0) {
    showToast('Please add at least one item with name, qty, and price', 'error');
    return;
  }

  const itemsTotal = validItems.reduce((s, i) => s + i.total, 0);
  const discountPercent = parseFloat(document.getElementById('bill-discount-percent').value) || 0;
  const discountAmount = itemsTotal * (discountPercent / 100);
  const discountedTotal = itemsTotal - discountAmount;
  let subtotal, cgst, sgst, grandTotal;
  if (gstMode === 'including') {
    grandTotal = discountedTotal;
    subtotal = discountedTotal / 1.05;
    cgst = subtotal * 0.025;
    sgst = subtotal * 0.025;
  } else {
    subtotal = discountedTotal;
    cgst = subtotal * 0.025;
    sgst = subtotal * 0.025;
    grandTotal = subtotal + cgst + sgst;
  }

  const manualTotalField = document.getElementById('bill-grand-total-input');
  if (isManualTotalOverride && manualTotalField) {
    grandTotal = parseFloat(manualTotalField.value) || grandTotal;
    subtotal = grandTotal / 1.05;
    cgst = subtotal * 0.025;
    sgst = subtotal * 0.025;
  }

  let splitCash = 0;
  let splitPhonepe = 0;
  if (paymentMethod === 'Split') {
    splitCash = parseFloat(document.getElementById('split-cash').value) || 0;
    splitPhonepe = parseFloat(document.getElementById('split-phonepe').value) || 0;
    const splitTotal = splitCash + splitPhonepe;
    if (Math.abs(splitTotal - grandTotal) > 0.05) {
       showToast(`Split amounts (₹${splitTotal}) do not match Grand Total (₹${grandTotal.toFixed(2)})`, 'error');
       return;
    }
  }

  const tailorAmountNum = noTailor ? 0 : (parseFloat(tailorAmountInput) || 0);
  const totalObligation = grandTotal + tailorAmountNum;
  const totalPending = Math.max(0, totalObligation - advancePaid);

  const bills = getData(STORAGE_KEYS.bills);

  // Parse manual bill number
  let manualBillNumber;
  const manualBillStr = document.getElementById('bill-number').value.trim();
  const match = manualBillStr.match(/(\d+)/);
  if (match) manualBillNumber = parseInt(match[1]);

  if (editingBillId) {
    // UPDATE EXISTING BILL
    const index = bills.findIndex(b => b.id === editingBillId);
    if (index !== -1) {
      const oldBill = bills[index];
      const finalBillNumber = manualBillNumber || oldBill.billNumber;

      // Check for duplicates
      if (finalBillNumber !== oldBill.billNumber && bills.some(b => b.billNumber === finalBillNumber && b.id !== editingBillId)) {
        showToast(`Bill #KALP-${String(finalBillNumber).padStart(4, '0')} already exists in your records! Please use a different number or delete the old bill first.`, 'error');
        return;
      }

      // Revert old stock
      oldBill.items.forEach(item => {
        incrementStock(item.itemName, item.qty);
        incrementBarcodeStock(item.itemName, item.qty, item.barcodeId);
      });

      // Update bill object
      bills[index] = {
        ...oldBill,
        billNumber: finalBillNumber,
        date, gstMode, paymentMethod,
        orderNumber,
        advancePaid,
        totalPending,
        splitCash, splitPhonepe,
        customerName: customerName || 'Walk-in Customer', phone, email,
        deliveryDate: noDelivery ? '' : deliveryDateInput,
        noDelivery: noDelivery,
        tailorAmount: noTailor ? '' : tailorAmountInput,
        noTailor: noTailor,
        tailoringItems,
        tailorAccessories,
        tailorHandwork,
        tailorEmbroidery,
        tailorDiscount,
        tailorPriority,
        outfitInstructions: outfitInstructions,
        outfitOptions: outfitOptions,
        outfitQuantities: outfitQuantities,
        staffId: selectedStaffId,
        staffName: staffName,
        staffCommission: selectedStaffId ? parseFloat((grandTotal * staffCommissionRate / 100).toFixed(2)) : 0,
        eventDate: billEventDate,
        fabricCut: fabricCut,
        items: validItems.map(i => ({
          itemName: i.itemName, qty: parseFloat(i.qty),
          price: parseFloat(i.price), total: i.total,
          barcodeId: i.barcodeId
        })),
        itemsTotal, discountPercent, discountAmount,
        subtotal, cgst, sgst, grandTotal,
        updatedAt: new Date().toISOString()
      };

      setData(STORAGE_KEYS.bills, bills);
      saveSingleBillToCloud(bills[index]);

      // Update counter if this number is higher
      const currentCounter = getBillCounter();
      if (finalBillNumber > currentCounter) {
        localStorage.setItem(STORAGE_KEYS.billCounter, finalBillNumber.toString());
      }

      // Apply new stock
      bills[index].items.forEach(item => {
        decrementStock(item.itemName, item.qty);
        decrementBarcodeStock(item.itemName, item.qty, item.barcodeId);
      });

      // Sync with Order Ledger
      const orders = getData(STORAGE_KEYS.orders);
      let orderIdx = orders.findIndex(o => o.billId === editingBillId);
      if (orderIdx === -1) {
        orderIdx = orders.findIndex(o => o.billNumber == oldBill.billNumber || o.billNumber == ("KALP-" + oldBill.billNumber));
      }

      if (orderIdx !== -1) {
        orders[orderIdx].billId = bills[index].id; 
        orders[orderIdx].billNumber = bills[index].billNumber;
        orders[orderIdx].customerName = bills[index].customerName;
        orders[orderIdx].deliveryDate = noDelivery ? '' : deliveryDateInput;
        orders[orderIdx].tailor = tailorAmountNum;
        orders[orderIdx].fabric = parseFloat(bills[index].grandTotal) || 0;
        orders[orderIdx].total = totalObligation;
        orders[orderIdx].advance = advancePaid;
        orders[orderIdx].pending = totalPending;
        if (orderNumber) orders[orderIdx].orderNumber = orderNumber;
        
        setData(STORAGE_KEYS.orders, orders);
        if (typeof renderOrdersTable === 'function') renderOrdersTable();
      }

      showToast(`Bill #KALP-${String(oldBill.billNumber).padStart(4, '0')} updated!`, 'success');
      printProfessionalBill(bills[index], printSide);
      resetBillForm();
    }
  } else {
    // CREATE NEW BILL
    let finalBillNumber;
    if (manualBillNumber) {
      finalBillNumber = manualBillNumber;
      if (bills.some(b => b.billNumber === finalBillNumber)) {
        showToast(`Bill #KALP-${String(finalBillNumber).padStart(4, '0')} already exists in your records! Please use a different number or delete the old bill first.`, 'error');
        return;
      }
      const currentCounter = getBillCounter();
      if (finalBillNumber > currentCounter) {
        localStorage.setItem(STORAGE_KEYS.billCounter, finalBillNumber.toString());
      }
    } else {
      finalBillNumber = incrementBillCounter();
    }

    const bill = {
      id: Date.now(), billNumber: finalBillNumber, date, gstMode, paymentMethod,
      orderNumber,
      advancePaid,
      totalPending,
      splitCash, splitPhonepe,
      customerName: customerName || 'Walk-in Customer', phone, email,
      deliveryDate: noDelivery ? '' : deliveryDateInput,
      noDelivery: noDelivery,
      tailorAmount: noTailor ? '' : tailorAmountInput,
      noTailor: noTailor,
      tailoringItems,
      tailorAccessories,
      tailorHandwork,
      tailorEmbroidery,
      tailorDiscount,
      tailorPriority,
      outfitInstructions: outfitInstructions,
      outfitOptions: outfitOptions,
      outfitQuantities: outfitQuantities,
      staffId: selectedStaffId,
      staffName: staffName,
      staffCommission: selectedStaffId ? parseFloat((grandTotal * staffCommissionRate / 100).toFixed(2)) : 0,
      eventDate: billEventDate,
      fabricCut: fabricCut,
      items: validItems.map(i => ({
        itemName: i.itemName, qty: parseFloat(i.qty),
        price: parseFloat(i.price), total: i.total,
        barcodeId: i.barcodeId
      })),
      itemsTotal, discountPercent, discountAmount,
      subtotal, cgst, sgst, grandTotal,
      createdAt: new Date().toISOString()
    };

    bills.push(bill);
    setData(STORAGE_KEYS.bills, bills);
    saveSingleBillToCloud(bill);

    bill.items.forEach(item => {
      decrementStock(item.itemName, item.qty);
      decrementBarcodeStock(item.itemName, item.qty, item.barcodeId);
    });

    // Create entry in Order Ledger
    const orders = getData(STORAGE_KEYS.orders);
    orders.push({
      id: Date.now() + Math.random(),
      billId: bill.id,
      billNumber: bill.billNumber,
      orderNumber: orderNumber || '',
      customerName: bill.customerName,
      fabric: bill.grandTotal,
      tailor: tailorAmountNum,
      deliveryDate: noDelivery ? '' : deliveryDateInput,
      advance: advancePaid,
      total: totalObligation,
      pending: totalPending
    });
    setData(STORAGE_KEYS.orders, orders);
    if (typeof renderOrdersTable === 'function') renderOrdersTable();

    showToast(`Bill #KALP-${String(finalBillNumber).padStart(4, '0')} saved!`, 'success');
    printProfessionalBill(bill, printSide);
    resetBillForm();
  }
}

function renderFrontBillPageHTML(bill, shop) {
  const dateStr = formatDate(bill.date);
  const billNo = String(bill.billNumber);
  const shopName = shop.name || 'KALP';
  const addrStr = shop.address ? esc(shop.address).replace(/\n/g, '<br>') : '';
  const gstinStr = shop.gstin ? esc(shop.gstin) : '';
  const shopPhone = shop.phone ? esc(shop.phone) : '';
  const shopEmail = shop.email ? esc(shop.email) : '';

  let logoHTML = '';
  const currentLogo = (shop.logo !== 'none' && shop.logo !== false) ? (shop.logo || 'image.png') : '';
  if (currentLogo) {
    logoHTML = `<img src="${currentLogo}" style="max-height:48px;max-width:110px;margin-bottom:3px;border-radius:4px;object-fit:contain;">`;
  }

  const totalQty = bill.items.reduce((s, i) => s + i.qty, 0);
  const roundedGrand = Math.round(bill.grandTotal);
  const roundOff = roundedGrand - bill.grandTotal;

  const itemRows = bill.items.map((item, i) => {
    return `<tr>
      <td class="bc br ta-c">${i + 1}</td>
      <td class="bc br" style="text-align:left;font-weight:500;">${esc(item.itemName.toUpperCase())}</td>
      <td class="bc br ta-r">${fmtQty(item.qty)}</td>
      <td class="bc br ta-r">${item.price.toFixed(2)}</td>
      <td class="bc ta-r" style="font-weight:600;">${item.total.toFixed(2)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="kb print-front-page">
      <div class="bill-professional-watermark">KALP</div>
      
      <!-- Header Content -->
      <div style="text-align:center;padding:8px 10px 6px;border-bottom:2px solid #000;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
          <div style="font-size:9px;font-weight:bold;text-decoration:underline;width:60px;text-align:left;">CASH BILL</div>
          <div style="text-align:center;flex:1;">
            ${logoHTML}
            <div style="font-size:20px;font-weight:900;letter-spacing:2px;">${esc(shopName)}</div>
            ${addrStr ? `<div style="font-size:10px;margin-top:1px;">${addrStr}</div>` : ''}
            ${shopPhone ? `<div style="font-size:10px;">Ph: ${shopPhone}${shopEmail ? ' &nbsp;|&nbsp; ' + shopEmail : ''}</div>` : ''}
            ${gstinStr ? `<div style="font-size:10px;font-weight:600;margin-top:1px;">GSTIN: ${gstinStr}</div>` : ''}
          </div>
          <div style="display:flex; flex-direction:column; align-items:flex-end; width:60px;">
            <div style="font-size:9px;font-weight:bold;margin-bottom:4px;">GST INVOICE</div>
            ${shop.qrCode ? `<img src="${shop.qrCode}" style="width:50px;height:50px;object-fit:contain;" alt="QR Code">` : ''}
          </div>
        </div>
      </div>

      <!-- Customer + Bill Info -->
      <div style="display:flex;border-bottom:2px solid #000;">
        <div style="flex:1;padding:5px 8px;border-right:1px solid #000;font-size:11px;">
          <div style="color:#555;font-size:9px;text-transform:uppercase;letter-spacing:0.5px;">Customer</div>
          <div style="font-weight:700;font-size:12px;margin-top:1px;">${esc(bill.customerName)}</div>
          ${bill.phone ? `<div style="margin-top:1px;">Ph: ${esc(bill.phone)}</div>` : ''}
          ${bill.email ? `<div>${esc(bill.email)}</div>` : ''}
        </div>
        <div style="width:160px;padding:5px 8px;font-size:11px;">
          <div><span style="color:#555;">Bill No:</span> <strong>${billNo}</strong></div>
          ${bill.orderNumber ? `<div style="margin-top:2px;"><span style="color:#555;">Order No:</span> <strong>${esc(bill.orderNumber)}</strong></div>` : ''}
          <div style="margin-top:2px;"><span style="color:#555;">Date:</span> <strong>${dateStr}</strong></div>
          ${bill.noDelivery || !bill.deliveryDate ? '' : `<div style="margin-top:2px;"><span style="color:#555;">Delivery:</span> <strong>${formatDate(bill.deliveryDate)}</strong></div>`}
        </div>
      </div>

      <!-- Items Table -->
      <table>
        <thead>
          <tr style="background:#f5f5f5;border-bottom:2px solid #000;">
            <th class="bc br" style="width:6%;text-align:center;">SN</th>
            <th class="bc br" style="width:42%;text-align:left;">PARTICULARS</th>
            <th class="bc br" style="width:10%;text-align:right;">Mts</th>
            <th class="bc br" style="width:20%;text-align:right;">Rate (₹)</th>
            <th class="bc" style="width:22%;text-align:right;">Total (₹)</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
        <tfoot>
          <tr style="border-top:2px solid #000;font-weight:700;background:#f9f9f9;">
            <td class="bc br" colspan="2" style="text-align:right;padding-right:6px;">TOTAL ITEMS/MTS</td>
            <td class="bc br ta-r">${fmtQty(totalQty)}</td>
            <td class="bc br"></td>
            <td class="bc ta-r">${(bill.itemsTotal || bill.subtotal).toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>

      ${bill.outfitInstructions || (bill.outfitOptions && bill.outfitOptions.length > 0) ? `
      <!-- Outfit Details -->
      <div style="padding:5px 8px;border-top:2px solid #000;font-size:10px;">
        <div style="font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Outfit Details & Instructions</div>
        ${bill.outfitOptions && bill.outfitOptions.length > 0 ? `<div style="margin-bottom:2px;"><strong>Garments:</strong> ${bill.outfitOptions.map(g => { const q = (bill.outfitQuantities && bill.outfitQuantities[g]) || 1; return q > 1 ? `${g} x${q}` : g; }).join(', ')}</div>` : ''}
        ${bill.outfitInstructions ? `<div><strong>Instructions:</strong> ${esc(bill.outfitInstructions).replace(/\n/g, '<br>')}</div>` : ''}
      </div>` : ''}

      <!-- Tax + Payment Summary side by side -->
      <div style="display:flex;border-top:2px solid #000;">
        <!-- Left: Tax Breakdown -->
        <div style="flex:1;border-right:2px solid #000;padding:0;">
          <div style="font-weight:700;font-size:10px;padding:4px 6px;border-bottom:1px solid #000;background:#f5f5f5;text-transform:uppercase;letter-spacing:0.5px;">Tax Breakdown</div>
          <table style="font-size:10px;">
            <thead>
              <tr style="border-bottom:1px solid #000;background:#f9f9f9;">
                <th style="padding:3px 5px;border-right:1px solid #ccc;text-align:left;">Description</th>
                <th style="padding:3px 5px;border-right:1px solid #ccc;text-align:left;">Taxable Value</th>
                <th style="padding:3px 5px;border-right:1px solid #ccc;text-align:center;">Rate</th>
                <th style="padding:3px 5px;text-align:right;">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="padding:3px 5px;border-right:1px solid #ccc;">CGST</td>
                <td style="padding:3px 5px;border-right:1px solid #ccc;text-align:right;">${bill.subtotal.toFixed(2)}</td>
                <td style="padding:3px 5px;border-right:1px solid #ccc;text-align:center;">2.50%</td>
                <td style="padding:3px 5px;text-align:right;">${bill.cgst.toFixed(2)}</td>
              </tr>
              <tr style="border-top:1px solid #eee;">
                <td style="padding:3px 5px;border-right:1px solid #ccc;">SGST</td>
                <td style="padding:3px 5px;border-right:1px solid #ccc;text-align:right;">${bill.subtotal.toFixed(2)}</td>
                <td style="padding:3px 5px;border-right:1px solid #ccc;text-align:center;">2.50%</td>
                <td style="padding:3px 5px;text-align:right;">${bill.sgst.toFixed(2)}</td>
              </tr>
              <tr style="border-top:1px solid #000;font-weight:700;background:#f5f5f5;">
                <td colspan="3" style="padding:3px 5px;border-right:1px solid #ccc;">Total Tax</td>
                <td style="padding:3px 5px;text-align:right;">${(bill.cgst + bill.sgst).toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Right: Payment Summary -->
        <div style="width:240px;padding:0;">
          <div style="font-weight:700;font-size:10px;padding:4px 6px;border-bottom:1px solid #000;background:#f5f5f5;text-transform:uppercase;letter-spacing:0.5px;">Payment Summary</div>
          <table style="font-size:11px;">
            <tr>
              <td style="padding:3px 6px;">Gross Total</td>
              <td style="padding:3px 6px;text-align:right;">${(bill.itemsTotal || bill.subtotal).toFixed(2)}</td>
            </tr>
            ${bill.discountAmount > 0 ? `<tr style="border-top:1px solid #eee; background:#fff9c4; font-weight:700;">
              <td style="padding:3px 6px;">Discount (${bill.discountPercent}%)</td>
              <td style="padding:3px 6px;text-align:right;">-${bill.discountAmount.toFixed(2)}</td>
            </tr>` : ''}
            <tr style="border-top:1px solid #eee;">
              <td style="padding:3px 6px;">Taxable Subtotal</td>
              <td style="padding:3px 6px;text-align:right;">${bill.subtotal.toFixed(2)}</td>
            </tr>
            <tr style="border-top:1px solid #eee;">
              <td style="padding:3px 6px;">CGST (2.5%)</td>
              <td style="padding:3px 6px;text-align:right;">${bill.cgst.toFixed(2)}</td>
            </tr>
            <tr style="border-top:1px solid #eee;">
              <td style="padding:3px 6px;">SGST (2.5%)</td>
              <td style="padding:3px 6px;text-align:right;">${bill.sgst.toFixed(2)}</td>
            </tr>
            ${roundOff !== 0 ? `<tr style="border-top:1px solid #eee;">
              <td style="padding:3px 6px;font-size:10px;color:#555;">Round Off</td>
              <td style="padding:3px 6px;text-align:right;font-size:10px;">${roundOff >= 0 ? '+' : ''}${roundOff.toFixed(2)}</td>
            </tr>` : ''}
            <tr style="border-top:2px solid #000; background:#000; color:#fff; font-size:14px; font-weight:900;">
              <td style="padding:6px 6px;">GRAND TOTAL</td>
              <td style="padding:6px 6px;text-align:right;">₹${roundedGrand.toFixed(2)}</td>
            </tr>
            ${(parseFloat(bill.tailorAmount) > 0) ? `
            <tr style="border-top:1px solid #eee; font-size:10px;">
              <td style="padding:2px 6px;">Tailoring Charges</td>
              <td style="padding:2px 6px;text-align:right;">₹${(parseFloat(bill.tailorAmount) || 0).toFixed(2)}</td>
            </tr>
            <tr style="border-top:1px solid #eee; font-size:10px; font-weight:600;">
              <td style="padding:2px 6px;">Total Obligation</td>
              <td style="padding:2px 6px;text-align:right;">₹${(roundedGrand + (parseFloat(bill.tailorAmount) || 0)).toFixed(2)}</td>
            </tr>` : ''}
            ${(bill.advancePaid > 0) ? `
            <tr style="border-top:1px solid #eee; font-size:10px; color:#15803d; font-weight:600;">
              <td style="padding:2px 6px;">Advance Paid</td>
              <td style="padding:2px 6px;text-align:right;">₹${parseFloat(bill.advancePaid).toFixed(2)}</td>
            </tr>` : ''}
            ${(bill.totalPending > 0) ? `
            <tr style="border-top:1px solid #eee; font-size:10px; color:#b91c1c; font-weight:700;">
              <td style="padding:2px 6px;">Balance Due</td>
              <td style="padding:2px 6px;text-align:right;">₹${parseFloat(bill.totalPending).toFixed(2)}</td>
            </tr>` : ''}
            <tr style="border-top:1px solid #000;">
              <td style="padding:3px 6px;font-size:10px;color:#555;">Payment Mode</td>
              <td style="padding:3px 6px;text-align:right;font-weight:700;">
                ${bill.paymentMethod === 'Split' ? `Cash: ₹${bill.splitCash} <br> PhonePe: ₹${bill.splitPhonepe}` : (bill.paymentMethod || 'Cash')}
              </td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Footer -->
      <div style="display:flex;border-top:2px solid #000;">
        <div style="flex:1;padding:6px 8px;border-right:1px solid #000;font-size:9px;">
          <div style="font-weight:700;text-decoration:underline;margin-bottom:2px;">Terms & Conditions</div>
          <div>1. Goods once sold will not be taken back or exchanged.</div>
          <div>2. Subject to local jurisdiction.</div>
        </div>
        <div style="width:220px;padding:6px 8px;text-align:right;font-size:10px;">
          <div style="font-weight:700;">For ${esc(shopName)}</div>
          <div style="margin-top:30px;border-top:1px solid #000;padding-top:3px;">Authorised Signatory</div>
        </div>
      </div>

      <!-- Computer generated -->
      <div style="text-align:center;border-top:1px solid #000;padding:3px;font-size:9px;font-weight:600;background:#f9f9f9;">
        This is a computer generated invoice
      </div>
    </div>
  `;
}

function renderBackBillPageHTML(bill, shop) {
  const shopName = shop.name || 'KALP';
  const billNo = String(bill.billNumber);
  const dateStr = formatDate(bill.date);
  const deliveryStr = bill.deliveryDate ? formatDate(bill.deliveryDate) : 'Not specified';
  const orderNo = bill.orderNumber || `KALP-${billNo}`;
  const tailorItems = Array.isArray(bill.tailoringItems) && bill.tailoringItems.length > 0
    ? bill.tailoringItems
    : [];

  const tailorRows = tailorItems.length > 0 ? tailorItems.map((item, idx) => `
    <tr>
      <td class="bc br ta-c">${idx + 1}</td>
      <td class="bc br" style="text-align:left;font-weight:500;">${esc(item.name || 'Custom Stitching')}</td>
      <td class="bc br ta-r">${item.qty || 1}</td>
      <td class="bc br ta-r">${(parseFloat(item.rate) || 0).toFixed(2)}</td>
      <td class="bc ta-r" style="font-weight:600;">${(parseFloat(item.total) || 0).toFixed(2)}</td>
    </tr>
  `).join('') : `
    <tr>
      <td class="bc br ta-c">1</td>
      <td class="bc br" style="text-align:left;">Tailoring / Alteration Services</td>
      <td class="bc br ta-r">1</td>
      <td class="bc br ta-r">${(parseFloat(bill.tailorAmount) || 0).toFixed(2)}</td>
      <td class="bc ta-r" style="font-weight:600;">${(parseFloat(bill.tailorAmount) || 0).toFixed(2)}</td>
    </tr>
  `;

  const garmentsList = (bill.outfitOptions && bill.outfitOptions.length > 0)
    ? bill.outfitOptions.map(g => {
        const q = (bill.outfitQuantities && bill.outfitQuantities[g]) || 1;
        return q > 1 ? `${g} (x${q})` : g;
      }).join(', ')
    : 'None specified';

  return `
    <div class="kb print-back-page">
      <div class="bill-professional-watermark">KALP</div>
      
      <!-- Header -->
      <div style="text-align:center;padding:8px 10px 6px;border-bottom:2px solid #000;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:9px;font-weight:bold;text-decoration:underline;width:80px;text-align:left;">WORK ORDER</div>
          <div style="text-align:center;flex:1;">
            <div style="font-size:18px;font-weight:900;letter-spacing:2px;">${esc(shopName)} - TAILORING SLIP</div>
            <div style="font-size:10px;margin-top:1px;">Production Job Card &amp; Measurement Record</div>
          </div>
          <div style="width:80px;text-align:right;font-size:9px;font-weight:bold;">SIDE 2 (BACK)</div>
        </div>
      </div>

      <!-- Customer & Job Info -->
      <div style="display:flex;border-bottom:2px solid #000;">
        <div style="flex:1;padding:5px 8px;border-right:1px solid #000;font-size:11px;">
          <div><span style="color:#555;">Customer:</span> <strong>${esc(bill.customerName)}</strong></div>
          ${bill.phone ? `<div style="margin-top:2px;"><span style="color:#555;">Phone:</span> <strong>${esc(bill.phone)}</strong></div>` : ''}
          ${bill.staffName ? `<div style="margin-top:2px;"><span style="color:#555;">Stylist/Staff:</span> <strong>${esc(bill.staffName)}</strong></div>` : ''}
        </div>
        <div style="width:200px;padding:5px 8px;font-size:11px;">
          <div><span style="color:#555;">Bill No:</span> <strong>#KALP-${String(billNo).padStart(4, '0')}</strong></div>
          <div><span style="color:#555;">Order / Job No:</span> <strong>${esc(orderNo)}</strong></div>
          <div><span style="color:#555;">Order Date:</span> <strong>${dateStr}</strong></div>
          <div style="margin-top:2px;color:#b91c1c;font-weight:700;"><span style="color:#555;">Delivery Due:</span> ${deliveryStr}</div>
        </div>
      </div>

      <!-- Selected Garments -->
      <div style="padding:6px 8px;border-bottom:1px solid #000;background:#f9f9f9;font-size:11px;">
        <strong>Garments for Tailoring:</strong> ${garmentsList}
      </div>

      <!-- Tailoring Items Table -->
      <table>
        <thead>
          <tr style="background:#f5f5f5;border-bottom:2px solid #000;">
            <th class="bc br" style="width:6%;text-align:center;">SN</th>
            <th class="bc br" style="width:46%;text-align:left;">TAILORING / WORK DESCRIPTION</th>
            <th class="bc br" style="width:12%;text-align:right;">Qty</th>
            <th class="bc br" style="width:16%;text-align:right;">Rate (₹)</th>
            <th class="bc" style="width:20%;text-align:right;">Total (₹)</th>
          </tr>
        </thead>
        <tbody>
          ${tailorRows}
        </tbody>
      </table>

      <!-- Tailoring Addons & Breakdown -->
      <div style="display:flex;border-top:2px solid #000;">
        <div style="flex:1;border-right:2px solid #000;padding:6px 8px;font-size:10px;">
          <div style="font-weight:700;text-transform:uppercase;margin-bottom:4px;letter-spacing:0.5px;">Outfit Instructions &amp; Measurements:</div>
          <div style="min-height:55px;font-size:10px;line-height:1.4;white-space:pre-wrap;">${bill.outfitInstructions ? esc(bill.outfitInstructions) : 'As per standard store measurements and trial.'}</div>
          <div style="margin-top:8px;display:flex;gap:12px;font-size:10px;">
            <div>Accessories: ₹${(parseFloat(bill.tailorAccessories) || 0).toFixed(2)}</div>
            <div>Handwork: ₹${(parseFloat(bill.tailorHandwork) || 0).toFixed(2)}</div>
            <div>Embroidery: ₹${(parseFloat(bill.tailorEmbroidery) || 0).toFixed(2)}</div>
            ${bill.tailorPriority ? '<div style="color:#b91c1c;font-weight:700;">⚡ Priority Express (+15%)</div>' : ''}
          </div>
        </div>
        <div style="width:240px;padding:0;">
          <table style="font-size:11px;">
            <tr>
              <td style="padding:3px 6px;">Fabric Bill Amount</td>
              <td style="padding:3px 6px;text-align:right;">₹${(parseFloat(bill.grandTotal) || 0).toFixed(2)}</td>
            </tr>
            <tr style="border-top:1px solid #eee;">
              <td style="padding:3px 6px;">Total Tailoring</td>
              <td style="padding:3px 6px;text-align:right;">₹${(parseFloat(bill.tailorAmount) || 0).toFixed(2)}</td>
            </tr>
            <tr style="border-top:1px solid #000;font-weight:700;background:#f5f5f5;">
              <td style="padding:3px 6px;">Total Obligation</td>
              <td style="padding:3px 6px;text-align:right;">₹${((parseFloat(bill.grandTotal) || 0) + (parseFloat(bill.tailorAmount) || 0)).toFixed(2)}</td>
            </tr>
            <tr style="border-top:1px solid #eee;color:#15803d;font-weight:600;">
              <td style="padding:3px 6px;">Advance Received</td>
              <td style="padding:3px 6px;text-align:right;">-₹${(parseFloat(bill.advancePaid) || 0).toFixed(2)}</td>
            </tr>
            <tr style="border-top:2px solid #000;background:#000;color:#fff;font-size:13px;font-weight:900;">
              <td style="padding:5px 6px;">BALANCE DUE</td>
              <td style="padding:5px 6px;text-align:right;">₹${(parseFloat(bill.totalPending) || 0).toFixed(2)}</td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Signatures -->
      <div style="display:flex;border-top:2px solid #000;padding:12px 10px 8px;">
        <div style="flex:1;font-size:10px;">
          <div style="margin-top:25px;border-top:1px solid #000;width:70%;padding-top:2px;">Customer Signature &amp; Acceptance</div>
        </div>
        <div style="flex:1;text-align:center;font-size:10px;">
          <div style="margin-top:25px;border-top:1px solid #000;width:70%;margin-left:auto;margin-right:auto;padding-top:2px;">Master Tailor Check</div>
        </div>
        <div style="width:180px;text-align:right;font-size:10px;">
          <div style="margin-top:25px;border-top:1px solid #000;padding-top:2px;">Store Authorised Signatory</div>
        </div>
      </div>

      <div style="text-align:center;border-top:1px solid #000;padding:3px;font-size:9px;font-weight:600;background:#f9f9f9;">
        Please bring this work order slip at the time of trial &amp; delivery.
      </div>
    </div>
  `;
}

function printProfessionalBill(bill, printSide = 'both') {
  const shop = getShopDetails();
  const printArea = document.getElementById('bill-professional-print');
  if (!printArea) return;

  const styleTag = `
    <style>
      .kb { position: relative; font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 11px; line-height: 1.35; max-width: 680px; margin: 0 auto; border: 2px solid #000; background: transparent; z-index: 2; margin-top: 10px; min-height: 200px; }
      .kb .bc { padding: 3px 5px; border-bottom: 1px solid #ccc; }
      .kb .br { border-right: 1px solid #ccc; }
      .kb .ta-r { text-align: right; }
      .kb .ta-c { text-align: center; }
      .kb table { width: 100%; border-collapse: collapse; }
      .bill-professional-watermark {
        position: absolute; 
        top: 100mm;
        left: 50%;
        transform: translate(-50%, -50%) rotate(-30deg);
        font-size: 115px;
        font-weight: 900;
        color: #000 !important;
        opacity: 0.08;
        z-index: 9999;
        pointer-events: none;
        white-space: nowrap;
        text-transform: uppercase;
        letter-spacing: 12px;
      }
      .print-page-break {
        page-break-after: always;
        break-after: page;
        height: 0;
        margin: 0;
        padding: 0;
      }
    </style>
  `;

  let contentHTML = '';
  if (printSide === 1 || printSide === 'front') {
    contentHTML = styleTag + renderFrontBillPageHTML(bill, shop);
  } else if (printSide === 2 || printSide === 'back') {
    contentHTML = styleTag + renderBackBillPageHTML(bill, shop);
  } else {
    contentHTML = styleTag + renderFrontBillPageHTML(bill, shop) + '<div class="print-page-break"></div>' + renderBackBillPageHTML(bill, shop);
  }

  printArea.innerHTML = contentHTML;
  document.body.classList.add('printing-bill');

  const images = printArea.querySelectorAll('img');
  let loadedCount = 0;

  const doPrint = () => {
    setTimeout(() => {
      window.print();
      document.body.classList.remove('printing-bill');
      printArea.innerHTML = '';
    }, 150);
  };

  if (images.length > 0) {
    const checkAllLoaded = () => {
      loadedCount++;
      if (loadedCount >= images.length) doPrint();
    };
    images.forEach(img => {
      if (img.complete) {
        checkAllLoaded();
      } else {
        img.onload = checkAllLoaded;
        img.onerror = checkAllLoaded;
      }
    });
  } else {
    doPrint();
  }
}

function resetBillForm() {
  editingBillId = null;
  document.getElementById('bill-customer-name').value = '';
  document.getElementById('bill-phone').value = '';
  document.getElementById('bill-email').value = '';
  document.getElementById('bill-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('bill-number').value = `KALP-${String(getBillCounter() + 1).padStart(4, '0')}`;
  if (document.getElementById('bill-order-number')) document.getElementById('bill-order-number').value = '';
  if (document.getElementById('bill-advance-paid')) document.getElementById('bill-advance-paid').value = '';
  document.getElementById('bill-discount-percent').value = '';
  document.getElementById('bill-payment-method').value = '';
  document.querySelectorAll('#payment-method-toggle button').forEach(btn => btn.classList.remove('active'));
  const splitFields = document.getElementById('split-payment-fields');
  if (splitFields) splitFields.style.display = 'none';
  const noDeliveryCb = document.getElementById('bill-no-delivery');
  const deliveryDateEl = document.getElementById('bill-delivery-date');
  if (noDeliveryCb) noDeliveryCb.checked = false;
  if (deliveryDateEl) {
    deliveryDateEl.disabled = false;
    deliveryDateEl.value = '';
  }

  const noTailorCb = document.getElementById('bill-no-tailor');
  const tailorAmountEl = document.getElementById('bill-tailor-amount');
  if (noTailorCb) noTailorCb.checked = false;
  if (tailorAmountEl) {
    tailorAmountEl.disabled = false;
    tailorAmountEl.value = '';
  }

  // Clear Stitching Items and Tailoring Addons
  const stitchingList = document.getElementById('stitching-items-list');
  if (stitchingList) stitchingList.innerHTML = '';
  if (document.getElementById('tailor-accessories')) document.getElementById('tailor-accessories').value = '';
  if (document.getElementById('tailor-handwork')) document.getElementById('tailor-handwork').value = '';
  if (document.getElementById('tailor-embroidery')) document.getElementById('tailor-embroidery').value = '';
  if (document.getElementById('tailor-discount')) document.getElementById('tailor-discount').value = '';
  if (document.getElementById('tailor-priority')) document.getElementById('tailor-priority').checked = false;

  const tailoringContainer = document.getElementById('tailoring-details-container');
  if (tailoringContainer) tailoringContainer.style.display = 'none';
  const toggleTailorBtn = document.getElementById('btn-toggle-tailoring');
  if (toggleTailorBtn) {
    toggleTailorBtn.innerHTML = '✂️ Expand Tailoring Options';
    toggleTailorBtn.style.display = 'block';
  }

  const instructionsEl = document.getElementById('bill-outfit-instructions');
  if (instructionsEl) instructionsEl.value = '';
  document.querySelectorAll('.outfit-checkbox').forEach(cb => {
    cb.checked = false;
    const row = cb.closest('.outfit-item-row');
    const qtyInput = row ? row.querySelector('.outfit-qty') : null;
    if (qtyInput) { qtyInput.style.display = 'none'; qtyInput.value = ''; }
  });

  const staffSel = document.getElementById('bill-staff-id');
  if (staffSel) staffSel.value = '';
  const evDateEl = document.getElementById('bill-event-date');
  if (evDateEl) evDateEl.value = '';
  const fabCutEl = document.getElementById('bill-fabric-cut');
  if (fabCutEl) fabCutEl.checked = false;

  lineItems = [];
  addLineItem();
  isManualTotalOverride = false;

  const saveBtn = document.getElementById('btn-save-print-bill');
  if (saveBtn) {
    saveBtn.innerHTML = '💾 Save &amp; Print All';
    saveBtn.classList.replace('btn-secondary', 'btn-primary');
  }

  updatePendingAmount();
  showToast('Form cleared', 'success');
}

function incrementStock(itemName, qty) {
  const inv = getData(STORAGE_KEYS.inventory);
  const item = inv.find(i => i.name.toLowerCase() === itemName.toLowerCase());
  if (item) {
    item.stock = (parseFloat(item.stock) || 0) + qty;
    setData(STORAGE_KEYS.inventory, inv);
  }
}

function incrementBarcodeStock(itemName, qty, barcodeId) {
  const barcodes = getData(STORAGE_KEYS.barcodes);
  let item = null;
  if (barcodeId) {
    item = barcodes.find(b => b.id === barcodeId);
  } else {
    item = barcodes.find(b => b.name.toLowerCase() === itemName.toLowerCase());
  }
  if (item) {
    item.stock = (parseFloat(item.stock) || 0) + qty;
    setData(STORAGE_KEYS.barcodes, barcodes);
  }
}

function decrementStock(itemName, qty) {
  const inv = getData(STORAGE_KEYS.inventory);
  const item = inv.find(i => i.name.toLowerCase() === itemName.toLowerCase());
  if (item) {
    item.stock = Math.max((item.stock || 0) - qty, 0);
    setData(STORAGE_KEYS.inventory, inv);
  }
}

function decrementBarcodeStock(itemName, qty, barcodeId) {
  const barcodes = getData(STORAGE_KEYS.barcodes);
  let item = null;
  if (barcodeId) {
    item = barcodes.find(b => b.id === barcodeId);
  } else {
    item = barcodes.find(b => b.name.toLowerCase() === itemName.toLowerCase());
  }
  if (item) {
    item.stock = Math.max((parseFloat(item.stock) || 0) - qty, 0);
    setData(STORAGE_KEYS.barcodes, barcodes);
  }
}


// ===================================================================
// INVENTORY
// ===================================================================

function renderInventoryTable(filter = '') {
  const inventory = getData(STORAGE_KEYS.inventory);
  const body = document.getElementById('inventory-body');
  let filtered = inventory;
  if (filter) {
    const lf = filter.toLowerCase();
    filtered = inventory.filter(i =>
      i.name.toLowerCase().includes(lf) || (i.category || '').toLowerCase().includes(lf)
    );
  }

  if (filtered.length === 0) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state">
      <div class="empty-icon">📦</div>
      <div class="empty-text">${filter ? 'No items match your search' : 'No items in inventory'}</div>
      <div class="empty-sub">${filter ? 'Try a different search term' : 'Add your first item to get started'}</div>
    </div></td></tr>`;
    return;
  }

  body.innerHTML = filtered.map((item, idx) => {
    const low = item.stock <= 5;
    const badge = item.stock === 0
      ? '<span class="badge badge-danger">Out of Stock</span>'
      : low ? '<span class="badge badge-warning">Low Stock</span>'
      : '<span class="badge badge-success">In Stock</span>';
    return `<tr>
      <td style="color:var(--text-muted)">${idx + 1}</td>
      <td style="font-weight:600">${esc(item.name)}</td>
      <td>${esc(item.category || '-')}</td>
      <td style="font-weight:600">${formatCurrency(item.price)}</td>
      <td class="${low ? 'low-stock' : ''}">${fmtQty(item.stock)} Mts</td>
      <td>${badge}</td>
      <td>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-secondary btn-sm" onclick="editInventoryItem('${item.id}')">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteInventoryItem('${item.id}')">🗑️</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function filterInventory() {
  renderInventoryTable(document.getElementById('inventory-search').value);
}

function openInventoryModal(editId = null) {
  const modal = document.getElementById('inventory-modal');
  const title = document.getElementById('modal-title');
  const saveBtn = document.getElementById('modal-save-btn');

  if (editId) {
    const inv = getData(STORAGE_KEYS.inventory);
    const item = inv.find(i => i.id === editId);
    if (item) {
      document.getElementById('edit-item-id').value = item.id;
      document.getElementById('modal-item-name').value = item.name;
      document.getElementById('modal-item-category').value = item.category || '';
      document.getElementById('modal-item-price').value = item.price;
      document.getElementById('modal-item-stock').value = item.stock;
      title.textContent = 'Edit Item';
      saveBtn.textContent = 'Update Item';
    }
  } else {
    document.getElementById('edit-item-id').value = '';
    document.getElementById('modal-item-name').value = '';
    document.getElementById('modal-item-category').value = '';
    document.getElementById('modal-item-price').value = '';
    document.getElementById('modal-item-stock').value = '';
    title.textContent = 'Add New Item';
    saveBtn.textContent = 'Add Item';
  }

  modal.classList.add('active');
}

function closeInventoryModal() {
  document.getElementById('inventory-modal').classList.remove('active');
}

function saveInventoryItem() {
  const name = document.getElementById('modal-item-name').value.trim();
  const category = document.getElementById('modal-item-category').value.trim();
  const price = parseFloat(document.getElementById('modal-item-price').value) || 0;
  const stock = parseFloat(document.getElementById('modal-item-stock').value) || 0;
  const editId = document.getElementById('edit-item-id').value;

  if (!name) { showToast('Please enter an item name', 'error'); return; }
  if (price <= 0) { showToast('Please enter a valid price', 'error'); return; }

  const inventory = getData(STORAGE_KEYS.inventory);

  if (editId) {
    const idx = inventory.findIndex(i => i.id === editId);
    if (idx !== -1) {
      inventory[idx].name = name;
      inventory[idx].category = category;
      inventory[idx].price = price;
      inventory[idx].stock = stock;
      showToast(`"${name}" updated successfully!`, 'success');
    }
  } else {
    inventory.push({ id: Date.now().toString(), name, category, price, stock, createdAt: new Date().toISOString() });
    showToast(`"${name}" added to inventory!`, 'success');
  }

  setData(STORAGE_KEYS.inventory, inventory);
  closeInventoryModal();
  renderInventoryTable();
}

function editInventoryItem(id) { openInventoryModal(id); }

function deleteInventoryItem(id) {
  if (!confirm('Are you sure you want to delete this item?')) return;
  const inv = getData(STORAGE_KEYS.inventory);
  const item = inv.find(i => i.id === id);
  setData(STORAGE_KEYS.inventory, inv.filter(i => i.id !== id));
  renderInventoryTable();
  showToast(`"${item?.name || 'Item'}" deleted`, 'warning');
}


// ===================================================================
// BARCODES
// ===================================================================

let lastGeneratedBarcode = null;

function generateBarcode() {
  const name = document.getElementById('barcode-item-name').value.trim();
  const supplierName = document.getElementById('barcode-supplier-name') ? document.getElementById('barcode-supplier-name').value.trim() : '';
  const fabricCode = document.getElementById('barcode-fabric-code') ? document.getElementById('barcode-fabric-code').value.trim() : '';
  const price = parseFloat(document.getElementById('barcode-item-price').value) || 0;
  const stock = parseFloat(document.getElementById('barcode-item-stock').value) || 0;
  let barcodeValue = document.getElementById('barcode-custom-value').value.trim();

  if (!name) { showToast('Please enter an item name', 'error'); return; }
  if (price <= 0) { showToast('Please enter a valid price', 'error'); return; }

  // Auto-generate barcode if not provided
  if (!barcodeValue) {
    const counter = incrementBarcodeCounter();
    barcodeValue = 'KALP' + String(counter).padStart(6, '0');
  }

  // Check for duplicate barcode values
  const existing = getData(STORAGE_KEYS.barcodes);
  if (existing.find(b => b.barcodeValue === barcodeValue)) {
    showToast('This barcode value already exists!', 'error');
    return;
  }

  // Generate barcode SVG
  const previewCard = document.getElementById('barcode-preview-card');
  const svg = document.getElementById('barcode-preview-svg');
  const details = document.getElementById('barcode-preview-details');

  try {
    JsBarcode(svg, barcodeValue, {
      format: 'CODE128',
      width: 2,
      height: 80,
      displayValue: true,
      fontSize: 14,
      font: 'Inter',
      margin: 10,
      background: '#ffffff',
      lineColor: '#1a1a2e'
    });
  } catch (err) {
    showToast('Error generating barcode: ' + err.message, 'error');
    return;
  }

  details.innerHTML = `
    <div class="item-detail"><span class="label">Item</span><span class="value">${esc(name)}</span></div>
    ${supplierName ? `<div class="item-detail"><span class="label">Supplier</span><span class="value">${esc(supplierName)}</span></div>` : ''}
    ${fabricCode ? `<div class="item-detail"><span class="label">Fabric Code</span><span class="value">${esc(fabricCode)}</span></div>` : ''}
    <div class="item-detail"><span class="label">Price</span><span class="value">${formatCurrency(price)}</span></div>
    <div class="item-detail"><span class="label">Stock</span><span class="value">${fmtQty(stock)} Mts</span></div>
    <div class="item-detail"><span class="label">Barcode</span><span class="value">${esc(barcodeValue)}</span></div>
  `;

  previewCard.style.display = 'block';

  lastGeneratedBarcode = {
    name, price, stock, barcodeValue, supplierName, fabricCode
  };

  showToast('Barcode generated! Save it or print it.', 'success');
}

function saveBarcodeItem() {
  if (!lastGeneratedBarcode) {
    showToast('Generate a barcode first', 'error');
    return;
  }

  const { name, price, stock, barcodeValue, supplierName, fabricCode } = lastGeneratedBarcode;

  const barcodes = getData(STORAGE_KEYS.barcodes);
  const newItem = {
    id: Date.now().toString(),
    name, price, stock, barcodeValue,
    supplierName: supplierName || '',
    fabricCode: fabricCode || '',
    createdAt: new Date().toISOString()
  };
  barcodes.push(newItem);
  setData(STORAGE_KEYS.barcodes, barcodes);

  // Also add to inventory
  const inventory = getData(STORAGE_KEYS.inventory);
  const existingInv = inventory.find(i => i.name.toLowerCase() === name.toLowerCase());
  if (!existingInv) {
    inventory.push({
      id: (Date.now() + 1).toString(),
      name, category: 'Barcoded',
      price, stock,
      createdAt: new Date().toISOString()
    });
  } else {
    existingInv.stock = (parseFloat(existingInv.stock) || 0) + (parseFloat(stock) || 0);
    // Optionally update price if current is higher
    if (price > existingInv.price) existingInv.price = price;
  }
  setData(STORAGE_KEYS.inventory, inventory);
  if (typeof renderInventoryTable === "function") renderInventoryTable();

  showToast(`"${name}" saved with barcode ${barcodeValue}`, 'success');

  // Clear form - Name and Margin are preserved as per user request
  if (document.getElementById('barcode-supplier-name')) document.getElementById('barcode-supplier-name').value = '';
  if (document.getElementById('barcode-fabric-code')) document.getElementById('barcode-fabric-code').value = '';
  document.getElementById('barcode-cost-price').value = '';
  document.getElementById('barcode-item-price').value = '';
  document.getElementById('barcode-item-stock').value = '';
  document.getElementById('barcode-custom-value').value = '';
  document.getElementById('barcode-preview-card').style.display = 'none';
  lastGeneratedBarcode = null;

  renderBarcodeList();
  
  // Use a slight delay to ensure focus works after window.print() closes
  setTimeout(() => {
    const costInput = document.getElementById('barcode-cost-price');
    if (costInput) {
      costInput.focus();
      costInput.select(); // Also select text for easy overwrite
    }
  }, 300);
}

function initBarcodeNavigation() {
  if (window.barcodeNavInitialized) return;

  // Load last used values
  const lastName = localStorage.getItem('kalp_last_item_name');
  if (lastName) {
    document.getElementById('barcode-item-name').value = lastName;
  }
  const lastMargin = localStorage.getItem('kalp_last_margin');
  if (lastMargin) {
    document.getElementById('barcode-margin').value = lastMargin;
  }

  const navigations = [
    { id: 'barcode-item-name', next: 'barcode-cost-price' },
    { id: 'barcode-cost-price', next: 'barcode-margin' },
    { id: 'barcode-margin', next: 'barcode-item-price' },
    { id: 'barcode-item-price', next: 'barcode-item-stock' },
    { id: 'barcode-item-stock', next: 'barcode-print-count' },
    { id: 'barcode-print-count', action: () => {
        generateBarcode();
        // Print AND Save automatically
        setTimeout(() => {
          printSingleBarcode();
          saveBarcodeItem();
        }, 100);
      } 
    }
  ];

  // --- Shortcuts for Item Name ---
  const itemNameInput = document.getElementById('barcode-item-name');
  if (itemNameInput) {
    itemNameInput.addEventListener('input', function() {
      // Save for persistence
      localStorage.setItem('kalp_last_item_name', this.value);
      
      const shortcuts = {
        '1': 'SHIRT',
        '2': 'SUIT',
        '3': 'ETHNIC',
        '4': 'SEMI',
        '5': 'GIFT COMBO'
      };
      if (shortcuts[this.value]) {
        this.value = shortcuts[this.value];
      }
    });
  }

  navigations.forEach(nav => {
    const input = document.getElementById(nav.id);
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (nav.next) {
            const nextEl = document.getElementById(nav.next);
            if (nextEl) nextEl.focus();
          } else if (nav.action) {
            nav.action();
          }
        }
      });
    }
  });

  window.barcodeNavInitialized = true;
}

function calculateSellingPrice() {
  const cost = parseFloat(document.getElementById('barcode-cost-price').value) || 0;
  const margin = parseFloat(document.getElementById('barcode-margin').value) || 0;
  
  // Save margin for next time
  localStorage.setItem('kalp_last_margin', margin.toString());

  if (cost > 0) {
    const rawPrice = cost + (cost * (margin / 100));
    const sellingPrice = Math.ceil(rawPrice / 5) * 5;
    document.getElementById('barcode-item-price').value = sellingPrice.toFixed(0);
  }
}

function renderBarcodeList(filter = '') {
  const barcodes = getData(STORAGE_KEYS.barcodes);
  const grid = document.getElementById('barcode-list-grid');

  let filtered = barcodes;
  if (filter) {
    const lf = filter.toLowerCase();
    filtered = barcodes.filter(b =>
      b.name.toLowerCase().includes(lf) ||
      b.barcodeValue.toLowerCase().includes(lf) ||
      (b.supplierName || '').toLowerCase().includes(lf) ||
      (b.fabricCode || '').toLowerCase().includes(lf)
    );
  }

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
      <div class="empty-icon">🏷️</div>
      <div class="empty-text">${filter ? 'No barcodes match' : 'No barcodes created yet'}</div>
      <div class="empty-sub">${filter ? 'Try a different search' : 'Create your first barcode using the form'}</div>
    </div>`;
    return;
  }

  grid.innerHTML = filtered.map(item => {
    return `<div class="barcode-card" id="bc-card-${item.id}">
      <svg id="bc-svg-${item.id}"></svg>
      <div class="barcode-card-input-wrapper">
        <input type="text" class="barcode-card-name-input" value="${esc(item.name)}" 
               oninput="updateBarcodeName('${item.id}', this.value)" 
               placeholder="Item Name">
      </div>
      ${(item.supplierName || item.fabricCode) ? `
      <div style="font-size: 11px; color: var(--text-muted); margin: 2px 0;">
        ${item.supplierName ? esc(item.supplierName) : ''}${item.supplierName && item.fabricCode ? ' • ' : ''}${item.fabricCode ? `Code: ${esc(item.fabricCode)}` : ''}
      </div>` : ''}
      <div class="barcode-card-price">${formatCurrency(item.price)}</div>
      <div class="barcode-card-stock">Stock: ${fmtQty(item.stock)} Mts</div>
      <div class="barcode-card-actions">
        <button class="btn btn-secondary btn-sm" onclick="printBarcode('${item.id}')">🖨️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteBarcode('${item.id}')">🗑️</button>
      </div>
    </div>`;
  }).join('');

  // Render barcodes into SVGs
  setTimeout(() => {
    filtered.forEach(item => {
      try {
        JsBarcode(document.getElementById(`bc-svg-${item.id}`), item.barcodeValue, {
          format: 'CODE128', width: 1.5, height: 50,
          displayValue: true, fontSize: 11, font: 'Inter', margin: 6,
          background: '#ffffff', lineColor: '#1a1a2e'
        });
      } catch (e) { /* ignore render errors for invalid codes */ }
    });
  }, 50);
}

function filterBarcodes() {
  renderBarcodeList(document.getElementById('barcode-search').value);
}

// --- Barcode CSV Import/Export ---
function exportBarcodesCSV() {
  const barcodes = getData(STORAGE_KEYS.barcodes);
  if (barcodes.length === 0) {
    showToast('No barcodes to export', 'error');
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "NAME,BARCODE,PRICE,QTY\n";
  
  barcodes.forEach(b => {
    const name = `"${b.name.replace(/"/g, '""')}"`;
    const barcode = `"${b.barcodeValue.replace(/"/g, '""')}"`;
    const price = b.price;
    const qty = b.stock;
    csvContent += `${name},${barcode},${price},${qty}\n`;
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `barcodes_export_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Barcodes exported to CSV', 'success');
}

function importBarcodesCSV(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length <= 1) {
      showToast('CSV is empty or missing data', 'error');
      return;
    }

    const headers = lines[0].toUpperCase().split(',').map(h => h.trim().replace(/"/g, ''));
    const nameIdx = headers.indexOf('NAME');
    const barcodeIdx = headers.indexOf('BARCODE');
    const priceIdx = headers.indexOf('PRICE');
    const qtyIdx = headers.indexOf('QTY');

    if (nameIdx === -1 || barcodeIdx === -1 || priceIdx === -1 || qtyIdx === -1) {
      showToast('CSV must have columns: NAME, BARCODE, PRICE, QTY', 'error');
      return;
    }

    const barcodes = getData(STORAGE_KEYS.barcodes);
    const inventory = getData(STORAGE_KEYS.inventory);
    let importedCount = 0;

    for (let i = 1; i < lines.length; i++) {
      let curr = lines[i];
      let row = [];
      let inQuotes = false;
      let val = '';
      for (let c = 0; c < curr.length; c++) {
        let char = curr[c];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          row.push(val.trim());
          val = '';
        } else {
          val += char;
        }
      }
      row.push(val.trim());

      if (row.length < Math.max(nameIdx, barcodeIdx, priceIdx, qtyIdx) + 1) continue;

      let name = row[nameIdx].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
      let barcodeVal = row[barcodeIdx].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
      let price = parseFloat(row[priceIdx].replace(/^"|"$/g, '').replace(/""/g, '"').trim()) || 0;
      let qty = parseFloat(row[qtyIdx].replace(/^"|"$/g, '').replace(/""/g, '"').trim()) || 0;

      if (!name || !barcodeVal) continue;

      // Update Barcodes DB (Skip if barcode already exists)
      const existingBarcode = barcodes.find(b => b.barcodeValue === barcodeVal);
      if (existingBarcode) {
        continue; // Do not import duplicate barcode numbers
      } else {
        barcodes.push({
          id: Date.now().toString() + Math.random().toString().substr(2, 5),
          name, price, stock: qty, barcodeValue: barcodeVal,
          createdAt: new Date().toISOString()
        });
      }

      // Update generic Inventory DB (Add stock based on matching name)
      const existingInv = inventory.find(inv => inv.name.toLowerCase() === name.toLowerCase());
      if (existingInv) {
        existingInv.stock += qty;
        if (price > existingInv.price) existingInv.price = Math.max(existingInv.price, price); 
      } else {
        inventory.push({
          id: Date.now().toString() + Math.random().toString().substr(2, 5),
          name, category: 'Barcoded',
          price, stock: qty,
          createdAt: new Date().toISOString()
        });
      }

      importedCount++;
    }

    setData(STORAGE_KEYS.barcodes, barcodes);
    setData(STORAGE_KEYS.inventory, inventory);
    
    renderBarcodeList();
    if(typeof renderInventoryTable === 'function') renderInventoryTable();
    showToast(`Successfully imported ${importedCount} new barcodes! (Duplicates skipped)`, 'success');
  };
  
  reader.readAsText(file);
  event.target.value = '';
}

function deleteAllBarcodes() {
  const barcodes = getData(STORAGE_KEYS.barcodes);
  if (barcodes.length === 0) {
    showToast('No barcodes to delete', 'info');
    return;
  }
  
  if (confirm('Are you sure you want to delete ALL barcodes? This cannot be undone.')) {
    // Also reflect in inventory: subtract each barcode's stock from its corresponding inventory item
    const inventory = getData(STORAGE_KEYS.inventory);
    barcodes.forEach(b => {
      const invItem = inventory.find(inv => inv.name.toLowerCase() === b.name.toLowerCase());
      if (invItem) {
        invItem.stock = Math.max(0, (parseFloat(invItem.stock) || 0) - (parseFloat(b.stock) || 0));
      }
    });
    setData(STORAGE_KEYS.inventory, inventory);
    
    setData(STORAGE_KEYS.barcodes, []);
    renderBarcodeList();
    if (typeof renderInventoryTable === 'function') renderInventoryTable();
    showToast('All barcodes deleted and inventory stock updated', 'success');
  }
}

function updateBarcodeName(id, newName) {
  const barcodes = getData(STORAGE_KEYS.barcodes);
  const barcode = barcodes.find(b => b.id === id);
  if (!barcode) return;

  const oldName = barcode.name;
  barcode.name = newName;
  setData(STORAGE_KEYS.barcodes, barcodes);

  // Sync with inventory
  const inventory = getData(STORAGE_KEYS.inventory);
  const invItem = inventory.find(i => i.name.toLowerCase() === oldName.toLowerCase());
  if (invItem) {
    invItem.name = newName;
    setData(STORAGE_KEYS.inventory, inventory);
    if (typeof renderInventoryTable === "function") renderInventoryTable();
  }
}

function deleteBarcode(id) {
  if (!confirm('Delete this barcode?')) return;
  const barcodes = getData(STORAGE_KEYS.barcodes);
  const item = barcodes.find(b => b.id === id);
  if (!item) return;

  // Also reflect in inventory: subtract this specific barcode's stock from its corresponding inventory item
  const inventory = getData(STORAGE_KEYS.inventory);
  const invItem = inventory.find(inv => inv.name.toLowerCase() === item.name.toLowerCase());
  if (invItem) {
    invItem.stock = Math.max(0, (parseFloat(invItem.stock) || 0) - (parseFloat(item.stock) || 0));
    setData(STORAGE_KEYS.inventory, inventory);
    if (typeof renderInventoryTable === 'function') renderInventoryTable();
  }

  const updatedBarcodes = barcodes.filter(b => b.id !== id);
  setData(STORAGE_KEYS.barcodes, updatedBarcodes);
  renderBarcodeList();
  showToast(`"${item.name}" barcode deleted and stock adjusted`, 'warning');
}

function printBarcode(id) {
  const barcodes = getData(STORAGE_KEYS.barcodes);
  const item = barcodes.find(b => b.id === id);
  if (!item) return;

  // For saved barcodes, we could ask for quantity if needed, 
  // but for now, we follow the user's specific request for the creation form.
  const printCount = parseInt(document.getElementById('barcode-print-count')?.value) || 1;
  printBarcodeSticker(item.name, item.price, item.barcodeValue, printCount);
}

function printSingleBarcode() {
  if (!lastGeneratedBarcode) return;
  const { name, price, barcodeValue } = lastGeneratedBarcode;
  const printCount = parseInt(document.getElementById('barcode-print-count')?.value) || 1;
  printBarcodeSticker(name, price, barcodeValue, printCount);
}

/**
 * Print a barcode sticker using Chrome's default print dialog.
 * Uses SVG (vector) for crisp, high-resolution barcode output.
 * All info (name, barcode, price) compact on a single page.
 */
function printBarcodeSticker(name, price, barcodeValue, count = 1) {
  const printArea = document.getElementById('barcode-print-area');

  // 1. Build multiple sticker HTML elements based on count
  let stickersHTML = '';
  for (let i = 0; i < count; i++) {
    stickersHTML += `
      <div class="barcode-print-sticker">
        <div class="bps-name">${esc(name)}</div>
        <svg class="bps-barcode-svg" data-index="${i}"></svg>
        <div class="bps-price">₹${parseFloat(price).toFixed(2)}</div>
      </div>
    `;
  }
  printArea.innerHTML = stickersHTML;

  // 2. Render each barcode SVG independently
  const svgs = printArea.querySelectorAll('.bps-barcode-svg');
  svgs.forEach(svg => {
    try {
      JsBarcode(svg, barcodeValue, {
        format: 'CODE128', width: 1.5, height: 40,
        displayValue: true, fontSize: 11, font: 'Arial', margin: 4,
        background: '#ffffff', lineColor: '#000000'
      });
    } catch (e) {
      console.error('Barcode generation failed', e);
    }
  });

  if (svgs.length === 0) {
    showToast('Failed to generate barcodes', 'error');
    printArea.innerHTML = '';
    return;
  }

  // 3. Add class to body → hides app, shows only sticker
  document.body.classList.add('printing-barcode-sticker');

  // 4. Small delay to let SVG render, then print
  setTimeout(() => {
    window.print();
    // Clean up
    document.body.classList.remove('printing-barcode-sticker');
    printArea.innerHTML = '';
  }, 100);
}


// ===================================================================
// UTILITY FUNCTIONS
// ===================================================================

function formatCurrency(amount) {
  return '₹' + parseFloat(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtRaw(amount) {
  return parseFloat(amount || 0).toFixed(2);
}

function fmtQty(qty) {
  return parseFloat(parseFloat(qty || 0).toFixed(2));
}

function formatCurrencyShort(amount) {
  if (amount >= 100000) return '₹' + (amount / 100000).toFixed(1) + 'L';
  if (amount >= 1000) return '₹' + (amount / 1000).toFixed(1) + 'K';
  return '₹' + amount.toFixed(0);
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parts[2]} ${months[parseInt(parts[1]) - 1]} ${parts[0]}`;
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Modal events
document.getElementById('inventory-modal').addEventListener('click', (e) => {
  if (e.target.id === 'inventory-modal') closeInventoryModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeInventoryModal();
});


// ===================================================================
// SHOP DETAILS
// ===================================================================

function getShopDetails() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEYS.shopDetails)) || {};
    if (!d.logo && d.logo !== false && d.logo !== 'none') {
      d.logo = 'image.png';
    }
    return d;
  } catch {
    return { logo: 'image.png' };
  }
}

function saveShopDetails() {
  const name = document.getElementById('shop-name').value.trim();
  const address = document.getElementById('shop-address').value.trim();
  const phone = document.getElementById('shop-phone').value.trim();
  const email = document.getElementById('shop-email').value.trim();
  const gstin = document.getElementById('shop-gstin').value.trim();
  const nextBill = parseInt(document.getElementById('shop-next-bill').value);

  const existing = getShopDetails();
  const details = {
    name, address, phone, email, gstin,
    logo: existing.logo !== undefined ? existing.logo : 'image.png'  // preserve existing logo
  };

  localStorage.setItem(STORAGE_KEYS.shopDetails, JSON.stringify(details));
  
  if (!isNaN(nextBill) && nextBill > 0) {
    // We set the counter to nextBill - 1 because incrementBillCounter adds 1
    localStorage.setItem(STORAGE_KEYS.billCounter, (nextBill - 1).toString());
  }

  showToast('Shop details and bill sequence updated!', 'success');
}

function loadShopDetails() {
  const details = getShopDetails();
  document.getElementById('shop-name').value = details.name || '';
  document.getElementById('shop-address').value = details.address || '';
  document.getElementById('shop-phone').value = details.phone || '';
  document.getElementById('shop-email').value = details.email || '';
  document.getElementById('shop-gstin').value = details.gstin || '';
  document.getElementById('shop-next-bill').value = getBillCounter() + 1;

  // Show logo if exists
  const currentLogo = (details.logo !== 'none' && details.logo !== false) ? (details.logo || 'image.png') : '';
  if (currentLogo) {
    document.getElementById('logo-preview-img').src = currentLogo;
    document.getElementById('logo-preview-img').style.display = 'block';
    document.getElementById('logo-placeholder').style.display = 'none';
  } else {
    document.getElementById('logo-preview-img').style.display = 'none';
    document.getElementById('logo-placeholder').style.display = 'flex';
  }

  // Show qr code if exists
  const qrImg = document.getElementById('qr-preview-img');
  const qrPlaceholder = document.getElementById('qr-placeholder');
  if (qrImg && qrPlaceholder) {
    if (details.qrCode) {
      qrImg.src = details.qrCode;
      qrImg.style.display = 'block';
      qrPlaceholder.style.display = 'none';
    } else {
      qrImg.style.display = 'none';
      qrPlaceholder.style.display = 'flex';
    }
  }

  // Reflect current theme in buttons
  const currentTheme = localStorage.getItem(STORAGE_KEYS.theme) || 'light';
  const lightBtn = document.getElementById('theme-light-btn');
  const darkBtn = document.getElementById('theme-dark-btn');
  if (lightBtn && darkBtn) {
    lightBtn.classList.toggle('active', currentTheme === 'light');
    darkBtn.classList.toggle('active', currentTheme === 'dark');
  }
}

function clearAllBillsData() {
  if (!confirm('🚨 WARNING: This will permanently delete ALL bills, orders, and ledger history. This cannot be undone. Are you sure?')) return;
  if (!confirm('Final Confirmation: Are you absolutely sure? This will wipe your sales records, but keep Inventory/Barcodes.')) return;

  setData(STORAGE_KEYS.bills, []);
  setData(STORAGE_KEYS.orders, []);
  setData(STORAGE_KEYS.adjustments, []);
  localStorage.setItem(STORAGE_KEYS.billCounter, '0');
  
  if (typeof refreshDashboard === 'function') refreshDashboard();
  if (typeof renderOrdersTable === 'function') renderOrdersTable();
  if (typeof renderRecentBills === 'function') renderRecentBills();
  
  showToast('All billing and ledger data cleared. Sequence reset to 1.', 'success');
  loadShopDetails(); // Refresh the setting display
}

function handleLogoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Check file size (max 500KB for localStorage)
  if (file.size > 512000) {
    showToast('Logo image must be under 500KB', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result;

    // Update preview
    document.getElementById('logo-preview-img').src = base64;
    document.getElementById('logo-preview-img').style.display = 'block';
    document.getElementById('logo-placeholder').style.display = 'none';

    // Save to localStorage
    const details = getShopDetails();
    details.logo = base64;
    localStorage.setItem(STORAGE_KEYS.shopDetails, JSON.stringify(details));
    showToast('Logo uploaded!', 'success');
  };
  reader.readAsDataURL(file);
}

function removeLogo() {
  const details = getShopDetails();
  details.logo = 'none';
  localStorage.setItem(STORAGE_KEYS.shopDetails, JSON.stringify(details));

  document.getElementById('logo-preview-img').src = '';
  document.getElementById('logo-preview-img').style.display = 'none';
  document.getElementById('logo-placeholder').style.display = 'flex';
  document.getElementById('shop-logo-input').value = '';
  showToast('Logo removed', 'warning');
}

function handleQrUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.size > 512000) {
    showToast('QR code image must be under 500KB', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result;
    document.getElementById('qr-preview-img').src = base64;
    document.getElementById('qr-preview-img').style.display = 'block';
    document.getElementById('qr-placeholder').style.display = 'none';

    const details = getShopDetails();
    details.qrCode = base64;
    localStorage.setItem(STORAGE_KEYS.shopDetails, JSON.stringify(details));
    showToast('QR Code uploaded!', 'success');
  };
  reader.readAsDataURL(file);
}

function removeQrCode() {
  const details = getShopDetails();
  details.qrCode = '';
  localStorage.setItem(STORAGE_KEYS.shopDetails, JSON.stringify(details));

  document.getElementById('qr-preview-img').src = '';
  document.getElementById('qr-preview-img').style.display = 'none';
  document.getElementById('qr-placeholder').style.display = 'flex';
  document.getElementById('shop-qr-input').value = '';
  showToast('QR Code removed', 'warning');
}

// ===================================================================
// ORDER LEDGER (TAILOR TRACKING)
// ===================================================================

function renderOrdersTable(filter = '') {
  const orders = getData(STORAGE_KEYS.orders);
  const body = document.getElementById('orders-body');
  
  if (!body) return;

  let filteredOrders = orders;
  if (filter) {
    const lf = filter.toLowerCase();
    filteredOrders = orders.filter(o => 
      String(o.billNumber).toLowerCase().includes(lf) ||
      (o.customerName || '').toLowerCase().includes(lf) ||
      String(o.fabric).includes(lf) ||
      String(o.tailor).includes(lf)
    );
  }

  if (filteredOrders.length === 0) {
    body.innerHTML = `<tr><td colspan="9"><div class="empty-state">
      <div class="empty-icon">📒</div><div class="empty-text">${filter ? 'No orders match search' : 'No orders tracked yet'}</div>
      <div class="empty-sub">${filter ? 'Try a different search term' : 'Create your first bill and it will automatically appear here'}</div>
    </div></td></tr>`;
    renderOrdersFooter(orders);
    renderTailorSummary();
    return;
  }
  
  const sortedOrders = [...filteredOrders].sort((a, b) => {
    const numA = parseInt(a.billNumber) || 0;
    const numB = parseInt(b.billNumber) || 0;
    return numB - numA;
  });

  body.innerHTML = sortedOrders.map(order => {
    return `<tr>
      <td><input type="text" class="form-input input-sm order-nav-input" style="background:#fff;" value="${order.billNumber || ''}" oninput="updateOrderField(${order.id}, 'billNumber', this.value)"></td>
      <td><input type="text" class="form-input input-sm order-nav-input" style="background:#fff;" value="${esc(order.customerName)}" oninput="updateOrderField(${order.id}, 'customerName', this.value)"></td>
      <td><input type="number" class="form-input input-sm order-nav-input" style="background:#fff;" value="${order.fabric || ''}" oninput="updateOrderField(${order.id}, 'fabric', this.value)"></td>
      <td><input type="number" class="form-input input-sm order-nav-input" style="background:#fff;" value="${order.tailor || ''}" oninput="updateOrderField(${order.id}, 'tailor', this.value)"></td>
      <td><input type="date" class="form-input input-sm order-nav-input" style="background:#fff;" value="${order.deliveryDate || ''}" oninput="updateOrderField(${order.id}, 'deliveryDate', this.value)"></td>
      <td><input type="number" class="form-input input-sm order-nav-input" style="background:#fff;" value="${order.advance || ''}" oninput="updateOrderField(${order.id}, 'advance', this.value)"></td>
      <td><input type="text" class="form-input input-sm" style="background:${order.pending <= 0 ? '#e6fffa' : '#fff'};font-weight:700;color:${order.pending <= 0 ? '#059669' : 'inherit'};" value="${order.pending <= 0 ? 'Full Paid' : fmtRaw(order.pending)}" id="order-pending-${order.id}" readonly></td>
      <td><input type="number" class="form-input input-sm order-nav-input" style="background:#fff;font-weight:600;" value="${fmtRaw(order.total)}" id="order-total-${order.id}" oninput="updateOrderField(${order.id}, 'total', this.value)"></td>
      <td><button class="btn btn-icon btn-delete" onclick="deleteOrder(${order.id})" title="Delete Order">×</button></td>
    </tr>`;
  }).join('');

  initOrderNavigation();
  renderOrdersFooter(orders);
  renderTailorSummary();
}

function filterOrders() {
  const filter = document.getElementById('orders-search') ? document.getElementById('orders-search').value : '';
  renderOrdersTable(filter);
}

function renderOrdersFooter(orders) {
  const footer = document.getElementById('orders-footer');
  if (!footer) return;

  const totals = orders.reduce((acc, o) => {
    acc.fabric += (parseFloat(o.fabric) || 0);
    acc.tailor += (parseFloat(o.tailor) || 0);
    acc.advance += (parseFloat(o.advance) || 0);
    acc.pending += (parseFloat(o.pending) || 0);
    acc.total += (parseFloat(o.total) || 0);
    return acc;
  }, { fabric: 0, tailor: 0, advance: 0, pending: 0, total: 0 });

  footer.innerHTML = `
    <tr>
      <td colspan="2" style="text-align: right; padding-right: 15px; color: var(--text-muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px;">Grand Totals</td>
      <td id="footer-total-fabric">${totals.fabric.toFixed(2)}</td>
      <td id="footer-total-tailor">${totals.tailor.toFixed(2)}</td>
      <td></td>
      <td id="footer-total-advance">${totals.advance.toFixed(2)}</td>
      <td id="footer-total-pending" style="color: var(--accent-color);">${totals.pending.toFixed(2)}</td>
      <td id="footer-total-bill" style="color: var(--primary-color);">${totals.total.toFixed(2)}</td>
      <td></td>
    </tr>
  `;
}

function updateOrderField(id, field, value) {
  const orders = getData(STORAGE_KEYS.orders);
  const index = orders.findIndex(o => o.id === id);
  if (index === -1) return;

  const order = orders[index];

  // Update the field
  const numericFields = ['fabric', 'tailor', 'advance', 'total', 'pending'];
  if (numericFields.includes(field)) {
    order[field] = parseFloat(value) || 0;
  } else {
    order[field] = value;
  }

  // Recalculate logic for auto-updates
  if (field === 'fabric' || field === 'tailor') {
    order.total = parseFloat(((parseFloat(order.fabric) || 0) + (parseFloat(order.tailor) || 0)).toFixed(2));
    order.pending = parseFloat((order.total - (parseFloat(order.advance) || 0)).toFixed(2));
  } else if (field === 'total' || field === 'advance') {
    order.pending = parseFloat(((parseFloat(order.total) || 0) - (parseFloat(order.advance) || 0)).toFixed(2));
  }

  // Sync back to DOM for instant visual numbers
  const totalEl = document.getElementById(`order-total-${id}`);
  const pendingEl = document.getElementById(`order-pending-${id}`);
  if (totalEl) totalEl.value = fmtRaw(order.total);
  if (pendingEl) {
    const isPaid = order.pending <= 0;
    pendingEl.value = isPaid ? 'Full Paid' : fmtRaw(order.pending);
    pendingEl.style.background = isPaid ? '#e6fffa' : '#fff';
    pendingEl.style.color = isPaid ? '#059669' : 'inherit';
  }
  
  setData(STORAGE_KEYS.orders, orders);
  renderOrdersFooter(orders);
  renderTailorSummary();
}

function toggleTailorDetails() {
  const card = document.getElementById('tailor-summary-card');
  if (card) card.classList.toggle('expanded');
}

function renderTailorSummary() {
  const orders = getData(STORAGE_KEYS.orders);
  const adjustments = getData(STORAGE_KEYS.adjustments);
  
  // 1. Calculate Total Earned by Tailor (from Orders)
  const totalEarned = orders.reduce((sum, order) => sum + (parseFloat(order.tailor) || 0), 0);
  
  // 2. Calculate Total Paid to Tailor (from Withdrawals matching "tailor")
  // We look for manual withdrawals where the description includes "tailor"
  const totalPaid = adjustments.reduce((sum, adj) => {
    const isTailor = adj.desc.toLowerCase().includes('tailor');
    // Only count withdrawals (negative amounts) as payments TO the tailor
    if (isTailor && adj.amount < 0) {
      return sum + Math.abs(adj.amount);
    }
    return sum;
  }, 0);
  
  const pending = totalEarned - totalPaid;
  
  // 3. Update DOM
  const pendingEl = document.getElementById('tailor-pending-display');
  const earnedEl = document.getElementById('tailor-total-earned');
  const paidEl = document.getElementById('tailor-total-paid');
  
  if (pendingEl) pendingEl.textContent = `₹${pending.toFixed(2)}`;
  if (earnedEl) earnedEl.textContent = `₹${totalEarned.toFixed(2)}`;
  if (paidEl) paidEl.textContent = `₹${totalPaid.toFixed(2)}`;
}

function addManualOrder() {
  const orders = getData(STORAGE_KEYS.orders);
  const newOrder = {
    id: Date.now(),
    billId: null,
    billNumber: 'Manual',
    customerName: '',
    fabric: 0,
    tailor: 0,
    deliveryDate: '',
    advance: 0,
    pending: 0,
    total: 0,
    createdAt: new Date().toISOString()
  };
  orders.push(newOrder);
  setData(STORAGE_KEYS.orders, orders);
  renderOrdersTable();
  showToast('New manual order entry added!', 'success');
  
  // Focus the first input of the new row (it will be at the TOP because of sorting)
  setTimeout(() => {
    const firstInput = document.querySelector('#orders-body tr:first-child .order-nav-input');
    if (firstInput) firstInput.focus();
  }, 100);
}

function initOrderNavigation() {
  const body = document.getElementById('orders-body');
  if (!body) return;

  // Clone and replace to prevent multiple listeners
  const newBody = body.cloneNode(true);
  body.parentNode.replaceChild(newBody, body);

  newBody.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const target = e.target;
      if (!target.classList.contains('order-nav-input')) return;

      const row = target.closest('tr');
      const inputs = Array.from(row.querySelectorAll('.order-nav-input'));
      const index = inputs.indexOf(target);

      e.preventDefault();

      if (index < inputs.length - 1) {
        inputs[index + 1].focus();
      } else {
        // Last input of the row - add new entry
        addManualOrder();
      }
    }
  });
}

function deleteOrder(id) {
  if (!confirm('Are you sure you want to delete this order entry?')) return;
  const orders = getData(STORAGE_KEYS.orders);
  const filtered = orders.filter(o => o.id !== id);
  setData(STORAGE_KEYS.orders, filtered);
  renderOrdersTable();
  showToast('Order entry deleted', 'warning');
}

function consolidateLedger() {
  const bills = getData(STORAGE_KEYS.bills) || [];
  const orders = getData(STORAGE_KEYS.orders) || [];
  let consolidatedCount = 0;
  let addedCount = 0;

  bills.forEach(bill => {
    let orderIdx = orders.findIndex(o => o.billId === bill.id);
    if (orderIdx === -1) {
      orderIdx = orders.findIndex(o => String(o.billNumber) == String(bill.billNumber) || String(o.billNumber) == ('KALP-' + bill.billNumber));
    }

    const fabric = parseFloat(bill.grandTotal) || 0;
    const tailor = parseFloat(bill.tailorAmount) || 0;
    const total = parseFloat((fabric + tailor).toFixed(2));
    const advance = parseFloat(bill.advancePaid) || 0;
    const pending = Math.max(0, parseFloat((total - advance).toFixed(2)));

    if (orderIdx !== -1) {
      orders[orderIdx].billId = bill.id;
      orders[orderIdx].billNumber = bill.billNumber;
      if (!orders[orderIdx].customerName || orders[orderIdx].customerName === 'Walk-in') {
        orders[orderIdx].customerName = bill.customerName;
      }
      if (!orders[orderIdx].deliveryDate && bill.deliveryDate) {
        orders[orderIdx].deliveryDate = bill.deliveryDate;
      }
      orders[orderIdx].fabric = fabric;
      if (orders[orderIdx].tailor === undefined || orders[orderIdx].tailor === null || orders[orderIdx].tailor === 0) {
        orders[orderIdx].tailor = tailor;
      }
      orders[orderIdx].total = parseFloat(((parseFloat(orders[orderIdx].fabric) || 0) + (parseFloat(orders[orderIdx].tailor) || 0)).toFixed(2));
      if (orders[orderIdx].advance === undefined || orders[orderIdx].advance === null) {
        orders[orderIdx].advance = advance;
      }
      orders[orderIdx].pending = parseFloat(((orders[orderIdx].total || 0) - (parseFloat(orders[orderIdx].advance) || 0)).toFixed(2));
      if (bill.orderNumber) orders[orderIdx].orderNumber = bill.orderNumber;
      consolidatedCount++;
    } else {
      orders.push({
        id: Date.now() + Math.random(),
        billId: bill.id,
        billNumber: bill.billNumber,
        orderNumber: bill.orderNumber || '',
        customerName: bill.customerName,
        deliveryDate: bill.noDelivery ? '' : (bill.deliveryDate || ''),
        fabric: fabric,
        tailor: tailor,
        advance: advance,
        total: total,
        pending: pending
      });
      addedCount++;
    }
  });

  setData(STORAGE_KEYS.orders, orders);
  renderOrdersTable();
  refreshDashboard();
  showToast(`Ledger consolidated! Reconciled ${consolidatedCount} orders${addedCount > 0 ? `, recovered ${addedCount} missing orders` : ''}.`, 'success');
}

// ===================================================================
// CONSIGNMENTS
// ===================================================================
function renderConsignments() {
  const consignments = getData(STORAGE_KEYS.consignments) || [];
  const tbody = document.getElementById('consignment-body');
  if (!tbody) return;

  if (consignments.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8">
      <div class="empty-state">
        <div class="empty-icon">🚚</div>
        <div class="empty-text">No consignments found</div>
        <div class="empty-sub">Add a new incoming order to track it here</div>
      </div>
    </td></tr>`;
    return;
  }

  const sorted = [...consignments].sort((a, b) => new Date(b.orderDate || 0) - new Date(a.orderDate || 0));

  tbody.innerHTML = sorted.map(c => `
    <tr>
      <td style="font-weight:600;">${esc(c.partyName || '-')}</td>
      <td>${c.orderDate ? formatDate(c.orderDate) : '-'}</td>
      <td>${c.expectedDelivery ? formatDate(c.expectedDelivery) : '-'}</td>
      <td>${esc(c.description || '-')}</td>
      <td style="text-align:center;">
        <input type="checkbox" ${c.lrReceived ? 'checked' : ''} onchange="toggleConsignmentStatus('${c.id}', 'lrReceived', this.checked)" style="cursor:pointer;width:18px;height:18px;">
      </td>
      <td style="text-align:center;">
        <input type="checkbox" ${c.delivered ? 'checked' : ''} onchange="toggleConsignmentStatus('${c.id}', 'delivered', this.checked)" style="cursor:pointer;width:18px;height:18px;">
      </td>
      <td style="text-align:center;">
        <input type="checkbox" ${c.payment ? 'checked' : ''} onchange="toggleConsignmentStatus('${c.id}', 'payment', this.checked)" style="cursor:pointer;width:18px;height:18px;">
      </td>
      <td style="text-align:center;">
        <button class="btn-icon btn-edit" onclick="openConsignmentModal('${c.id}')" title="Edit">📝</button>
        <button class="btn-icon btn-delete" onclick="deleteConsignment('${c.id}')" title="Delete">🗑️</button>
      </td>
    </tr>
  `).join('');
}

function openConsignmentModal(id = null) {
  const modal = document.getElementById('consignment-modal');
  if (!modal) return;
  const title = document.getElementById('consignment-modal-title');
  const idInput = document.getElementById('consignment-id');
  const partyInput = document.getElementById('consignment-party');
  const orderDateInput = document.getElementById('consignment-order-date');
  const delDateInput = document.getElementById('consignment-delivery-date');
  const descInput = document.getElementById('consignment-desc');
  const lrCb = document.getElementById('consignment-lr');
  const deliveredCb = document.getElementById('consignment-delivered');
  const paymentCb = document.getElementById('consignment-payment');

  if (id) {
    const list = getData(STORAGE_KEYS.consignments) || [];
    const item = list.find(c => String(c.id) === String(id));
    if (item) {
      if (title) title.textContent = 'Edit Consignment';
      idInput.value = item.id;
      partyInput.value = item.partyName || '';
      orderDateInput.value = item.orderDate || '';
      delDateInput.value = item.expectedDelivery || '';
      descInput.value = item.description || '';
      lrCb.checked = !!item.lrReceived;
      deliveredCb.checked = !!item.delivered;
      paymentCb.checked = !!item.payment;
      modal.classList.add('active');
      return;
    }
  }

  if (title) title.textContent = 'Add Consignment';
  idInput.value = '';
  partyInput.value = '';
  orderDateInput.value = new Date().toISOString().split('T')[0];
  delDateInput.value = '';
  descInput.value = '';
  lrCb.checked = false;
  deliveredCb.checked = false;
  paymentCb.checked = false;

  modal.classList.add('active');
}

function closeConsignmentModal() {
  const modal = document.getElementById('consignment-modal');
  if (modal) modal.classList.remove('active');
}

function saveConsignment() {
  const party = document.getElementById('consignment-party').value.trim();
  if (!party) {
    showToast('Please enter Party Name', 'error');
    return;
  }
  const id = document.getElementById('consignment-id').value;
  const orderDate = document.getElementById('consignment-order-date').value;
  const expectedDelivery = document.getElementById('consignment-delivery-date').value;
  const description = document.getElementById('consignment-desc').value.trim();
  const lrReceived = document.getElementById('consignment-lr').checked;
  const delivered = document.getElementById('consignment-delivered').checked;
  const payment = document.getElementById('consignment-payment').checked;

  const consignments = getData(STORAGE_KEYS.consignments) || [];

  if (id) {
    const idx = consignments.findIndex(c => String(c.id) === String(id));
    if (idx !== -1) {
      consignments[idx] = {
        ...consignments[idx],
        partyName: party,
        orderDate,
        expectedDelivery,
        description,
        lrReceived,
        delivered,
        payment,
        updatedAt: new Date().toISOString()
      };
      showToast('Consignment updated', 'success');
    }
  } else {
    consignments.push({
      id: 'cs_' + Date.now(),
      partyName: party,
      orderDate,
      expectedDelivery,
      description,
      lrReceived,
      delivered,
      payment,
      createdAt: new Date().toISOString()
    });
    showToast('Consignment saved', 'success');
  }

  setData(STORAGE_KEYS.consignments, consignments);
  closeConsignmentModal();
  renderConsignments();
}

function toggleConsignmentStatus(id, field, value) {
  const consignments = getData(STORAGE_KEYS.consignments) || [];
  const item = consignments.find(c => String(c.id) === String(id));
  if (item) {
    item[field] = value;
    setData(STORAGE_KEYS.consignments, consignments);
    showToast('Status updated', 'success');
  }
}

function deleteConsignment(id) {
  if (!confirm('Are you sure you want to delete this consignment?')) return;
  const consignments = getData(STORAGE_KEYS.consignments) || [];
  const updated = consignments.filter(c => String(c.id) !== String(id));
  setData(STORAGE_KEYS.consignments, updated);
  showToast('Consignment deleted', 'warning');
  renderConsignments();
}

// ===================================================================
// DATA IMPORT / EXPORT (ALL DATA)
// ===================================================================

function exportAllData() {
  const exportData = {};
  for (const [key, storageKey] of Object.entries(STORAGE_KEYS)) {
    const data = localStorage.getItem(storageKey);
    if (data !== null) {
      exportData[storageKey] = data;
    }
  }
  
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kalp_backup_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('App data exported successfully!', 'success');
}

function exportBillsCSV() {
  const bills = getData(STORAGE_KEYS.bills);
  if (!bills || bills.length === 0) {
    showToast('No bills available to export', 'error');
    return;
  }

  showToast('Generating CSV... Please wait', 'info');

  const headers = ['Bill Number', 'Date', 'Customer Name', 'Items', 'Total (Rs)'];
  const rows = [];
  let totalRevenue = 0;

  bills.forEach(bill => {
    totalRevenue += (bill.grandTotal || 0);
    const itemNames = (bill.items || []).map(i => i.itemName).join('; ').replace(/"/g, '""');
    
    const row = [
      bill.billNumber,
      bill.date,
      (bill.customerName || 'Walk-in').replace(/"/g, '""'),
      itemNames,
      bill.grandTotal || 0
    ];
    
    rows.push('"' + row.join('","') + '"');
  });

  rows.push('');
  rows.push(`"Grand Total","","","","${totalRevenue}"`);

  const csvContent = headers.join(',') + '\\n' + rows.join('\\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `All_Bills_Report_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  showToast('Excel CSV Exported Successfully!', 'success');
}

function importAllData(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!confirm('WARNING: Importing data will completely OVERWRITE your current data. Are you sure you want to proceed?')) {
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const parsedData = JSON.parse(e.target.result);
      const validKeys = Object.values(STORAGE_KEYS);
      let importedKeysCount = 0;
      
      for (const [key, value] of Object.entries(parsedData)) {
        if (validKeys.includes(key)) {
          localStorage.setItem(key, value);
          importedKeysCount++;
        }
      }
      
      if (importedKeysCount > 0) {
        alert('Data imported successfully! The application will now reload to apply the backup.');
        window.location.reload();
      } else {
        showToast('Invalid backup file. No matching data keys found.', 'error');
      }
    } catch (err) {
      showToast('Error reading backup file: ' + err.message, 'error');
    }
    // Prevent blocking same file re-selection
    event.target.value = '';
  };
  reader.readAsText(file);
}

// Security function for Order Ledger
let currentPasscode = "";
const CORRECT_PASSCODE = "3324";

function handlePasscodeEntry(dotNum) {
  // Visual feedback: brief flash
  const dot = document.getElementById(`pass-btn-${dotNum}`);
  if (dot) {
    dot.style.background = 'var(--text-muted)';
    setTimeout(() => { dot.style.background = 'transparent'; }, 200);
  }

  currentPasscode += dotNum;

  if (currentPasscode.length === 4) {
    if (currentPasscode === CORRECT_PASSCODE) {
      setTimeout(() => {
        unlockOrderLedger();
        currentPasscode = "";
      }, 150);
    } else {
      // Error shake
      const container = document.getElementById('passcode-container');
      if (container) {
        container.style.transform = 'translateX(10px)';
        setTimeout(() => container.style.transform = 'translateX(-10px)', 50);
        setTimeout(() => container.style.transform = 'translateX(10px)', 100);
        setTimeout(() => container.style.transform = 'translateX(-10px)', 150);
        setTimeout(() => container.style.transform = 'translateX(0)', 200);
      }
      setTimeout(() => {
        currentPasscode = "";
      }, 250);
    }
  }
}

function unlockOrderLedger() {
  const lockScreen = document.getElementById('order-ledger-lock');
  const contentScreen = document.getElementById('order-ledger-content');
  if (lockScreen && contentScreen) {
    lockScreen.style.display = 'none';
    contentScreen.style.display = 'block';
  }
}

// --- ANALYTICS ---
let analyticsChartInstances = {};

function getAnalyticsDateRanges(rangeStr) {
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  let end = now.getTime();
  let start = 0;
  
  let prevEnd = 0;
  let prevStart = 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (rangeStr === 'this_week') {
    const day = today.getDay(); 
    const diff = today.getDate() - day + (day === 0 ? -6 : 1);
    const thisMonday = new Date(today.setDate(diff));
    start = thisMonday.getTime();
    
    prevEnd = start - 1;
    const prevMonday = new Date(thisMonday);
    prevMonday.setDate(prevMonday.getDate() - 7);
    prevStart = prevMonday.getTime();
  } else if (rangeStr === 'this_month') {
    const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    start = thisMonthStart.getTime();
    
    prevEnd = start - 1;
    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    prevStart = prevMonthStart.getTime();
  } else if (rangeStr === 'last_month') {
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    start = lastMonthStart.getTime();
    
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59, 999);
    end = lastMonthEnd.getTime();
    
    prevEnd = start - 1;
    const prevPrevMonthStart = new Date(today.getFullYear(), today.getMonth() - 2, 1);
    prevStart = prevPrevMonthStart.getTime();
  } else if (rangeStr === 'last_3_months') {
    const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate());
    start = threeMonthsAgo.getTime();
    
    prevEnd = start - 1;
    const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 6, today.getDate());
    prevStart = sixMonthsAgo.getTime();
  } else {
    // all_time
    start = 0;
    end = now.getTime();
    prevStart = 0;
    prevEnd = 0;
  }
  
  return { start, end, prevStart, prevEnd };
}

function renderAnalytics() {
  const rangeStr = document.getElementById('analytics-date-range').value;
  const { start, end, prevStart, prevEnd } = getAnalyticsDateRanges(rangeStr);
  
  const allBills = getData(STORAGE_KEYS.bills) || [];
  const inventory = getData(STORAGE_KEYS.inventory) || [];
  
  // Filter bills
  const periodBills = allBills.filter(b => b.id >= start && b.id <= end);
  const prevBills = allBills.filter(b => b.id >= prevStart && b.id <= prevEnd);
  
  // 1. Health Snapshot
  const totalRevenue = periodBills.reduce((sum, b) => sum + (parseFloat(b.grandTotal) || 0), 0);
  const prevRevenue = prevBills.reduce((sum, b) => sum + (parseFloat(b.grandTotal) || 0), 0);
  const totalOrders = periodBills.length;
  const aov = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  
  let growthHtml = '';
  if (prevRevenue > 0) {
    const growth = ((totalRevenue - prevRevenue) / prevRevenue) * 100;
    if (growth >= 0) {
      growthHtml = `<span style="color:var(--success-color);">↑ ${growth.toFixed(1)}%</span>`;
    } else {
      growthHtml = `<span style="color:var(--danger-color);">↓ ${Math.abs(growth).toFixed(1)}%</span>`;
    }
  } else if (prevStart > 0 && totalRevenue > 0) {
    growthHtml = `<span style="color:var(--success-color);">↑ 100%</span>`;
  }

  document.getElementById('analytics-revenue').textContent = formatCurrencyShort(totalRevenue);
  document.getElementById('analytics-revenue-growth').innerHTML = growthHtml;
  document.getElementById('analytics-orders').textContent = totalOrders;
  document.getElementById('analytics-aov').textContent = formatCurrencyShort(aov);
  
  const lowStockCount = inventory.filter(i => (parseFloat(i.stock) || 0) < 5).length;
  document.getElementById('analytics-low-stock').textContent = lowStockCount;

  // Destroy old charts
  Object.values(analyticsChartInstances).forEach(chart => chart.destroy());
  analyticsChartInstances = {};

  if (typeof Chart === 'undefined') return;

  const chartOptions = { responsive: true, maintainAspectRatio: false };
  const primaryColor = '#3b82f6';
  const accentColor = '#8b5cf6';
  const successColor = '#22c55e';

  // 2. Sales Trend (Revenue & AOV)
  const salesByDate = {};
  periodBills.forEach(b => {
    const dateStr = b.date; // YYYY-MM-DD
    if (!salesByDate[dateStr]) salesByDate[dateStr] = { rev: 0, count: 0 };
    salesByDate[dateStr].rev += (parseFloat(b.grandTotal) || 0);
    salesByDate[dateStr].count += 1;
  });
  
  const sortedDates = Object.keys(salesByDate).sort();
  const trendLabels = sortedDates.map(d => formatDateShort(d));
  const trendDataRev = sortedDates.map(d => salesByDate[d].rev);
  const trendDataAov = sortedDates.map(d => salesByDate[d].rev / salesByDate[d].count);

  if (document.getElementById('analyticsSalesChart')) {
    analyticsChartInstances.sales = new Chart(document.getElementById('analyticsSalesChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: trendLabels,
        datasets: [
          { label: 'Revenue (₹)', data: trendDataRev, borderColor: primaryColor, backgroundColor: primaryColor + '20', fill: true, tension: 0.3, yAxisID: 'y' },
          { label: 'Avg Order Value (₹)', data: trendDataAov, borderColor: successColor, borderDash: [5, 5], fill: false, tension: 0.3, yAxisID: 'y1' }
        ]
      },
      options: {
        ...chartOptions,
        onClick: (e, elements) => {
          if (elements && elements.length > 0) {
            const index = elements[0].index;
            const clickedDate = sortedDates[index];
            const billsForDate = periodBills.filter(b => b.date === clickedDate);
            openAnalyticsDrilldown(`Sales on ${formatDateShort(clickedDate)}`, billsForDate);
          }
        },
        scales: {
          y: { type: 'linear', display: true, position: 'left' },
          y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false } }
        }
      }
    });
  }

  // 3. Revenue by Category
  const categoryRev = {};
  periodBills.forEach(b => {
    (b.items || []).forEach(item => {
      const invItem = inventory.find(i => i.name.toLowerCase() === item.itemName.toLowerCase());
      const cat = invItem && invItem.category ? invItem.category : 'Uncategorized';
      if (!categoryRev[cat]) categoryRev[cat] = 0;
      categoryRev[cat] += (parseFloat(item.total) || 0);
    });
  });
  
  const catLabels = Object.keys(categoryRev).sort((a,b) => categoryRev[b] - categoryRev[a]);
  const catData = catLabels.map(c => categoryRev[c]);
  
  if (document.getElementById('analyticsCategoryChart')) {
    analyticsChartInstances.category = new Chart(document.getElementById('analyticsCategoryChart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: catLabels,
        datasets: [{ label: 'Revenue (₹)', data: catData, backgroundColor: accentColor }]
      },
      options: {
        ...chartOptions,
        onClick: (e, elements) => {
          if (elements && elements.length > 0) {
            const index = elements[0].index;
            const clickedCat = catLabels[index];
            const relevantBills = periodBills.filter(b => {
              return (b.items || []).some(item => {
                const invItem = inventory.find(i => i.name.toLowerCase() === item.itemName.toLowerCase());
                const cat = invItem && invItem.category ? invItem.category : 'Uncategorized';
                return cat === clickedCat;
              });
            });
            openAnalyticsDrilldown(`Revenue from ${clickedCat}`, relevantBills);
          }
        }
      }
    });
  }

  // 4. Stitching vs Ready-to-Wear / Fabric
  let stitchingRevenue = 0;
  let fabricRevenue = 0;
  periodBills.forEach(b => {
    const tailor = parseFloat(b.tailorAmount) || 0;
    stitchingRevenue += tailor;
    fabricRevenue += (parseFloat(b.grandTotal) || 0);
  });

  if (document.getElementById('analyticsStitchingChart')) {
    analyticsChartInstances.stitching = new Chart(document.getElementById('analyticsStitchingChart').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Ready-to-Wear / Fabric', 'Stitching & Tailoring'],
        datasets: [{
          data: [fabricRevenue, stitchingRevenue],
          backgroundColor: ['#3b82f6', '#f59e0b']
        }]
      },
      options: {
        ...chartOptions,
        maintainAspectRatio: true,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: function(context) {
                const val = context.raw || 0;
                return ` ${context.label}: ₹${val.toFixed(2)}`;
              }
            }
          }
        }
      }
    });
  }

  // 5. New vs Repeat Customers
  const customerCounts = {};
  allBills.forEach(b => {
    // track over ALL bills to find true repeats
    const key = (b.phone || b.customerName).toLowerCase();
    if (!customerCounts[key]) customerCounts[key] = 0;
    customerCounts[key]++;
  });

  let newCust = 0;
  let repeatCust = 0;
  const handledCustomers = new Set();
  periodBills.forEach(b => {
    const key = (b.phone || b.customerName).toLowerCase();
    if (!handledCustomers.has(key)) {
      handledCustomers.add(key);
      if (customerCounts[key] === 1) newCust++;
      else repeatCust++;
    }
  });

  if (document.getElementById('analyticsCustomerPieChart')) {
    analyticsChartInstances.customers = new Chart(document.getElementById('analyticsCustomerPieChart').getContext('2d'), {
      type: 'pie',
      data: {
        labels: ['New Customers', 'Repeat Customers'],
        datasets: [{ data: [newCust, repeatCust], backgroundColor: ['#ec4899', '#8b5cf6'] }]
      },
      options: { ...chartOptions, maintainAspectRatio: true, plugins: { legend: { position: 'bottom' } } }
    });
  }

  // 6. Peak Days & Hours
  const hourCounts = new Array(24).fill(0);
  periodBills.forEach(b => {
    const hour = new Date(b.id).getHours();
    hourCounts[hour]++;
  });
  
  const hourLabels = hourCounts.map((_, i) => `${i}:00`);

  if (document.getElementById('analyticsPeakHoursChart')) {
    analyticsChartInstances.peak = new Chart(document.getElementById('analyticsPeakHoursChart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: hourLabels,
        datasets: [{ label: 'Number of Orders', data: hourCounts, backgroundColor: '#14b8a6' }]
      },
      options: chartOptions
    });
  }

  // 7. Top Customers
  const custSpend = {};
  periodBills.forEach(b => {
    const key = `${b.customerName}|${b.phone}`;
    if (!custSpend[key]) custSpend[key] = { name: b.customerName, phone: b.phone, spend: 0, orders: 0 };
    custSpend[key].spend += (parseFloat(b.grandTotal) || 0);
    custSpend[key].orders += 1;
  });
  
  const topCusts = Object.values(custSpend).sort((a,b) => b.spend - a.spend).slice(0, 10);
  document.getElementById('analytics-top-customers').innerHTML = topCusts.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${esc(c.phone)}</td>
      <td style="text-align:right;">${c.orders}</td>
      <td style="text-align:right; font-weight:600;">${formatCurrency(c.spend)}</td>
    </tr>
  `).join('') || `<tr><td colspan="4" style="text-align:center;">No customer data</td></tr>`;

  // 8. Inventory Analytics
  const itemSales = {};
  periodBills.forEach(b => {
    (b.items || []).forEach(item => {
      const name = item.itemName.toLowerCase();
      if (!itemSales[name]) itemSales[name] = { name: item.itemName, qty: 0, rev: 0 };
      itemSales[name].qty += (parseFloat(item.qty) || 0);
      itemSales[name].rev += (parseFloat(item.total) || 0);
    });
  });

  const fastItems = Object.values(itemSales).sort((a,b) => b.qty - a.qty).slice(0, 10);
  document.getElementById('analytics-fast-moving').innerHTML = fastItems.map(i => `
    <tr>
      <td>${esc(i.name)}</td>
      <td style="text-align:right;">${i.qty}</td>
      <td style="text-align:right; font-weight:600;">${formatCurrency(i.rev)}</td>
    </tr>
  `).join('') || `<tr><td colspan="3" style="text-align:center;">No sales data</td></tr>`;

  // Dead stock (in inventory but 0 sales in period)
  const deadStock = inventory.filter(i => {
    const sold = itemSales[i.name.toLowerCase()];
    return !sold || sold.qty === 0;
  }).sort((a,b) => b.stock - a.stock); // sort by highest stock

  document.getElementById('analytics-dead-stock').innerHTML = deadStock.map(i => `
    <tr>
      <td>${esc(i.name)}</td>
      <td style="text-align:right; color: var(--danger-color); font-weight:600;">${i.stock}</td>
    </tr>
  `).join('') || `<tr><td colspan="2" style="text-align:center;">No dead stock found</td></tr>`;

  // 9. Stock Value vs Sold Value
  let currentStockValue = 0;
  inventory.forEach(i => {
    currentStockValue += (parseFloat(i.stock) || 0) * (parseFloat(i.price) || 0);
  });
  
  let realizedValue = 0;
  Object.values(itemSales).forEach(i => realizedValue += i.rev);

  document.getElementById('analytics-stock-value').textContent = formatCurrencyShort(currentStockValue);
  document.getElementById('analytics-sold-value').textContent = formatCurrencyShort(realizedValue);
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// ===================================================================
// STAFF MODULE
// ===================================================================

// --- Default Staff Seed ---
const DEFAULT_STAFF = [
  { id: 'staff_nabeel',  name: 'Nabeel',   role: 'Salesperson',  phone: '', commissionRate: 1, attendanceOnly: false },
  { id: 'staff_dishant', name: 'Dishant',  role: 'Salesperson',  phone: '', commissionRate: 1, attendanceOnly: false },
  { id: 'staff_harish',  name: 'Harish',   role: 'Salesperson',  phone: '', commissionRate: 1, attendanceOnly: false },
  { id: 'staff_raghu',   name: 'Raghu',    role: 'Salesperson',  phone: '', commissionRate: 1, attendanceOnly: false },
  { id: 'staff_hk',      name: 'Housekeeping', role: 'Housekeeping', phone: '', commissionRate: 0, attendanceOnly: true }
];

function seedDefaultStaff() {
  const existing = getData(STORAGE_KEYS.staff);
  if (existing && existing.length > 0) return; // Already seeded
  setData(STORAGE_KEYS.staff, DEFAULT_STAFF);
}

// --- Staff Dropdown for Billing ---
function populateStaffDropdown() {
  const sel = document.getElementById('bill-staff-id');
  if (!sel) return;
  const staff = getData(STORAGE_KEYS.staff).filter(s => !s.attendanceOnly);
  sel.innerHTML = `<option value="">— Select Staff —</option>` +
    staff.map(s => `<option value="${s.id}">${esc(s.name)} (${s.commissionRate}%)</option>`).join('');
}

// --- Staff Page Rendering ---
function renderStaffPage() {
  renderStaffTable();
  const todayIso = new Date().toISOString().split('T')[0];
  
  const dateInput = document.getElementById('attendance-date');
  if (dateInput && !dateInput.value) {
    dateInput.value = todayIso;
  }
  renderAttendance(dateInput ? dateInput.value : todayIso);
  
  const monthInput = document.getElementById('attendance-month');
  const currentMonthStr = todayIso.substring(0, 7);
  if (monthInput && !monthInput.value) {
    monthInput.value = currentMonthStr;
  }
  renderMonthlyAttendanceReport(monthInput ? monthInput.value : currentMonthStr);

  populateStaffDropdown();
}

function switchStaffTab(tab) {
  document.getElementById('staff-panel-staff').style.display = tab === 'staff' ? 'block' : 'none';
  document.getElementById('staff-panel-attendance').style.display = tab === 'attendance' ? 'block' : 'none';
  document.getElementById('staff-tab-staff').classList.toggle('active', tab === 'staff');
  document.getElementById('staff-tab-attendance').classList.toggle('active', tab === 'attendance');
}

// --- Commission Aggregation ---
function getStaffTotalCommission(staffId) {
  const bills = getData(STORAGE_KEYS.bills);
  return bills.reduce((sum, b) => {
    if (b.staffId === staffId) return sum + (parseFloat(b.staffCommission) || 0);
    return sum;
  }, 0);
}

function renderStaffTable() {
  const staff = getData(STORAGE_KEYS.staff);
  const tbody = document.getElementById('staff-table-body');
  if (!tbody) return;

  if (staff.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">👨‍💼</div><div class="empty-text">No staff added yet</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = staff.map((s, i) => {
    const commission = getStaffTotalCommission(s.id);
    const attOnlyBadge = s.attendanceOnly
      ? `<span class="commission-badge" style="background:rgba(100,100,100,0.08);color:var(--text-muted);">Attendance Only</span>`
      : `<span class="commission-badge">${s.commissionRate}%</span>`;

    return `<tr>
      <td style="color:var(--text-muted);">${i + 1}</td>
      <td style="font-weight:700;">${esc(s.name)}</td>
      <td>${esc(s.role || '—')}</td>
      <td>${esc(s.phone || '—')}</td>
      <td style="text-align:right;">${attOnlyBadge}</td>
      <td style="text-align:right; font-weight:700; color:var(--accent-primary);">
        ${s.attendanceOnly ? '—' : formatCurrency(commission)}
      </td>
      <td style="text-align:center;">
        <div style="display:flex;gap:6px;justify-content:center;">
          <button class="btn btn-secondary btn-sm" onclick="editStaff('${s.id}')">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteStaff('${s.id}')">🗑️</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// --- Staff CRUD ---
function openStaffModal(editId = null) {
  document.getElementById('edit-staff-id').value = editId || '';
  document.getElementById('staff-modal-title').textContent = editId ? 'Edit Staff Member' : 'Add Staff Member';
  document.getElementById('staff-name').value = '';
  document.getElementById('staff-role').value = '';
  document.getElementById('staff-phone').value = '';
  document.getElementById('staff-commission').value = '1';
  document.getElementById('staff-attendance-only').checked = false;

  if (editId) {
    const staff = getData(STORAGE_KEYS.staff);
    const member = staff.find(s => s.id === editId);
    if (member) {
      document.getElementById('staff-name').value = member.name;
      document.getElementById('staff-role').value = member.role || '';
      document.getElementById('staff-phone').value = member.phone || '';
      document.getElementById('staff-commission').value = member.commissionRate;
      document.getElementById('staff-attendance-only').checked = !!member.attendanceOnly;
    }
  }

  document.getElementById('staff-modal').classList.add('active');
  setTimeout(() => document.getElementById('staff-name').focus(), 50);
}

function closeStaffModal() {
  document.getElementById('staff-modal').classList.remove('active');
}

function saveStaffModal() {
  const name = document.getElementById('staff-name').value.trim();
  if (!name) { showToast('Please enter a name', 'error'); return; }

  const id = document.getElementById('edit-staff-id').value;
  const role = document.getElementById('staff-role').value.trim();
  const phone = document.getElementById('staff-phone').value.trim();
  const commissionRate = parseFloat(document.getElementById('staff-commission').value) || 0;
  const attendanceOnly = document.getElementById('staff-attendance-only').checked;

  const staff = getData(STORAGE_KEYS.staff);

  if (id) {
    // Update
    const idx = staff.findIndex(s => s.id === id);
    if (idx !== -1) {
      staff[idx] = { ...staff[idx], name, role, phone, commissionRate, attendanceOnly };
    }
  } else {
    // Create
    staff.push({
      id: 'staff_' + Date.now(),
      name, role, phone, commissionRate, attendanceOnly,
      createdAt: new Date().toISOString()
    });
  }

  setData(STORAGE_KEYS.staff, staff);
  closeStaffModal();
  renderStaffTable();
  populateStaffDropdown();
  showToast(id ? 'Staff updated!' : 'Staff member added!', 'success');
}

function editStaff(id) {
  openStaffModal(id);
}

function deleteStaff(id) {
  if (!confirm('Delete this staff member? Their commission history in bills will still be retained.')) return;
  const staff = getData(STORAGE_KEYS.staff).filter(s => s.id !== id);
  setData(STORAGE_KEYS.staff, staff);
  renderStaffTable();
  populateStaffDropdown();
  showToast('Staff member deleted', 'warning');
}

// --- Attendance ---
function getAttendanceData() {
  const cached = appCache[STORAGE_KEYS.attendance];
  if (cached && typeof cached === 'object' && !Array.isArray(cached)) return cached;
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEYS.attendance));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      appCache[STORAGE_KEYS.attendance] = data;
      return data;
    }
  } catch { /* ignore */ }
  return {};
}

function saveAttendanceData(data) {
  // Use setData so attendance syncs to Supabase like other stores
  setData(STORAGE_KEYS.attendance, data);
}

function markAttendance(staffId, date, status) {
  const data = getAttendanceData();
  if (!data[date]) data[date] = {};

  if (data[date][staffId] === status) {
    // Toggle off (clicking same status clears it)
    delete data[date][staffId];
  } else {
    data[date][staffId] = status;
  }

  saveAttendanceData(data);
  renderAttendance(date);
  
  // Refresh monthly report if it's showing the same month
  const monthInput = document.getElementById('attendance-month');
  if (monthInput && monthInput.value && date.startsWith(monthInput.value)) {
    renderMonthlyAttendanceReport(monthInput.value);
  }
}

function renderAttendance(dateStr) {
  if (!dateStr) return;

  const staff = getData(STORAGE_KEYS.staff);
  const data = getAttendanceData();
  const dayData = data[dateStr] || {};

  // Summary
  let present = 0, halfday = 0, absent = 0, unmarked = 0;
  staff.forEach(s => {
    const status = dayData[s.id];
    if (status === 'present') present++;
    else if (status === 'halfday') halfday++;
    else if (status === 'absent') absent++;
    else unmarked++;
  });

  const summaryEl = document.getElementById('attendance-summary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <span class="att-summary-pill present">✅ Present: ${present}</span>
      <span class="att-summary-pill halfday">🌓 Half-Day: ${halfday}</span>
      <span class="att-summary-pill absent">❌ Absent: ${absent}</span>
      ${unmarked > 0 ? `<span class="att-summary-pill" style="background:rgba(0,0,0,0.05);color:var(--text-muted);">⬜ Unmarked: ${unmarked}</span>` : ''}
    `;
  }

  // Grid
  const gridEl = document.getElementById('attendance-grid');
  if (!gridEl) return;

  if (staff.length === 0) {
    gridEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-text">No staff to show</div></div>`;
    return;
  }

  gridEl.innerHTML = `<div class="attendance-grid">` + staff.map(s => {
    const status = dayData[s.id] || '';
    return `<div class="attendance-card">
      <div>
        <div class="attendance-name">${esc(s.name)}</div>
        <div class="attendance-role">${esc(s.role || 'Staff')}</div>
      </div>
      <div class="attendance-buttons">
        <button class="att-btn present ${status === 'present' ? 'present' : ''}"
          onclick="markAttendance('${s.id}', '${dateStr}', 'present')">✅ Present</button>
        <button class="att-btn halfday ${status === 'halfday' ? 'halfday' : ''}"
          onclick="markAttendance('${s.id}', '${dateStr}', 'halfday')">🌓 Half</button>
        <button class="att-btn absent ${status === 'absent' ? 'absent' : ''}"
          onclick="markAttendance('${s.id}', '${dateStr}', 'absent')">❌ Absent</button>
      </div>
    </div>`;
  }).join('') + `</div>`;
}

function renderMonthlyAttendanceReport(monthStr) {
  const tbody = document.getElementById('attendance-monthly-report');
  if (!tbody) return;
  
  if (!monthStr) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">📅</div><div class="empty-text">Select a month to view report</div></div></td></tr>';
    return;
  }

  const staff = getData(STORAGE_KEYS.staff);
  const data = getAttendanceData();
  
  if (staff.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="ta-c">No staff added yet.</td></tr>';
    return;
  }

  const stats = {};
  staff.forEach(s => stats[s.id] = { present: 0, halfday: 0, absent: 0 });

  Object.keys(data).forEach(date => {
    if (date.startsWith(monthStr)) {
      const dayData = data[date];
      Object.keys(dayData).forEach(staffId => {
        if (stats[staffId] && stats[staffId][dayData[staffId]] !== undefined) {
          stats[staffId][dayData[staffId]]++;
        }
      });
    }
  });

  tbody.innerHTML = staff.map(s => {
    const st = stats[s.id];
    const effectiveDays = st.present + (st.halfday * 0.5);
    return `<tr>
      <td style="font-weight:700;">${esc(s.name)}</td>
      <td>${esc(s.role || '—')}</td>
      <td style="text-align:center; color:#16a34a; font-weight:600;">${st.present}</td>
      <td style="text-align:center; color:#d97706; font-weight:600;">${st.halfday}</td>
      <td style="text-align:center; color:#dc2626; font-weight:600;">${st.absent}</td>
      <td style="text-align:right; font-weight:700;">${effectiveDays}</td>
    </tr>`;
  }).join('');
}

function openAnalyticsDrilldown(title, bills) {
  document.getElementById('analytics-drilldown-title').textContent = title;
  const tbody = document.getElementById('analytics-drilldown-body');
  
  if (bills.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="ta-c">No data found.</td></tr>';
  } else {
    tbody.innerHTML = bills.map(b => `
      <tr>
        <td>${formatDate(b.date)}</td>
        <td style="font-weight:600;">#${b.billNumber}</td>
        <td>${esc(b.customerName || 'Walk-in')}</td>
        <td>${esc(b.phone || '-')}</td>
        <td style="text-align:right; font-weight:600;">₹${parseFloat(b.grandTotal).toFixed(2)}</td>
      </tr>
    `).join('');
  }
  document.getElementById('analytics-drilldown-modal').classList.add('active');
}

function closeAnalyticsDrilldown() {
  document.getElementById('analytics-drilldown-modal').classList.remove('active');
}
