const state = {
  products: [],
  cart: [],
  history: [],
  currentUser: null,
  currency: "USD",
  theme: "light",
  cashierName: ""
};

const productGrid = document.getElementById("productGrid");
const cartBody = document.getElementById("cartBody");
const historyBody = document.getElementById("historyBody");
const receiptContent = document.getElementById("receiptContent");
const cashierNameInput = document.getElementById("cashierName");
const inventoryAdmin = document.getElementById("inventoryAdmin");
const currencySelect = document.getElementById("currencySelect");
const darkModeBtn = document.getElementById("darkModeBtn");
const productSearch = document.getElementById("productSearch");

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || "API error");
  }

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
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: state.currency
  }).format(value || 0);
}

function saleTotals() {
  const subtotal = state.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const discountRate = Number(document.getElementById("discount").value || 0) / 100;
  const taxRate = Number(document.getElementById("tax").value || 0) / 100;
  const discountAmount = subtotal * discountRate;
  const taxable = Math.max(subtotal - discountAmount, 0);
  const taxAmount = taxable * taxRate;
  const total = taxable + taxAmount;
  const received = Number(document.getElementById("amountReceived").value || 0);
  const change = Math.max(received - total, 0);
  return { subtotal, discountAmount, taxAmount, total, received, change };
}

function renderTotals() {
  const totals = saleTotals();
  document.getElementById("subtotal").textContent = money(totals.subtotal);
  document.getElementById("discountValue").textContent = `-${money(totals.discountAmount)}`;
  document.getElementById("taxValue").textContent = money(totals.taxAmount);
  document.getElementById("grandTotal").textContent = money(totals.total);
  document.getElementById("changeDue").textContent = money(totals.change);
}

function renderKpis() {
  const today = new Date().toDateString();
  const todaySales = state.history.filter((h) => new Date(h.timestamp).toDateString() === today);
  const revenue = todaySales.reduce((sum, h) => sum + (h.total || 0), 0);
  const transactions = todaySales.length;
  const average = transactions ? revenue / transactions : 0;
  const lowStock = state.products.filter((p) => p.stock <= 5).length;

  document.getElementById("kpiRevenue").textContent = money(revenue);
  document.getElementById("kpiTransactions").textContent = String(transactions);
  document.getElementById("kpiAverage").textContent = money(average);
  document.getElementById("kpiLowStock").textContent = String(lowStock);
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");

  state.products = data.products || [];
  state.history = data.history || [];
  state.currency = data.settings?.currency || "USD";
  state.theme = data.settings?.theme || "light";
  state.cashierName = data.settings?.cashierName || "";

  currencySelect.value = state.currency;
  cashierNameInput.value = state.cashierName;

  applyTheme();
  renderProducts();
  renderHistory();
  renderCart();
  renderKpis();
}

