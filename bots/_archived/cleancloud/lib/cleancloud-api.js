/**
 * CleanCloud API client (read-only)
 *
 * Uses the CleanCloud REST API for fetching products and price lists.
 * The API has no write endpoints — mutations go through browser automation.
 */

const API_BASE = 'https://cleancloudapp.com/api';
const RATE_LIMIT_MS = 300;

let lastRequestTime = 0;

async function rateLimitedFetch(url, options) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
  return fetch(url, options);
}

function getApiToken() {
  const token = process.env.CLEANCLOUD_API_TOKEN;
  if (!token) throw new Error('CLEANCLOUD_API_TOKEN not set');
  return token;
}

/**
 * Fetch products from CleanCloud API
 * @param {string} priceListId - Price list ID ('0' for default/retail)
 * @returns {Promise<Array>} Array of product objects
 */
export async function getProducts(priceListId = '0') {
  const res = await rateLimitedFetch(`${API_BASE}/getProducts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_token: getApiToken(),
      priceListID: priceListId,
      inStore: '1',
      sendParents: '1',
    }),
  });

  if (!res.ok) {
    throw new Error(`getProducts failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.Products || [];
}

/**
 * Fetch price lists from CleanCloud API
 * @returns {Promise<Array>} Array of price list objects
 */
export async function getPriceLists() {
  const res = await rateLimitedFetch(`${API_BASE}/getPriceLists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_token: getApiToken(),
    }),
  });

  if (!res.ok) {
    throw new Error(`getPriceLists failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.PriceLists || data.priceLists || [];
}

/**
 * Full sync: fetch products + price lists and upsert into DB
 */
export async function syncFromAPI(config, db) {
  const {
    upsertSection,
    upsertProduct,
    upsertProductPrice,
    upsertPriceList,
    saveSyncSnapshot,
  } = db;

  // 1. Fetch price lists
  let priceLists = [];
  try {
    priceLists = await getPriceLists();
    for (const pl of priceLists) {
      upsertPriceList(config, { id: String(pl.ID || pl.id), name: pl.name });
    }
  } catch (err) {
    // Price lists may not be available — continue with products
    console.warn(`getPriceLists failed: ${err.message}`);
  }

  // 2. Fetch products (default price list)
  const products = await getProducts('0');

  // 3. Extract unique sections
  const sectionMap = new Map();
  for (const p of products) {
    const secId = String(p.section || p.sectionId || '');
    const secName = p.sectionName || p.section_name || '';
    if (secId && !sectionMap.has(secId)) {
      sectionMap.set(secId, { id: secId, name: secName, sort_order: sectionMap.size });
    }
  }

  // Upsert sections
  for (const section of sectionMap.values()) {
    upsertSection(config, section);
  }

  // 4. Upsert products + prices
  for (const p of products) {
    const productId = String(p.ID || p.id);
    const sectionId = String(p.section || p.sectionId || '');
    const isParent = p.type === '4' || p.productType === 'parent';

    upsertProduct(config, {
      id: productId,
      name: p.name,
      section_id: sectionId,
      sort_order: p.sortOrder ?? p.sort_order ?? null,
      sku: p.sku ?? null,
      type: p.type ?? null,
      pieces: p.pieces ?? null,
      is_parent: isParent,
      parent_id: p.parentId ? String(p.parentId) : null,
    });

    // Upsert default price
    const price = p.price ?? p.Price ?? null;
    const expressPrice = p.expressPrice ?? p.express_price ?? p.expressRate ?? null;
    if (price != null) {
      upsertProductPrice(config, productId, '0', String(price), expressPrice != null ? String(expressPrice) : null);
    }
  }

  // 5. Save snapshot
  saveSyncSnapshot(config, {
    product_count: products.length,
    section_count: sectionMap.size,
  });

  return {
    products: products.length,
    sections: sectionMap.size,
    priceLists: priceLists.length,
  };
}
