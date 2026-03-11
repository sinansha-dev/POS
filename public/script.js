// ── STATE ─────────────────────────────────────────────────────
const state = {
  products: [], cart: [], history: [], categories: [],
  currentUser: null, currency: "INR", theme: "light",
  heldOrders: JSON.parse(localStorage.getItem("novapos_held_orders") || "[]"),
  customers: [], suppliers: [], reports: {}, taxCodes: [],
  saleKey: crypto.randomUUID(), // idempotency key — regenerated after each sale
  reportRange: { from: null, to: null }, // persists active date filter across bootstrap reloads
};

const productGrid    = document.getElementById("productGrid");
const cartBody       = document.getElementById("cartBody");
const historyBody    = document.getElementById("historyBody");
const receiptContent = document.getElementById("receiptContent");
const cashierNameInput = document.getElementById("cashierName");
const currencySelect = document.getElementById("currencySelect");
const darkModeBtn    = document.getElementById("darkModeBtn");
const productSearch  = document.getElementById("productSearch");
const barcodeInput   = document.getElementById("barcodeInput");

function saveToken(token, user) {
  sessionStorage.setItem("novapos_token", token);
  sessionStorage.setItem("novapos_user", JSON.stringify(user));
  localStorage.setItem("novapos_token", token);
  localStorage.setItem("novapos_user", JSON.stringify(user));
}
function getToken() { return sessionStorage.getItem("novapos_token") || localStorage.getItem("novapos_token"); }
function getSavedUser() {
  try { const u = sessionStorage.getItem("novapos_user") || localStorage.getItem("novapos_user"); return u ? JSON.parse(u) : null; }
  catch { return null; }
}
function clearToken() {
  ["novapos_token","novapos_user"].forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); });
}

async function api(url, options = {}) {
  const token = getToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  if (options.headers) Object.assign(headers, options.headers);
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) { clearToken(); state.currentUser = null; applySessionState(); throw new Error("Session expired. Please login again."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "API error");
  return data;
}

function applyTheme() {
  document.body.dataset.theme = state.theme;
  if (darkModeBtn) darkModeBtn.textContent = state.theme === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode";
}
function applySessionState() {
  const logged  = Boolean(state.currentUser);
  const isAdmin = state.currentUser?.role === "admin";
  document.body.classList.toggle("authenticated", logged);
  // Show/hide Admin button in topbar
  const adminBtn = document.getElementById("adminDashBtn");
  if (adminBtn) adminBtn.style.display = isAdmin ? "inline-flex" : "none";
  // If logged out while dashboard open, close it
  if (!isAdmin) closeAdminDashboard();
  if (cashierNameInput) { cashierNameInput.value = state.currentUser?.username || ""; cashierNameInput.disabled = true; }
}

function money(v) { return new Intl.NumberFormat("en-US", { style: "currency", currency: state.currency }).format(v || 0); }

function extractInclusiveTax(amount, gstRate) {
  const rate = Number(gstRate || 0);
  const gross = Number(amount || 0);
  if (!rate || gross <= 0) return { gross, gst: 0, base: gross, cgst: 0, sgst: 0 };
  const gst = +(gross * rate / (100 + rate)).toFixed(2);
  const base = +(gross - gst).toFixed(2);
  const cgst = +(gst / 2).toFixed(2);
  return { gross, gst, base, cgst, sgst: +(gst - cgst).toFixed(2) };
}

function saleTotals() {
  const subtotal     = state.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const discountRate = Number(document.getElementById("discount")?.value || 0) / 100;
  const discountAmt  = subtotal * discountRate;
  // GST-inclusive pricing: GST is extracted from selling price, not added on top.
  const taxAmount = +state.cart.reduce((sum, i) => {
    const lineVal  = i.price * i.qty;
    const lineDisc = lineVal * discountRate;
    return sum + extractInclusiveTax(lineVal - lineDisc, i.gstRate || 0).gst;
  }, 0).toFixed(2);
  const total   = +Math.max(subtotal - discountAmt, 0).toFixed(2);
  const pm      = document.getElementById("paymentMethod")?.value;
  const splitTotal = ["splitCash","splitCard","splitWallet"].reduce((s, id) => s + Number(document.getElementById(id)?.value || 0), 0);
  const received = pm === "Split" ? splitTotal : Number(document.getElementById("amountReceived")?.value || 0);
  return { subtotal, discountAmount: discountAmt, taxAmount, total, received, change: Math.max(received - total, 0) };
}
function renderTotals() {
  const t = saleTotals();
  document.getElementById("subtotal").textContent      = money(t.subtotal);
  document.getElementById("discountValue").textContent = `-${money(t.discountAmount)}`;
  document.getElementById("taxValue").textContent = money(t.taxAmount);
  const gbEl = document.getElementById("gstBreakdown"); if(gbEl) gbEl.textContent = buildGstBreakdownLine();
  document.getElementById("grandTotal").textContent    = money(t.total);
  document.getElementById("changeDue").textContent     = money(t.change);
}

function renderKpis() {
  const today    = new Date().toDateString();
  const todaySales = state.history.filter(h => h.total > 0 && new Date(h.timestamp).toDateString() === today);
  const revenue  = todaySales.reduce((s, h) => s + (h.total || 0), 0);
  const txns     = todaySales.length;
  document.getElementById("kpiRevenue").textContent      = money(revenue);
  document.getElementById("kpiTransactions").textContent = String(txns);
  document.getElementById("kpiAverage").textContent      = money(txns ? revenue / txns : 0);
  document.getElementById("kpiLowStock").textContent     = String(state.products.filter(p => p.stock <= 5).length);
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  state.products  = data.products  || [];
  state.history   = data.history   || [];
  state.currency  = data.settings?.currency || "INR";
  state.theme     = data.settings?.theme    || "light";
  state.customers  = data.customers  || [];
  state.suppliers  = data.suppliers  || [];
  state.categories = data.categories || [];
  state.taxCodes = data.taxCodes || [];
  state.reports    = data.reports    || {};
  currencySelect.value = state.currency;
  applyTheme();
  renderProducts(); renderHistory(); renderCart(); renderKpis(); renderCustomers(); renderSuppliersTable(); renderInventoryTable(); refreshSkuList(); renderCategoryOptions(); renderCategoriesTable();
  await loadReports(state.reportRange.from, state.reportRange.to);
  if (state.currentUser?.role === "admin") await loadUsers();
}

function renderProducts() {
  productGrid.innerHTML = "";
  const term     = (productSearch?.value || "").trim().toLowerCase();
  const filtered = state.products.filter(p => !term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term));
  if (!filtered.length) { productGrid.innerHTML = "<p style='color:var(--muted);padding:1rem'>No products found.</p>"; return; }
  filtered.forEach(p => {
    const card = document.createElement("div");
    card.className = "product-card";
    const hsnBadge = p.hsn_code ? `<small class="hsn-badge">HSN ${p.hsn_code}</small>` : '';
    const gstBadge = `<small class="gst-badge ${(p.gst_rate||0)===0?'exempt':''}">GST ${p.gst_rate||0}%</small>`;
    card.innerHTML = `<strong>${p.name}</strong><small>SKU: ${p.sku}</small><div style="display:flex;gap:4px;flex-wrap:wrap;margin:2px 0">${hsnBadge}${gstBadge}</div><small>${money(p.price)}</small><small class="stock ${p.stock <= 5 ? "low" : ""}">Stock: ${p.stock}</small><button class="btn" ${p.stock <= 0 ? "disabled" : ""}>Add</button>`;
    card.querySelector("button").onclick = () => addToCart(p.id);
    productGrid.appendChild(card);
  });
}

