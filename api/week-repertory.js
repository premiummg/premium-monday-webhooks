const MONDAY_API_URL = 'https://api.monday.com/v2';
const TIMESHEET_BOARD      = 6080681807;
const WEEK_REPERTORY_BOARD = 6080792866;
const TOPICS_GROUP         = 'topics';
const MAX_WEEKS_AHEAD      = 8;

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

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function weeksFromNow(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return (d - Date.now()) / (1000 * 60 * 60 * 24 * 7);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body?.challenge)   return res.status(200).json({ challenge: req.body.challenge });
  if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'Missing MONDAY_API_TOKEN' });

  const itemId   = String(req.body?.event?.pulseId  || req.body?.event?.itemId   || '').trim();
  const itemName = String(req.body?.event?.pulseName || req.body?.event?.itemName || '').trim();

  if (!itemId || !itemName) return res.status(200).json({ success: false, error: 'Missing item ID or name' });

  const parts     = itemName.split(' - ');
  const startDate = parts[0]?.trim();
  const endDate   = parts[1]?.trim();

  if (!startDate || !endDate) {
    return res.status(200).json({ success: false, error: 'Invalid date range format', name: itemName });
  }

  // 1. Create group in Time Sheet with the week name
  let newGroupId;
  try {
    const r = await mondayRequest(
      `mutation ($b: ID!, $n: String!) { create_group(board_id: $b, group_name: $n) { id } }`,
      { b: String(TIMESHEET_BOARD), n: itemName }
    );
    newGroupId = r?.data?.create_group?.id;
    if (!newGroupId) throw new Error('No group ID returned');
  } catch (err) {
    console.error('[week-repertory] create_group failed', JSON.stringify({ itemName, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to create Time Sheet group' });
  }

  // 2. Update Week Repertory item: store group ID and set timeline + status
  try {
    await mondayRequest(
      `mutation ($b: ID!, $i: ID!, $c: JSON!) {
        change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id }
      }`,
      {
        b: String(WEEK_REPERTORY_BOARD),
        i: String(itemId),
        c: JSON.stringify({
          text:     newGroupId,
          timeline: { from: startDate, to: endDate },
          status:   { label: 'Created' },
        }),
      }
    );
  } catch (err) {
    console.error('[week-repertory] update item failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
  }

  // 3. Calculate next week
  const nextStart    = addDays(startDate, 7);
  const nextEnd      = addDays(endDate, 7);
  const nextWeekName = `${nextStart} - ${nextEnd}`;

  // Guard: stop cascading if next week is too far in the future
  if (weeksFromNow(nextStart) > MAX_WEEKS_AHEAD) {
    return res.status(200).json({ success: true, item_id: itemId, group_id: newGroupId, skipped_next: true, reason: 'Too far in the future' });
  }

  // 4. Skip if next week item already exists
  try {
    const existing = await mondayRequest(
      `query ($b: ID!, $n: String!) {
        boards(ids: [$b]) {
          items_page(limit: 1, query_params: { rules: [{ column_id: "name", compare_value: [$n] }] }) {
            items { id }
          }
        }
      }`,
      { b: String(WEEK_REPERTORY_BOARD), n: nextWeekName }
    );
    if (existing?.data?.boards?.[0]?.items_page?.items?.[0]) {
      return res.status(200).json({ success: true, item_id: itemId, group_id: newGroupId, skipped_next: true, reason: 'Next week already exists' });
    }
  } catch {}

  // 5. Create next week item in Week Repertory with Date Trigger = nextStart
  try {
    const newItem = await mondayRequest(
      `mutation ($b: ID!, $g: String!, $n: String!) {
        create_item(board_id: $b, group_id: $g, item_name: $n) { id }
      }`,
      { b: String(WEEK_REPERTORY_BOARD), g: TOPICS_GROUP, n: nextWeekName }
    );
    const newItemId = newItem?.data?.create_item?.id;
    if (newItemId) {
      await mondayRequest(
        `mutation ($b: ID!, $i: ID!, $c: JSON!) {
          change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id }
        }`,
        {
          b: String(WEEK_REPERTORY_BOARD),
          i: String(newItemId),
          c: JSON.stringify({ date: { date: nextStart } }),
        }
      );
    }
  } catch (err) {
    console.error('[week-repertory] create next item failed', JSON.stringify({ nextWeekName, details: err.details ?? err.message }));
  }

  return res.status(200).json({
    success: true,
    item_id: itemId,
    week_name: itemName,
    group_id: newGroupId,
    next_week: nextWeekName,
  });
}
