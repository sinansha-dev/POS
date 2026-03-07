// ── STATE ─────────────────────────────────────────────────────
const state = {
  products: [], cart: [], history: [], categories: [],
  currentUser: null, currency: "USD", theme: "light",
  heldOrders: JSON.parse(localStorage.getItem("novapos_held_orders") || "[]"),
  customers: [], suppliers: [], reports: {}
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

function saleTotals() {
  const subtotal     = state.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const discountRate = Number(document.getElementById("discount")?.value || 0) / 100;
  const discountAmt  = subtotal * discountRate;
  // Per-item GST — each product carries its own rate (Indian GST rules)
  const taxAmount = +state.cart.reduce((sum, i) => {
    const lineVal  = i.price * i.qty;
    const lineDisc = lineVal * discountRate;
    return sum + (lineVal - lineDisc) * (i.gstRate || 0) / 100;
  }, 0).toFixed(2);
  const taxable = Math.max(subtotal - discountAmt, 0);
  const total   = +(taxable + taxAmount).toFixed(2);
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
  state.currency  = data.settings?.currency || "USD";
  state.theme     = data.settings?.theme    || "light";
  state.customers  = data.customers  || [];
  state.suppliers  = data.suppliers  || [];
  state.categories = data.categories || [];
  state.reports    = data.reports    || {};
  currencySelect.value = state.currency;
  applyTheme();
  renderProducts(); renderHistory(); renderCart(); renderKpis(); renderCustomers(); renderSuppliersTable(); renderInventoryTable(); refreshSkuList(); renderCategoryOptions(); renderCategoriesTable();
  await loadReports();
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
    const lineGst = +(item.price * item.qty * (item.gstRate||0) / 100).toFixed(2);
    row.innerHTML = `
      <td>${item.name}${item.hsnCode ? `<br><small style="color:var(--muted);font-size:0.7rem;font-family:monospace">HSN: ${item.hsnCode}</small>` : ''}</td>
      <td><input type="number" min="1" value="${item.qty}" style="width:54px;border:1px solid var(--border);border-radius:6px;padding:2px 5px;background:var(--surface);color:var(--text)"/></td>
      <td>${money(item.price)}<br><small style="color:var(--muted);font-size:0.7rem">+${item.gstRate||0}% GST</small></td>
      <td>${money(item.price * item.qty + lineGst)}<br><small style="color:var(--muted);font-size:0.7rem">tax: ${money(lineGst)}</small></td>
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
async function loadReports() {
  try { const data = await api("/api/reports"); if (data.reports) state.reports = data.reports; } catch {}
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
  if (plEl) { const p = r.profitLoss||{}; plEl.textContent = `Revenue:        ${money(p.revenue||0)}\nCost of Goods:  ${money(p.cogs||0)}\n─────────────────────────\nGross Profit:   ${money(p.grossProfit||0)}\nStock Value:    ${money(p.stockValue||0)}`; }

  const bestEl = document.getElementById("bestSellingReport");
  if (bestEl) bestEl.innerHTML = listHtml((r.bestSelling||[]).slice(0,8), (p,i) =>
    `<li style="display:flex;justify-content:space-between;padding:0.3rem 0"><span style="font-size:0.83rem">${i+1}. ${p.name}</span><strong style="color:var(--success)">${p.qty} sold</strong></li>`);

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
          y: { type:"linear", position:"left", ticks:{color:tc,callback:v=>"$"+v}, grid:{color:gc}, title:{display:true,text:"Revenue",color:tc} },
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
  state.cart.forEach(i => { const r = i.gstRate||0; byRate[r] = (byRate[r]||0) + i.price * i.qty * r / 100; });
  const parts = Object.entries(byRate).filter(([r]) => Number(r) > 0).map(([r,v]) => `GST@${r}%: ${money(+v.toFixed(2))}`);
  return parts.length ? parts.join("  |  ") : "All items: 0% GST exempt";
}

function buildReceipt(sale, totals) {
  const W    = 50;
  const LINE = "=".repeat(W);
  const line2= "-".repeat(W);
  const lpad = (s, n) => String(s).substring(0, n).padEnd(n);
  const rpad = (s, n) => String(s).substring(0, n).padStart(n);

  // Build GST groups for CGST/SGST breakup
  const gstGroups = {};
  state.cart.forEach(i => {
    const r = i.gstRate||0; if (!r) return;
    gstGroups[r] = (gstGroups[r]||0) + i.price * i.qty * r / 100;
  });

  const header = [
    LINE,
    "         NovaPOS — Tax Invoice         ".substring(0, W),
    LINE,
    `Receipt : ${sale.receiptNo}`,
    `Date    : ${new Date(sale.timestamp).toLocaleString("en-IN")}`,
    `Cashier : ${state.currentUser?.username||"-"}`,
    `Payment : ${document.getElementById("paymentMethod")?.value||"-"}`,
    line2,
    lpad("Item", 20) + rpad("HSN", 7) + rpad("Qty", 4) + rpad("Rate", 8) + rpad("GST%", 5) + rpad("Total", 8),
    line2,
  ];

  const itemLines = state.cart.map(i => {
    const lineAmt = i.price * i.qty;
    const lineGst = +(lineAmt * (i.gstRate||0) / 100).toFixed(2);
    return lpad(i.name, 20)
      + rpad(i.hsnCode||i.hsn_code||"—", 7)
      + rpad(i.qty, 4)
      + rpad(money(i.price), 8)
      + rpad((i.gstRate||0)+"%", 5)
      + rpad(money(lineAmt + lineGst), 8);
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
    `  Subtotal  : ${money(totals.subtotal)}`,
    `  Discount  : -${money(totals.discountAmount)}`,
    `  Total GST : ${money(totals.taxAmount)}`,
    "  " + "─".repeat(W - 2),
    `  TOTAL     : ${money(totals.total)}`,
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
  if (!state.currentUser) { alert("Please login first."); return; }
  if (!state.cart.length) { alert("Cart is empty."); return; }
  const totals = saleTotals();
  if (totals.received < totals.total) { alert("Amount received is less than total."); return; }
  try {
    const sale = await api("/api/sales", { method:"POST", body:JSON.stringify({ paymentMethod:document.getElementById("paymentMethod")?.value, subtotal:totals.subtotal, discount:totals.discountAmount, tax:totals.taxAmount, total:totals.total, received:totals.received, change:totals.change, currency:state.currency, items:state.cart }) });
    receiptContent.textContent = buildReceipt(sale, totals);
    state.cart = []; document.getElementById("amountReceived").value = "0";
    await loadBootstrap();
  } catch (err) { alert("Sale failed: " + err.message); }
}

async function addProduct(event) {
  event.preventDefault();
  const catId   = document.getElementById("productCategory")?.value;
  const cat     = state.categories.find(c => String(c.id) === String(catId));
  const hsnCode = cat?.hsn_code || document.getElementById("productHsn")?.value?.trim() || "";
  const gstRate = (cat && catId) ? cat.gst_rate : Number(document.getElementById("productGst")?.value || 0);
  try {
    await api("/api/products", { method:"POST", body: JSON.stringify({
      name:     document.getElementById("productName").value.trim(),
      sku:      document.getElementById("productSku").value.trim(),
      price:    Number(document.getElementById("productPrice").value),
      stock:    Number(document.getElementById("productStock").value),
      hsnCode, gstRate, categoryId: catId || null
    })});
    event.target.reset();
    const hEl = document.getElementById("productHsn"); if(hEl){ hEl.value=""; hEl.readOnly=false; }
    const gEl = document.getElementById("productGst"); if(gEl){ gEl.value="18"; gEl.readOnly=false; }
    await loadBootstrap(); renderCategoryOptions(); renderCategoriesTable();
  } catch(err){ alert(err.message); }
}
async function updatePrice(event) {
  event.preventDefault();
  try { await api(`/api/products/${encodeURIComponent(document.getElementById("priceSku").value.trim())}/price`,{method:"PATCH",body:JSON.stringify({price:Number(document.getElementById("newPrice").value)})}); event.target.reset(); await loadBootstrap(); }
  catch(err){alert(err.message);}
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
  try { const d=await api("/api/purchase-orders",{method:"POST",body:JSON.stringify({supplierId:document.getElementById("poSupplierId").value,sku:document.getElementById("poSku").value,qty:document.getElementById("poQty").value,cost:document.getElementById("poCost").value})}); event.target.reset(); alert(`✅ PO received: ${d.poNumber}`); await loadBootstrap(); }
  catch(err){alert(String(err.message).includes("SQLite")?"This feature works when running locally.":err.message);}
}
async function recordTransfer(event) {
  event.preventDefault();
  try { await api("/api/stock-transfer",{method:"POST",body:JSON.stringify({sku:document.getElementById("transferSku").value,qty:document.getElementById("transferQty").value,fromStore:document.getElementById("fromStore").value,toStore:document.getElementById("toStore").value})}); event.target.reset(); alert("✅ Transfer recorded!"); }
  catch(err){alert(String(err.message).includes("SQLite")?"This feature works when running locally.":err.message);}
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
  "users":           "User Management"
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
    });
  });
}

// ── SKU AUTOCOMPLETE ──────────────────────────────────────────
function refreshSkuList() {
  const dl = document.getElementById("skuList");
  if (!dl) return;
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
    body.innerHTML = "<tr><td colspan='5' style='color:var(--muted);text-align:center;padding:1rem'>No products</td></tr>";
    return;
  }
  list.forEach(p => {
    const low = p.stock <= 5;
    const tr = document.createElement("tr");
    const gc = (p.gst_rate||0) >= 18 ? "var(--danger)" : (p.gst_rate||0) > 0 ? "var(--primary)" : "var(--success)";
    tr.innerHTML = `
      <td><strong>${p.name}</strong></td>
      <td style="font-family:monospace;font-size:0.78rem;color:var(--muted)">${p.sku}</td>
      <td style="font-family:monospace;font-size:0.8rem">${p.hsn_code||"—"}</td>
      <td><span style="background:${gc}20;color:${gc};padding:1px 8px;border-radius:999px;font-weight:700;font-size:0.75rem">${p.gst_rate||0}%</span></td>
      <td id="pc-${p.id}">${money(p.price)}</td>
      <td style="font-weight:600;color:${low ? "var(--danger)" : "var(--text)"}">${p.stock}${low ? " ⚠️" : ""}</td>
      <td><button class="btn ghost" style="padding:0.2rem 0.45rem;font-size:0.74rem"
          onclick="inlineEditPrice('${p.id}','${p.sku}',${p.price})">✏️</button></td>
    `;
    body.appendChild(tr);
  });
}

function inlineEditPrice(id, sku, cur) {
  const cell = document.getElementById("pc-" + id);
  if (!cell) return;
  cell.innerHTML = `<div style="display:flex;gap:4px;align-items:center">
    <input type="number" id="ip-${id}" value="${cur}" min="0" step="0.01"
      style="width:74px;border:1px solid var(--primary);border-radius:5px;padding:2px 5px;font:inherit;font-size:0.8rem;background:var(--surface);color:var(--text)" />
    <button class="btn" style="padding:2px 7px;font-size:0.74rem" onclick="submitInlinePrice('${id}','${sku}')">✓</button>
    <button class="btn ghost" style="padding:2px 6px;font-size:0.74rem" onclick="renderInventoryTable()">✕</button>
  </div>`;
  document.getElementById("ip-" + id)?.focus();
}

async function submitInlinePrice(id, sku) {
  const v = Number(document.getElementById("ip-" + id)?.value);
  if (!v || v <= 0) { alert("Enter a valid price."); return; }
  try {
    await api(`/api/products/${encodeURIComponent(sku)}/price`, { method:"PATCH", body:JSON.stringify({ price:v }) });
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
  if (cat) {
    if (hEl) { hEl.value = cat.hsn_code; hEl.readOnly = true; hEl.style.opacity = "0.6"; }
    if (gEl) { gEl.value = cat.gst_rate; gEl.readOnly = true; gEl.style.opacity = "0.6"; }
  } else {
    if (hEl) { hEl.value = ""; hEl.readOnly = false; hEl.style.opacity = "1"; }
    if (gEl) { gEl.value = "18"; gEl.readOnly = false; gEl.style.opacity = "1"; }
  }
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


function init() {
  document.getElementById("loginForm")?.addEventListener("submit",handleLogin);
  document.getElementById("logoutBtn")?.addEventListener("click",logout);
  document.getElementById("checkoutForm")?.addEventListener("submit",completeSale);
  document.getElementById("productForm")?.addEventListener("submit",addProduct);
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