function renderProducts() {
  productGrid.innerHTML = "";
  const term = productSearch.value.trim().toLowerCase();
  const filtered = state.products.filter((p) => {
    if (!term) return true;
    return p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term);
  });

  filtered.forEach((p) => {
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
  const product = state.products.find((p) => p.id === id);
  if (!product || product.stock <= 0) return;

  const existing = state.cart.find((i) => i.productId === id);
  const alreadyInCart = existing ? existing.qty : 0;
  if (alreadyInCart >= product.stock) {
    alert("Cannot add more than available stock.");
    return;
  }

  if (existing) {
    existing.qty += 1;
  } else {
    state.cart.push({
      productId: id,
      name: product.name,
      price: product.price,
      qty: 1
    });
  }

  renderCart();
}

function removeFromCart(productId) {
  state.cart = state.cart.filter((line) => line.productId !== productId);
  renderCart();
}

function renderCart() {
  cartBody.innerHTML = "";

  state.cart.forEach((item) => {
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

  state.history.forEach((sale) => {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${sale.receiptNo}</td>
      <td>${new Date(sale.timestamp).toLocaleString()}</td>
      <td>${sale.cashier || "-"}</td>
      <td>${sale.items?.length || 0}</td>
      <td>${sale.paymentMethod || "-"}</td>
      <td>${money(sale.total)}</td>
    `;

    historyBody.appendChild(row);
  });
}

async function persistSettings(partial) {
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(partial)
  });
}

async function handleLogin(event) {
  event.preventDefault();

  const username = document.getElementById("loginUsername").value;
  const password = document.getElementById("loginPassword").value;
  const role = document.getElementById("loginRole").value;

  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password, role })
    });

    state.currentUser = data.user;
    if (!cashierNameInput.value) {
      cashierNameInput.value = data.user.username;
    }
    applySessionState();
  } catch {
    alert("Login failed");
  }
}

function logout() {
  state.currentUser = null;
  applySessionState();
}

function buildReceipt(sale, totals) {
  const lines = [
    `Receipt ${sale.receiptNo}`,
    `Time: ${new Date(sale.timestamp).toLocaleString()}`,
    `Cashier: ${state.cashierName || state.currentUser?.username || "-"}`,
    `Payment: ${document.getElementById("paymentMethod").value}`,
    "",
    ...state.cart.map((i) => `${i.name} x${i.qty}  ${money(i.price * i.qty)}`),
    "",
    `Subtotal: ${money(totals.subtotal)}`,
    `Discount: -${money(totals.discountAmount)}`,
    `Tax: ${money(totals.taxAmount)}`,
    `Total: ${money(totals.total)}`,
    `Received: ${money(totals.received)}`,
    `Change: ${money(totals.change)}`
  ];

  return lines.join("\n");
}

async function completeSale(event) {
  event.preventDefault();

  if (!state.currentUser) {
    alert("Please login first.");
    return;
  }

  if (!state.cart.length) {
    alert("Cart empty");
    return;
  }

  const totals = saleTotals();
  if (totals.received < totals.total) {
    alert("Amount received is less than total.");
    return;
  }

  const sale = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      cashier: state.cashierName || state.currentUser.username,
      paymentMethod: document.getElementById("paymentMethod").value,
      subtotal: totals.subtotal,
      discount: totals.discountAmount,
      tax: totals.taxAmount,
      total: totals.total,
      received: totals.received,
      change: totals.change,
      currency: state.currency,
      items: state.cart
    })
  });

  receiptContent.textContent = buildReceipt(sale, totals);

  state.cart = [];
  document.getElementById("amountReceived").value = "0";

  await loadBootstrap();
}

async function addProduct(event) {
  event.preventDefault();

  const name = document.getElementById("productName").value;
  const sku = document.getElementById("productSku").value;
  const price = Number(document.getElementById("productPrice").value);
  const stock = Number(document.getElementById("productStock").value);

  await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ name, sku, price, stock })
  });

  event.target.reset();
  await loadBootstrap();
}

async function updatePrice(event) {
  event.preventDefault();

  const sku = document.getElementById("priceSku").value.trim();
  const price = Number(document.getElementById("newPrice").value);

  await api(`/api/products/${encodeURIComponent(sku)}/price`, {
    method: "PATCH",
    body: JSON.stringify({ price })
  });

  event.target.reset();
  await loadBootstrap();
}

async function clearHistory() {
  if (!confirm("Clear complete sales history?")) return;
  await api("/api/history", { method: "DELETE" });
  await loadBootstrap();
}

function resetSale() {
  state.cart = [];
  document.getElementById("discount").value = "0";
  document.getElementById("tax").value = "10";
  document.getElementById("paymentMethod").value = "Cash";
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

  ["discount", "tax", "amountReceived"].forEach((id) => {
    document.getElementById(id).addEventListener("input", renderTotals);
  });

  productSearch.addEventListener("input", renderProducts);

  currencySelect.addEventListener("change", async (event) => {
    state.currency = event.target.value;
    await persistSettings({ currency: state.currency });
    renderProducts();
    renderCart();
    renderHistory();
    renderKpis();
  });

  cashierNameInput.addEventListener("change", async (event) => {
    state.cashierName = event.target.value.trim();
    await persistSettings({ cashierName: state.cashierName });
  });

  darkModeBtn.addEventListener("click", async () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
    await persistSettings({ theme: state.theme });
  });

  loadBootstrap();
}

init();
