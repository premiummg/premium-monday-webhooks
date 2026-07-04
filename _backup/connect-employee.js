const MONDAY_API_URL = 'https://api.monday.com/v2';
const FORM_BOARD_ID = 5679186588;
const EMPLOYEE_BOARD_ID = 5830605725;

const COL = {
  contracting:   'dropdown74',       // 📄Contracting Employee
  caulking:      'multi_select2',    // 📄Caulking employee
  fireStop:      'multi_select__1',  // 📄Fire Stop Employee
  employeeLink:  'connect_boards__1', // Board relation to employees
  connectStatus: 'status0__1',       // ⚙️ Connect Employee
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

async function fetchFormItem(itemId) {
  const res = await mondayRequest(
    `query ($ids: [ID!]!) {
      items(ids: $ids) {
        id
        name
        column_values(ids: ["dropdown74", "multi_select2", "multi_select__1"]) {
          id
          text
        }
      }
    }`,
    { ids: [String(itemId)] }
  );
  return res?.data?.items?.[0] ?? null;
}

async function searchEmployeeByName(name) {
  const res = await mondayRequest(
    `query ($boardId: ID!, $name: String!) {
      boards(ids: [$boardId]) {
        items_page(limit: 1, query_params: {
          rules: [{ column_id: "name", compare_value: [$name] }]
        }) {
          items { id name }
        }
      }
    }`,
    { boardId: String(EMPLOYEE_BOARD_ID), name }
  );
  return res?.data?.boards?.[0]?.items_page?.items?.[0] ?? null;
}

async function updateItem(itemId, cols) {
  return mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
    }`,
    {
      boardId: String(FORM_BOARD_ID),
      itemId: String(itemId),
      cols: JSON.stringify(cols),
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body?.challenge) return res.status(200).json({ challenge: req.body.challenge });
  if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'Missing MONDAY_API_TOKEN' });

  const itemId = String(req.body?.event?.pulseId || req.body?.event?.itemId || '').trim();
  if (!itemId) return res.status(200).json({ success: false, error: 'Missing item ID' });

  let formItem;
  try {
    formItem = await fetchFormItem(itemId);
  } catch (err) {
    console.error('[monday] fetch failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    return res.status(200).json({ success: false, error: 'Failed to fetch form item' });
  }

  if (!formItem) return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });

  const colMap = Object.fromEntries(formItem.column_values.map(c => [c.id, c]));

  const getNames = (colId) => {
    const text = colMap[colId]?.text?.trim() ?? '';
    return text ? text.split(', ').map(n => n.trim()).filter(Boolean) : [];
  };

  const allNames = [
    ...getNames(COL.contracting),
    ...getNames(COL.caulking),
    ...getNames(COL.fireStop),
  ];

  const messages = [];
  const employeeIds = [];

  await Promise.all(allNames.map(async (name) => {
    try {
      const employee = await searchEmployeeByName(name);
      if (employee) {
        employeeIds.push(Number(employee.id));
        messages.push(`✅ Item ID: ${employee.id}, Name: ${employee.name}`);
      } else {
        messages.push(`🚨 No items found for name: ${name} in database`);
      }
    } catch (err) {
      console.error(`[monday] search failed for "${name}"`, JSON.stringify({ details: err.details ?? err.message }));
      messages.push(`🚨 Error searching for: ${name}`);
    }
  }));

  try {
    await updateItem(itemId, {
      [COL.employeeLink]:  { item_ids: employeeIds },
      [COL.connectStatus]: { label: 'Connected' },
    });
  } catch (err) {
    console.error('[monday] update failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
  }

  const commentBody = messages.join('\n') || 'No data';
  try {
    await postComment(itemId, commentBody);
  } catch (err) {
    console.error('[monday] post comment failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
  }

  return res.status(200).json({
    success: true,
    item_id: itemId,
    employees_found: employeeIds.length,
    total_searched: allNames.length,
    message: commentBody,
  });
}
