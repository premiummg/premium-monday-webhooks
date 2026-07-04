const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 5603681269;

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

async function renameItem(itemId, newName) {
  return mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) {
        id
        name
      }
    }`,
    {
      boardId: String(BOARD_ID),
      itemId: String(itemId),
      cols: JSON.stringify({
        name:    newName,
        status7: { label: 'Item Name Copied' }, // "⚙️ Copy Name"
      }),
    }
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
  const itemName = String(req.body?.event?.pulseName || '').trim();

  if (!itemId) {
    return res.status(200).json({ success: false, error: 'Missing item ID in webhook payload' });
  }

  if (!itemName) {
    return res.status(200).json({ success: false, error: 'Missing item name in webhook payload' });
  }

  try {
    await renameItem(itemId, itemName);
  } catch (err) {
    console.error('[monday] rename failed', JSON.stringify({ itemId, itemName, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to rename item', details: err.details ?? err.message });
  }

  return res.status(200).json({
    success: true,
    item_id: itemId,
    new_name: itemName,
  });
}