function addToCart(id) {
  const product = state.products.find(p => p.id === id);
  if (!product || product.stock <= 0) return;
  const existing = state.cart.find(i => i.productId === id);
  if (existing) { if (existing.qty >= product.stock) { alert("Cannot exceed available stock."); return; } existing.qty++; }
  else state.cart.push({ productId: id, name: product.name, price: product.price, qty: 1, hsnCode: product.hsn_code||null, gstRate: product.gst_rate||0 });
  renderCart();
}
function removeFromCart(productId) { state.cart = state.cart.filter(l => l.productId !== productId); renderCart(); }
function renderCart() {
  cartBody.innerHTML = "";
  state.cart.forEach(item => {
    const row = document.createElement("tr");
    const line = extractInclusiveTax(item.price * item.qty, item.gstRate || 0);
    row.innerHTML = `
      <td>${item.name}${item.hsnCode ? `<br><small style="color:var(--muted);font-size:0.7rem;font-family:monospace">HSN: ${item.hsnCode}</small>` : ''}</td>
      <td><input type="number" min="1" value="${item.qty}" style="width:54px;border:1px solid var(--border);border-radius:6px;padding:2px 5px;background:var(--surface);color:var(--text)"/></td>
      <td>${money(item.price)}<br><small style="color:var(--muted);font-size:0.7rem">GST incl. @ ${item.gstRate||0}%</small></td>
      <td>${money(line.gross)}<br><small style="color:var(--muted);font-size:0.7rem">GST incl.: ${money(line.gst)}</small></td>
      <td><button class="btn danger" type="button" style="padding:0.2rem 0.5rem">×</button></td>`;
    row.querySelector("input").addEventListener("change", e => {
      const v = parseInt(e.target.value); const p = state.products.find(x => x.id === item.productId);
      if (v < 1) { removeFromCart(item.productId); return; }
      item.qty = p && v > p.stock ? (e.target.value = p.stock, p.stock) : v; renderTotals();
    });
    row.querySelector("button").addEventListener("click", () => removeFromCart(item.productId));
    cartBody.appendChild(row);
  });
  renderTotals();
}

function handleBarcode(e) {
  if (e.key !== "Enter") return; e.preventDefault();
  const val = barcodeInput.value.trim().toLowerCase(); if (!val) return;
  const p = state.products.find(p => p.sku.toLowerCase() === val || p.name.toLowerCase() === val);
  barcodeInput.value = "";
  if (p) { addToCart(p.id); barcodeInput.placeholder = `✅ Added: ${p.name}`; }
  else barcodeInput.placeholder = `❌ Not found: ${val}`;
  setTimeout(() => { barcodeInput.placeholder = "Scan barcode / enter SKU then press Enter"; }, 2000);
}

function saveHeldOrders() { localStorage.setItem("novapos_held_orders", JSON.stringify(state.heldOrders)); }
function holdCurrentOrder() {
  if (!state.cart.length) { alert("Cart is empty."); return; }
  state.heldOrders.push({ id: crypto.randomUUID(), cart: structuredClone(state.cart), discount: document.getElementById("discount").value, tax: document.getElementById("tax").value, at: new Date().toLocaleTimeString() });
  saveHeldOrders(); resetSale(); alert("Order held successfully.");
}
function resumeHeldOrder() {
  if (!state.heldOrders.length) { alert("No held orders."); return; }
  const held = state.heldOrders.shift();
  state.cart = held.cart || []; document.getElementById("discount").value = held.discount || "0"; document.getElementById("tax").value = held.tax || "10";
  saveHeldOrders(); renderCart();
}

function renderHistory() {
  historyBody.innerHTML = "";
  if (!state.history.length) { historyBody.innerHTML = "<tr><td colspan='7' style='color:var(--muted);text-align:center;padding:1rem'>No sales yet</td></tr>"; return; }
  state.history.forEach(sale => {
    const isRefund = (sale.total || 0) < 0 || sale.receiptNo?.startsWith("REF-");
    const row = document.createElement("tr");
    row.style.background = isRefund ? "rgba(220,38,38,0.06)" : "";
    row.innerHTML = `<td style="font-family:monospace;font-size:0.8rem">${sale.receiptNo}</td><td style="font-size:0.82rem">${new Date(sale.timestamp).toLocaleString()}</td><td>${sale.cashier||"-"}</td><td>${sale.items?.length||0}</td><td>${sale.paymentMethod||"-"}</td><td style="font-weight:600;color:${isRefund?"var(--danger)":"var(--success)"}">${money(sale.total)}</td><td>${isRefund ? '<span style="font-size:0.72rem;color:var(--danger);font-weight:600">REFUNDED</span>' : '<button class="btn ghost" style="padding:0.2rem 0.5rem;font-size:0.75rem">↩ Refund</button>'}</td>`;
    if (!isRefund) row.querySelector("button").addEventListener("click", () => openRefundDialog(sale.receiptNo, sale.total));
    historyBody.appendChild(row);
  });
}

function openRefundDialog(receiptNo, amount) {
  const reason = prompt(`Refund Receipt: ${receiptNo}\nAmount: ${money(amount)}\n\nEnter reason (or press OK):`);
  if (reason === null) return;
  processRefund(receiptNo, reason || "No reason");
}
async function processRefund(receiptNo, reason) {
  try {
    const data = await api("/api/refund", { method: "POST", body: JSON.stringify({ receiptNo, reason }) });
    alert(`✅ Refund Successful!\nRefund No: ${data.refundNo}\nAmount: ${money(data.amount)}`);
    await loadBootstrap();
  } catch (err) { alert("❌ Refund failed: " + err.message); }
}

let chartInstance = null;
let checkoutInFlight = false;
async function loadReports(fromDate = null, toDate = null) {
  try {
    let url = "/api/reports";
    const params = [];
    if (fromDate) params.push(`from=${fromDate}`);
    if (toDate)   params.push(`to=${toDate}`);
    if (params.length) url += "?" + params.join("&");
    const data = await api(url);
    if (data.reports) state.reports = data.reports;
  } catch {}
  renderReports();
}

