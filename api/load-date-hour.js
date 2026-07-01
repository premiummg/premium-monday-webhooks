const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 5679186588;

const COL = {
  loadStatus: 'status1__1',  // "⚙️ Load Data in date & Hour" — trigger + output
  workStart:  'date',         // "Work start date + Hour" — input datetime
  workEnd:    'date2',        // "Work end date + Hour" — input datetime
  dateStart:  'date9__1',     // "📄Work date (Start)" — output
  startHour:  'numbers2__1',  // "📄Start Hour" — output decimal
  endTime:    'numbers88__1', // "📄End Time" — output decimal
  dateEnd:    'date1__1',     // "📄Work date (End)" — output
  primaryName:'text2__1',     // "⚙️ Primary Item Name" — output
};

// Monday date columns return value JSON: {"date": "2026-02-12", "time": "09:00:00"}
function parseDateTimeColumn(item, colId) {
  const col = item?.column_values?.find((c) => c.id === colId);
  if (!col?.value) return null;
  try {
    const parsed = JSON.parse(col.value);
    return { date: parsed.date ?? null, time: parsed.time ?? null };
  } catch {
    return null;
  }
}

// "09:00:00" → 9.00, "13:30:00" → 13.50
function timeToDecimal(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  return parseFloat((h + m / 60).toFixed(2));
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
        column_values(ids: ["date", "date2"]) {
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
  if (!itemId) {
    return res.status(200).json({ success: false, error: 'Missing item ID in webhook payload' });
  }

  let item;
  try {
    item = await fetchItem(itemId);
  } catch (err) {
    console.error('[monday] fetch item failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to fetch item' });
  }

  if (!item) {
    return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });
  }

  const startDT = parseDateTimeColumn(item, COL.workStart);
  const endDT   = parseDateTimeColumn(item, COL.workEnd);

  const valid = startDT?.date && startDT?.time && endDT?.date && endDT?.time;

  if (!valid) {
    // Path A: invalid format — set ERROR and post comment
    try {
      await updateItem(itemId, { [COL.loadStatus]: { label: 'ERROR' } });
    } catch (err) {
      console.error('[monday] update ERROR status failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    }
    try {
      await postComment(itemId, "🚨 The time formats for 'Work start date + Hour' and 'Work end date + Hour' are incorrect, please enter date & time and then change the status '⚙️ Load Data in date & Hour' to 'Loading'.");
    } catch (err) {
      console.error('[monday] post comment failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    }

    return res.status(200).json({
      success: true,
      valid: false,
      item_id: itemId,
      start: startDT,
      end: endDT,
    });
  }

  // Path B: valid — write all output columns and set Loaded
  const numericHourStart = timeToDecimal(startDT.time);
  const numericHourEnd   = timeToDecimal(endDT.time);

  try {
    await updateItem(itemId, {
      [COL.dateStart]:   { date: startDT.date },
      [COL.startHour]:   numericHourStart,
      [COL.endTime]:     numericHourEnd,
      [COL.dateEnd]:     { date: endDT.date },
      [COL.loadStatus]:  { label: 'Loaded' },
      [COL.primaryName]: item.name,
    });
  } catch (err) {
    console.error('[monday] update failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to update item', details: err.details ?? err.message });
  }

  return res.status(200).json({
    success: true,
    valid: true,
    item_id: itemId,
    name: item.name,
    date_start: startDT.date,
    date_end: endDT.date,
    hour_start: numericHourStart,
    hour_end: numericHourEnd,
  });
}
