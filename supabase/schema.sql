-- ============================================================
-- KALP — Supabase Free Tier Schema
-- Run this once in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- 1) Key-value store for inventory, orders, barcodes, staff, etc.
CREATE TABLE IF NOT EXISTS public.kalp_store (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kalp_store_updated
  ON public.kalp_store (updated_at DESC);

ALTER TABLE public.kalp_store ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anonymous read/write on store" ON public.kalp_store;
CREATE POLICY "Allow anonymous read/write on store"
  ON public.kalp_store FOR ALL USING (true) WITH CHECK (true);

-- 2) Individual bills (realtime + searchable)
CREATE TABLE IF NOT EXISTS public.kalp_bills (
    id BIGINT PRIMARY KEY,
    bill_number BIGINT NOT NULL,
    customer_name TEXT,
    phone TEXT,
    date DATE,
    grand_total NUMERIC,
    raw_data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kalp_bills_number ON public.kalp_bills (bill_number DESC);
CREATE INDEX IF NOT EXISTS idx_kalp_bills_customer ON public.kalp_bills (customer_name);
CREATE INDEX IF NOT EXISTS idx_kalp_bills_phone ON public.kalp_bills (phone);
CREATE INDEX IF NOT EXISTS idx_kalp_bills_date ON public.kalp_bills (date DESC);

ALTER TABLE public.kalp_bills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anonymous read/write on bills" ON public.kalp_bills;
CREATE POLICY "Allow anonymous read/write on bills"
  ON public.kalp_bills FOR ALL USING (true) WITH CHECK (true);

-- 3) Realtime for multi-device bill sync
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.kalp_bills;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- 4) Bill number sequence helper (optional; app also tracks counter in kalp_store)
CREATE SEQUENCE IF NOT EXISTS kalp_bill_seq START 1;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON public.kalp_store TO anon, authenticated;
GRANT ALL ON public.kalp_bills TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE kalp_bill_seq TO anon, authenticated;