function renderReports() {
  const r = state.reports;
  const listHtml = (items, fn) => items?.length ? items.map(fn).join("") : "<li style='color:var(--muted);font-size:0.85rem'>No data yet</li>";

  const dailyEl = document.getElementById("dailySalesReport");
  if (dailyEl) dailyEl.innerHTML = listHtml((r.dailySales||[]).slice(0,7), d =>
    `<li style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border)"><span style="font-size:0.83rem">${d.day}</span><span><strong>${money(d.revenue)}</strong> <small style="color:var(--muted)">${d.transactions} txns</small></span></li>`);

  const monthEl = document.getElementById("monthlyRevenueReport");
  if (monthEl) monthEl.innerHTML = listHtml((r.monthlyRevenue||[]).slice(0,6), m =>
    `<li style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border)"><span style="font-size:0.83rem">${m.month}</span><strong>${money(m.revenue)}</strong></li>`);

  const plEl = document.getElementById("profitLossReport");
  if (plEl) {
    const p = r.profitLoss||{};
    const range = r.range?.from ? ` (${r.range.from} → ${r.range.to||"today"})` : " (All time)";
    plEl.textContent = `${range}\nRevenue:        ${money(p.revenue||0)}\nCost of Goods:  ${money(p.cogs||0)}\n─────────────────────────\nGross Profit:   ${money(p.grossProfit||0)}\nStock Value:    ${money(p.stockValue||0)}`;
  }

  const bestEl = document.getElementById("bestSellingReport");
  if (bestEl) bestEl.innerHTML = listHtml((r.bestSelling||[]).slice(0,8), (p,i) =>
    `<li style="display:flex;justify-content:space-between;padding:0.3rem 0"><span style="font-size:0.83rem">${i+1}. ${p.name}</span><span style="text-align:right"><strong style="color:var(--success)">${p.qty} sold</strong>${p.cogs ? `<br><small style="color:var(--muted)">COGS ${money(p.cogs)}</small>` : ""}</span></li>`);

  const slowEl = document.getElementById("slowMovingReport");
  if (slowEl) slowEl.innerHTML = listHtml((r.slowMoving||[]).slice(0,10), p =>
    `<li style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border)">
      <span><span style="font-size:0.83rem">${p.name}</span><br><small style="color:var(--muted);font-family:monospace">${p.sku||""}</small></span>
      <span style="text-align:right;flex-shrink:0;margin-left:0.5rem"><strong style="color:var(--danger)">${p.qty} sold</strong><br><small style="color:var(--muted)">stock: ${p.stock}</small></span>
    </li>`);

  const cashEl = document.getElementById("cashSummaryReport");
  if (cashEl) cashEl.innerHTML = listHtml(r.cashSummary, c =>
    `<li style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border)"><span style="font-size:0.83rem">${c.method}</span><span><strong>${money(c.amount)}</strong> <small style="color:var(--muted)">(${c.count})</small></span></li>`);

  const taxEl = document.getElementById("taxReport");
  if (taxEl) taxEl.innerHTML = listHtml((r.taxReport||[]).slice(0,7), t =>
    `<li style="display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border)"><span style="font-size:0.83rem">${t.day}</span><strong>${money(t.gst)}</strong></li>`);

  renderDashboardChart(r);
}

function renderDashboardChart(r) {
  const canvas = document.getElementById("dashboardChart"); if (!canvas) return;
  const daily  = (r.dailySales||[]).slice(0,7).reverse();
  const isDark = state.theme === "dark";
  const tc     = isDark ? "#e2e8f0" : "#374151";
  const gc     = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)";
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  if (!daily.length) {
    const ctx = canvas.getContext("2d"); ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = tc; ctx.font = "14px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Complete a sale to see the dashboard chart!", canvas.width/2, canvas.height/2); return;
  }
  function build() {
    chartInstance = new Chart(canvas, {
      data: {
        labels: daily.map(d => d.day.slice(5)),
        datasets: [
          { type:"bar", label:"Revenue", data: daily.map(d=>d.revenue), backgroundColor: isDark?"rgba(96,165,250,0.75)":"rgba(37,99,235,0.75)", borderRadius:6, yAxisID:"y" },
          { type:"line", label:"Transactions", data: daily.map(d=>d.transactions), borderColor:"#16a34a", backgroundColor:"rgba(22,163,74,0.1)", fill:true, tension:0.4, pointRadius:5, pointBackgroundColor:"#16a34a", yAxisID:"y1" }
        ]
      },
      options: {
        responsive: true, interaction: { mode:"index", intersect:false },
        plugins: { legend: { labels: { color:tc } }, title: { display:true, text:"Revenue & Transactions — Last 7 Days", color:tc, font:{size:14,weight:"600"} } },
        scales: {
          x: { ticks:{color:tc}, grid:{color:gc} },
          y: { type:"linear", position:"left", ticks:{color:tc,callback:v=>money(v)}, grid:{color:gc}, title:{display:true,text:"Revenue",color:tc} },
          y1: { type:"linear", position:"right", ticks:{color:tc}, grid:{drawOnChartArea:false}, title:{display:true,text:"Transactions",color:tc} }
        }
      }
    });
  }
  if (!window.Chart) { const s=document.createElement("script"); s.src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"; s.onload=build; document.head.appendChild(s); }
  else build();
}

