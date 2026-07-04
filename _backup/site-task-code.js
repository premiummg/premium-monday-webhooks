const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 5623928047;

const COL = {
  numbers: 'numbers8', // ⚙️ Numbers — source number
  project: 'mirror6',  // ⚙️ #Projet — project code prefix
  code:    'text_1',   // ⚙️ Code — output
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
    `query ($ids: [ID!]!) {
      items(ids: $ids) {
        id
        name
        column_values(ids: ["numbers8", "mirror6"]) {
          id
          text
          ... on MirrorValue {
            display_value
          }
        }
      }
    }`,
    { ids: [String(itemId)] }
  );
  return res?.data?.items?.[0] ?? null;
}

async function updateCode(itemId, code) {
  return mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) {
        id
      }
    }`,
    {
      boardId: String(BOARD_ID),
      itemId: String(itemId),
      cols: JSON.stringify({ [COL.code]: code }),
    }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body?.challenge) return res.status(200).json({ challenge: req.body.challenge });
  if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'Missing MONDAY_API_TOKEN' });

  const itemId = String(req.body?.event?.pulseId || req.body?.event?.itemId || '').trim();
  if (!itemId) return res.status(200).json({ success: false, error: 'Missing item ID' });

  let item;
  try {
    item = await fetchItem(itemId);
  } catch (err) {
    console.error('[monday] fetch failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to fetch item' });
  }

  if (!item) return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });

  const colMap = Object.fromEntries(item.column_values.map(c => [c.id, c]));
  const rawNumber = colMap['numbers8']?.text ?? '';
  const projectCode = colMap['mirror6']?.display_value ?? colMap['mirror6']?.text ?? '';

  // Convert "15.0" → "15" (same as Zapier's Split Text by ".0", index 0)
  const intNumber = rawNumber ? String(Math.floor(parseFloat(rawNumber))) : '';

  if (!projectCode && !intNumber) {
    return res.status(200).json({ success: false, error: 'No data to build code', item_id: itemId });
  }

  const code = `${projectCode} ${intNumber}`.trim();

  try {
    await updateCode(itemId, code);
  } catch (err) {
    console.error('[monday] update failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to update code', details: err.details ?? err.message });
  }

  return res.status(200).json({ success: true, item_id: itemId, code });
}
