const CURRENCY_LOCALES = {
  USD: "en-US",
  INR: "en-IN",
  SAR: "en-SA"
};

const state = {
  products: [],
  cart: [],
  history: [],
  currentUser: null,
  currency: "USD",
  theme: "light"
};

const productGrid = document.getElementById("productGrid");
const cartBody = document.getElementById("cartBody");
const historyBody = document.getElementById("historyBody");
const receiptContent = document.getElementById("receiptContent");
const cashierNameInput = document.getElementById("cashierName");
const inventoryAdmin = document.getElementById("inventoryAdmin");
const currencySelect = document.getElementById("currencySelect");
const darkModeBtn = document.getElementById("darkModeBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Request failed.");
  }
  return response.json();
}

function money(value) {
  const locale = CURRENCY_LOCALES[state.currency] || "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: state.currency,
    minimumFractionDigits: 2
  }).format(value);
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  state.products = data.products || [];
  state.history = data.history || [];
  state.currency = CURRENCY_LOCALES[data.settings?.currency] ? data.settings.currency : "USD";
  state.theme = data.settings?.theme === "dark" ? "dark" : "light";
  cashierNameInput.value = data.settings?.cashierName || "";
}

async function persistSettings(partial) {
  await api("/api/settings", { method: "PUT", body: JSON.stringify(partial) });
}

function setTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  darkModeBtn.textContent = theme === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode";
  persistSettings({ theme }).catch((e) => alert(e.message));
}

function applySessionState() {
  const isLoggedIn = Boolean(state.currentUser);
  document.body.classList.toggle("authenticated", isLoggedIn);

  if (state.currentUser?.role === "admin") {
    inventoryAdmin.hidden = false;
    clearHistoryBtn.hidden = false;
  } else {
    inventoryAdmin.hidden = true;
    clearHistoryBtn.hidden = true;
    inventoryAdmin.removeAttribute("open");
  }
}

function computeTotals() {
  const discountRate = Number(document.getElementById("discount").value || 0) / 100;
  const taxRate = Number(document.getElementById("tax").value || 0) / 100;
  const subtotal = state.cart.reduce((sum, item) => sum + item.qty * item.price, 0);
  const discount = subtotal * discountRate;
  const taxable = Math.max(0, subtotal - discount);
  const tax = taxable * taxRate;
  const total = taxable + tax;
  return { subtotal, discount, tax, total };
}

function renderProducts() {
  const search = document.getElementById("productSearch").value.trim().toLowerCase();
  const filtered = state.products.filter((p) =>
    [p.name, p.sku].some((v) => v.toLowerCase().includes(search))
  );

  productGrid.innerHTML = "";
  filtered.forEach((product) => {
    const card = document.createElement("article");
    card.className = "product-card";
    card.innerHTML = `
      <strong>${product.name}</strong>
      <small>SKU: ${product.sku}</small>
      <small>${money(product.price)}</small>
      <small class="stock ${product.stock <= 5 ? "low" : ""}">Stock: ${product.stock}</small>
      <button class="btn" ${product.stock <= 0 ? "disabled" : ""}>Add to Cart</button>
    `;
    card.querySelector("button").addEventListener("click", () => addToCart(product.id));
    productGrid.appendChild(card);
  });
}

function addToCart(productId) {
  const product = state.products.find((p) => p.id === productId);
  if (!product || product.stock <= 0) return;

  const line = state.cart.find((item) => item.productId === productId);
  if (line) {
    if (line.qty >= product.stock) return;
    line.qty += 1;
  } else {
    state.cart.push({ productId, name: product.name, price: product.price, qty: 1 });
  }

  renderCart();
}

function updateCartQty(productId, qty) {
  const product = state.products.find((p) => p.id === productId);
  const line = state.cart.find((item) => item.productId === productId);
  if (!product || !line) return;

  line.qty = Math.max(1, Math.min(Number(qty) || 1, product.stock));
  renderCart();
}

function removeFromCart(productId) {
  state.cart = state.cart.filter((item) => item.productId !== productId);
  renderCart();
}

