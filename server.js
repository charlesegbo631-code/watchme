// server.js — Clean dropship store with live USD→NGN conversion for OPay + Paystack + ship.html frontend
require("dotenv").config();
const express = require("express");
const path = require("path");
const axios = require("axios");
const nodemailer = require("nodemailer");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Config & Init ----------
console.log("🔑 Paystack Key starts with:", process.env.PAYSTACK_SECRET_KEY?.slice(0, 6));

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || "587", 10),
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.MY_EMAIL,
    pass: process.env.MY_EMAIL_PASSWORD,
  },
});

// SQLite DB init
let db;
(async () => {
  db = await open({
    filename: path.join(__dirname, "dropship.db"),
    driver: sqlite3.Database,
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_order_id TEXT,
      payment_id TEXT UNIQUE,
      status TEXT,
      customer_name TEXT,
      customer_email TEXT,
      items_json TEXT,
      total_cents_usd INTEGER,
      total_kobo_ngn INTEGER,
      supplier_share_cents INTEGER,
      profit_cents INTEGER,
      supplier_response TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      title TEXT,
      price_usd_cents INTEGER,
      supplierCost_usd_cents INTEGER,
      supplier_sku TEXT,
      img TEXT
    )
  `);
  console.log("📦 DB ready");
})();

// Basic middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Helpers ----------
function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (Number.isInteger(n) && n > 1000) return n; // already cents
  return Math.round(n * 100); // assume dollars
}

function fromCents(cents) {
  return (cents || 0) / 100;
}

async function fetchUsdToNgnRate() {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  if (!apiKey) throw new Error("Missing EXCHANGE_RATE_API_KEY");

  // 👇 THIS is the url
  const resp = await axios.get(
    `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`
  );

  const rate = resp.data?.conversion_rates?.NGN;
  if (!rate) throw new Error("Could not get NGN rate");
  return rate;
}


async function createDraftOrder({
  paymentId,
  cartItems,
  customer,
  usdTotalCents,
  koboTotal,
  supplierTotal,
  profitCents,
}) {
  const local_order_id = "o" + Date.now();
  await db.run(
    `INSERT OR IGNORE INTO orders
     (local_order_id, payment_id, status, customer_name, customer_email, items_json,
      total_cents_usd, total_kobo_ngn, supplier_share_cents, profit_cents)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    local_order_id,
    paymentId,
    "pending",
    customer?.name || "",
    customer?.email || "",
    JSON.stringify(cartItems || []),
    usdTotalCents,
    koboTotal,
    supplierTotal,
    profitCents
  );
  return local_order_id;
}

// ---------- Product Endpoints ----------
app.get("/api/products", async (req, res) => {
  try {
    const usdToNgn = await fetchUsdToNgnRate();
    let products = await db.all("SELECT * FROM products ORDER BY rowid DESC");

    products = products.map((p) => {
      const usdPrice = fromCents(p.price_usd_cents);
      const ngnPrice = usdPrice * usdToNgn;
      return {
        ...p,
        price_usd: usdPrice,
        price_ngn: ngnPrice,
        supplierCost_usd: fromCents(p.supplierCost_usd_cents),
      };
    });

    res.json({ success: true, products });
  } catch (err) {
    console.error("GET /api/products error", err);
    res.status(500).json({ success: false, error: "DB error" });
  }
});


app.get("/api/orders", async (req, res) => {
  try {
    const rows = await db.all("SELECT * FROM orders ORDER BY created_at DESC");
    res.json({ success: true, orders: rows });
  } catch (err) {
    console.error("GET /api/orders error", err);
    res.json({ success: false, message: err.message });
  }
});

app.post("/api/add-product", async (req, res) => {
  try {
    const { id, title, price, supplierCost, supplier_sku, img } = req.body;
    if (!title || price == null) {
      return res.status(400).json({ success: false, message: "title & price required" });
    }
    const pid = id || "p" + Date.now();
    const priceUsd = toCents(price);
    const costUsd = toCents(supplierCost || 0);
    await db.run(
      `INSERT OR REPLACE INTO products (id, title, price_usd_cents, supplierCost_usd_cents, supplier_sku, img)
       VALUES (?,?,?,?,?,?)`,
      pid,
      title,
      priceUsd,
      costUsd,
      supplier_sku || "",
      img || ""
    );
    const product = await db.get("SELECT * FROM products WHERE id = ?", pid);
    res.json({
      success: true,
      product: {
        ...product,
        price: fromCents(product.price_usd_cents),
        supplierCost: fromCents(product.supplierCost_usd_cents),
      },
    });
  } catch (err) {
    console.error("POST /api/add-product error", err);
    res.status(500).json({ success: false, error: "DB insert error" });
  }
});

app.delete("/api/delete-product/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.run("DELETE FROM products WHERE id = ?", id);
    res.json({ success: true, message: `Deleted ${id}` });
  } catch (err) {
    console.error("DELETE product error", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.get("/api/rates", async (req, res) => {
  try {
    const usdToNgn = await fetchUsdToNgnRate();
    res.json({ success: true, rates: { USD: 1, NGN: usdToNgn } });
  } catch (err) {
    console.error("GET /api/rates error", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Paystack ----------
// ✅ Create Paystack Order
// ---------- Paystack ----------
// ✅ Create Paystack Order (improved logging)
async function createPaystackOrderHandler(req, res) {
  try {
    console.log("📥 Incoming /api/create-paystack-order body:", JSON.stringify(req.body, null, 2));

    const { cartItems, customer } = req.body;

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ success: false, message: "cartItems required" });
    }

    // --- Calculate totals (USD cents -> USD)
    let usdTotal = 0;
    let usdSupplierTotal = 0;
    for (const it of cartItems) {
      const price = toCents(it.price);
      const cost = toCents(it.supplierCost || 0);
      const qty = parseInt(it.quantity || 1, 10);
      usdTotal += price * qty;
      usdSupplierTotal += cost * qty;
    }

    
  // 1. Get live USD → NGN rate
const usdToNgn = await fetchUsdToNgnRate();

// 2. Convert the cart total from USD → NGN
const totalUsd = fromCents(usdTotal);
const totalNaira = totalUsd * usdToNgn;

// 3. Paystack needs kobo (₦ × 100)
const totalKobo = Math.round(totalNaira * 100);

// 4. Build Paystack payload
const payload = {
  email: customer?.email || "guest@example.com",
  amount: totalKobo,   // ✅ now correct in kobo
  currency: "NGN",     // ✅ Paystack knows it's naira
  metadata: { cartItems, customer }
};
const url = "https://api.paystack.co/transaction/initialize";

    const headers = {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json"
    };

    // --- DEBUG: outgoing request details
    console.log("▶️ Paystack INIT call");
    console.log("URL:", url);
    console.log("Payload:", JSON.stringify(payload, null, 2));
    // don't log full secret; show masked
    console.log("Authorization:", typeof process.env.PAYSTACK_SECRET_KEY === "string" ? process.env.PAYSTACK_SECRET_KEY.slice(0,6) + "...(masked)" : process.env.PAYSTACK_SECRET_KEY);

    // --- Perform request
    const response = await axios.post(url, payload, { headers, timeout: 20000 });

    // --- DEBUG: response details
    console.log("✅ Paystack responded (status):", response.status);
    console.log("Paystack body:", JSON.stringify(response.data, null, 2));

    // Save draft order
    await createDraftOrder({
      paymentId: response.data.data.reference,
      cartItems,
      customer,
      usdTotalCents: usdTotal,
      koboTotal: totalKobo,
      supplierTotal: usdSupplierTotal,
      profitCents: usdTotal - usdSupplierTotal
    });

    return res.json({
      success: true,
      authorizationUrl: response.data.data.authorization_url,
      reference: response.data.data.reference,
      totalUsd: totalUsd,
      totalKobo
    });
  } catch (err) {
    console.error("❌ create-paystack-order error");

    // axios error -> show config, request, response (if present)
    if (err.config) {
      console.error("axios config/url:", err.config.url, err.config.method);
    }
    if (err.request) {
      console.error("axios request made but no response (request object):", err.request && err.request._header ? "(has headers)" : "(no headers shown)");
    }
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Response headers:", err.response.headers);
      console.error("Response data:", typeof err.response.data === "string" ? err.response.data : JSON.stringify(err.response.data, null, 2));
    } else {
      console.error("Error message:", err.message);
    }

    return res.status(500).json({ success: false, error: err.message || "Paystack request failed" });
  }
}

app.post("/api/create-paystack-order", createPaystackOrderHandler);

// ✅ Verify Paystack Payment
async function verifyPaystackPayment(req, res) {
  try {
    const { reference } = req.query;
    if (!reference) {
      return res
        .status(400)
        .json({ success: false, message: "Reference required" });
    }

    console.log("👉 Verifying Paystack payment for reference:", reference);

    const verifyResp = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    console.log("✅ Verify response:", JSON.stringify(verifyResp.data, null, 2));

    const data = verifyResp.data.data;

    if (data.status === "success") {
      await db.run(
        `UPDATE orders
         SET status = ?, processed_at = CURRENT_TIMESTAMP
         WHERE payment_id = ?`,
        "paid",
        reference
      );

      return res.json({
        success: true,
        message: "Payment verified",
        order: data,
      });
    } else {
      console.warn("⚠️ Payment not successful:", data);
      return res.status(400).json({ success: false, message: "Payment failed" });
    }
  } catch (err) {
    console.error("❌ verify-paystack error");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error("Message:", err.message);
    }
    res.status(500).json({ success: false, error: err.message });
  }
} // 👈 closes the function

// now you can register it:
app.get("/api/paystack-callback", verifyPaystackPayment);


// ---------- OPay ----------
async function createOpayOrderHandler(req, res) {
  try {
    const { cartItems, customer } = req.body;
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ success: false, message: "cartItems required" });
    }

    let usdTotal = 0;
    for (const it of cartItems) {
      const price = toCents(it.price);
      const qty = parseInt(it.quantity || 1, 10);
      usdTotal += price * qty;
    }

    const usdToNgn = await fetchUsdToNgnRate();
    const totalUsd = fromCents(usdTotal);
    const totalNaira = totalUsd * usdToNgn;
    const totalKobo = Math.round(totalNaira * 100);

    const reference = "opay_ref_" + Date.now();

    const opayBody = {
      reference,
      amount: totalKobo,
      currency: "NGN",
      country: "NG",
      payType: "WEB",
      userInfo: {
        userId: customer?.email || "guest",
        name: customer?.name || "Anonymous",
      },
      callbackUrl: process.env.OPAY_CALLBACK_URL,
      returnUrl: process.env.OPAY_RETURN_URL,
    };

    const signature = crypto
      .createHmac("sha512", process.env.OPAY_SECRET_KEY)
      .update(JSON.stringify(opayBody))
      .digest("hex");

    const opayResp = await axios.post(`${process.env.OPAY_BASE_URL}/invoices/create`, opayBody, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPAY_PUBLIC_KEY}`,
        SIGNATURE: signature,
      },
    });

    await createDraftOrder({
      paymentId: reference,
      cartItems,
      customer,
      usdTotalCents: usdTotal,
      koboTotal: totalKobo,
      supplierTotal: 0,
      profitCents: 0,
    });

    res.json({ success: true, data: opayResp.data, reference, totalKobo, rate: usdToNgn });
  } catch (err) {
    console.error("create-opay-order error", err.response?.data || err);
    res.status(500).json({ success: false, error: err.message });
  }
}

app.post("/api/create-opay-order", createOpayOrderHandler);
app.post("/api/create-opay-session", createOpayOrderHandler);

// ---------- Serve Frontend ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ship.html"));
});

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
