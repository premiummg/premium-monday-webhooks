const MONDAY_API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 5679186588;

// All boards connected via the "🌍 Macro Plan" column — searched in order
const MACRO_PLAN_BOARD_IDS = [5603041438, 18410435691, 18411058373];

// Column IDs in the time tracking board (5679186588)
const COL = {
  projectName: 'dropdown__1',  // "📄Project Name" — used as lookup key
  macroPlan: 'connect_boards', // "🌍 Macro Plan" — board_relation to update
  triggerMacro: 'status6',     // "⚙️ Trigger Macro adjusted"
  macroConnexion: 'status60',  // "⚙️ Macro Connexion"
};

// Column in the Macro Plan boards that holds the project name for matching
const MACRO_SEARCH_COL = 'text__1'; // "⚙️ Project Name in Forms"

function colText(item, colId) {
  return item?.column_values?.find((c) => c.id === colId)?.text ?? '';
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
        column_values(ids: ["dropdown__1"]) {
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

async function searchMacroPlanByName(projectName) {
  // compare_value expects Monday's CompareValue scalar — must be inlined, not passed as a variable
  const escapedName = JSON.stringify(projectName);
  const results = await Promise.all(
    MACRO_PLAN_BOARD_IDS.map(async (boardId) => {
      const res = await mondayRequest(
        `query ($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 10, query_params: {
              rules: [{ column_id: "text__1", compare_value: [${escapedName}], operator: contains_text }]
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
      return items.find((i) => i.column_values?.[0]?.text?.trim() === projectName.trim()) ?? null;
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
    console.error('[monday] fetch item failed', { itemId, details: err.details ?? err.message });
    return res.status(200).json({ success: false, error: 'Failed to fetch item', details: err.details ?? err.message });
  }

  if (!item) {
    return res.status(200).json({ success: false, error: 'Item not found', item_id: itemId });
  }

  const projectName = colText(item, COL.projectName);
  if (!projectName) {
    return res.status(200).json({ success: false, error: 'Project Name column is empty', item_id: itemId });
  }

  // Search all Macro Plan boards for a matching project
  let macroPlanItem = null;
  try {
    macroPlanItem = await searchMacroPlanByName(projectName);
  } catch (err) {
    console.error('[monday] macro plan search failed', JSON.stringify({ itemId, projectName, details: err.details ?? err.message }, null, 2));
    return res.status(200).json({ success: false, error: 'Macro Plan search failed', details: err.details ?? err.message });
  }

  if (macroPlanItem) {
    // Path A: found — connect to Macro Plan and set status to "Connected"
    try {
      await updateItem(itemId, {
        [COL.macroPlan]: { item_ids: [Number(macroPlanItem.id)] },
        [COL.triggerMacro]: { label: 'Connected' },
        [COL.macroConnexion]: { label: 'Connected' },
      });
    } catch (err) {
      console.error('[monday] update failed (path A)', { itemId, details: err.details ?? err.message });
      return res.status(200).json({ success: false, error: 'Failed to update item', details: err.details ?? err.message });
    }

    return res.status(200).json({
      success: true,
      found: true,
      item_id: itemId,
      project_name: projectName,
      macro_plan_item_id: macroPlanItem.id,
      macro_plan_item_name: macroPlanItem.name,
    });
  } else {
    // Path B: not found — clear trigger, set connexion to ERROR, post warning
    try {
      await updateItem(itemId, {
        [COL.triggerMacro]: { label: '' },
        [COL.macroConnexion]: { label: 'ERROR' },
      });
    } catch (err) {
      console.error('[monday] update failed (path B)', { itemId, details: err.details ?? err.message });
    }

    try {
      await postComment(itemId, '🚨 The inventory log did not connect to the Macro Plan Project');
    } catch (err) {
      console.error('[monday] post comment failed', { itemId, details: err.details ?? err.message });
    }

    return res.status(200).json({
      success: true,
      found: false,
      item_id: itemId,
      project_name: projectName,
    });
  }
}