function renderCart() {
  cartBody.innerHTML = "";

  state.cart.forEach((line) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${line.name}</td>
      <td><input data-role="qty" type="number" min="1" value="${line.qty}" style="width:70px"></td>
      <td>${money(line.price)}</td>
      <td>${money(line.price * line.qty)}</td>
      <td><button class="btn danger" data-role="remove">×</button></td>
    `;
    row.querySelector('[data-role="qty"]').addEventListener("input", (e) => updateCartQty(line.productId, e.target.value));
    row.querySelector('[data-role="remove"]').addEventListener("click", () => removeFromCart(line.productId));
    cartBody.appendChild(row);
  });

  const totals = computeTotals();
  const amountReceived = Number(document.getElementById("amountReceived").value || 0);
  const change = amountReceived - totals.total;

  document.getElementById("subtotal").textContent = money(totals.subtotal);
  document.getElementById("discountValue").textContent = `-${money(totals.discount)}`;
  document.getElementById("taxValue").textContent = money(totals.tax);
  document.getElementById("grandTotal").textContent = money(totals.total);
  document.getElementById("changeDue").textContent = money(change > 0 ? change : 0);
}

function renderHistory() {
  historyBody.innerHTML = "";
  [...state.history].forEach((sale) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${sale.receiptNo}</td>
      <td>${new Date(sale.timestamp).toLocaleString()}</td>
      <td>${sale.cashier || "-"}</td>
      <td>${sale.items.reduce((sum, i) => sum + i.qty, 0)}</td>
      <td>${sale.paymentMethod}</td>
      <td>${money(sale.total)}</td>
    `;
    historyBody.appendChild(row);
  });
}

function renderKPIs() {
  const today = new Date().toDateString();
  const todaySales = state.history.filter((sale) => new Date(sale.timestamp).toDateString() === today);
  const revenue = todaySales.reduce((sum, sale) => sum + sale.total, 0);
  const average = todaySales.length ? revenue / todaySales.length : 0;
  const lowStock = state.products.filter((p) => p.stock <= 5).length;

  document.getElementById("kpiRevenue").textContent = money(revenue);
  document.getElementById("kpiTransactions").textContent = String(todaySales.length);
  document.getElementById("kpiAverage").textContent = money(average);
  document.getElementById("kpiLowStock").textContent = String(lowStock);
}

async function refreshFromServer() {
  await loadBootstrap();
  renderProducts();
  renderCart();
  renderHistory();
  renderKPIs();
}

async function completeSale(event) {
  event.preventDefault();
  if (!state.cart.length) return alert("Cart is empty.");

  const totals = computeTotals();
  const amountReceived = Number(document.getElementById("amountReceived").value || 0);
  if (amountReceived < totals.total) return alert("Amount received is less than total.");

  try {
    const result = await api("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        cashier: cashierNameInput.value.trim() || state.currentUser?.username || "",
        paymentMethod: document.getElementById("paymentMethod").value,
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        total: totals.total,
        received: amountReceived,
        change: amountReceived - totals.total,
        currency: state.currency,
        items: state.cart
      })
    });

    const sale = {
      receiptNo: result.receiptNo,
      timestamp: result.timestamp,
      cashier: cashierNameInput.value.trim() || state.currentUser?.username || "",
      paymentMethod: document.getElementById("paymentMethod").value,
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      total: totals.total,
      received: amountReceived,
      change: amountReceived - totals.total,
      items: state.cart.map((x) => ({ ...x }))
    };

    receiptContent.textContent = formatReceipt(sale);
    state.cart = [];
    await refreshFromServer();
  } catch (e) {
    alert(e.message);
  }
}

function formatReceipt(sale) {
  const lines = [
    `Receipt ${sale.receiptNo}`,
    `${new Date(sale.timestamp).toLocaleString()}`,
    `Cashier: ${sale.cashier || "N/A"}`,
    `Role: ${state.currentUser?.role || "unknown"}`,
    `Currency: ${state.currency}`,
    "--------------------------------",
    ...sale.items.map((i) => `${i.name} x${i.qty}  ${money(i.qty * i.price)}`),
    "--------------------------------",
    `Subtotal: ${money(sale.subtotal)}`,
    `Discount: -${money(sale.discount)}`,
    `Tax: ${money(sale.tax)}`,
    `Total: ${money(sale.total)}`,
    `Paid: ${money(sale.received)} via ${sale.paymentMethod}`,
    `Change: ${money(sale.change)}`,
    "Thank you for shopping!"
  ];
  return lines.join("\n");
}