function renderCustomers() {
  const body = document.getElementById("customerBody"); if (!body) return;
  body.innerHTML = "";
  if (!state.customers.length) { body.innerHTML = "<tr><td colspan='5' style='color:var(--muted);text-align:center;padding:1rem'>No customers yet</td></tr>"; return; }
  state.customers.forEach(c => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${c.name}</td><td>${c.phone}</td><td style="color:var(--primary)">${c.loyaltyPoints||0} pts</td><td>${c.memberDiscount||0}%</td><td>${money(c.creditBalance||0)}</td>`;
    body.appendChild(row);
  });
}

function buildGstBreakdownLine() {
  const byRate = {};
  state.cart.forEach(i => {
    const r = i.gstRate || 0;
    byRate[r] = (byRate[r] || 0) + extractInclusiveTax(i.price * i.qty, r).gst;
  });
  const parts = Object.entries(byRate).filter(([r]) => Number(r) > 0).map(([r,v]) => `GST@${r}%: ${money(+v.toFixed(2))}`);
  return parts.length ? parts.join("  |  ") : "All items: 0% GST exempt";
}

function buildReceipt(sale, totals) {
  const W    = 50;
  const LINE = "=".repeat(W);
  const line2= "-".repeat(W);
  const lpad = (s, n) => String(s).substring(0, n).padEnd(n);
  const rpad = (s, n) => String(s).substring(0, n).padStart(n);

  const saleItems = Array.isArray(sale.items) && sale.items.length ? sale.items : state.cart;

  // Build GST groups for CGST/SGST breakup
  const gstGroups = {};
  saleItems.forEach(i => {
    const r = i.gstRate||0; if (!r) return;
    gstGroups[r] = (gstGroups[r]||0) + extractInclusiveTax(i.price * i.qty, r).gst;
  });

  const header = [
    LINE,
    "         NovaPOS — Tax Invoice         ".substring(0, W),
    LINE,
    `Receipt : ${sale.receiptNo}`,
    `Date    : ${new Date(sale.timestamp).toLocaleString("en-IN")}`,
    `Cashier : ${state.currentUser?.username||"-"}`,
    `Payment : ${sale.paymentMethod || document.getElementById("paymentMethod")?.value || "-"}`,
    line2,
    lpad("Item", 20) + rpad("HSN", 7) + rpad("Qty", 4) + rpad("Rate", 8) + rpad("GST%", 5) + rpad("Total", 8),
    line2,
  ];

  const itemLines = saleItems.map(i => {
    const lineAmt = i.price * i.qty;
    const lineTax = extractInclusiveTax(lineAmt, i.gstRate || 0);
    return lpad(i.name, 20)
      + rpad(i.hsnCode||i.hsn_code||"—", 7)
      + rpad(i.qty, 4)
      + rpad(money(i.price), 8)
      + rpad((i.gstRate||0)+"%", 5)
      + rpad(money(lineTax.gross), 8);
  });

  // GST Summary table
  const gstRows = [line2, "  GST Breakup (Intrastate — CGST + SGST):"];
  gstRows.push("  " + lpad("Rate", 6) + rpad("Taxable", 14) + rpad("CGST", 9) + rpad("SGST", 9) + rpad("Total GST", 11));
  if (!Object.keys(gstGroups).length) {
    gstRows.push("  All items exempt — 0% GST");
  } else {
    Object.entries(gstGroups).sort((a,b)=>Number(a[0])-Number(b[0])).forEach(([rate, gstAmt]) => {
      const taxable = gstAmt * 100 / Number(rate);
      gstRows.push("  " + lpad(rate+"%", 6)
        + rpad(money(+taxable.toFixed(2)), 14)
        + rpad(money(+(gstAmt/2).toFixed(2)), 9)
        + rpad(money(+(gstAmt/2).toFixed(2)), 9)
        + rpad(money(+gstAmt.toFixed(2)), 11));
    });
  }

  const footer = [
    line2,
    `  Subtotal (Incl. GST): ${money(totals.subtotal)}`,
    `  Discount  : -${money(totals.discountAmount)}`,
    `  Total GST (included): ${money(totals.taxAmount)}`,
    "  " + "─".repeat(W - 2),
    `  TOTAL PAYABLE: ${money(totals.total)}`,
    `  Received  : ${money(totals.received)}`,
    `  Change    : ${money(totals.change)}`,
    LINE,
    "       Thank you! Visit Again!        ".substring(0, W),
    "       GSTIN: [Your GSTIN here]       ".substring(0, W),
    LINE,
  ];
  return [...header, ...itemLines, ...gstRows, ...footer].join("\n");
}

function downloadReceipt() {
  const txt = receiptContent?.textContent||""; if (!txt||txt==="No completed sale yet.") { alert("No receipt to download."); return; }
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([txt],{type:"text/plain"})); a.download=`receipt-${Date.now()}.txt`; a.click();
}

async function completeSale(event) {
  event.preventDefault();
  if (checkoutInFlight) return;
  if (!state.currentUser) { alert("Please login first."); return; }
  if (!state.cart.length) { alert("Cart is empty."); return; }

  const discountPct = Number(document.getElementById("discount")?.value || 0);
  const pm = document.getElementById("paymentMethod")?.value;
  const clientTotals = saleTotals();

  if (!["Cash", "Card", "Mobile Wallet", "Split"].includes(pm)) {
    alert("Please select a valid payment method.");
    return;
  }

  if (pm === "Card" || pm === "Mobile Wallet") {
    const amtEl = document.getElementById("amountReceived");
    if (amtEl) amtEl.value = clientTotals.total.toFixed(2);
  }

  const splitTotal = ["splitCash","splitCard","splitWallet"].reduce((s, id) => s + Number(document.getElementById(id)?.value || 0), 0);
  const received = pm === "Split" ? splitTotal : Number(document.getElementById("amountReceived")?.value || 0);

  if (!Number.isFinite(received) || received < 0) { alert("Amount received is invalid."); return; }
  if ((pm === "Card" || pm === "Mobile Wallet" || pm === "Split") && Math.abs(received - clientTotals.total) > 0.01) {
    alert("Non-cash payment must exactly match total payable.");
    return;
  }
  if (received < clientTotals.total - 0.01) { alert("Amount received is less than total."); return; }

  checkoutInFlight = true;
  const checkoutBtn = document.getElementById("checkoutBtn");
  if (checkoutBtn) checkoutBtn.disabled = true;

  try {
    const submittedCart = structuredClone(state.cart);
    const sale = await api("/api/sales", { method: "POST", body: JSON.stringify({
      idempotencyKey: state.saleKey,
      paymentMethod:  pm,
      discountPct,
      received,
      currency:       state.currency,
      items:          submittedCart.map(i => ({
        productId: i.productId,
        qty:       i.qty,
        saleType:  i.saleType || "retail",
      })),
    })});

    const serverTotals = {
      subtotal:       sale.subtotal       ?? clientTotals.subtotal,
      discountAmount: sale.discount       ?? clientTotals.discountAmount,
      taxAmount:      sale.tax            ?? clientTotals.taxAmount,
      total:          sale.total          ?? clientTotals.total,
      received,
      change:         Math.max(received - (sale.total ?? clientTotals.total), 0),
    };

    receiptContent.textContent = buildReceipt({ ...sale, paymentMethod: pm, items: sale.items || submittedCart }, serverTotals);
    state.cart    = [];
    state.saleKey = crypto.randomUUID();
    document.getElementById("amountReceived").value = "0";
    await loadBootstrap();
  } catch (err) { alert("Sale failed: " + err.message); }
  finally {
    checkoutInFlight = false;
    if (checkoutBtn) checkoutBtn.disabled = false;
  }
}

async function addProduct(event) {
  event.preventDefault();
  const catId  = document.getElementById("productCategory")?.value;
  const cat    = state.categories.find(c => String(c.id) === String(catId));
  const gstRate  = Number(cat ? cat.gst_rate : (document.getElementById("productGst")?.value || 0));
  const cessRate = 0;
  const wholesalePrice = Number(document.getElementById("productWholesale")?.value || 0);
  const retailPrice    = Number(document.getElementById("productRetail")?.value || 0);
  const mrp            = Number(document.getElementById("productMrp")?.value || 0);
  const costPrice      = Number(document.getElementById("productCostPrice")?.value || 0) || wholesalePrice;
  const hsnCode        = (cat?.hsn_code || document.getElementById("productHsn")?.value?.trim() || "");
  if (wholesalePrice <= 0) { alert("Wholesale price must be greater than 0."); return; }
  if (retailPrice <= 0)    { alert("Retail price must be greater than 0."); return; }
  if (retailPrice < wholesalePrice) { alert("Retail price must be >= wholesale price."); return; }
  if (mrp > 0 && retailPrice > mrp) { alert("Retail price cannot exceed MRP."); return; }
  try {
    await api("/api/products", { method:"POST", body: JSON.stringify({
      name:     document.getElementById("productName").value.trim(),
      sku:      document.getElementById("productSku").value.trim(),
      barcode:  document.getElementById("productSku").value.trim(),
      wholesalePrice,
      retailPrice,
      costPrice,
      mrp: mrp || retailPrice,
      stock:    Number(document.getElementById("productStock").value),
      hsnCode,
      gstRate,
      cessRate,
      categoryId: catId || null
    })});
    event.target.reset();
    const hEl = document.getElementById("productHsn"); if(hEl){ hEl.value=""; hEl.readOnly=false; hEl.style.opacity="1"; }
    await loadBootstrap();
  } catch(err){ alert(err.message); }
}
async function updatePrice(event) {
  event.preventDefault();
  const sku    = document.getElementById("priceSku").value.trim();
  const price  = Number(document.getElementById("newPrice").value);
  const reason = document.getElementById("priceReason")?.value?.trim() || "";
  try {
    await api(`/api/products/${encodeURIComponent(sku)}/price`, {
      method: "PATCH", body: JSON.stringify({ price, reason })
    });
    event.target.reset();
    await loadBootstrap();
  } catch(err) { alert(err.message); }
}

async function addSupplier(event) {
  event.preventDefault();
  try {
    await api("/api/suppliers",{method:"POST",body:JSON.stringify({name:document.getElementById("supplierName").value,phone:document.getElementById("supplierPhone").value,email:document.getElementById("supplierEmail").value})});
    event.target.reset();
    await loadBootstrap();
    renderSuppliersTable();
  } catch(err) { alert(String(err.message).includes("SQLite")?"This feature works when running locally.":err.message); }
}
async function receivePO(event) {
  event.preventDefault();
  const sku = document.getElementById("poSku").value.trim();
  const qty = document.getElementById("poQty").value;
  const supplierId = document.getElementById("poSupplierId").value;
  if (!sku || !qty || Number(qty) <= 0) { alert("Please enter a valid SKU and quantity."); return; }
  try {
    const d = await api("/api/purchase-orders", { method:"POST", body:JSON.stringify({ supplierId, sku, qty }) });
    event.target.reset();
    alert(`✅ PO received: ${d.poNumber}\n+${qty} units added to stock.\nNew stock: ${d.newStock}`);
    await loadBootstrap();
    renderInventoryTable();
  } catch(err){ alert("❌ " + err.message); }
}
async function recordTransfer(event) {
  event.preventDefault();
  const sku      = document.getElementById("transferSku").value.trim();
  const qty      = document.getElementById("transferQty").value;
  const fromStore= document.getElementById("fromStore").value.trim();
  const toStore  = document.getElementById("toStore").value.trim();
  if (!sku || !qty || Number(qty) <= 0) { alert("Please enter a valid SKU and quantity."); return; }
  try {
    const d = await api("/api/stock-transfer", { method:"POST", body:JSON.stringify({ sku, qty, fromStore, toStore }) });
    event.target.reset();
    alert(`✅ Transfer recorded!\n${qty} units of "${sku}" moved from ${fromStore} → ${toStore}.\nRemaining stock: ${d.newStock}`);
    await loadBootstrap();
    renderInventoryTable();
  } catch(err){ alert("❌ " + err.message); }
}
async function addBatch(event) {
  event.preventDefault();
  try { await api("/api/stock-batches",{method:"POST",body:JSON.stringify({sku:document.getElementById("batchSku").value,batchNo:document.getElementById("batchNo").value,expiryDate:document.getElementById("batchExpiry").value,qty:document.getElementById("batchQty").value})}); event.target.reset(); alert("✅ Batch added!"); }
  catch(err){alert(String(err.message).includes("SQLite")?"This feature works when running locally.":err.message);}
}
async function addCustomer(event) {
  event.preventDefault();
  try { await api("/api/customers",{method:"POST",body:JSON.stringify({name:document.getElementById("customerName").value,phone:document.getElementById("customerPhone").value,memberDiscount:document.getElementById("memberDiscount").value,creditBalance:document.getElementById("creditBalance").value})}); event.target.reset(); await loadBootstrap(); }
  catch(err){alert(String(err.message).includes("SQLite")?"Customer DB works when running locally.":err.message);}
}

async function persistSettings(partial) { try { await api("/api/settings",{method:"PUT",body:JSON.stringify(partial)}); } catch(e){console.warn("Settings save failed:",e.message);} }
async function clearHistory() { if(!confirm("Clear ALL sales history? This cannot be undone."))return; try{await api("/api/history",{method:"DELETE"});await loadBootstrap();}catch(err){alert(err.message);} }
function resetSale() { state.cart=[]; document.getElementById("discount").value="0"; document.getElementById("tax").value="10"; document.getElementById("paymentMethod").value="Cash"; document.getElementById("amountReceived").value="0"; document.getElementById("splitPaymentFields").hidden=true; renderCart(); }

async function handleLogin(event) {
  event.preventDefault();
  const btn=event.target.querySelector("button[type=submit]"); btn.disabled=true; btn.textContent="Logging in…";
  try {
    const data=await api("/api/login",{method:"POST",body:JSON.stringify({username:document.getElementById("loginUsername").value.trim(),password:document.getElementById("loginPassword").value,role:document.getElementById("loginRole").value})});
    saveToken(data.token,data.user); state.currentUser=data.user; applySessionState(); await loadBootstrap();
  } catch(err){alert(err.message||"Login failed");}
  finally{btn.disabled=false;btn.textContent="Login";}
}

function logout() { clearToken(); state.currentUser=null; state.cart=[]; applySessionState(); renderCart(); if(receiptContent)receiptContent.textContent="No completed sale yet."; }

// ── USER MANAGEMENT ───────────────────────────────────────────
async function loadUsers() {
  try {
    const data = await api("/api/users");
    renderUsersTable(data.users || []);
  } catch (e) { console.warn("Could not load users:", e.message); }
}

function renderUsersTable(users) {
  const body = document.getElementById("usersTableBody");
  if (!body) return;
  body.innerHTML = "";
  if (!users.length) {
    body.innerHTML = "<tr><td colspan='4' style='color:var(--muted);text-align:center;padding:1rem'>No users found</td></tr>";
    return;
  }
  users.forEach(u => {
    const isSelf = u.username === state.currentUser?.username;
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${u.username}</strong> ${isSelf ? '<small style="color:var(--muted)">(you)</small>' : ''}</td>
      <td><span class="role-badge ${u.role}">${u.role === 'admin' ? '🔑 Admin' : '👤 Cashier'}</span></td>
      <td>
        <button class="btn ghost" style="padding:0.25rem 0.6rem;font-size:0.78rem" onclick="resetUserPassword('${u.username}')">
          🔑 Reset Password
        </button>
      </td>
      <td>
        ${isSelf ? '<span style="color:var(--muted);font-size:0.78rem">—</span>' :
          `<button class="btn danger" style="padding:0.25rem 0.6rem;font-size:0.78rem" onclick="deleteUser('${u.username}')">🗑 Delete</button>`}
      </td>
    `;
    body.appendChild(row);
  });
}

