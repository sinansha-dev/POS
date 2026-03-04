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

function applySessionState() {
  const logged = Boolean(state.currentUser);
  document.body.classList.toggle("authenticated", logged);

  if (state.currentUser?.role === "admin") {
    inventoryAdmin.hidden = false;
  } else {
    inventoryAdmin.hidden = true;
  }
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: state.currency
  }).format(value);
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");

  state.products = data.products || [];
  state.history = data.history || [];
  state.currency = data.settings?.currency || "USD";

  renderProducts();
  renderHistory();
}

function renderProducts() {
  productGrid.innerHTML = "";

  state.products.forEach((p) => {
    const card = document.createElement("div");
    card.className = "product-card";

    card.innerHTML = `
      <strong>${p.name}</strong>
      <small>SKU: ${p.sku}</small>
      <small>${money(p.price)}</small>
      <small>Stock: ${p.stock}</small>
     <button class="btn">Add</button>
    `;

    card.querySelector("button").onclick = () => addToCart(p.id);

    productGrid.appendChild(card);
  });
}

function addToCart(id) {
  const product = state.products.find(p => p.id === id);
  if (!product) return;

  const existing = state.cart.find(i => i.productId === id);

  if (existing) {
    existing.qty++;
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

function renderCart() {
  cartBody.innerHTML = "";

  state.cart.forEach((item) => {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${item.name}</td>
      <td>${item.qty}</td>
      <td>${money(item.price)}</td>
      <td>${money(item.price * item.qty)}</td>
    `;

    cartBody.appendChild(row);
  });
}

function renderHistory() {
  historyBody.innerHTML = "";

  state.history.forEach((sale) => {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${sale.receiptNo}</td>
      <td>${new Date(sale.timestamp).toLocaleString()}</td>
      <td>${sale.cashier}</td>
      <td>${sale.paymentMethod}</td>
      <td>${money(sale.total)}</td>
    `;

    historyBody.appendChild(row);
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

    cashierNameInput.value = data.user.username;

    applySessionState();

  } catch (err) {
    alert("Login failed");
  }
}

function logout() {
  state.currentUser = null;
  applySessionState();
}

async function completeSale(event) {
  event.preventDefault();

  if (!state.cart.length) {
    alert("Cart empty");
    return;
  }

  const subtotal = state.cart.reduce((s, i) => s + i.price * i.qty, 0);

  const sale = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      cashier: state.currentUser.username,
      paymentMethod: "cash",
      subtotal,
      discount: 0,
      tax: 0,
      total: subtotal,
      received: subtotal,
      change: 0,
      currency: state.currency,
      items: state.cart
    })
  });

  receiptContent.textContent = `Receipt ${sale.receiptNo}`;

  state.cart = [];

  await loadBootstrap();

  renderCart();
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

  await loadBootstrap();
}

function init() {

  document.getElementById("loginForm").addEventListener("submit", handleLogin);

  document.getElementById("logoutBtn").addEventListener("click", logout);

  document.getElementById("checkoutForm").addEventListener("submit", completeSale);

  document.getElementById("productForm").addEventListener("submit", addProduct);

  loadBootstrap();
}

init();
