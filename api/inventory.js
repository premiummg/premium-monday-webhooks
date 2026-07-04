const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 5603681269;

// ─── Shared ───────────────────────────────────────────────────────────────────

async function mondayRequest(query, variables = {}) {
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: process.env.MONDAY_API_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json?.errors?.length) {
    const err = new Error('Monday API error');
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

async function updateBoardItem(itemId, cols) {
  return mondayRequest(
    `mutation ($b: ID!, $i: ID!, $c: JSON!) {
      change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id }
    }`,
    { b: String(BOARD_ID), i: String(itemId), c: JSON.stringify(cols) }
  );
}

async function postComment(itemId, body) {
  return mondayRequest(
    `mutation ($i: ID!, $b: String!) { create_update(item_id: $i, body: $b) { id } }`,
    { i: String(itemId), b: body }
  );
}

// ─── Inventory Adjustment (trigger: status1 → "Adjust") ──────────────────────

async function handleInventoryAdjustment(req, res, itemId) {
  const userId      = String(req.body?.event?.userId || '').trim();
  const triggerTime = req.body?.event?.triggerTime || new Date().toISOString();

  const res1 = await mondayRequest(
    `query ($ids: [ID!]) { items(ids: $ids) { id name column_values(ids: ["numbers0","numbers2"]) { id text } } }`,
    { ids: [itemId] }
  );
  const item = res1?.data?.items?.[0];
  if (!item) return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });

  const colMap         = Object.fromEntries(item.column_values.map(c => [c.id, c.text]));
  const oldQty         = parseFloat(colMap['numbers0'] || '0');
  const adjustmentValue = parseFloat(colMap['numbers2'] || '0');
  const newValue        = oldQty + adjustmentValue;
  const resetLabel      = newValue === 0 ? 'reset' : 'ghost';

  await updateBoardItem(itemId, {
    numbers0:  newValue,
    status1:   { label: 'Successful adjustment' },
    status_10: { label: resetLabel },
  });

  try {
    await postComment(itemId, `Inventory adjustment of ${adjustmentValue} by MANAGER (${userId})\n\nThe quantity changed from ${oldQty} to ${newValue}\n\nDate: ${triggerTime}`);
  } catch {}

  return res.status(200).json({ success: true, item_id: itemId, old_qty: oldQty, adjustment_value: adjustmentValue, new_qty: newValue });
}

// ─── Inventory Copy Name (trigger: status7) ───────────────────────────────────

async function handleInventoryCopyName(req, res, itemId) {
  const itemName = String(req.body?.event?.pulseName || '').trim();
  if (!itemName) return res.status(200).json({ success: false, error: 'Missing item name in webhook payload' });

  await updateBoardItem(itemId, {
    name:    itemName,
    status7: { label: 'Item Name Copied' },
  });

  return res.status(200).json({ success: true, item_id: itemId, new_name: itemName });
}

// ─── Router ───────────────────────────────────────────────────────────────────

const ROUTES = {
  'status1': handleInventoryAdjustment,
  'status7': handleInventoryCopyName,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body?.challenge)   return res.status(200).json({ challenge: req.body.challenge });
  if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'Missing MONDAY_API_TOKEN' });

  const itemId   = String(req.body?.event?.pulseId || req.body?.event?.itemId || '').trim();
  const columnId = req.body?.event?.columnId;

  if (!itemId) return res.status(200).json({ success: false, error: 'Missing item ID' });

  const route = ROUTES[columnId];
  if (!route)  return res.status(200).json({ success: false, error: 'Unknown trigger column', column_id: columnId });

  try {
    return await route(req, res, itemId);
  } catch (err) {
    console.error('[monday] handler error', JSON.stringify({ columnId, itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Internal error', column_id: columnId });
  }
}