async function createUser(event) {
  event.preventDefault();
  const username = document.getElementById("newUserUsername").value.trim();
  const password = document.getElementById("newUserPassword").value;
  const role     = document.getElementById("newUserRole").value;
  try {
    await api("/api/users", { method: "POST", body: JSON.stringify({ username, password, role }) });
    event.target.reset();
    alert(`✅ User "${username}" created!`);
    await loadUsers();
  } catch (err) { alert("❌ " + err.message); }
}

async function deleteUser(username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  try {
    await api(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    alert(`✅ User "${username}" deleted.`);
    await loadUsers();
  } catch (err) { alert("❌ " + err.message); }
}

async function resetUserPassword(username) {
  const newPassword = prompt(`Reset password for "${username}":\nEnter new password (min 6 characters):`);
  if (newPassword === null) return;
  if (newPassword.length < 6) { alert("Password must be at least 6 characters."); return; }
  try {
    await api(`/api/users/${encodeURIComponent(username)}/reset-password`, { method: "POST", body: JSON.stringify({ newPassword }) });
    alert(`✅ Password reset for "${username}"!`);
  } catch (err) { alert("❌ " + err.message); }
}


// ══════════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ══════════════════════════════════════════════════════════════

const TAB_LABELS = {
  "inventory":       "Inventory",
  "suppliers":       "Suppliers",
  "purchase-orders": "Purchase Orders",
  "stock-transfer":  "Stock Transfer",
  "batches":         "Batch / Expiry",
  "customers":       "Customers",
  "reports":         "Reports",
  "gst-categories":  "GST Categories",
  "users":           "User Management",
  "z-report":        "EOD Z-Report",
  "audit-log":       "Audit Log",
};

function openAdminDashboard() {
  const el = document.getElementById("adminOverlay");
  if (!el) return;
  el.classList.add("open");
  document.body.style.overflow = "hidden";
  renderInventoryTable();
  renderSuppliersTable();
}
function closeAdminDashboard() {
  const el = document.getElementById("adminOverlay");
  if (!el) return;
  el.classList.remove("open");
  document.body.style.overflow = "";
}

function initAdminTabs() {
  document.getElementById("adminDashBtn")?.addEventListener("click", openAdminDashboard);
  document.getElementById("adminCloseBtn")?.addEventListener("click", closeAdminDashboard);
  document.getElementById("adminCloseBtnTop")?.addEventListener("click", closeAdminDashboard);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeAdminDashboard(); });

  document.querySelectorAll(".admin-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".admin-pane").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      const key = tab.dataset.tab;
      const pane = document.getElementById("tab-" + key);
      if (pane) pane.classList.add("active");
      const label = TAB_LABELS[key] || key;
      const t = document.getElementById("adminPaneTitle");
      const b = document.getElementById("adminPaneBreadcrumb");
      if (t) t.textContent = label;
      if (b) b.textContent = label;
      // Lazy-load data for tabs that need fresh server data
      if (key === "z-report")  loadZReports();
      if (key === "audit-log") loadAuditLog();
    });
  });
}

