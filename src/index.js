// Shopify → Klaviyo Customer Metafield Sync
// Receives Shopify customer webhooks, fetches metafields, and syncs to Klaviyo

const SHOPIFY_METAFIELD_TO_KLAVIYO_PROPERTY = {
  "counterpoint:LOY_1": "Loyalty Program 1",
  "counterpoint:LOY_2": "Loyalty Program 2",
  "counterpoint:LOY_3": "Loyalty Program 3",
  "counterpoint:CustomerCateg": "Customer Category",
  "counterpoint:CustomerNumber": "Customer Number",
  "counterpoint:Email": "Email",
  "counterpoint:email": "Email",
  "counterpoint:FirstSaleDate": "First Sale Date ",
  "counterpoint:LastSaleDate": "Last Sale Date",
  "counterpoint:Name": "Name",
  "counterpoint:PhoneNumber": "Phone Number",
  "counterpoint:StoreID": "Store ID",
  "klaviyo:First_Sale_Date": "First Sale Date",
  "klaviyo:Date_of_Birth": "Date of Birth",
};

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'shopify-klaviyo-sync' });
    }

    // Verify webhook signature
    const body = await request.text();
    const isValid = await verifyShopifyWebhook(
      body,
      request.headers.get('X-Shopify-Hmac-Sha256'),
      env.SHOPIFY_WEBHOOK_SECRET
    );
    if (!isValid) {
      return new Response('Unauthorized', { status: 401 });
    }

    const topic = request.headers.get('X-Shopify-Topic');

    if (!topic || !topic.startsWith('customers/')) {
      return new Response('Ignored', { status: 200 });
    }

    let customer;
    try {
      customer = JSON.parse(body);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const email = customer.email;
    if (!email) {
      return new Response('No email on customer', { status: 200 });
    }

    try {
      // 1. Fetch metafields from Shopify
      const metafields = await fetchShopifyMetafields(env, customer.id);

      // 2. Build properties and list of properties to unset
      const { properties, unsetKeys } = buildKlaviyoProperties(metafields);

      // 3. Add standard Shopify fields
      properties.shopify_customer_id = String(customer.id);
      properties.shopify_tags = customer.tags || '';
      properties.shopify_state = customer.state || '';
      if (customer.default_address) {
        properties.shopify_city = customer.default_address.city || '';
        properties.shopify_province = customer.default_address.province || '';
        properties.shopify_country = customer.default_address.country || '';
      }

      // 4. Upsert Klaviyo profile
      await upsertKlaviyoProfile(env, email, properties, unsetKeys);

      return new Response('Synced', { status: 200 });
    } catch (err) {
      console.error('Sync error:', err.message);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// ── Verify Shopify webhook HMAC ──
async function verifyShopifyWebhook(body, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return computed === hmacHeader;
}

// ── Fetch customer metafields via Shopify Admin GraphQL ──
async function fetchShopifyMetafields(env, customerId) {
  const query = `
    query {
      customer(id: "gid://shopify/Customer/${customerId}") {
        metafields(first: 100) {
          edges {
            node { namespace key value type }
          }
        }
      }
    }`;

  const resp = await fetch(`https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({ query })
  });

  const data = await resp.json();
  if (data.errors) throw new Error('Shopify API error: ' + JSON.stringify(data.errors));

  const edges = data.data?.customer?.metafields?.edges || [];
  return edges.map(e => e.node).filter(Boolean);
}

// ── Map Shopify metafields → Klaviyo properties ──
// Returns: { properties: {...}, unsetKeys: [...] }
// - properties with values → set normally
// - missing/empty metafields → added to unsetKeys for removal
function buildKlaviyoProperties(metafields) {
  const properties = {};
  const unsetKeys = [];

  // Index existing metafields by "namespace:key"
  const mfMap = {};
  for (const mf of metafields) {
    const mfKey = `${mf.namespace}:${mf.key}`;
    mfMap[mfKey] = mf;
  }

  for (const [mfKey, klaviyoProp] of Object.entries(SHOPIFY_METAFIELD_TO_KLAVIYO_PROPERTY)) {
    const mf = mfMap[mfKey];

    if (!mf || mf.value === null || mf.value === undefined || mf.value === '') {
      // Metafield missing or empty → clear the Klaviyo property
      properties[klaviyoProp] = null;
      continue;
    }

    switch (mf.type) {
      case 'number_integer':  properties[klaviyoProp] = parseInt(mf.value, 10); break;
      case 'number_decimal':  properties[klaviyoProp] = parseFloat(mf.value); break;
      case 'boolean':         properties[klaviyoProp] = mf.value === 'true'; break;
      case 'json':
        try { properties[klaviyoProp] = JSON.parse(mf.value); }
        catch { properties[klaviyoProp] = mf.value; }
        break;
      default:                properties[klaviyoProp] = mf.value;
    }
  }

  return { properties, unsetKeys };
}

// ── Upsert Klaviyo profile using Create or Update Profile endpoint ──
// Uses meta.patch_properties.unset to fully remove cleared properties
async function upsertKlaviyoProfile(env, email, properties, unsetKeys) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Klaviyo-API-Key ${env.KLAVIYO_API_KEY}`,
    'accept': 'application/json',
    'revision': '2025-01-15'
  };

  // Build the request body
  const data = {
    type: 'profile',
    attributes: { email, properties }
  };

  // Add unset keys if any
  if (unsetKeys.length > 0) {
    data.meta = {
      patch_properties: {
        unset: unsetKeys
      }
    };
  }

  // Use Create or Update Profile endpoint (creates if new, updates if exists)
  const resp = await fetch('https://a.klaviyo.com/api/profiles/', {
    method: 'POST',
    headers,
    body: JSON.stringify({ data })
  });

  if (!resp.ok && resp.status !== 201 && resp.status !== 200) {
    throw new Error('Klaviyo upsert failed: ' + await resp.text());
  }
}