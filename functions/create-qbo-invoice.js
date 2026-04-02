const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = process.env.QBO_ENV === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

// Fill this in with your real sell prices.
// Key format: Product|Dose
const MIN_ORDER_TOTAL = 150;

// Key format: Product|Dose
const PRICE_BOOK = {
  'ARA 290|16mg': 99,
  'AOD-9604|5mg': 75,
  'BPC-157|10mg': 95,
  'BPC-157|15mg': 110,
  'BPC-157 + TB-500|10mg/10mg': 135,
  'CJC-1295 + DAC|5mg/5mg': 95,
  'NAD+|500mg': 115,
  'NAD+ 500mg|500mg': 115,
  'NAD+|1000mg': 160,
  'Epithalon|50mg': 99,
  'Kisspeptin|10mg': 150,
  'Melanotan 2|10mg': 70,
  'PT-141|10mg': 79,
  'MOTS-C|10mg': 95,
  'DSIP|5mg': 50,
  'GHK-Cu|Copper Peptide': 65,
  'GHK-Cu|100mg': 90,
  'Sermorelin|5mg': 90,
  'Sermorelin|10mg': 110,
  'SS-31|10mg': 99,
  'Tesamorelin|2mg': 99,
  'Tesamorelin|5mg': 99,
  'Tesamorelin|10mg': 110,
  'Thymosin Alpha-1|10mg': 125,
  'TB-500|10mg': 99,
  'IGF-1 LR3|5mg': 110,
  'Retatrutide|10mg': 250,
  'Retatrutide|15mg': 325,
  'Retatrutide|20mg': 399,
  'Semax|10mg': 75,
  'Semax|30mg': 75,
  'Selank|10mg': 75,
  'Tirzepatide|30mg': 310,
  'Ipamorelin|5mg': 90,
  'Ipamorelin|10mg': 90,
  'KLOW Stack|Default': 260,
  'KLOW Stack|Custom': 260,
  'Wolverine Stack|Default': 260,
  'Wolverine Stack|Custom': 260,
  'BBG|Default': 99,
  'BBG|Custom': 99
};

function getUnitPrice(productName, doseLabel) {
  return PRICE_BOOK[`${productName}|${doseLabel}`]
    ?? PRICE_BOOK[`${productName}|Default`]
    ?? 99;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { customer, items } = body;

    validateEnv();

    if (!customer?.name || !customer?.email) {
      return json(400, { error: 'Customer name and email are required.' });
    }
    if (!Array.isArray(items) || !items.length) {
      return json(400, { error: 'At least one cart item is required.' });
    }

    const subtotal = items.reduce((sum, item) => {
      const dose = item.dose || 'Custom';
      const qty = Math.max(1, Number(item.qty) || 1);
      return sum + (getUnitPrice(item.product, dose) * qty);
    }, 0);

    if (subtotal < MIN_ORDER_TOTAL) {
      return json(400, {
        error: `Minimum order is $${MIN_ORDER_TOTAL}. Add $${(MIN_ORDER_TOTAL - subtotal).toFixed(2)} more before checkout.`
      });
    }

    const token = await refreshAccessToken();
    const customerId = await findOrCreateCustomer(token, customer);
    const invoice = await createInvoice(token, customerId, customer, items);
    const invoiceWithLink = await getInvoiceWithLink(token, invoice.Id);

    if (!invoiceWithLink?.InvoiceLink) {
      return json(500, {
        error: 'Invoice created, but no pay link came back. Confirm online card/ACH payment is enabled in QuickBooks Payments and that the customer email is valid.'
      });
    }

    return json(200, {
      invoiceId: invoiceWithLink.Id,
      invoiceUrl: invoiceWithLink.InvoiceLink,
      docNumber: invoiceWithLink.DocNumber || ''
    });
  } catch (err) {
    return json(500, { error: err.message || 'Unknown QuickBooks error.' });
  }
};

function validateEnv() {
  const required = [
    'QBO_CLIENT_ID',
    'QBO_CLIENT_SECRET',
    'QBO_REFRESH_TOKEN',
    'QBO_REALM_ID',
    'QBO_ITEM_ID'
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

async function refreshAccessToken() {
  const basic = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.QBO_REFRESH_TOKEN
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: body.toString()
  });

  const jsonBody = await res.json();
  if (!res.ok || !jsonBody.access_token) {
    throw new Error(`Could not refresh QuickBooks access token: ${JSON.stringify(jsonBody)}`);
  }
  return jsonBody.access_token;
}

async function qboFetch(token, path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) {
    throw new Error(`QuickBooks API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function findOrCreateCustomer(token, customer) {
  const realmId = process.env.QBO_REALM_ID;
  const escapedEmail = customer.email.replace(/'/g, "\\'");
  const query = `select * from Customer where PrimaryEmailAddr = '${escapedEmail}' maxresults 1`;
  const queryPath = `/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`;
  const queryRes = await qboFetch(token, queryPath, { method: 'GET' });
  const existing = queryRes?.QueryResponse?.Customer?.[0];
  if (existing?.Id) return existing.Id;

  const payload = {
    DisplayName: customer.name,
    FullyQualifiedName: customer.name,
    PrimaryEmailAddr: { Address: customer.email }
  };
  if (customer.contact_handle) payload.PrimaryPhone = { FreeFormNumber: customer.contact_handle };

  const createRes = await qboFetch(token, `/v3/company/${realmId}/customer`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  if (!createRes?.Customer?.Id) {
    throw new Error('QuickBooks customer creation failed.');
  }
  return createRes.Customer.Id;
}

async function createInvoice(token, customerId, customer, items) {
  const realmId = process.env.QBO_REALM_ID;
  const itemRef = process.env.QBO_ITEM_ID;
  const itemName = process.env.QBO_ITEM_NAME || 'Peptide Order';

  const lines = items.map((item) => {
    const dose = item.dose || 'Custom';
    const unitPrice = getUnitPrice(item.product, dose);
    const qty = Math.max(1, Number(item.qty) || 1);
    return {
      DetailType: 'SalesItemLineDetail',
      Amount: Number((unitPrice * qty).toFixed(2)),
      Description: `${item.product} — ${dose}`,
      SalesItemLineDetail: {
        ItemRef: { value: itemRef, name: itemName },
        Qty: qty,
        UnitPrice: unitPrice
      }
    };
  });

  const payload = {
    CustomerRef: { value: customerId },
    BillEmail: { Address: customer.email },
    Line: lines,
    CustomerMemo: {
      value: [
        customer.contact_handle ? `Contact: ${customer.contact_handle}` : '',
        customer.country ? `Country: ${customer.country}` : '',
        customer.notes ? `Notes: ${customer.notes}` : ''
      ].filter(Boolean).join(' | ')
    },
    AllowOnlineCreditCardPayment: true,
    AllowOnlineACHPayment: true,
    EmailStatus: 'NeedToSend'
  };

  const invoiceRes = await qboFetch(token, `/v3/company/${realmId}/invoice`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  if (!invoiceRes?.Invoice?.Id) {
    throw new Error('QuickBooks invoice creation failed.');
  }
  return invoiceRes.Invoice;
}

async function getInvoiceWithLink(token, invoiceId) {
  const realmId = process.env.QBO_REALM_ID;
  const path = `/v3/company/${realmId}/invoice/${invoiceId}?include=invoiceLink`;
  const res = await qboFetch(token, path, { method: 'GET' });
  return res?.Invoice;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
