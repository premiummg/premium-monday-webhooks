const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 5679186588;

// Column IDs in the time tracking board (5679186588)
const COL = {
  date: 'date9__1', // "📄Work date (Start)"
  fireStop: 'multi_select__1', // "📄Fire Stop Employee"
  caulking: 'multi_select2', // "📄Caulking employee"
  contracting: 'dropdown74', // "📄Contracting Employee"
  specialId: 'text__1', // "⚙️ Special ID" — output column, written by all 3 divisions
};

function colText(item, colId) {
  return item?.column_values?.find((c) => c.id === colId)?.text ?? '';
}

// Monday of the ISO week containing dateString, through Sunday of that week
function getWeekBounds(dateString) {
  const date = new Date(dateString);
  const day = date.getDay() || 7; // Mon=1 ... Sun=7

  const start = new Date(date);
  start.setDate(date.getDate() - (day - 1));

  const end = new Date(date);
  end.setDate(date.getDate() + (7 - day));

  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

// Builds "weekStart-weekEnd-name" per employee, joined with ", " for multiple names
function buildSpecialIds(namesRaw, dateString) {
  if (!namesRaw || !dateString) return null;
  const { start, end } = getWeekBounds(dateString);
  const names = namesRaw.split(',').map((n) => n.trim()).filter(Boolean);
  if (!names.length) return null;
  return names.map((name) => `${start}-${end}-${name}`).join(', ');
}

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
        column_values(ids: ["date9__1", "multi_select__1", "multi_select2", "dropdown74"]) {
          id
          text
          value
        }
      }
    }`,
    { ids: [String(itemId)] }
  );
  return res?.data?.items?.[0] ?? null;
}

async function updateSpecialId(itemId, specialId) {
  return mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) {
        id
      }
    }`,
    {
      boardId: String(BOARD_ID),
      itemId: String(itemId),
      cols: JSON.stringify({ [COL.specialId]: specialId }),
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
    console.error('[monday] fetch item failed', { itemId, details: err.details ?? err.message });
    return res.status(200).json({ success: false, error: 'Failed to fetch item', details: err.details ?? err.message });
  }

  if (!item) {
    return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });
  }

  const dateStr = colText(item, COL.date);

  const divisions = [
    { key: 'fire_stop', names: colText(item, COL.fireStop) },
    { key: 'caulking', names: colText(item, COL.caulking) },
    { key: 'contracting', names: colText(item, COL.contracting) },
  ].filter((d) => d.names);

  if (!divisions.length) {
    return res.status(200).json({ success: true, skipped: true, reason: 'No employee columns have values', item_id: itemId });
  }

  if (!dateStr) {
    return res.status(200).json({ success: false, error: 'Work date (Start) is empty', item_id: itemId });
  }

  const specialIds = divisions.map((d) => buildSpecialIds(d.names, dateStr)).filter(Boolean);

  if (!specialIds.length) {
    return res.status(200).json({ success: false, error: 'Could not generate special ID', item_id: itemId });
  }

  const finalSpecialId = specialIds.join(', ');

  try {
    await updateSpecialId(itemId, finalSpecialId);
  } catch (err) {
    console.error('[monday] update failed', { itemId, details: err.details ?? err.message });
    return res.status(200).json({ success: false, error: 'Failed to update item', details: err.details ?? err.message });
  }

  return res.status(200).json({
    success: true,
    item_id: itemId,
    name: item.name,
    special_id: finalSpecialId,
    divisions: divisions.map((d) => d.key),
  });
}
