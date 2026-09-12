-- ==========================================================
-- STEP 3: MIGRATION TO DEDICATED BILLS TABLE (INDIVIDUAL ROWS)
-- ==========================================================

-- 1. Create table for individual bills
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

-- 2. Indexes for fast searches and sorting
CREATE INDEX IF NOT EXISTS idx_kalp_bills_number ON public.kalp_bills (bill_number DESC);
CREATE INDEX IF NOT EXISTS idx_kalp_bills_customer ON public.kalp_bills (customer_name);
CREATE INDEX IF NOT EXISTS idx_kalp_bills_phone ON public.kalp_bills (phone);

-- 3. Enable RLS and public policies
ALTER TABLE public.kalp_bills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anonymous read/write on bills" ON public.kalp_bills;
CREATE POLICY "Allow anonymous read/write on bills" ON public.kalp_bills FOR ALL USING (true) WITH CHECK (true);

-- 4. Enable Realtime broadcast on bills table
DO $$ 
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.kalp_bills;
EXCEPTION WHEN duplicate_object THEN 
  NULL; 
END $$;

-- 5. Automatically unpack all 585+ bills from existing kalp_store into individual rows
INSERT INTO public.kalp_bills (id, bill_number, customer_name, phone, date, grand_total, raw_data, created_at, updated_at)
SELECT
    (elem->>'id')::bigint AS id,
    COALESCE((elem->>'billNumber')::bigint, 0) AS bill_number,
    COALESCE(elem->>'customerName', 'Walk-in Customer') AS customer_name,
    COALESCE(elem->>'phone', '') AS phone,
    COALESCE(NULLIF(elem->>'date', '')::date, CURRENT_DATE) AS date,
    COALESCE((elem->>'grandTotal')::numeric, 0) AS grand_total,
    elem AS raw_data,
    COALESCE(NULLIF(elem->>'createdAt', '')::timestamptz, NOW()) AS created_at,
    COALESCE(NULLIF(elem->>'updatedAt', '')::timestamptz, NOW()) AS updated_at
FROM public.kalp_store,
     jsonb_array_elements(value) AS elem
WHERE key = 'kalp_bills'
ON CONFLICT (id) DO UPDATE SET
    bill_number = EXCLUDED.bill_number,
    customer_name = EXCLUDED.customer_name,
    phone = EXCLUDED.phone,
    date = EXCLUDED.date,
    grand_total = EXCLUDED.grand_total,
    raw_data = EXCLUDED.raw_data,
    updated_at = NOW();

-- 6. Set sequence counter starting after highest bill number
CREATE SEQUENCE IF NOT EXISTS kalp_bill_seq;
SELECT setval('kalp_bill_seq', COALESCE((SELECT MAX(bill_number) FROM public.kalp_bills), 0) + 1);