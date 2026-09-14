# KALP — Online Hosting (Supabase Free Tier)

Static PWA (HTML/CSS/JS) + Supabase Postgres. No Node backend required.

## What is already live

- **Cloud DB:** `https://hrdirkxtydyprrqexnln.supabase.co` (585 bills + inventory/orders/staff)
- **Frontend (existing):** https://kalp-billing.vercel.app/
- **Full data backup:** `backups/kalp_backup_2026-09-11.json`
- **Excel files in `backups/`:** monthly/all-time *reports* (not a full DB restore). Use the JSON backup to seed.

## Fresh Supabase project (optional)

1. Create a free project at https://supabase.com
2. SQL Editor → paste & run `supabase/schema.sql`
3. Project Settings → API → copy **Project URL** and **anon / publishable key**
4. Seed data:

```bash
python3 scripts/push_backup_to_supabase.py \
  --backup backups/kalp_backup_2026-09-11.json \
  --url https://YOUR_PROJECT.supabase.co \
  --key YOUR_ANON_KEY
```

5. In the app: **Shop Details → Cloud Database Sync** → paste URL + key → **Connect & Sync Cloud**

## Deploy frontend (Vercel)

```bash
npx vercel --prod
```

Or connect this folder to a GitHub repo and import it in the Vercel dashboard (framework: Other / static).

## Local test

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

On first load the app pulls from Supabase so a blank browser still gets full shop data.
