const MONDAY_API_URL = 'https://api.monday.com/v2';
const TIME_TRACKING_BOARD_ID = 18410440007;
const INVENTORY_BOARD_ID = 18410440950;
const TIME_TRACKING_COLUMNS = {
  status: 'status',
  qty: 'numbers',
  cost: 'numbers_1',
  footage: 'numbers4',
  total: 'numbers_2',
  inventoryRelation: 'connect_boards',
};
const INVENTORY_COLUMNS = {
  cost: 'chiffres',
};

function toNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readInputData(req) {
  if (req.body && typeof req.body === 'object') {
    if (req.body.inputData && typeof req.body.inputData === 'object') {
      return req.body.inputData;
    }

    if (req.body.event && typeof req.body.event === 'object') {
      return req.body;
    }

    return req.body;
  }

  return {};
}

async function mondayRequest(query, variables = {}) {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: process.env.MONDAY_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  return response.json();
}

async function getItemWithColumns(boardId, itemId, columnIds) {
  const result = await mondayRequest(
    `query ($boardId: [ID!], $itemIds: [ID!], $columnIds: [String!]) {
      boards(ids: $boardId) {
        id
        name
      }
      items(ids: $itemIds) {
        id
        name
        column_values(ids: $columnIds) {
          id
          text
          value
        }
      }
    }`,
    {
      boardId: [String(boardId)],
      itemIds: [String(itemId)],
      columnIds,
    }
  );

  return result?.data?.items?.[0] || null;
}

function getColumnText(item, columnId) {
  return item?.column_values?.find((column) => column.id === columnId)?.text || '';
}

function getColumnValue(item, columnId) {
  return item?.column_values?.find((column) => column.id === columnId)?.value || '';
}

async function updateItem(boardId, itemId, columnValues) {
  return mondayRequest(
    `mutation ($boardId: Int!, $itemId: Int!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
        id
      }
    }`,
    {
      boardId: Number(boardId),
      itemId: Number(itemId),
      columnValues: JSON.stringify(columnValues),
    }
  );
}

async function createUpdate(itemId, body) {
  return mondayRequest(
    `mutation ($itemId: Int!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }`,
    {
      itemId: Number(itemId),
      body,
    }
  );
}

function parseLinkedItemIds(columnValue) {
  if (!columnValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(columnValue);
    const linkedPulseIds = parsed?.linkedPulseIds || [];
    return linkedPulseIds
      .map((item) => item?.linkedPulseId)
      .filter((itemId) => itemId !== undefined && itemId !== null)
      .map((itemId) => String(itemId));
  } catch {
    return [];
  }
}

async function getLinkedInventoryCost(itemId) {
  const item = await getItemWithColumns(
    TIME_TRACKING_BOARD_ID,
    itemId,
    [TIME_TRACKING_COLUMNS.inventoryRelation]
  );

  const linkedItemIds = parseLinkedItemIds(getColumnValue(item, TIME_TRACKING_COLUMNS.inventoryRelation));

  if (linkedItemIds.length === 0) {
    return { inventoryCost: 0, inventoryItemId: null };
  }

  const inventoryItem = await getItemWithColumns(
    INVENTORY_BOARD_ID,
    linkedItemIds[0],
    [INVENTORY_COLUMNS.cost]
  );

  return {
    inventoryCost: toNumber(inventoryItem?.column_values?.[0]?.text),
    inventoryItemId: inventoryItem?.id || null,
  };
}

function buildUpdateBody({ name, qty, cost, inventoryCost, footage, total, usedInventoryCost }) {
  const lines = [
    `Name: ${name || 'N/A'}`,
    `Qty: ${qty}`,
    `Cost: ${cost}`,
    `Inventory cost: ${inventoryCost}`,
    `Footage: ${footage}`,
    `Total: ${total}`,
  ];

  if (usedInventoryCost) {
    lines.push('Cost source: inventory fallback');
  }

  return lines.join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.body?.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const inputData = readInputData(req);
  const eventItemId = req.body?.event?.pulseId || req.body?.event?.itemId;
  const boardId = inputData.board_id || req.body?.event?.boardId || TIME_TRACKING_BOARD_ID;

  const itemId = (inputData.item_id || eventItemId || '').toString().trim();

  if (!process.env.MONDAY_API_TOKEN) {
    return res.status(500).json({ error: 'Missing MONDAY_API_TOKEN' });
  }

  if (!itemId) {
    return res.status(400).json({
      error: 'Missing item id',
      hint: 'Send item_id or rely on a Monday webhook event with pulseId.',
    });
  }

  const currentItem = await getItemWithColumns(
    boardId,
    itemId,
    [
      TIME_TRACKING_COLUMNS.qty,
      TIME_TRACKING_COLUMNS.cost,
      TIME_TRACKING_COLUMNS.footage,
      TIME_TRACKING_COLUMNS.inventoryRelation,
    ]
  );

  let qty = toNumber(inputData.qty || getColumnText(currentItem, TIME_TRACKING_COLUMNS.qty));
  let cost = toNumber(inputData.cost || getColumnText(currentItem, TIME_TRACKING_COLUMNS.cost));
  let inventoryCost = toNumber(inputData.inventory_cost);
  const footage = toNumber(inputData.footage || getColumnText(currentItem, TIME_TRACKING_COLUMNS.footage));
  const name = (inputData.name || inputData.item_name || currentItem?.name || '').toString().trim();

  if (!inventoryCost) {
    const inventoryLookup = await getLinkedInventoryCost(itemId);
    inventoryCost = inventoryLookup.inventoryCost;
  }

  const usedInventoryCost = cost === 0 && inventoryCost > 0;
  if (usedInventoryCost) {
    cost = inventoryCost;
  }

  const total = Number((qty * cost).toFixed(2));

  const columnValues = {
    [TIME_TRACKING_COLUMNS.qty]: qty,
    [TIME_TRACKING_COLUMNS.cost]: cost,
    [TIME_TRACKING_COLUMNS.footage]: footage,
    [TIME_TRACKING_COLUMNS.total]: total,
  };

  const updateResult = await updateItem(boardId, itemId, columnValues);

  let noteResult = null;
  if (usedInventoryCost || qty === 0 || cost === 0) {
    noteResult = await createUpdate(
      itemId,
      buildUpdateBody({
        name,
        qty,
        cost,
        inventoryCost,
        footage,
        total,
        usedInventoryCost,
      })
    );
  }

  return res.status(200).json({
    success: true,
    board_id: TIME_TRACKING_BOARD_ID,
    item_id: itemId,
    qty,
    cost,
    inventory_cost: inventoryCost,
    footage,
    total,
    updated: Boolean(updateResult?.data),
    update_noted: Boolean(noteResult?.data),
  });
}