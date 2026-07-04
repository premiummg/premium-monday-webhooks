const MONDAY_API_URL = 'https://api.monday.com/v2';
const FORM_BOARD_ID = 5679186588;
const INVENTORY_BOARD_ID = 5603681269;

const FORM_COL = {
  fireStop:      'multi_select__1',
  caulking:      'multi_select2',
  contracting:   'dropdown74',
  endDate:       'date1__1',
  projectName:   'dropdown__1',
  triggerStatus: 'status',
  dateLoaded:    'date4',
  tomorrow:      'date_1',
};

// Columns on subitem board 6004904071
const SUBITEM_COL = {
  status:    'status',
  qty:       'numbers',
  cost:      'numbers_1',
  footage:   'numbers4',
  totalCost: 'numbers_2',
  inventory: 'connect_boards',
};

const PRODUCTS = [
  { num: 1,  relCol: 'board_relation_mkyq5rg9', qtyCol: 'dup__of_qty__2', coverageCol: 'number3' },
  { num: 2,  relCol: 'board_relation_mkyqsr4h', qtyCol: 'number8',         coverageCol: 'number__1' },
  { num: 3,  relCol: 'board_relation_mkyq61bs', qtyCol: 'numeric',          coverageCol: 'number348912684__1' },
  { num: 4,  relCol: 'board_relation_mkyqmgvk', qtyCol: 'numbers',          coverageCol: 'number348912685__1' },
  { num: 5,  relCol: 'board_relation_mkyqkvpp', qtyCol: 'numeric6',         coverageCol: 'number348912682__1' },
  { num: 6,  relCol: 'board_relation_mkyqmm15', qtyCol: 'numeric3',         coverageCol: 'number348912683__1' },
  { num: 7,  relCol: 'board_relation_mkyqymej', qtyCol: 'numeric1',         coverageCol: 'number348912719__1' },
  { num: 8,  relCol: 'board_relation_mkyq74b4', qtyCol: 'numeric7',         coverageCol: 'number0__1' },
  { num: 9,  relCol: 'board_relation_mkyqej8p', qtyCol: 'numeric9',         coverageCol: 'number348912688__1' },
  { num: 10, relCol: 'board_relation_mkyqzy97', qtyCol: 'numeric4',         coverageCol: 'number348912661__1' },
];

const ALL_FORM_COLS = [
  FORM_COL.fireStop, FORM_COL.caulking, FORM_COL.contracting,
  FORM_COL.endDate, FORM_COL.projectName,
  ...PRODUCTS.map(p => p.relCol),
  ...PRODUCTS.map(p => p.qtyCol),
  ...PRODUCTS.map(p => p.coverageCol),
];

function todayDate() {
  return new Date().toISOString().split('T')[0];
}

function tomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
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

async function fetchFormItem(itemId) {
  const colIdsGql = ALL_FORM_COLS.map(id => `"${id}"`).join(', ');
  const res = await mondayRequest(
    `query ($ids: [ID!]!) {
      items(ids: $ids) {
        id
        name
        column_values(ids: [${colIdsGql}]) {
          id
          text
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

async function fetchInventoryItems(itemIds) {
  if (!itemIds.length) return [];
  const res = await mondayRequest(
    `query ($ids: [ID!]!) {
      items(ids: $ids) {
        id
        name
        column_values(ids: ["chiffres", "numbers0"]) {
          id
          text
        }
      }
    }`,
    { ids: itemIds.map(String) }
  );
  return res?.data?.items ?? [];
}

async function updateFormItemName(itemId, newName) {
  return mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
    }`,
    {
      boardId: String(FORM_BOARD_ID),
      itemId: String(itemId),
      cols: JSON.stringify({ name: newName }),
    }
  );
}

async function updateInventoryItem(itemId, newQty, statusTrigger) {
  return mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
    }`,
    {
      boardId: String(INVENTORY_BOARD_ID),
      itemId: String(itemId),
      cols: JSON.stringify({
        numbers0:  newQty,
        status_10: { label: statusTrigger },
      }),
    }
  );
}

async function postComment(itemId, body) {
  return mondayRequest(
    `mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId: String(itemId), body }
  );
}

async function createSubitem(parentItemId, productName, cols) {
  return mondayRequest(
    `mutation ($parentId: ID!, $name: String!, $cols: JSON!) {
      create_subitem(parent_item_id: $parentId, item_name: $name, column_values: $cols) { id }
    }`,
    {
      parentId: String(parentItemId),
      name: productName,
      cols: JSON.stringify(cols),
    }
  );
}

