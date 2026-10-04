/**
 * restore_to_supabase.js
 * Reads temp/kalp_backup_2026-10-02.json and restores all data to Supabase.
 *
 * Usage:
 *   cd /Users/mohitsherkhane/Desktop/KALP
 *   node scripts/restore_to_supabase.js
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase credentials (same as in app.js) ─────────────────────────────
const SUPABASE_URL = 'https://hrdirkxtydyprrqexnln.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ES0G9ef3bF6Ht217PGHDWg_2uWd1jFB';

// ── Keys that go into kalp_store ─────────────────────────────────────────
const STORE_KEYS = [
  'kalp_inventory',
  'kalp_barcodes',
  'kalp_orders',
  'kalp_adjustments',
  'kalp_deleted_bills',
  'kalp_consignments',
  'kalp_shop_details',
  'kalp_theme',
  'kalp_bill_counter',
  'kalp_barcode_counter',
  'kalp_staff',
  'kalp_attendance',
];

// Helper: parse value (all values in backup are JSON strings or plain strings)
function parseVal(v) {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

async function main() {
  console.log('🚀 KALP Supabase Restore Script');
  console.log('================================\n');

  // 1. Load backup — accepts --backup /path/to/file.json or uses default
  const cliArg = process.argv.find(a => a.startsWith('--backup=') || a === '--backup');
  let backupPath;
  if (cliArg === '--backup') {
    backupPath = process.argv[process.argv.indexOf('--backup') + 1];
  } else if (cliArg && cliArg.startsWith('--backup=')) {
    backupPath = cliArg.split('=').slice(1).join('=');
  } else {
    backupPath = path.join(__dirname, '..', 'kalp_backup_2026-10-03 (3).json');
  }
  if (!fs.existsSync(backupPath)) {
    console.error('❌ Backup file not found:', backupPath);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  console.log('✅ Backup loaded:', backupPath);

  // 2. Init Supabase
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('✅ Supabase client initialized\n');

  let totalSuccess = 0;
  let totalErrors = 0;

  // ── STEP 1: Restore bills into kalp_bills table ───────────────────────
  console.log('📋 Step 1: Restoring bills into kalp_bills...');
  const bills = parseVal(raw['kalp_bills']) || [];
  console.log(`   Found ${bills.length} bills in backup`);

  const BATCH_SIZE = 50;
  for (let i = 0; i < bills.length; i += BATCH_SIZE) {
    const batch = bills.slice(i, i + BATCH_SIZE);
    const rows = batch.map(b => ({
      id: b.id,
      bill_number: b.billNumber,
      customer_name: b.customerName || 'Walk-in Customer',
      phone: b.phone || '',
      date: b.date || new Date().toISOString().split('T')[0],
      grand_total: b.grandTotal || 0,
      raw_data: b,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from('kalp_bills').upsert(rows, { onConflict: 'id' });
    if (error) {
      console.error(`   ❌ Batch ${i + 1}–${i + batch.length} failed:`, error.message);
      totalErrors += batch.length;
    } else {
      process.stdout.write(`   ✅ Bills ${i + 1}–${Math.min(i + BATCH_SIZE, bills.length)} / ${bills.length}\r`);
      totalSuccess += batch.length;
    }
  }
  console.log(`\n   Done — ${totalSuccess} bills upserted, ${totalErrors} errors\n`);

  // ── STEP 2: Restore all other keys into kalp_store ───────────────────
  console.log('🗄️  Step 2: Restoring all other data into kalp_store...');

  for (const key of STORE_KEYS) {
    if (!(key in raw)) {
      console.log(`   ⚠️  ${key}: not in backup, skipping`);
      continue;
    }
    const value = parseVal(raw[key]);

    const { error } = await supabase
      .from('kalp_store')
      .upsert(
        { key, value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );

    if (error) {
      console.error(`   ❌ ${key}: ${error.message}`);
      totalErrors++;
    } else {
      const desc = Array.isArray(value) ? `${value.length} records` : JSON.stringify(value).slice(0, 60);
      console.log(`   ✅ ${key}: ${desc}`);
      totalSuccess++;
    }
  }

  // ── Final summary ─────────────────────────────────────────────────────
  console.log('\n================================');
  console.log(`✅ Restore complete!`);
  console.log(`   Bills: ${bills.length} upserted to kalp_bills`);
  console.log(`   Store: ${STORE_KEYS.length} keys upserted to kalp_store`);
  if (totalErrors > 0) {
    console.log(`   ⚠️  ${totalErrors} errors — check output above`);
  }
  console.log('\n📱 Open the app → click the sync badge (top of sidebar) to pull on any device.');
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
