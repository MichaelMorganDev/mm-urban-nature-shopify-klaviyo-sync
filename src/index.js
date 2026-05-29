// Shopify → Klaviyo Customer Metafield Sync
// Receives Shopify customer webhooks, fetches metafields, syncs to Klaviyo

const METAFIELD_MAP = {
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
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'shopify-klaviyo-sync' });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
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

      // 2. Map metafields to Klaviyo properties using our mapping
      const properties = buildKlaviyoProperties(metafields);

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
      await upsertKlaviyoProfile(env, email, properties);

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

function buildKlaviyoProperties(metafields) {
  const properties = {};
  for (const mf of metafields) {
    const mapKey = mf.namespace + ':' + mf.key;
    const propKey = METAFIELD_MAP[mapKey];

    // Only sync metafields that are in our mapping
    if (!propKey) continue;

    switch (mf.type) {
      case 'number_integer':  properties[propKey] = parseInt(mf.value, 10); break;
      case 'number_decimal':  properties[propKey] = parseFloat(mf.value); break;
      case 'boolean':         properties[propKey] = mf.value === 'true'; break;
      case 'json':
        try { properties[propKey] = JSON.parse(mf.value); }
        catch { properties[propKey] = mf.value; }
        break;
      default:                properties[propKey] = mf.value;
    }
  }
  return properties;
}

async function upsertKlaviyoProfile(env, email, properties) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Klaviyo-API-Key ' + env.KLAVIYO_API_KEY,
    'accept': 'application/json',
    'revision': '2025-01-15'
  };

  const createResp = await fetch('https://a.klaviyo.com/api/profiles/', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      data: { type: 'profile', attributes: { email, properties } }
    })
  });

  if (createResp.status === 409) {
    const lookup = await fetch(
      'https://a.klaviyo.com/api/profiles/?filter=equals(email,"' + email + '")',
      { headers }
    );
    const lookupData = await lookup.json();
    const profileId = lookupData.data?.[0]?.id;
    if (!profileId) throw new Error('Could not find existing Klaviyo profile');

    const updateResp = await fetch('https://a.klaviyo.com/api/profiles/' + profileId + '/', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        data: { type: 'profile', id: profileId, attributes: { properties } }
      })
    });
    if (!updateResp.ok) throw new Error('Klaviyo update failed: ' + await updateResp.text());
  } else if (!createResp.ok && createResp.status !== 201) {
    throw new Error('Klaviyo upsert failed: ' + await createResp.text());
  }
}

async function subscribeKlaviyoProfile(env, email, listId) {
  const resp = await fetch('https://a.klaviyo.com/api/lists/' + listId + '/relationships/profiles/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Klaviyo-API-Key ' + env.KLAVIYO_API_KEY,
      'accept': 'application/json',
      'revision': '2025-01-15'
    },
    body: JSON.stringify({
      data: [{ type: 'profile', attributes: { email } }]
    })
  });
  if (!resp.ok) console.error('List subscription failed:', await resp.text());
}
