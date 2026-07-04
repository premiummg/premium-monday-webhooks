const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 6080681807;
const SKIP_GROUP = 'new_group';

const COL = {
  specialId:       'text',     // ⚙️ SpecialID
  timeline:        'timeline', // Timeline
  settingTimeline: 'status1',  // ⚙️ Setting Timeline
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

async function searchByGroupId(groupId) {
  const res = await mondayRequest(
    `query ($boardId: ID!, $val: String!) {
      boards(ids: [$boardId]) {
        items_page(limit: 1, query_params: {
          rules: [{ column_id: "text", compare_value: [$val] }]
        }) {
          items { id name }
        }
      }
    }`,
    { boardId: String(BOARD_ID), val: groupId }
  );
  return res?.data?.boards?.[0]?.items_page?.items?.[0] ?? null;
}

async function updateItem(itemId, startDate, endDate, itemName) {
  return mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
    }`,
    {
      boardId: String(BOARD_ID),
      itemId: String(itemId),
      cols: JSON.stringify({
        [COL.timeline]:        { from: startDate, to: endDate },
        [COL.specialId]:       `${startDate} - ${endDate} - ${itemName}`,
        [COL.settingTimeline]: { label: 'Set' },
      }),
    }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body?.challenge) return res.status(200).json({ challenge: req.body.challenge });
  if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'Missing MONDAY_API_TOKEN' });

  const itemId   = String(req.body?.event?.pulseId  || req.body?.event?.itemId   || '').trim();
  const groupId  = String(req.body?.event?.groupId  || '').trim();
  const itemName = String(req.body?.event?.pulseName || req.body?.event?.itemName || '').trim();

  if (!itemId)  return res.status(200).json({ success: false, error: 'Missing item ID' });
  if (!groupId) return res.status(200).json({ success: false, error: 'Missing group ID' });

  if (groupId === SKIP_GROUP) {
    return res.status(200).json({ success: true, skipped: true, reason: 'Item in new_group' });
  }

  let templateItem;
  try {
    templateItem = await searchByGroupId(groupId);
  } catch (err) {
    console.error('[monday] search failed', JSON.stringify({ groupId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Search failed' });
  }

  if (!templateItem) {
    return res.status(200).json({ success: false, error: 'No template item found', group_id: groupId });
  }

  const parts     = templateItem.name.split(' - ');
  const startDate = parts[0]?.trim();
  const endDate   = parts[1]?.trim();

  if (!startDate || !endDate) {
    return res.status(200).json({ success: false, error: 'Invalid date format in template name', template_name: templateItem.name });
  }

  try {
    await updateItem(itemId, startDate, endDate, itemName);
  } catch (err) {
    console.error('[monday] update failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Update failed', details: err.details ?? err.message });
  }

  return res.status(200).json({
    success: true,
    item_id: itemId,
    template_item_id: templateItem.id,
    start_date: startDate,
    end_date: endDate,
    special_id: `${startDate} - ${endDate} - ${itemName}`,
  });
}