// ── SKU AUTOCOMPLETE ──────────────────────────────────────────
function refreshSkuList() {
  const dl = document.getElementById("skuList");
  const dnl = document.getElementById("productNamesList");
  if (dl) {
    dl.innerHTML = "";
    state.products.forEach(p => {
      // Option by SKU
      const o1 = document.createElement("option");
      o1.value = p.sku;
      o1.label = p.name + " | " + money(p.price) + " | stock: " + p.stock;
      dl.appendChild(o1);
      // Option by name → auto-resolve to SKU on change
      const o2 = document.createElement("option");
      o2.value = p.name;
      o2.label = "SKU: " + p.sku;
      dl.appendChild(o2);
    });
  }
  // Populate product names list for the Add Product form
  if (dnl) {
    dnl.innerHTML = "";
    state.products.forEach(p => {
      const o = document.createElement("option");
      o.value = p.name;
      dnl.appendChild(o);
    });
  }
  // Auto-resolve name → SKU and show current price hint
  ["priceSku","adjustSku","poSku","transferSku","batchSku"].forEach(id => {
    const el = document.getElementById(id);
    if (!el || el._skuListened) return;
    el._skuListened = true;
    el.addEventListener("change", () => {
      const val = el.value.trim();
      const match = state.products.find(p =>
        p.name.toLowerCase() === val.toLowerCase() ||
        p.sku.toLowerCase() === val.toLowerCase()
      );
      if (!match) return;
      // For name input, swap to SKU
      if (match.name.toLowerCase() === val.toLowerCase()) el.value = match.sku;
      // Show current price hint on price form
      if (id === "priceSku") {
        const ni = document.getElementById("newPrice");
        if (ni && !ni.value) { ni.value = match.price; ni.select(); }
      }
    });
  });
}

// ── INVENTORY TABLE ───────────────────────────────────────────
function renderInventoryTable() {
  const body = document.getElementById("inventoryTableBody");
  if (!body) return;
  const term = (document.getElementById("inventorySearch")?.value || "").toLowerCase();
  const list = term
    ? state.products.filter(p => p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term))
    : state.products;
  body.innerHTML = "";
  if (!list.length) {
    body.innerHTML = "<tr><td colspan='8' style='color:var(--muted);text-align:center;padding:1rem'>No products</td></tr>";
    return;
  }
  list.forEach(p => {
    const low = p.stock <= 5;
    const tr = document.createElement("tr");
    const gstTotal = Number(p.gst_rate || 0) + Number(p.cess_rate || 0);
    const gc = gstTotal >= 18 ? "var(--danger)" : gstTotal > 0 ? "var(--primary)" : "var(--success)";
    const costDisplay = Number(p.cost_price || p.wholesale_price || p.price || 0);
    tr.innerHTML = `
      <td><strong>${p.name}</strong></td>
      <td style="font-family:monospace;font-size:0.8rem">${p.hsn_code||"—"}</td>
      <td>${money(costDisplay)}</td>
      <td id="pc-${p.id}">${money(Number(p.retail_price ?? p.price ?? 0))}</td>
      <td>${money(Number(p.mrp ?? p.retail_price ?? p.price ?? 0))}</td>
      <td><span style="background:${gc}20;color:${gc};padding:1px 8px;border-radius:999px;font-weight:700;font-size:0.75rem">GST ${p.gst_rate||0}%${(p.cess_rate||0)>0 ? ` + Cess ${p.cess_rate}%` : ""}</span></td>
      <td style="font-weight:600;color:${low ? "var(--danger)" : "var(--text)"}">${p.stock}${low ? " ⚠️" : ""}</td>
      <td><button class="btn danger" style="padding:0.2rem 0.45rem;font-size:0.74rem"
          onclick="deleteProduct('${p.id}','${p.name.replace(/'/g,"\\'")}')">🗑️</button></td>
    `;
    body.appendChild(tr);
  });
}

async function deleteProduct(id, name) {
  if (!confirm(`Delete "${name}"?\n\nThis cannot be undone. All sales history referencing this product is kept.`)) return;
  try {
    await api(`/api/products/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadBootstrap();
    renderInventoryTable();
  } catch(e) { alert("❌ " + e.message); }
}

// ── STOCK ADJUSTMENT ──────────────────────────────────────────
async function stockAdjust(event) {
  event.preventDefault();
  const raw   = document.getElementById("adjustSku").value.trim();
  const type  = document.getElementById("adjustType").value;
  const qty   = Number(document.getElementById("adjustQty").value);
  const reason= document.getElementById("adjustReason")?.value || "";
  const p = state.products.find(x =>
    x.sku.toLowerCase() === raw.toLowerCase() || x.name.toLowerCase() === raw.toLowerCase()
  );
  if (!p) { alert("❌ Product not found. Check SKU or name."); return; }
  const newStock = type === "set" ? qty : type === "add" ? p.stock + qty : Math.max(0, p.stock - qty);
  if (!confirm(`Adjust "${p.name}"?

Current stock: ${p.stock}
New stock: ${newStock}
Reason: ${reason||"—"}`)) return;
  try {
    await api(`/api/products/${encodeURIComponent(p.sku)}/stock`, {
      method:"PATCH", body:JSON.stringify({ stock:newStock, reason })
    });
    event.target.reset();
    await loadBootstrap();
    renderInventoryTable();
    alert(`✅ Stock updated! ${p.name}: ${p.stock} → ${newStock}`);
  } catch(e) { alert("❌ " + e.message); }
}

// ── SUPPLIERS TABLE ───────────────────────────────────────────
function renderSuppliersTable() {
  const body = document.getElementById("suppliersTableBody");
  if (!body) return;
  body.innerHTML = "";
  if (!state.suppliers.length) {
    body.innerHTML = "<tr><td colspan='4' style='color:var(--muted);text-align:center;padding:1rem'>No suppliers yet</td></tr>";
    return;
  }
  state.suppliers.forEach(s => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td style="font-weight:600">${s.id||"—"}</td><td>${s.name}</td><td>${s.phone||"—"}</td><td>${s.email||"—"}</td>`;
    body.appendChild(tr);
  });
}


// ══════════════════════════════════════════════════════════════
// HSN / GST CATEGORIES
// ══════════════════════════════════════════════════════════════

