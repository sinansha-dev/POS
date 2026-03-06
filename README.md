<div align="center">

# 🛒 NovaPOS

**A full-featured, security-hardened Point of Sale system**
built with pure Node.js and Supabase — zero npm bloat, cloud-ready in minutes.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-pos--4nqm.onrender.com-00e5ff?style=for-the-badge&logo=render&logoColor=white)](https://pos-4nqm.onrender.com)
[![Node.js](https://img.shields.io/badge/Node.js-v22+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-MIT-ffd166?style=for-the-badge)](LICENSE)

---

| 🔐 24 Vulnerabilities Fixed | 📦 0 NPM Dependencies | ⚡ 40+ Features | ☁️ Multi-device via Supabase |
|:---:|:---:|:---:|:---:|

</div>

---

## 📋 Table of Contents

- [✨ Features](#-features)
- [🔒 Security](#-security)
- [🛠 Tech Stack](#-tech-stack)
- [🗄 Supabase Setup](#-supabase-setup)
- [💻 Running Locally](#-running-locally)
- [☁️ Deploy to Render](#-deploy-to-render)
- [🔑 Default Credentials](#-default-credentials)
- [📡 API Reference](#-api-reference)
- [🔧 Troubleshooting](#-troubleshooting)

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🧾 Point of Sale
- Fast product search by name or SKU
- Barcode scanner (type SKU + Enter)
- Editable cart quantities inline
- Hold & resume orders
- Cash / Card / Mobile Wallet / Split payment
- GST presets (5%, 12%, 18%, 28%)
- Print receipt or download as `.txt`
- **Refund / return** — restores stock automatically

</td>
<td width="50%">

### 📦 Inventory
- Product catalog with live stock tracking
- ⚠️ Low stock alerts (≤ 5 units, shown in red)
- Add products & update prices by SKU
- Supplier management
- Purchase order system (updates stock on receive)
- Stock transfer between stores
- Batch & expiry date tracking

</td>
</tr>
<tr>
<td>

### 📊 Reports & Dashboard
- Daily sales — last 7 days
- Monthly revenue — last 12 months
- Profit & Loss statement
- Best selling & slow moving products (top 10)
- Cash register summary by payment method
- GST / Tax report
- **Interactive bar + line chart** (Chart.js)

</td>
<td>

### 👥 Users & Customers
- Create / delete users directly from the UI
- Role-based access: **Admin** or **Cashier**
- Reset any user's password
- Customer database with phone number
- Loyalty points & member discounts
- Credit balance tracking

</td>
</tr>
</table>

---

## 🔒 Security

> **24 vulnerabilities were identified and fixed** before the first deployment.

| # | Fix | Details |
|---|-----|---------|
| 🔐 | **Password hashing** | Salt + HMAC-SHA256 — never stored in plaintext |
| 🎫 | **JWT authentication** | All protected routes require a signed token (8hr expiry) |
| 🚦 | **Rate limiting** | 10 login attempts per minute per IP address |
| 🚫 | **File blocking** | `server.js`, `.db`, `.env`, `package.json` blocked from public access |
| 👮 | **Role enforcement** | Admin-only routes verified server-side — not just on the frontend |
| 🧾 | **Cashier identity** | Receipt always uses the authenticated username — cannot be faked |
| 📏 | **Input validation** | Max lengths, type checks, 100 KB request size limit |
| 🛡️ | **Security headers** | `X-Frame-Options`, `HSTS`, `CSP`, `X-Content-Type-Options` |
| 🌐 | **CORS policy** | Configurable `ALLOWED_ORIGIN` environment variable |
| 🗂️ | **Path traversal guard** | `normalize()` + `startsWith()` on every static file request |

---

## 🛠 Tech Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Backend | **Node.js** (ESM, no framework) | Zero dependencies — uses only built-in modules |
| Cloud DB | **Supabase** (PostgreSQL) | Syncs across all devices, free tier available |
| Local DB | **SQLite** (Node built-in) | Automatic fallback when no Supabase env vars are set |
| Auth | **JWT** (manual, no library) | Built with `node:crypto` — HMAC-SHA256 |
| Charts | **Chart.js** (CDN) | Revenue + transaction chart on dashboard |
| Hosting | **Render.com** | Free tier, auto-deploys on every git push |

---

## 🗄 Supabase Setup

### Step 1 — Create a project

1. Go to [supabase.com](https://supabase.com) → **New Project**
2. Choose a name and a strong database password
3. Wait ~1 minute for setup to complete

### Step 2 — Run the schema

Go to **SQL Editor → New Query**, paste the SQL below, and press `Ctrl+Enter`:

```sql
-- Core tables
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT UNIQUE NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
  id BIGSERIAL PRIMARY KEY,
  receipt_no TEXT UNIQUE NOT NULL,
  timestamp TEXT, cashier TEXT,
  payment_method TEXT, subtotal REAL,
  discount REAL, tax REAL, total REAL,
  received REAL, change_amount REAL,
  currency TEXT DEFAULT 'USD'
);

CREATE TABLE IF NOT EXISTS sale_items (
  id BIGSERIAL PRIMARY KEY,
  sale_id BIGINT REFERENCES sales(id),
  product_id UUID, name TEXT, price REAL, qty INTEGER
);

CREATE TABLE IF NOT EXISTS settings        (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS suppliers       (id BIGSERIAL PRIMARY KEY, name TEXT, phone TEXT, email TEXT);
CREATE TABLE IF NOT EXISTS customers       (id BIGSERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, loyalty_points INTEGER DEFAULT 0, member_discount REAL DEFAULT 0, credit_balance REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS purchase_orders (id BIGSERIAL PRIMARY KEY, supplier_id INTEGER, po_number TEXT, status TEXT DEFAULT 'Received', total REAL, created_at TEXT);
CREATE TABLE IF NOT EXISTS stock_transfers (id BIGSERIAL PRIMARY KEY, sku TEXT, qty INTEGER, from_store TEXT, to_store TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS stock_batches   (id BIGSERIAL PRIMARY KEY, sku TEXT, batch_no TEXT, expiry_date TEXT, qty INTEGER);

-- Enable Row Level Security on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_batches ENABLE ROW LEVEL SECURITY;

-- Atomic stock decrement (prevents negative stock)
CREATE OR REPLACE FUNCTION decrement_stock(p_id UUID, p_qty INTEGER)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE products SET stock = GREATEST(stock - p_qty, 0) WHERE id = p_id;
END;
$$;
```

> ✅ You should see: **Success. No rows returned.**

### Step 3 — Get your API keys

Go to **Settings → API** in your Supabase dashboard:
- Copy the **Project URL** → this is your `SUPABASE_URL`
- Copy the **service_role** key → this is your `SUPABASE_KEY`

> ⚠️ **Always use `service_role`** — not the anon key. The anon key will not work because RLS is enabled on all tables.

---

## 💻 Running Locally

```bash
# 1. Clone the repository
git clone https://github.com/sinansha-dev/POS-main.git
cd POS-main

# 2. No dependencies needed — uses Node.js built-ins only
npm install

# 3. Start the server
npm start

# Open http://localhost:4173
```

> 💡 Without Supabase env vars, the server automatically uses a local **SQLite** database. It is created on first run — no setup needed.

---

## ☁️ Deploy to Render

### 1 — Push to GitHub

```bash
git add -A
git commit -m "initial commit"
git push origin main
```

### 2 — Create a Web Service on Render

Go to **render.com → New → Web Service** → connect your GitHub repo:

| Setting | Value |
|---------|-------|
| Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |

### 3 — Add environment variables

In Render → your service → **Environment**:

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_KEY` | your `service_role` key |
| `JWT_SECRET` | any long random string |
| `ALLOWED_ORIGIN` | `https://your-app.onrender.com` |

### 4 — Verify in Render logs

```
✅ NovaPOS running on http://localhost:PORT
🗄️  Using Supabase database
🌱 Seeding default users into Supabase...
✅ Supabase ready!
```

---

## 🔑 Default Credentials

> ⚠️ **Change these passwords immediately after your first login!**

| Username | Password | Role | Can do |
|----------|----------|------|--------|
| `admin` | `admin123` | 🔑 Admin | Everything — products, refunds, reports, manage users, suppliers |
| `cashier` | `cash123` | 👤 Cashier | Make sales, view products, download receipts |

---

## 📡 API Reference

All routes are prefixed with `/api/`. Protected routes require:
```
Authorization: Bearer <token>
```

### Auth & Sales

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/login` | Public | Login — returns JWT token |
| `POST` | `/api/change-password` | User | Change own password |
| `GET` | `/api/bootstrap` | User | Load all app data on startup |
| `POST` | `/api/sales` | User | Complete a sale |
| `POST` | `/api/refund` | User | Refund a sale (restores stock) |
| `DELETE` | `/api/history` | Admin | Clear all sales history |
| `GET` | `/api/reports` | User | All report and chart data |

### Products & Settings

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/products` | Admin | Add new product |
| `PATCH` | `/api/products/:sku/price` | Admin | Update price by SKU |
| `PUT` | `/api/settings` | Admin | Update currency / theme |

### Users

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/users` | Admin | List all users |
| `POST` | `/api/users` | Admin | Create new user |
| `DELETE` | `/api/users/:username` | Admin | Delete a user |
| `POST` | `/api/users/:username/reset-password` | Admin | Reset a user's password |

### Inventory & Customers

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/suppliers` | User | List suppliers |
| `POST` | `/api/suppliers` | Admin | Add supplier |
| `POST` | `/api/purchase-orders` | Admin | Receive PO (updates stock) |
| `POST` | `/api/stock-transfer` | Admin | Record stock transfer |
| `POST` | `/api/stock-batches` | Admin | Add batch / expiry record |
| `GET` | `/api/customers` | User | List customers |
| `POST` | `/api/customers` | Admin | Add customer |

---

## 🔧 Troubleshooting

<details>
<summary><strong>⚠️ Login fails on live site</strong></summary>

Check Render logs for errors. Go to Supabase → Table Editor → `users` and check rows exist. If empty, trigger a redeploy:

```bash
git commit --allow-empty -m "trigger reseed"
git push origin main
```
</details>

<details>
<summary><strong>⚠️ "Internal server error" on API calls</strong></summary>

Check that `SUPABASE_URL` and `SUPABASE_KEY` are correctly set in Render → Environment. Make sure you are using the **service_role** key — not the anon key.
</details>

<details>
<summary><strong>⚠️ Changes not showing after deploy</strong></summary>

Hard refresh: `Ctrl + Shift + R`

Also clear localStorage: DevTools → Application → Local Storage → Clear All
</details>

<details>
<summary><strong>⚠️ Git push rejected</strong></summary>

```bash
git pull origin main --rebase
git push origin main
```
</details>

---

## 📁 Project Structure

```
POS-main/
├── public/
│   ├── index.html      ← Main app + login page
│   ├── script.js       ← All frontend JavaScript
│   └── style.css       ← All styles (dark + light theme)
├── server.js           ← Backend — API routes, auth, DB logic
├── package.json        ← "start": "node server.js"
├── .gitignore          ← Excludes novapos.db and .env
└── README.md           ← This file
```

## 🔄 Git Workflow

```bash
# After making any changes:
git add -A
git commit -m "describe what you changed"
git push origin main        # Render auto-deploys on push

# If push is rejected:
git pull origin main --rebase
git push origin main
```

---

<div align="center">

**MIT License** · Built by [@sinansha-dev](https://github.com/sinansha-dev)

*Node.js · Supabase · Render · Zero dependencies*

</div>