async function addProduct(event) {
  event.preventDefault();
  if (state.currentUser?.role !== "admin") return alert("Only admin can add products.");

  const name = document.getElementById("productName").value.trim();
  const sku = document.getElementById("productSku").value.trim();
  const price = Number(document.getElementById("productPrice").value);
  const stock = Number(document.getElementById("productStock").value);
  if (!name || !sku || price < 0 || stock < 0) return;

  try {
    await api("/api/products", { method: "POST", body: JSON.stringify({ name, sku, price, stock }) });
    event.target.reset();
    await refreshFromServer();
  } catch (e) {
    alert(e.message);
  }
}

async function updateProductPrice(event) {
  event.preventDefault();
  if (state.currentUser?.role !== "admin") return alert("Only admin can update price.");

  const sku = document.getElementById("priceSku").value.trim();
  const newPrice = Number(document.getElementById("newPrice").value);
  if (!sku || Number.isNaN(newPrice) || newPrice < 0) return alert("Enter valid SKU and price.");

  try {
    await api(`/api/products/${encodeURIComponent(sku)}/price`, {
      method: "PATCH",
      body: JSON.stringify({ price: newPrice })
    });

    const product = state.products.find((p) => p.sku.toLowerCase() === sku.toLowerCase());
    if (product) {
      state.cart = state.cart.map((line) => (
        line.productId === product.id ? { ...line, price: newPrice } : line
      ));
    }

    event.target.reset();
    await refreshFromServer();
    alert("Price updated successfully.");
  } catch (e) {
    alert(e.message);
  }
}

async function clearHistory() {
  if (state.currentUser?.role !== "admin") return alert("Only admin can clear history.");
  if (!confirm("Clear all sales history?")) return;
  await api("/api/history", { method: "DELETE" });
  await refreshFromServer();
}

function resetCurrentSale() {
  state.cart = [];
  document.getElementById("discount").value = 0;
  document.getElementById("tax").value = 10;
  document.getElementById("amountReceived").value = 0;
  renderCart();
}

async function handleLogin(event) {
  event.preventDefault();
  const role = document.getElementById("loginRole").value;
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;

  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password, role })
    });

    state.currentUser = result.user;
    if (!cashierNameInput.value.trim()) cashierNameInput.value = result.user.username;
    applySessionState();
  } catch (e) {
    alert(e.message);
  }
}

function logout() {
  if (!confirm("Logout from current session?")) return;
  state.currentUser = null;
  applySessionState();
}

function changeCurrency() {
  state.currency = currencySelect.value;
  persistSettings({ currency: state.currency }).catch((e) => alert(e.message));
  renderProducts();
  renderCart();
  renderHistory();
  renderKPIs();
}

function printReceipt() {
  window.print();
}

function persistCashierName() {
  persistSettings({ cashierName: cashierNameInput.value.trim() }).catch((e) => alert(e.message));
}

async function init() {
  await loadBootstrap();
  currencySelect.value = state.currency;
  setTheme(state.theme);
  applySessionState();
  renderProducts();
  renderCart();
  renderHistory();
  renderKPIs();

  document.getElementById("productSearch").addEventListener("input", renderProducts);
  document.getElementById("discount").addEventListener("input", renderCart);
  document.getElementById("tax").addEventListener("input", renderCart);
  document.getElementById("amountReceived").addEventListener("input", renderCart);
  document.getElementById("checkoutForm").addEventListener("submit", completeSale);
  document.getElementById("productForm").addEventListener("submit", addProduct);
  document.getElementById("priceForm").addEventListener("submit", updateProductPrice);
  document.getElementById("clearHistoryBtn").addEventListener("click", clearHistory);
  document.getElementById("newSaleBtn").addEventListener("click", resetCurrentSale);
  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("printReceiptBtn").addEventListener("click", printReceipt);
  currencySelect.addEventListener("change", changeCurrency);
  darkModeBtn.addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));
  cashierNameInput.addEventListener("input", persistCashierName);
}

init().catch((e) => {
  alert(`Failed to load backend: ${e.message}`);
});
