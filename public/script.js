const state = {
  products: [],
  cart: [],
  history: [],
  currentUser: null,
  currency: "USD",
  theme: "light",
  cashierName: "",
  heldOrders: JSON.parse(localStorage.getItem("novapos_held_orders") || "[]"),
  customerDb: JSON.parse(localStorage.getItem("novapos_customers") || "[]")
};

const productGrid      = document.getElementById("productGrid");
const cartBody         = document.getElementById("cartBody");
const historyBody      = document.getElementById("historyBody");
const receiptContent   = document.getElementById("receiptContent");
const cashierNameInput = document.getElementById("cashierName");
const inventoryAdmin   = document.getElementById("inventoryAdmin");
const currencySelect   = document.getElementById("currencySelect");
const darkModeBtn      = document.getElementById("darkModeBtn");
const productSearch    = document.getElementById("productSearch");
const barcodeInput     = document.getElementById("barcodeInput");

// ── TOKEN STORAGE ─────────────────────────────────────────────
function saveToken(token, user) {
  sessionStorage.setItem("novapos_token", token);
  sessionStorage.setItem("novapos_user", JSON.stringify(user));
  localStorage.setItem("novapos_token", token);
  localStorage.setItem("novapos_user", JSON.stringify(user));
}

function getToken() {
  return sessionStorage.getItem("novapos_token") || localStorage.getItem("novapos_token");
}

function getSavedUser() {
  try {
    const u = sessionStorage.getItem("novapos_user") || localStorage.getItem("novapos_user");
    return u ? JSON.parse(u) : null;
  } catch { return null; }
}

function clearToken() {
  sessionStorage.removeItem("novapos_token");
  sessionStorage.removeItem("novapos_user");
  localStorage.removeItem("novapos_token");
  localStorage.removeItem("novapos_user");
}

// ── API HELPER ────────────────────────────────────────────────
async function api(url, options = {}) {
  const token = getToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  if (options.headers) Object.assign(headers, options.headers);

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    state.currentUser = null;
    applySessionState();
    throw new Error("Session expired. Please login again.");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "API error");
  return data;
}

function applyTheme() {
  document.body.dataset.theme = state.theme;
  darkModeBtn.textContent = state.theme === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode";
}

function applySessionState() {
  const logged = Boolean(state.currentUser);
  document.body.classList.toggle("authenticated", logged);
  inventoryAdmin.hidden = state.currentUser?.role !== "admin";
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: state.currency }).format(value || 0);
}

function saleTotals() {
  const subtotal       = state.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const discountRate   = Number(document.getElementById("discount").value || 0) / 100;
  const taxRate        = Number(document.getElementById("tax").value || 0) / 100;
  const discountAmount = subtotal * discountRate;
  const taxable        = Math.max(subtotal - discountAmount, 0);
  const taxAmount      = taxable * taxRate;
  const total          = taxable + taxAmount;
  const paymentMethod  = document.getElementById("paymentMethod").value;
  const splitTotal = ["splitCash", "splitCard", "splitWallet"]
    .reduce((sum, id) => sum + Number(document.getElementById(id)?.value || 0), 0);
  const received = paymentMethod === "Split"
    ? splitTotal
    : Number(document.getElementById("amountReceived").value || 0);
  const change         = Math.max(received - total, 0);
  return { subtotal, discountAmount, taxAmount, total, received, change };
}

function renderTotals() {
  const t = saleTotals();
  document.getElementById("subtotal").textContent      = money(t.subtotal);
  document.getElementById("discountValue").textContent = `-${money(t.discountAmount)}`;
  document.getElementById("taxValue").textContent      = money(t.taxAmount);
  document.getElementById("grandTotal").textContent    = money(t.total);
  document.getElementById("changeDue").textContent     = money(t.change);
}

function renderKpis() {
  const today        = new Date().toDateString();
  const todaySales   = state.history.filter(h => new Date(h.timestamp).toDateString() === today);
  const revenue      = todaySales.reduce((s, h) => s + (h.total || 0), 0);
  const transactions = todaySales.length;
  const average      = transactions ? revenue / transactions : 0;
  const lowStock     = state.products.filter(p => p.stock <= 5).length;
  document.getElementById("kpiRevenue").textContent      = money(revenue);
  document.getElementById("kpiTransactions").textContent = String(transactions);
  document.getElementById("kpiAverage").textContent      = money(average);
  document.getElementById("kpiLowStock").textContent     = String(lowStock);
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  state.products    = data.products || [];
  state.history     = data.history  || [];
  state.currency    = data.settings?.currency    || "USD";
  state.theme       = data.settings?.theme       || "light";
  state.cashierName = state.currentUser?.username || "";
  currencySelect.value   = state.currency;
  cashierNameInput.value = state.currentUser?.username || state.cashierName || "";
  cashierNameInput.disabled = Boolean(state.currentUser);
  applyTheme();
  renderProducts();
  renderHistory();
  renderCart();
  renderKpis();
}

