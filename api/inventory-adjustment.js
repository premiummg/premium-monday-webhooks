const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 5603681269;

const COL = {
  qty:           'numbers0',  // QTY
  adjustment:    'numbers2',  // 🗑𝌡 Adjustment Value
  status:        'status1',   // 𝌡 Status
  resetTrigger:  'status_10', // ⚙️ Statut trigger Reset
};

async function mondayRequest(query, variables = {}) {
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: process.env.MONDAY_API_TOKEN,
    },
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

async function fetchItem(itemId) {
  const res = await mondayRequest(
    `query ($ids: [ID!]) {
      items(ids: $ids) {
        id
        name
        column_values(ids: ["numbers0", "numbers2"]) {
          id
          text
        }
      }
    }`,
    { ids: [String(itemId)] }
  );
  return res?.data?.items?.[0] ?? null;
}

async function updateItem(itemId, columnValues) {
  return mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) {
        id
      }
    }`,
    {
      boardId: String(BOARD_ID),
      itemId: String(itemId),
      cols: JSON.stringify(columnValues),
    }
  );
}

async function postComment(itemId, body) {
  return mondayRequest(
    `mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }`,
    { itemId: String(itemId), body }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.body?.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  if (!process.env.MONDAY_API_TOKEN) {
    return res.status(500).json({ error: 'Missing MONDAY_API_TOKEN' });
  }

  const itemId = String(req.body?.event?.pulseId || req.body?.event?.itemId || '').trim();
  const userId = String(req.body?.event?.userId || '').trim();
  const triggerTime = req.body?.event?.triggerTime || new Date().toISOString();

  if (!itemId) {
    return res.status(200).json({ success: false, error: 'Missing item ID in webhook payload' });
  }

  let item;
  try {
    item = await fetchItem(itemId);
  } catch (err) {
    console.error('[monday] fetch failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to fetch item' });
  }

  if (!item) {
    return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });
  }

  const colMap = Object.fromEntries(item.column_values.map((c) => [c.id, c.text]));
  const oldQty = parseFloat(colMap['numbers0'] || '0');
  const adjustmentValue = parseFloat(colMap['numbers2'] || '0');
  const newValue = oldQty + adjustmentValue;
  const resetTriggerLabel = newValue === 0 ? 'reset' : 'ghost';

  try {
    await updateItem(itemId, {
      [COL.qty]:          newValue,
      [COL.status]:       { label: 'Successful adjustment' },
      [COL.resetTrigger]: { label: resetTriggerLabel },
    });
  } catch (err) {
    console.error('[monday] update failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to update item', details: err.details ?? err.message });
  }

  const commentBody = `Inventory adjustment of ${adjustmentValue} by MANAGER (${userId})\n\nThe quantity changed from ${oldQty} to ${newValue}\n\nDate: ${triggerTime}`;

  try {
    await postComment(itemId, commentBody);
  } catch (err) {
    console.error('[monday] post comment failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
  }

  return res.status(200).json({
    success: true,
    item_id: itemId,
    old_qty: oldQty,
    adjustment_value: adjustmentValue,
    new_qty: newValue,
    reset_trigger: resetTriggerLabel,
  });
}
