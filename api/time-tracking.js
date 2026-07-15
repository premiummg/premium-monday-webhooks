const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID        = 5679186588;
const EMPLOYEE_BOARD  = 5830605725;
const INVENTORY_BOARD = 5603681269;
const MACRO_BOARDS    = [5603041438, 18410435691, 18411058373];

// ─── Shared ──────────────────────────────────────────────────────────────────

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

function colText(item, colId) {
  return item?.column_values?.find(c => c.id === colId)?.text?.trim() ?? '';
}

function todayDate() { return new Date().toISOString().split('T')[0]; }
function tomorrowDate() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; }

async function updateBoardItem(boardId, itemId, cols) {
  return mondayRequest(
    `mutation ($b: ID!, $i: ID!, $c: JSON!) {
      change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id }
    }`,
    { b: String(boardId), i: String(itemId), c: JSON.stringify(cols) }
  );
}

async function postComment(itemId, body) {
  return mondayRequest(
    `mutation ($i: ID!, $b: String!) { create_update(item_id: $i, body: $b) { id } }`,
    { i: String(itemId), b: body }
  );
}

// ─── Create Special ID (trigger: status2__1) ─────────────────────────────────

function getWeekBounds(dateString) {
  const date = new Date(dateString);
  const day  = date.getDay() || 7;
  const start = new Date(date); start.setDate(date.getDate() - (day - 1));
  const end   = new Date(date); end.setDate(date.getDate() + (7 - day));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function buildSpecialIds(namesRaw, dateString) {
  if (!namesRaw || !dateString) return null;
  const { start, end } = getWeekBounds(dateString);
  const names = namesRaw.split(',').map(n => n.trim()).filter(Boolean);
  if (!names.length) return null;
  return names.map(name => `${start}-${end}-${name}`).join(', ');
}

async function handleCreateSpecialId(req, res, itemId) {
  const res1 = await mondayRequest(
    `query ($ids: [ID!]) {
      items(ids: $ids) {
        id name
        column_values(ids: ["date9__1","multi_select__1","multi_select2","dropdown74"]) { id text value }
      }
    }`,
    { ids: [itemId] }
  );
  const item = res1?.data?.items?.[0];
  if (!item) return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });

  const dateStr   = colText(item, 'date9__1');
  const divisions = [
    { key: 'fire_stop',   names: colText(item, 'multi_select__1') },
    { key: 'caulking',    names: colText(item, 'multi_select2') },
    { key: 'contracting', names: colText(item, 'dropdown74') },
  ].filter(d => d.names);

  if (!divisions.length) return res.status(200).json({ success: true, skipped: true, reason: 'No employee columns', item_id: itemId });
  if (!dateStr)          return res.status(200).json({ success: false, error: 'Work date empty', item_id: itemId });

  const specialIds = divisions.map(d => buildSpecialIds(d.names, dateStr)).filter(Boolean);
  if (!specialIds.length) return res.status(200).json({ success: false, error: 'Could not build special ID', item_id: itemId });

  const finalSpecialId = specialIds.join(', ');
  await updateBoardItem(BOARD_ID, itemId, { text__1: finalSpecialId });
  return res.status(200).json({ success: true, item_id: itemId, special_id: finalSpecialId });
}

// ─── Connect Employee (trigger: status0__1 → "Connexion") ────────────────────

async function handleConnectEmployee(req, res, itemId) {
  const res1 = await mondayRequest(
    `query ($ids: [ID!]!) {
      items(ids: $ids) {
        id name
        column_values(ids: ["dropdown74","multi_select2","multi_select__1"]) { id text }
      }
    }`,
    { ids: [itemId] }
  );
  const item = res1?.data?.items?.[0];
  if (!item) return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });

  const getNames = id => {
    const text = colText(item, id);
    return text ? text.split(', ').map(n => n.trim()).filter(Boolean) : [];
  };
  const allNames = [...getNames('dropdown74'), ...getNames('multi_select2'), ...getNames('multi_select__1')];

  const messages = [];
  const employeeIds = [];

  await Promise.all(allNames.map(async name => {
    try {
      const r = await mondayRequest(
        `query ($b: ID!, $n: String!) {
          boards(ids: [$b]) {
            items_page(limit: 1, query_params: { rules: [{ column_id: "name", compare_value: [$n] }] }) {
              items { id name }
            }
          }
        }`,
        { b: String(EMPLOYEE_BOARD), n: name }
      );
      const emp = r?.data?.boards?.[0]?.items_page?.items?.[0];
      if (emp) { employeeIds.push(Number(emp.id)); messages.push(`✅ Item ID: ${emp.id}, Name: ${emp.name}`); }
      else       messages.push(`🚨 No items found for name: ${name} in database`);
    } catch (err) {
      messages.push(`🚨 Error searching for: ${name}`);
    }
  }));

  await updateBoardItem(BOARD_ID, itemId, {
    connect_boards__1: { item_ids: employeeIds },
    status0__1:        { label: 'Connected' },
  });

  const commentBody = messages.join('\n') || 'No data';
  try { await postComment(itemId, commentBody); } catch {}

  return res.status(200).json({ success: true, item_id: itemId, employees_found: employeeIds.length, message: commentBody });
}