function renderProducts() {
  productGrid.innerHTML = "";
  const term     = productSearch.value.trim().toLowerCase();
  const filtered = state.products.filter(p =>
    !term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term) || (p.barcode || "").toLowerCase().includes(term)
  );
  if (filtered.length === 0) {
    productGrid.innerHTML = "<p style='color:var(--muted);padding:1rem'>No products found.</p>";
    return;
  }
  filtered.forEach(p => {
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <strong>${p.name}</strong>
      <small>SKU: ${p.sku}</small>
      <small>${money(p.price)}</small>
      <small class="stock ${p.stock <= 5 ? "low" : ""}">Stock: ${p.stock}</small>
      <button class="btn" ${p.stock <= 0 ? "disabled" : ""}>Add</button>
    `;
    card.querySelector("button").onclick = () => addToCart(p.id);
    productGrid.appendChild(card);
  });
}

function addToCart(id) {
  const product = state.products.find(p => p.id === id);
  if (!product || product.stock <= 0) return;
  const existing = state.cart.find(i => i.productId === id);
  if (existing) {
    if (existing.qty >= product.stock) { alert("Cannot add more than available stock."); return; }
    existing.qty += 1;
  } else {
    state.cart.push({ productId: id, name: product.name, price: product.price, qty: 1 });
  }
  renderCart();
}

function removeFromCart(productId) {
  state.cart = state.cart.filter(l => l.productId !== productId);
  renderCart();
}

function renderCart() {
  cartBody.innerHTML = "";
  state.cart.forEach(item => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.qty}</td>
      <td>${money(item.price)}</td>
      <td>${money(item.price * item.qty)}</td>
      <td><button class="btn danger" type="button">×</button></td>
    `;
    row.querySelector("button").addEventListener("click", () => removeFromCart(item.productId));
    cartBody.appendChild(row);
  });
  renderTotals();
}

function renderHistory() {
  historyBody.innerHTML = "";
  state.history.forEach(sale => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${sale.receiptNo}</td>
      <td>${new Date(sale.timestamp).toLocaleString()}</td>
      <td>${sale.cashier || "-"}</td>
      <td>${sale.items?.length || 0}</td>
      <td>${sale.paymentMethod || "-"}</td>
      <td>${money(sale.total)}</td>
      <td><button class="btn ghost" type="button">Refund</button></td>
    `;
    row.querySelector("button").addEventListener("click", () => alert("Refund/return request captured for " + sale.receiptNo));
    historyBody.appendChild(row);
  });
}

async function persistSettings(partial) {
  await api("/api/settings", { method: "PUT", body: JSON.stringify(partial) });
}

async function handleLogin(event) {
  event.preventDefault();
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const role     = document.getElementById("loginRole").value;
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password, role })
    });
    saveToken(data.token, data.user);
    state.currentUser = data.user;
    // cashier name is always the logged in user
    cashierNameInput.value = data.user.username;
    cashierNameInput.disabled = true;
    applySessionState();
    await loadBootstrap();
  } catch (err) {
    alert(err.message || "Login failed");
  }
}

function logout() {
  clearToken();
  state.currentUser = null;
  state.cart = [];
  applySessionState();
  renderCart();
}

function buildReceipt(sale, totals) {
  return [
    `Receipt: ${sale.receiptNo}`,
    `Time: ${new Date(sale.timestamp).toLocaleString()}`,
    `Cashier: ${state.currentUser?.username || "-"}`,
    `Payment: ${document.getElementById("paymentMethod").value}`,
    "",
    ...state.cart.map(i => `${i.name} x${i.qty}  ${money(i.price * i.qty)}`),
    "",
    `Subtotal: ${money(totals.subtotal)}`,
    `Discount: -${money(totals.discountAmount)}`,
    `Tax:      ${money(totals.taxAmount)}`,
    `Total:    ${money(totals.total)}`,
    `Received: ${money(totals.received)}`,
    `Change:   ${money(totals.change)}`
  ].join("\n");
}


function saveHeldOrders() {
  localStorage.setItem("novapos_held_orders", JSON.stringify(state.heldOrders));
}

function holdCurrentOrder() {
  if (!state.cart.length) { alert("Cart is empty."); return; }
  const held = {
    id: crypto.randomUUID(),
    cart: structuredClone(state.cart),
    discount: document.getElementById("discount").value,
    tax: document.getElementById("tax").value,
    at: new Date().toISOString()
  };
  state.heldOrders.push(held);
  saveHeldOrders();
  resetSale();
  alert("Order held successfully.");
}

function resumeHeldOrder() {
  if (!state.heldOrders.length) { alert("No held orders."); return; }
  const held = state.heldOrders.shift();
  state.cart = held.cart || [];
  document.getElementById("discount").value = held.discount || "0";
  document.getElementById("tax").value = held.tax || "10";
  saveHeldOrders();
  renderCart();
}

function addBySkuOrBarcode(raw) {
  const term = raw.trim().toLowerCase();
  if (!term) return false;
  const product = state.products.find(p => p.sku.toLowerCase() === term || (p.barcode || "").toLowerCase() === term || p.name.toLowerCase() === term);
  if (!product) return false;
  addToCart(product.id);
  return true;
}

function downloadReceipt() {
  const content = receiptContent.textContent || "";
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `receipt-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function completeSale(event) {
  event.preventDefault();
  if (!state.currentUser) { alert("Please login first."); return; }
  if (!state.cart.length) { alert("Cart is empty."); return; }
  const totals = saleTotals();
  if (totals.received < totals.total) { alert("Amount received is less than total."); return; }
  const sale = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      paymentMethod: document.getElementById("paymentMethod").value,
      subtotal: totals.subtotal, discount: totals.discountAmount,
      tax: totals.taxAmount, total: totals.total,
      received: totals.received, change: totals.change,
      currency: state.currency, items: state.cart
    })
  });
  receiptContent.textContent = buildReceipt(sale, totals);
  state.cart = [];
  document.getElementById("amountReceived").value = "0";
  await loadBootstrap();
}

