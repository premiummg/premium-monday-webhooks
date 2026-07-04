const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 6004904071;
const INVENTORY_BOARD_ID = 5603681269;

// Column IDs in the time tracking board (6004904071)
const COL = {
  status: 'status',
  qty: 'numbers',
  cost: 'numbers_1',
  footage: 'numbers4',
  total: 'numbers_2',
  inventoryLink: 'connect_boards',
};

// Column ID for cost in the inventory board (5603681269)
const INV_COL_COST = 'chiffres'; // "Cost Price ($)"

function toNum(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : 0;
}

function colText(item, colId) {
  return item?.column_values?.find((c) => c.id === colId)?.text ?? '';
}

function getLinkedItemIds(item) {
  const col = item?.column_values?.find((c) => c.id === COL.inventoryLink);
  if (!col) return [];

  // Try inline fragment data first (works when Monday returns BoardRelationValue)
  if (Array.isArray(col.linked_item_ids) && col.linked_item_ids.length) {
    return col.linked_item_ids.map(String);
  }

  // Fallback: parse raw value JSON
  try {
    if (!col.value) return [];
    const parsed = JSON.parse(col.value);
    return (parsed?.linkedPulseIds ?? []).map((p) => String(p.linkedPulseId));
  } catch {
    return [];
  }
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
        column_values {
          id
          text
          value
          ... on BoardRelationValue {
            linked_item_ids
          }
        }
      }
    }`,
    { ids: [String(itemId)] }
  );
  return res?.data?.items?.[0] ?? null;
}

// Search inventory board by item name — used when connect_boards returns null (subitem board limitation)
async function searchInventoryByName(name) {
  const res = await mondayRequest(
    `query ($boardId: ID!, $name: String!) {
      boards(ids: [$boardId]) {
        items_page(limit: 1, query_params: {
          rules: [{ column_id: "name", compare_value: [$name] }]
        }) {
          items {
            id
            name
            column_values(ids: ["chiffres"]) {
              id
              text
              value
            }
          }
        }
      }
    }`,
    { boardId: String(INVENTORY_BOARD_ID), name }
  );
  return res?.data?.boards?.[0]?.items_page?.items?.[0] ?? null;
}

async function getInventoryCost(timeTrackingItem) {
  let inventoryItem = null;
  let lookupMethod = null;

  // Try 1: connect_boards linked IDs (may return null on subitem boards)
  const linkedIds = getLinkedItemIds(timeTrackingItem);
  if (linkedIds.length) {
    lookupMethod = 'connect_boards';
    inventoryItem = await fetchItem(linkedIds[0]);
  }

  // Try 2: search inventory by item name (reliable fallback)
  if (!inventoryItem && timeTrackingItem.name) {
    lookupMethod = 'name_search';
    inventoryItem = await searchInventoryByName(timeTrackingItem.name);
  }

  const cost = inventoryItem ? toNum(colText(inventoryItem, INV_COL_COST)) : 0;
  return { cost, lookupMethod, inventoryItemId: inventoryItem?.id ?? null };
}

async function updateItemColumns(itemId, columnValues) {
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
    console.error('[monday] fetch item failed', { itemId, details: err.details ?? err.message });
    return res.status(200).json({ success: false, error: 'Failed to fetch item', details: err.details ?? err.message });
  }

  if (!item) {
    return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });
  }

  // Skip if status is already "Loaded"
  if (colText(item, COL.status) === 'Loaded') {
    return res.status(200).json({ success: true, skipped: true, reason: 'Status is Loaded', item_id: itemId });
  }

  let qty = toNum(colText(item, COL.qty));
  let cost = toNum(colText(item, COL.cost));
  const footage = toNum(colText(item, COL.footage));

  let inventoryCost = 0;
  let inventoryLookup = null;
  if (cost === 0) {
    try {
      inventoryLookup = await getInventoryCost(item);
      inventoryCost = inventoryLookup.cost;
    } catch (err) {
      console.error('[monday] inventory lookup failed', { itemId, details: err.details ?? err.message });
    }
  }

  const usedInventoryCost = cost === 0 && inventoryCost > 0;
  if (usedInventoryCost) cost = inventoryCost;

  const total = Number((qty * cost).toFixed(2));

  const newStatus = cost > 0 ? 'Loaded' : 'ERROR';

  try {
    await updateItemColumns(itemId, {
      [COL.status]:  { label: newStatus },
      [COL.qty]:     qty,
      [COL.cost]:    cost,
      [COL.footage]: footage,
      [COL.total]:   total,
    });
  } catch (err) {
    console.error('[monday] update failed', { itemId, details: err.details ?? err.message });
    return res.status(200).json({ success: false, error: 'Failed to update item', details: err.details ?? err.message });
  }

  if (cost === 0) {
    try {
      await postComment(itemId, 'The item cost is not defined');
    } catch (err) {
      console.error('[monday] post comment failed', { itemId, details: err.details ?? err.message });
    }
  }

  return res.status(200).json({
    success: true,
    item_id: itemId,
    name: item.name,
    qty,
    cost,
    footage,
    total,
    inventory_cost: inventoryCost,
    used_inventory_cost: usedInventoryCost,
    _debug: {
      inventory_lookup_method: inventoryLookup?.lookupMethod ?? null,
      inventory_item_id: inventoryLookup?.inventoryItemId ?? null,
    },
  });
}