async function markFormItemLoaded(itemId) {
  return mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
    }`,
    {
      boardId: String(FORM_BOARD_ID),
      itemId: String(itemId),
      cols: JSON.stringify({
        [FORM_COL.triggerStatus]: { label: 'Loaded' },
        [FORM_COL.dateLoaded]:    { date: todayDate() },
        [FORM_COL.tomorrow]:      { date: tomorrowDate() },
      }),
    }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body?.challenge) return res.status(200).json({ challenge: req.body.challenge });
  if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'Missing MONDAY_API_TOKEN' });

  const itemId     = String(req.body?.event?.pulseId || req.body?.event?.itemId || '').trim();
  const triggerTime = req.body?.event?.triggerTime || new Date().toISOString();

  if (!itemId) return res.status(200).json({ success: false, error: 'Missing item ID' });

  // Fetch all form item columns in one call
  let formItem;
  try {
    formItem = await fetchFormItem(itemId);
  } catch (err) {
    console.error('[monday] fetch form item failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to fetch form item' });
  }

  if (!formItem) return res.status(200).json({ success: false, error: 'Form item not found', item_id: itemId });

  const colMap = Object.fromEntries(formItem.column_values.map(c => [c.id, c]));
  const colText = (id) => colMap[id]?.text?.trim() ?? '';
  const colIds  = (id) => colMap[id]?.linked_item_ids ?? [];

  const fireStop    = colText(FORM_COL.fireStop);
  const caulking    = colText(FORM_COL.caulking);
  const contracting = colText(FORM_COL.contracting);
  const endDate     = colText(FORM_COL.endDate);
  const projectName = colText(FORM_COL.projectName);

  // Update item name
  const newName = `${fireStop} - ${caulking} ${contracting} ${endDate}`.trim();
  try {
    await updateFormItemName(itemId, newName);
  } catch (err) {
    console.error('[monday] update item name failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
  }

  // Collect products that have a linked inventory item
  const activeProducts = PRODUCTS
    .map(p => ({
      ...p,
      inventoryItemId: colIds(p.relCol)[0] ?? null,
      qtyUsed:  parseFloat(colText(p.qtyCol)  || '0') || 0,
      coverage: parseFloat(colText(p.coverageCol) || '0') || 0,
    }))
    .filter(p => p.inventoryItemId);

  // Batch-fetch all inventory item details
  let inventoryItems = [];
  if (activeProducts.length > 0) {
    try {
      inventoryItems = await fetchInventoryItems(activeProducts.map(p => p.inventoryItemId));
    } catch (err) {
      console.error('[monday] fetch inventory items failed', JSON.stringify({ details: err.details ?? err.message }));
    }
  }

  const inventoryMap = Object.fromEntries(
    inventoryItems.map(item => {
      const cols = Object.fromEntries(item.column_values.map(c => [c.id, c]));
      return [item.id, {
        name:       item.name,
        price:      parseFloat(cols['chiffres']?.text || '0') || 0,
        currentQty: parseFloat(cols['numbers0']?.text || '0') || 0,
      }];
    })
  );

  // Process each product in parallel
  let processed = 0;
  await Promise.all(activeProducts.map(async (p) => {
    const inv = inventoryMap[String(p.inventoryItemId)];
    if (!inv) {
      console.error(`[monday] inventory item ${p.inventoryItemId} not found`);
      return;
    }

    const newQty        = inv.currentQty - p.qtyUsed;
    const statusTrigger = newQty === 0 ? 'reset' : 'ghost';
    const totalCost     = p.qtyUsed * inv.price;

    try {
      await updateInventoryItem(p.inventoryItemId, newQty, statusTrigger);
    } catch (err) {
      console.error(`[monday] update inventory ${p.inventoryItemId} failed`, JSON.stringify({ details: err.details ?? err.message }));
    }

    const commentBody = `Inventory withdrawal of ${p.qtyUsed} ${inv.name} by ${caulking} for project ${projectName}\n\nThe quantity changed from ${inv.currentQty} to ${newQty}\n\nDate: ${triggerTime}`;
    try {
      await postComment(p.inventoryItemId, commentBody);
    } catch (err) {
      console.error(`[monday] post comment ${p.inventoryItemId} failed`, JSON.stringify({ details: err.details ?? err.message }));
    }

    try {
      await createSubitem(itemId, inv.name, {
        [SUBITEM_COL.status]:    { label: 'Loaded' },
        [SUBITEM_COL.qty]:       p.qtyUsed,
        [SUBITEM_COL.cost]:      inv.price,
        [SUBITEM_COL.footage]:   p.coverage,
        [SUBITEM_COL.totalCost]: totalCost,
        [SUBITEM_COL.inventory]: { item_ids: [Number(p.inventoryItemId)] },
      });
    } catch (err) {
      console.error(`[monday] create subitem product ${p.num} failed`, JSON.stringify({ details: err.details ?? err.message }));
    }

    processed++;
  }));

  // Mark form item as loaded
  try {
    await markFormItemLoaded(itemId);
  } catch (err) {
    console.error('[monday] mark loaded failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
  }

  return res.status(200).json({
    success: true,
    item_id: itemId,
    new_name: newName,
    products_processed: processed,
  });
}