function renderCategoryOptions() {
  const sel = document.getElementById("productCategory");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select Category (auto-fills HSN &amp; GST) —</option>';
  state.categories.forEach(c => {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${c.name}  ·  HSN: ${c.hsn_code}  ·  GST: ${c.gst_rate}%`;
    sel.appendChild(o);
  });
  if (cur) sel.value = cur;
}

function onCategoryChange() {
  const val = document.getElementById("productCategory")?.value;
  const cat = state.categories.find(c => String(c.id) === String(val));
  const hEl = document.getElementById("productHsn");
  const gEl = document.getElementById("productGst");
  const retailInput = document.getElementById("productRetail");
  if (cat) {
    if (hEl) { hEl.value = cat.hsn_code; hEl.readOnly = true; hEl.style.opacity = "0.6"; }
    // Set GST select to match category
    if (gEl) {
      // Find matching option or create one
      let found = false;
      for (const opt of gEl.options) {
        if (Number(opt.value) === Number(cat.gst_rate)) { gEl.value = opt.value; found = true; break; }
      }
      if (!found) {
        const o = document.createElement("option");
        o.value = String(cat.gst_rate);
        o.textContent = `GST ${cat.gst_rate}%`;
        gEl.appendChild(o);
        gEl.value = String(cat.gst_rate);
      }
    }
    // Reset retail so it auto-fills from new GST rate
    if (retailInput) retailInput.value = "";
  } else {
    if (hEl) { hEl.value = ""; hEl.readOnly = false; hEl.style.opacity = "1"; }
  }
  recalcRetailPreview(true);
}


function recalcRetailPreview(autoFill = false) {
  const wholesale = Number(document.getElementById("productWholesale")?.value || 0);
  const mrp       = Number(document.getElementById("productMrp")?.value || 0);
  const catId = document.getElementById("productCategory")?.value;
  const cat   = state.categories.find(c => String(c.id) === String(catId));
  const gst   = cat ? Number(cat.gst_rate || 0) : Number(document.getElementById("productGst")?.value || 0);
  const suggested = +(wholesale + (wholesale * gst / 100)).toFixed(2);
  const retailInput = document.getElementById("productRetail");
  // Auto-fill only when explicitly triggered (blur or category/GST change) AND field is still empty
  if (autoFill && retailInput && !retailInput.value && suggested > 0) {
    retailInput.value = suggested.toFixed(2);
  }
  const retail = Number(retailInput?.value || 0);
  const preview = document.getElementById("pricingPreview");
  if (preview) {
    if (wholesale > 0) {
      preview.textContent = `Wholesale ₹${wholesale.toFixed(2)} + GST ${gst}% = Suggested ₹${suggested.toFixed(2)}${retail ? ` | Retail ₹${retail.toFixed(2)}` : " — leave Wholesale field to auto-fill Retail"}`;
    } else {
      preview.textContent = "Enter wholesale price to see suggestion";
    }
  }
  const err = document.getElementById("pricingError");
  if (err) {
    if (retail > 0 && mrp > 0 && retail > mrp) err.textContent = "⚠️ Retail price cannot exceed MRP.";
    else if (retail > 0 && wholesale > 0 && retail < wholesale) err.textContent = "⚠️ Retail price must be >= wholesale price.";
    else err.textContent = "";
  }
}

function updatePricingPreview() {
  recalcRetailPreview(false); // user is typing retail manually — just update preview/errors
}

function renderCategoriesTable() {
  const body = document.getElementById("categoriesTableBody");
  if (!body) return;
  body.innerHTML = "";
  if (!state.categories.length) {
    body.innerHTML = "<tr><td colspan='4' style='color:var(--muted);text-align:center;padding:1rem'>No categories yet. Add one above.</td></tr>";
    return;
  }
  state.categories.forEach(c => {
    const gc = c.gst_rate === 0 ? "var(--success)" : c.gst_rate <= 12 ? "var(--primary)" : "var(--danger)";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${c.name}</strong></td>
      <td style="font-family:monospace;font-weight:600;font-size:0.85rem">${c.hsn_code}</td>
      <td><span style="background:${gc}20;color:${gc};padding:2px 10px;border-radius:999px;font-weight:700;font-size:0.78rem">${c.gst_rate}%</span></td>
      <td style="font-size:0.75rem;color:var(--muted)">${c.gst_rate > 0 ? `CGST ${c.gst_rate/2}% + SGST ${c.gst_rate/2}%` : "Exempt (0%)"}</td>`;
    body.appendChild(tr);
  });
}

async function addCategory(event) {
  event.preventDefault();
  const name    = document.getElementById("catName")?.value?.trim();
  const hsnCode = document.getElementById("catHsn")?.value?.trim();
  const gstRate = Number(document.getElementById("catGst")?.value);
  if (!name || !hsnCode) { alert("Category name and HSN code are required."); return; }
  if (![0,3,5,12,18,28].includes(gstRate)) { alert("GST rate must be 0, 3, 5, 12, 18 or 28."); return; }
  try {
    await api("/api/categories", { method:"POST", body:JSON.stringify({ name, hsnCode, gstRate }) });
    event.target.reset();
    await loadBootstrap();
    renderCategoryOptions(); renderCategoriesTable();
    alert(`✅ Category "${name}" added!\nHSN: ${hsnCode} | GST: ${gstRate}%`);
  } catch(err) { alert("❌ " + err.message); }
}


// ── DATE RANGE REPORTS ─────────────────────────────────────────
async function applyReportDateRange(event) {
  if (event) event.preventDefault();
  const from = document.getElementById("reportFrom")?.value || null;
  const to   = document.getElementById("reportTo")?.value   || null;
  state.reportRange = { from, to };
  await loadReports(from, to);
}

// ── Z-REPORT ──────────────────────────────────────────────────
async function loadZReports() {
  try {
    const data = await api("/api/z-report");
    renderZReports(data.zReports || []);
  } catch(e) { console.warn("Z-report load failed:", e.message); }
}

function renderZReports(reports) {
  const body = document.getElementById("zReportTableBody");
  if (!body) return;
  if (!reports.length) {
    body.innerHTML = "<tr><td colspan='9' style='color:var(--muted);text-align:center;padding:1rem'>No Z-reports yet. Close the day to generate the first one.</td></tr>";
    return;
  }
  body.innerHTML = "";
  reports.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-family:monospace;font-size:0.8rem">${r.report_date}</td>
      <td style="font-size:0.78rem;color:var(--muted)">${new Date(r.closed_at).toLocaleTimeString("en-IN")}</td>
      <td>${r.cashier}</td>
      <td>${r.transaction_count}</td>
      <td style="font-weight:600">${money(r.total_sales)}</td>
      <td style="color:var(--muted)">${money(r.cash_sales)} / ${money(r.card_sales)}</td>
      <td style="color:var(--danger)">${money(r.total_refunds)}</td>
      <td style="color:var(--primary)">${money(r.total_tax)}</td>
      <td style="font-size:0.75rem;color:var(--muted)">${r.notes||"—"}</td>`;
    body.appendChild(tr);
  });
}

async function closeDay(event) {
  event.preventDefault();
  const openingCash = Number(document.getElementById("zOpeningCash")?.value || 0);
  const closingCash = Number(document.getElementById("zClosingCash")?.value || 0);
  const notes       = document.getElementById("zNotes")?.value || "";
  if (!confirm(`Close today's trading day?\n\nOpening cash: ${money(openingCash)}\nClosing cash:  ${money(closingCash)}\n\nThis action is permanent.`)) return;
  try {
    const data = await api("/api/z-report", { method: "POST", body: JSON.stringify({ openingCash, closingCash, notes }) });
    const r = data.zReport;
    alert(`✅ Z-Report Generated!\n\nDate:         ${r.report_date}\nTransactions: ${r.transaction_count}\nTotal Sales:  ${money(r.total_sales)}\n  • Cash:     ${money(r.cash_sales)}\n  • Card:     ${money(r.card_sales)}\n  • Mobile:   ${money(r.mobile_sales)}\nRefunds:      ${money(r.total_refunds)}\nGST Collected:${money(r.total_tax)}\nNet Cash:     ${money(closingCash - openingCash)}`);
    event.target.reset();
    await loadZReports();
  } catch(e) { alert("❌ " + e.message); }
}

