const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 5679186588;
const MACRO_PLAN_BOARD_IDS = [5603041438, 18410435691, 18411058373];

const COL = {
  projectName1:   'dropdown__1',       // "📄Project Name"
  projectName2:   'dropdown_mkv0khrr', // "📄Project Name List 2"
  macroPlan:      'connect_boards',    // "🌍 Macro Plan"
  triggerMacro:   'status6',           // "⚙️ Trigger Macro adjusted"
  macroConnexion: 'status60',          // "⚙️ Macro Connexion"
};

function colText(item, colId) {
  return item?.column_values?.find((c) => c.id === colId)?.text?.trim() ?? '';
}

function extractProjectNumber(name) {
  if (!name) return null;
  const part = name.split('|')[0].trim();
  return part || null;
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
        column_values(ids: ["dropdown__1", "dropdown_mkv0khrr"]) {
          id
          text
        }
      }
    }`,
    { ids: [String(itemId)] }
  );
  return res?.data?.items?.[0] ?? null;
}

// Method 1: search by project number in "# Project" (text) — board 5603041438 only
async function searchByProjectNumber(projectNumber) {
  const escaped = JSON.stringify(projectNumber);
  const res = await mondayRequest(
    `query {
      boards(ids: [5603041438]) {
        items_page(limit: 5, query_params: {
          rules: [{ column_id: "text", compare_value: [${escaped}], operator: contains_text }]
        }) {
          items {
            id
            name
            column_values(ids: ["text"]) { id text }
          }
        }
      }
    }`
  );
  const items = res?.data?.boards?.[0]?.items_page?.items ?? [];
  return items.find((i) => i.column_values?.[0]?.text?.trim() === projectNumber) ?? null;
}

// Method 2: search by full project name in "⚙️ Project Name in Forms" (text__1) — all 3 boards
async function searchByProjectName(projectName) {
  const escaped = JSON.stringify(projectName);
  const results = await Promise.all(
    MACRO_PLAN_BOARD_IDS.map(async (boardId) => {
      const res = await mondayRequest(
        `query ($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 5, query_params: {
              rules: [{ column_id: "text__1", compare_value: [${escaped}], operator: contains_text }]
            }) {
              items {
                id
                name
                column_values(ids: ["text__1"]) { id text }
              }
            }
          }
        }`,
        { boardId: String(boardId) }
      );
      const items = res?.data?.boards?.[0]?.items_page?.items ?? [];
      return items.find((i) => i.column_values?.[0]?.text?.trim() === projectName) ?? null;
    })
  );
  return results.find((r) => r !== null) ?? null;
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

  const projectName = colText(item, COL.projectName1) || colText(item, COL.projectName2);
  if (!projectName) {
    return res.status(200).json({ success: false, error: 'Project Name column is empty', item_id: itemId });
  }

  const projectNumber = extractProjectNumber(projectName);

  // Try method 1: by project number in "# Project" column
  let macroPlanItem = null;
  let method = null;

  try {
    if (projectNumber) {
      macroPlanItem = await searchByProjectNumber(projectNumber);
      if (macroPlanItem) method = 'project_number';
    }
  } catch (err) {
    console.error('[monday] search by number failed', JSON.stringify({ itemId, projectNumber, details: err.details ?? err.message }));
  }

  // Try method 2: by full name in "⚙️ Project Name in Forms" column
  if (!macroPlanItem) {
    try {
      macroPlanItem = await searchByProjectName(projectName);
      if (macroPlanItem) method = 'project_name';
    } catch (err) {
      console.error('[monday] search by name failed', JSON.stringify({ itemId, projectName, details: err.details ?? err.message }));
    }
  }

  if (macroPlanItem) {
    try {
      await updateItem(itemId, {
        [COL.macroPlan]:      { item_ids: [Number(macroPlanItem.id)] },
        [COL.triggerMacro]:   { label: 'Connected' },
        [COL.macroConnexion]: { label: 'Connected' },
      });
    } catch (err) {
      console.error('[monday] update failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
      return res.status(200).json({ success: false, error: 'Failed to update item' });
    }

    return res.status(200).json({
      success: true,
      found: true,
      method,
      item_id: itemId,
      project_name: projectName,
      project_number: projectNumber,
      macro_plan_item_id: macroPlanItem.id,
      macro_plan_item_name: macroPlanItem.name,
    });
  } else {
    try {
      await updateItem(itemId, {
        [COL.triggerMacro]:   { label: '' },
        [COL.macroConnexion]: { label: 'ERROR' },
      });
    } catch (err) {
      console.error('[monday] update failed (not found)', JSON.stringify({ itemId, details: err.details ?? err.message }));
    }

    try {
      await postComment(itemId, '🚨 The inventory log did not connect to the Macro Plan Project');
    } catch (err) {
      console.error('[monday] post comment failed', JSON.stringify({ itemId, details: err.details ?? err.message }));
    }

    return res.status(200).json({
      success: true,
      found: false,
      item_id: itemId,
      project_name: projectName,
      project_number: projectNumber,
    });
  }
}