// ─── Connect Macro Plan (trigger: status60) ───────────────────────────────────

function extractProjectNumber(name) {
  if (!name) return null;
  const part = name.split('|')[0].trim();
  return part || null;
}

async function handleConnectMacroPlan(req, res, itemId) {
  const res1 = await mondayRequest(
    `query ($ids: [ID!]) {
      items(ids: $ids) {
        id name
        column_values(ids: ["dropdown__1","dropdown_mkv0khrr"]) { id text }
      }
    }`,
    { ids: [itemId] }
  );
  const item = res1?.data?.items?.[0];
  if (!item) return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });

  const projectName = colText(item, 'dropdown__1') || colText(item, 'dropdown_mkv0khrr');
  if (!projectName) return res.status(200).json({ success: false, error: 'Project Name empty', item_id: itemId });

  const projectNumber = extractProjectNumber(projectName);
  let macroPlanItem = null;
  let method = null;

  if (projectNumber) {
    try {
      const r = await mondayRequest(`query {
        boards(ids: [5603041438]) {
          items_page(limit: 5, query_params: {
            rules: [{ column_id: "text", compare_value: [${JSON.stringify(projectNumber)}], operator: contains_text }]
          }) { items { id name column_values(ids: ["text"]) { id text } } }
        }
      }`);
      const items = r?.data?.boards?.[0]?.items_page?.items ?? [];
      macroPlanItem = items.find(i => i.column_values?.[0]?.text?.trim() === projectNumber) ?? null;
      if (macroPlanItem) method = 'project_number';
    } catch {}
  }

  if (!macroPlanItem) {
    try {
      const results = await Promise.all(MACRO_BOARDS.map(async boardId => {
        const r = await mondayRequest(
          `query ($b: ID!) {
            boards(ids: [$b]) {
              items_page(limit: 5, query_params: {
                rules: [{ column_id: "text__1", compare_value: [${JSON.stringify(projectName)}], operator: contains_text }]
              }) { items { id name column_values(ids: ["text__1"]) { id text } } }
            }
          }`,
          { b: String(boardId) }
        );
        const items = r?.data?.boards?.[0]?.items_page?.items ?? [];
        return items.find(i => i.column_values?.[0]?.text?.trim() === projectName) ?? null;
      }));
      macroPlanItem = results.find(r => r !== null) ?? null;
      if (macroPlanItem) method = 'project_name';
    } catch {}
  }

  if (macroPlanItem) {
    await updateBoardItem(BOARD_ID, itemId, {
      connect_boards: { item_ids: [Number(macroPlanItem.id)] },
      status6:  { label: 'Connected' },
      status60: { label: 'Connected' },
    });
    return res.status(200).json({ success: true, found: true, method, item_id: itemId, macro_plan_item_id: macroPlanItem.id });
  } else {
    await updateBoardItem(BOARD_ID, itemId, { status6: { label: '' }, status60: { label: 'ERROR' } });
    try { await postComment(itemId, '🚨 The inventory log did not connect to the Macro Plan Project'); } catch {}
    return res.status(200).json({ success: true, found: false, item_id: itemId, project_name: projectName });
  }
}

// ─── Inventory Log Form (trigger: status → "Loading") ────────────────────────

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

const FORM_COL_IDS = [
  'multi_select__1','multi_select2','dropdown74','date1__1','dropdown__1',
  ...PRODUCTS.map(p => p.relCol),
  ...PRODUCTS.map(p => p.qtyCol),
  ...PRODUCTS.map(p => p.coverageCol),
];

