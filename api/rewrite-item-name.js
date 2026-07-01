const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 5679186588;

const COL = {
  primaryName:   'text2__1',     // "⚙️ Primary Item Name" — source for new name
  rewriteStatus: 'status_1__1',  // "⚙️ Rewrite Name of form in item name" — set to Writed
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
        column_values(ids: ["text2__1"]) {
          id
          text
        }
      }
    }`,
    { ids: [String(itemId)] }
  );
  return res?.data?.items?.[0] ?? null;
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
        name: newName,
        [COL.rewriteStatus]: { label: 'Writed' },
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

  const newName = item.column_values?.[0]?.text?.trim();
  if (!newName) {
    return res.status(200).json({ success: false, error: '⚙️ Primary Item Name is empty', item_id: itemId });
  }

  try {
    await renameItem(itemId, newName);
  } catch (err) {
    console.error('[monday] rename failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to rename item', details: err.details ?? err.message });
  }

  return res.status(200).json({
    success: true,
    item_id: itemId,
    old_name: item.name,
    new_name: newName,
  });
}
