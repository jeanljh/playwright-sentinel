// A small shop app with planted bugs. Every page looks fine, so UI tests pass,
// but the browser console and network log show real problems.
//
// The page is served from http://localhost:PORT. Anything served from
// http://127.0.0.1:PORT counts as a different origin, which stands in for a
// third-party CDN and lets the demo produce CORS errors.
import http from 'node:http';
import { randomInt } from 'node:crypto';

const PORT = Number(process.env.DEMO_PORT ?? 4319);
const THIRD_PARTY = `http://127.0.0.1:${PORT}`;
const EXTRA_BUG = process.env.DEMO_EXTRA_BUG === '1';

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title} · ShopLite</title>
  <link rel="stylesheet" href="/static/theme-v2.css">
  <style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:40rem} nav a{margin-right:1rem}</style>
</head>
<body>
  <nav><a href="/">Home</a><a href="/products">Products</a><a href="/cart">Cart</a><a href="/checkout">Checkout</a></nav>
  ${body}
</body>
</html>`;
}

const pages = {
  '/': layout('Home', `
  <h1>Welcome to ShopLite</h1>
  <p id="banner">Loading…</p>
  <script src="${THIRD_PARTY}/vendor/chat-widget.js"></script>
  <script>
    console.warn('[deprecated] initLegacyAnalytics() will be removed in v3. Use initAnalytics() instead.');
    fetch('/api/banner').then((r) => r.json()).then((d) => { document.getElementById('banner').textContent = d.text; });
    ${EXTRA_BUG ? "console.error('Price service returned stale prices for 4 products');" : ''}
  </script>`),

  '/products': layout('Products', `
  <h1>Products</h1>
  <ul id="list"></ul>
  <section id="recs" hidden><h2>Recommended for you</h2><ul id="recs-list"></ul></section>
  <p id="reviews">Loading reviews…</p>
  <script>
    fetch('/api/products').then((r) => r.json()).then((items) => {
      const list = document.getElementById('list');
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item.name + ' - $' + item.price;
        list.appendChild(li);
      }
      console.error('Warning: Each child in a list should have a unique "key" prop. Check the render method of \`ProductList\`.');
    });
    fetch('/api/recommendations')
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(() => { document.getElementById('recs').hidden = false; })
      .catch((err) => console.error('Failed to load recommendations:', err.message));
    fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ reviews(productId: 1) { rating text } }' }),
    })
      .then((r) => r.json())
      .then((d) => {
        document.getElementById('reviews').textContent = d.data && d.data.reviews ? d.data.reviews.length + ' reviews' : 'No reviews yet';
      });
  </script>`),

  '/cart': layout('Cart', `
  <h1>Your cart</h1>
  <p>Items: <span id="count">0</span></p>
  <button id="add">Add to cart</button>
  <p id="stock">Checking stock…</p>
  <script>
    // Simulates the message React logs when server and client markup differ.
    console.error('Hydration failed because the server rendered text didn\\'t match the client. Server: "3 items" Client: "0 items"');
    fetch('${THIRD_PARTY}/api/stock?sku=123')
      .then((r) => r.json())
      .then((d) => { document.getElementById('stock').textContent = d.text; })
      .catch(() => { document.getElementById('stock').textContent = 'Stock info unavailable'; });

    let count = 0;
    function trackEvent(name) {
      return new Promise((_, reject) => setTimeout(() => reject(new Error('Analytics queue not initialized: dropped event ' + name)), 0));
    }
    function updateMiniCart() {
      window.miniCart.items.push({ sku: 123 });
    }
    document.getElementById('add').addEventListener('click', () => {
      count++;
      document.getElementById('count').textContent = String(count);
      trackEvent('add_to_cart');
      updateMiniCart();
    });
  </script>`),

  '/checkout': layout('Checkout', `
  <h1>Checkout</h1>
  <form id="form">
    <label>Email <input name="email" type="email" required></label>
    <button type="submit">Place order</button>
  </form>
  <p id="result"></p>
  <script>
    document.getElementById('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = new FormData(event.target).get('email');
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const order = await res.json();
      await fetch('/api/orders/' + order.id + '/receipt').catch(() => {});
      document.getElementById('result').textContent = 'Order ' + order.id + ' placed';
    });
  </script>`),
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json', ...headers });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'GET' && pages[path]) return send(res, 200, pages[path], { 'content-type': 'text/html' });

  switch (`${req.method} ${path}`) {
    case 'GET /health':
      return send(res, 200, 'ok');
    case 'GET /vendor/chat-widget.js':
      // A third-party widget that expects a config object the page never defines.
      return send(res, 200, "(function () { var config = window.ChatWidgetConfig; config.position = 'bottom-right'; })();", {
        'content-type': 'application/javascript',
      });
    case 'GET /api/banner':
      return json(res, 200, { text: 'Free shipping over $50' });
    case 'GET /api/products':
      return json(res, 200, [
        { id: 1, name: 'Trail runner shoes', price: 89 },
        { id: 2, name: 'Rain jacket', price: 120 },
        { id: 3, name: 'Water bottle', price: 18 },
      ]);
    case 'GET /api/recommendations':
      return json(res, 500, { error: 'recommendation-service timed out after 3000ms', requestId: 'f3b2c1d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' });
    case 'POST /graphql':
      return json(res, 200, {
        data: { reviews: null },
        errors: [{ message: 'Cannot query field "rating" on type "Review".', path: ['reviews'] }],
      });
    case 'GET /api/stock':
      // No Access-Control-Allow-Origin header, so the browser blocks the cross-origin read.
      return json(res, 200, { text: 'In stock' });
    case 'POST /api/orders':
      return json(res, 201, { id: randomInt(10000, 99999) });
    case 'GET /favicon.ico':
      return send(res, 404, '');
    default:
      break;
  }

  if (req.method === 'GET' && /^\/api\/orders\/\d+\/receipt$/.test(path)) {
    return json(res, 404, {
      error: 'receipt not found',
      customer: 'jane.doe@example.com',
      token: 'demo-session-token-not-real',
    });
  }
  if (path.startsWith('/api/') || path.startsWith('/static/')) return json(res, 404, { error: 'not found' });
  return send(res, 404, layout('Not found', '<h1>Page not found</h1><p>Try the <a href="/">home page</a>.</p>'), {
    'content-type': 'text/html',
  });
});

server.listen(PORT, () => {
  console.log(`ShopLite demo running at http://localhost:${PORT}${EXTRA_BUG ? ' (with the extra bug)' : ''}`);
});