// ── AUDIT LOG ─────────────────────────────────────────────────
async function loadAuditLog() {
  const entity = document.getElementById("auditEntityFilter")?.value || null;
  try {
    let url = "/api/audit-log?limit=100";
    if (entity) url += `&entity=${entity}`;
    const data = await api(url);
    renderAuditLog(data.auditLog || []);
  } catch(e) { console.warn("Audit log load failed:", e.message); }
}

function renderAuditLog(rows) {
  const body = document.getElementById("auditLogTableBody");
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = "<tr><td colspan='6' style='color:var(--muted);text-align:center;padding:1rem'>No audit events yet.</td></tr>";
    return;
  }
  const ACTION_COLOR = { REFUND:"var(--danger)", PRICE_UPDATE:"var(--warning,#f59e0b)", STOCK_ADJUST:"var(--primary)", COST_UPDATE:"var(--primary)", Z_REPORT:"var(--success)" };
  body.innerHTML = "";
  rows.forEach(r => {
    const tr = document.createElement("tr");
    const color = ACTION_COLOR[r.action] || "var(--text)";
    let before = "", after = "";
    try { before = r.before_value ? JSON.stringify(JSON.parse(r.before_value), null, 0).slice(0, 60) : "—"; } catch { before = r.before_value || "—"; }
    try { after  = r.after_value  ? JSON.stringify(JSON.parse(r.after_value),  null, 0).slice(0, 80) : "—"; } catch { after  = r.after_value  || "—"; }
    tr.innerHTML = `
      <td style="font-size:0.78rem;color:var(--muted);font-family:monospace;white-space:nowrap">${new Date(r.timestamp).toLocaleString("en-IN")}</td>
      <td style="font-weight:600">${r.actor}</td>
      <td><span style="background:${color}20;color:${color};padding:1px 8px;border-radius:999px;font-weight:700;font-size:0.75rem">${r.action}</span></td>
      <td style="font-size:0.8rem;color:var(--muted)">${r.entity_type}${r.entity_id ? ` · ${r.entity_id}` : ""}</td>
      <td style="font-size:0.75rem;font-family:monospace;color:var(--muted)">${before} → ${after}</td>
      <td style="font-size:0.78rem;color:var(--muted)">${r.note||"—"}</td>`;
    body.appendChild(tr);
  });
}

// ── COST PRICE UPDATE (from inventory tab) ────────────────────
async function updateCostPrice(event) {
  event.preventDefault();
  const sku       = document.getElementById("costSku")?.value?.trim();
  const costPrice = Number(document.getElementById("costPrice")?.value || 0);
  const qty       = Number(document.getElementById("costQty")?.value   || 0);
  const reason    = document.getElementById("costReason")?.value?.trim() || "";
  if (!sku || costPrice <= 0) { alert("SKU and a valid cost price are required."); return; }
  try {
    await api(`/api/products/${encodeURIComponent(sku)}/cost`, {
      method: "PATCH", body: JSON.stringify({ costPrice, qty, reason })
    });
    event.target.reset();
    await loadBootstrap();
    alert(`✅ Cost price updated for "${sku}"!${qty > 0 ? `\nFIFO batch of ${qty} units seeded.` : ""}`);
  } catch(e) { alert("❌ " + e.message); }
}

function init() {
  document.getElementById("loginForm")?.addEventListener("submit",handleLogin);
  document.getElementById("logoutBtn")?.addEventListener("click",logout);
  document.getElementById("checkoutForm")?.addEventListener("submit",completeSale);
  document.getElementById("productForm")?.addEventListener("submit",addProduct);
  document.getElementById("productGst")?.addEventListener("change", () => { document.getElementById("productRetail").value=""; recalcRetailPreview(true); });
  document.getElementById("productRetail")?.addEventListener("input", updatePricingPreview);
  document.getElementById("productWholesale")?.addEventListener("input", () => recalcRetailPreview(false));
  document.getElementById("productWholesale")?.addEventListener("blur",  () => recalcRetailPreview(true));
  document.getElementById("productMrp")?.addEventListener("input", recalcRetailPreview);
  document.getElementById("priceForm")?.addEventListener("submit",updatePrice);
  document.getElementById("clearHistoryBtn")?.addEventListener("click",clearHistory);
  document.getElementById("newSaleBtn")?.addEventListener("click",resetSale);
  document.getElementById("printReceiptBtn")?.addEventListener("click",()=>window.print());
  document.getElementById("downloadReceiptBtn")?.addEventListener("click",downloadReceipt);
  document.getElementById("holdOrderBtn")?.addEventListener("click",holdCurrentOrder);
  document.getElementById("resumeOrderBtn")?.addEventListener("click",resumeHeldOrder);
  document.getElementById("supplierForm")?.addEventListener("submit",addSupplier);
  document.getElementById("purchaseOrderForm")?.addEventListener("submit",receivePO);
  document.getElementById("stockTransferForm")?.addEventListener("submit",recordTransfer);
  document.getElementById("batchForm")?.addEventListener("submit",addBatch);
  document.getElementById("customerForm")?.addEventListener("submit",addCustomer);
  document.getElementById("createUserForm")?.addEventListener("submit",createUser);
  document.getElementById("stockAdjustForm")?.addEventListener("submit",stockAdjust);
  document.getElementById("categoryForm")?.addEventListener("submit",addCategory);
  document.getElementById("productCategory")?.addEventListener("change",onCategoryChange);
  document.getElementById("inventorySearch")?.addEventListener("input", renderInventoryTable);
  document.getElementById("reportDateForm")?.addEventListener("submit", applyReportDateRange);
  document.getElementById("zReportForm")?.addEventListener("submit", closeDay);
  document.getElementById("auditEntityFilter")?.addEventListener("change", loadAuditLog);
  document.getElementById("costPriceForm")?.addEventListener("submit", updateCostPrice);
  initAdminTabs();
  barcodeInput?.addEventListener("keydown",handleBarcode);
  productSearch?.addEventListener("input",renderProducts);
  ["discount","tax","amountReceived","splitCash","splitCard","splitWallet"].forEach(id=>document.getElementById(id)?.addEventListener("input",renderTotals));
  document.getElementById("gstPreset")?.addEventListener("change",e=>{if(e.target.value)document.getElementById("tax").value=e.target.value;renderTotals();});
  document.getElementById("paymentMethod")?.addEventListener("change",e=>{document.getElementById("splitPaymentFields").hidden=e.target.value!=="Split";renderTotals();});
  currencySelect?.addEventListener("change",async e=>{state.currency=e.target.value;await persistSettings({currency:state.currency});renderProducts();renderCart();renderHistory();renderKpis();});
  darkModeBtn?.addEventListener("click",async()=>{state.theme=state.theme==="dark"?"light":"dark";applyTheme();await persistSettings({theme:state.theme});renderDashboardChart(state.reports);});
  const savedUser=getSavedUser(),savedToken=getToken();
  if(savedUser&&savedToken){state.currentUser=savedUser;applySessionState();loadBootstrap().catch(err=>{const m=String(err?.message||"");if(m.includes("Session expired")||m.includes("Login required")){clearToken();state.currentUser=null;applySessionState();}else console.error("Bootstrap failed:",err);});}
}
init();