async function handleInventoryLogForm(req, res, itemId) {
  const triggerTime = req.body?.event?.triggerTime || new Date().toISOString();
  const colIdsGql   = FORM_COL_IDS.map(id => `"${id}"`).join(', ');

  const res1 = await mondayRequest(
    `query ($ids: [ID!]!) {
      items(ids: $ids) {
        id name
        column_values(ids: [${colIdsGql}]) {
          id text
          ... on BoardRelationValue { linked_item_ids }
        }
      }
    }`,
    { ids: [itemId] }
  );
  const formItem = res1?.data?.items?.[0];
  if (!formItem) return res.status(200).json({ success: false, error: 'Form item not found', item_id: itemId });

  const colMap    = Object.fromEntries(formItem.column_values.map(c => [c.id, c]));
  const getColTxt = id => colMap[id]?.text?.trim() ?? '';
  const getColIds = id => colMap[id]?.linked_item_ids ?? [];

  const fireStop    = getColTxt('multi_select__1');
  const caulking    = getColTxt('multi_select2');
  const contracting = getColTxt('dropdown74');
  const endDate     = getColTxt('date1__1');
  const projectName = getColTxt('dropdown__1');

  const newName = `${fireStop} - ${caulking} ${contracting} ${endDate}`.trim();
  try { await updateBoardItem(BOARD_ID, itemId, { name: newName }); } catch {}

  const activeProducts = PRODUCTS
    .map(p => ({
      ...p,
      inventoryItemId: getColIds(p.relCol)[0] ?? null,
      qtyUsed:  parseFloat(getColTxt(p.qtyCol)  || '0') || 0,
      coverage: parseFloat(getColTxt(p.coverageCol) || '0') || 0,
    }))
    .filter(p => p.inventoryItemId);

  let inventoryItems = [];
  if (activeProducts.length > 0) {
    try {
      const r = await mondayRequest(
        `query ($ids: [ID!]!) { items(ids: $ids) { id name column_values(ids: ["chiffres","numbers0"]) { id text } } }`,
        { ids: activeProducts.map(p => String(p.inventoryItemId)) }
      );
      inventoryItems = r?.data?.items ?? [];
    } catch {}
  }

  const inventoryMap = Object.fromEntries(inventoryItems.map(inv => {
    const c = Object.fromEntries(inv.column_values.map(col => [col.id, col]));
    return [inv.id, { name: inv.name, price: parseFloat(c['chiffres']?.text || '0') || 0, currentQty: parseFloat(c['numbers0']?.text || '0') || 0 }];
  }));

  let processed = 0;
  await Promise.all(activeProducts.map(async p => {
    const inv = inventoryMap[String(p.inventoryItemId)];
    if (!inv) return;

    const newQty        = inv.currentQty - p.qtyUsed;
    const statusTrigger = newQty === 0 ? 'reset' : 'ghost';
    const totalCost     = p.qtyUsed * inv.price;

    try { await updateBoardItem(INVENTORY_BOARD, p.inventoryItemId, { numbers0: newQty, status_10: { label: statusTrigger } }); } catch {}
    try { await postComment(p.inventoryItemId, `Inventory withdrawal of ${p.qtyUsed} ${inv.name} by ${caulking} for project ${projectName}\n\nThe quantity changed from ${inv.currentQty} to ${newQty}\n\nDate: ${triggerTime}`); } catch {}
    try {
      await mondayRequest(
        `mutation ($pid: ID!, $name: String!, $cols: JSON!) { create_subitem(parent_item_id: $pid, item_name: $name, column_values: $cols) { id } }`,
        {
          pid: String(itemId), name: inv.name,
          cols: JSON.stringify({
            status:        { label: 'Loaded' },
            numbers:       p.qtyUsed,
            numbers_1:     inv.price,
            numbers4:      p.coverage,
            numbers_2:     totalCost,
            connect_boards: { item_ids: [Number(p.inventoryItemId)] },
          }),
        }
      );
    } catch {}
    processed++;
  }));

  try {
    await updateBoardItem(BOARD_ID, itemId, {
      status:  { label: 'Loaded' },
      date4:   { date: todayDate() },
      date_1:  { date: tomorrowDate() },
    });
  } catch {}

  return res.status(200).json({ success: true, item_id: itemId, new_name: newName, products_processed: processed });
}

// ─── Load Date & Hour (trigger: status1__1) ───────────────────────────────────

function parseDateTimeCol(item, colId) {
  const col = item?.column_values?.find(c => c.id === colId);
  if (!col?.text) return null;
  const [date, time] = col.text.split(' ');
  return { date: date ?? null, time: time ?? null };
}

function timeToDecimal(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return parseFloat((h + m / 60).toFixed(2));
}