async function addProduct(event) {
  event.preventDefault();
  await api("/api/products", {
    method: "POST",
    body: JSON.stringify({
      name:  document.getElementById("productName").value,
      sku:   document.getElementById("productSku").value,
      price: Number(document.getElementById("productPrice").value),
      stock: Number(document.getElementById("productStock").value)
    })
  });
  event.target.reset();
  await loadBootstrap();
}

async function updatePrice(event) {
  event.preventDefault();
  await api(`/api/products/${encodeURIComponent(document.getElementById("priceSku").value.trim())}/price`, {
    method: "PATCH",
    body: JSON.stringify({ price: Number(document.getElementById("newPrice").value) })
  });
  event.target.reset();
  await loadBootstrap();
}

async function clearHistory() {
  if (!confirm("Clear all sales history?")) return;
  await api("/api/history", { method: "DELETE" });
  await loadBootstrap();
}

function resetSale() {
  state.cart = [];
  document.getElementById("discount").value       = "0";
  document.getElementById("tax").value            = "10";
  document.getElementById("paymentMethod").value  = "Cash";
  document.getElementById("amountReceived").value = "0";
  renderCart();
}

function init() {
  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("checkoutForm").addEventListener("submit", completeSale);
  document.getElementById("productForm").addEventListener("submit", addProduct);
  document.getElementById("priceForm").addEventListener("submit", updatePrice);
  document.getElementById("clearHistoryBtn").addEventListener("click", clearHistory);
  document.getElementById("newSaleBtn").addEventListener("click", resetSale);
  document.getElementById("printReceiptBtn").addEventListener("click", () => window.print());

  ["discount", "tax", "amountReceived", "splitCash", "splitCard", "splitWallet"].forEach(id =>
    document.getElementById(id)?.addEventListener("input", renderTotals)
  );

  productSearch.addEventListener("input", renderProducts);

  barcodeInput.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const ok = addBySkuOrBarcode(barcodeInput.value);
    if (!ok) alert("No product found for scanned barcode / SKU.");
    barcodeInput.value = "";
  });

  document.getElementById("gstPreset").addEventListener("change", e => {
    if (e.target.value) document.getElementById("tax").value = e.target.value;
    renderTotals();
  });

  document.getElementById("paymentMethod").addEventListener("change", e => {
    const split = e.target.value === "Split";
    document.getElementById("splitPaymentFields").hidden = !split;
    renderTotals();
  });

  document.getElementById("holdOrderBtn").addEventListener("click", holdCurrentOrder);
  document.getElementById("resumeOrderBtn").addEventListener("click", resumeHeldOrder);
  document.getElementById("downloadReceiptBtn").addEventListener("click", downloadReceipt);

  currencySelect.addEventListener("change", async e => {
    state.currency = e.target.value;
    await persistSettings({ currency: state.currency });
    renderProducts(); renderCart(); renderHistory(); renderKpis();
  });

  // cashierName is locked to logged in user - no change listener needed

  darkModeBtn.addEventListener("click", async () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
    await persistSettings({ theme: state.theme });
  });

  // Restore session on page reload
  const savedUser  = getSavedUser();
  const savedToken = getToken();
  if (savedUser && savedToken) {
    state.currentUser = savedUser;
    applySessionState();
    loadBootstrap().catch(() => { clearToken(); state.currentUser = null; applySessionState(); });
  }
}

init();