async function handleLoadDateHour(req, res, itemId) {
  const res1 = await mondayRequest(
    `query ($ids: [ID!]) { items(ids: $ids) { id name column_values(ids: ["date","date2"]) { id text value } } }`,
    { ids: [itemId] }
  );
  const item = res1?.data?.items?.[0];
  if (!item) return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });

  const startDT = parseDateTimeCol(item, 'date');
  const endDT   = parseDateTimeCol(item, 'date2');
  const valid   = startDT?.date && startDT?.time && endDT?.date && endDT?.time;

  if (!valid) {
    try { await updateBoardItem(BOARD_ID, itemId, { status1__1: { label: 'ERROR' } }); } catch {}
    try { await postComment(itemId, "🚨 The time formats for 'Work start date + Hour' and 'Work end date + Hour' are incorrect, please enter date & time and then change the status '⚙️ Load Data in date & Hour' to 'Loading'."); } catch {}
    return res.status(200).json({ success: true, valid: false, item_id: itemId });
  }

  await updateBoardItem(BOARD_ID, itemId, {
    date9__1:    { date: startDT.date },
    numbers2__1: timeToDecimal(startDT.time),
    numbers88__1: timeToDecimal(endDT.time),
    date1__1:    { date: endDT.date },
    status1__1:  { label: 'Loaded' },
    text2__1:    item.name,
  });

  return res.status(200).json({ success: true, valid: true, item_id: itemId, date_start: startDT.date, date_end: endDT.date });
}

// ─── Rewrite Item Name (trigger: status_1__1) ─────────────────────────────────

async function handleRewriteItemName(req, res, itemId) {
  const res1 = await mondayRequest(
    `query ($ids: [ID!]) { items(ids: $ids) { id name column_values(ids: ["text2__1"]) { id text } } }`,
    { ids: [itemId] }
  );
  const item = res1?.data?.items?.[0];
  if (!item) return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });

  const newName = item.column_values?.[0]?.text?.trim();
  if (!newName) return res.status(200).json({ success: false, error: '⚙️ Primary Item Name is empty', item_id: itemId });

  await updateBoardItem(BOARD_ID, itemId, { name: newName, status_1__1: { label: 'Writed' } });
  return res.status(200).json({ success: true, item_id: itemId, old_name: item.name, new_name: newName });
}

// ─── Timesheet Approve (trigger: status__1 → Leader Approbation) ──────────────

async function handleTimesheetApprove(req, res, itemId) {
  const res1 = await mondayRequest(
    `query ($ids: [ID!]) { items(ids: $ids) { column_values(ids: ["numbers2__1","numbers88__1","status8__1"]) { id text } } }`,
    { ids: [itemId] }
  );
  const cols       = res1?.data?.items?.[0]?.column_values || [];
  const startHour  = parseFloat(cols.find(c => c.id === 'numbers2__1')?.text  || 0);
  const endTime    = parseFloat(cols.find(c => c.id === 'numbers88__1')?.text  || 0);
  const lunch      = cols.find(c => c.id === 'status8__1')?.text || '';
  const breakHours = lunch === 'Yes' ? 0.5 : 0;
  const hours      = parseFloat((endTime - startHour - breakHours).toFixed(2));

  await updateBoardItem(BOARD_ID, itemId, { numbers__1: hours });
  return res.status(200).json({ success: true, item_id: itemId, hours });
}

// ─── Router ───────────────────────────────────────────────────────────────────

const ROUTES = {
  'status2__1':  handleCreateSpecialId,
  'status0__1':  handleConnectEmployee,
  'status60':    handleConnectMacroPlan,
  'status':      handleInventoryLogForm,
  'status1__1':  handleLoadDateHour,
  'status_1__1': handleRewriteItemName,
  'status__1':   handleTimesheetApprove,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body?.challenge)   return res.status(200).json({ challenge: req.body.challenge });
  if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'Missing MONDAY_API_TOKEN' });

  const itemId   = String(req.body?.event?.pulseId || req.body?.event?.itemId || '').trim();
  const columnId = req.body?.event?.columnId;

  if (!itemId) return res.status(200).json({ success: false, error: 'Missing item ID' });

  const route = ROUTES[columnId];
  if (!route)  return res.status(200).json({ success: false, error: 'Unknown trigger column', column_id: columnId });

  try {
    return await route(req, res, itemId);
  } catch (err) {
    console.error('[monday] handler error', JSON.stringify({ columnId, itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Internal error', column_id: columnId });
  }
}
