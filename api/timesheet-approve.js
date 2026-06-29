const MONDAY_API_URL = 'https://api.monday.com/v2';

async function mondayQuery(query, variables = {}) {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': process.env.MONDAY_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.body?.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const itemId = req.body?.event?.pulseId;
  if (!itemId) {
    return res.status(400).json({ error: 'No item ID' });
  }

  const { data } = await mondayQuery(
    `query ($id: ID!) {
      items(ids: [$id]) {
        column_values(ids: ["numbers2__1", "numbers88__1", "status8__1"]) {
          id
          text
        }
      }
    }`,
    { id: String(itemId) }
  );

  const cols = data?.items?.[0]?.column_values || [];
  const startHour = parseFloat(cols.find(c => c.id === 'numbers2__1')?.text || 0);
  const endTime   = parseFloat(cols.find(c => c.id === 'numbers88__1')?.text || 0);
  const lunch     = cols.find(c => c.id === 'status8__1')?.text || '';
  const breakNum  = lunch === 'Yes' ? 0.5 : 0;
  const hours     = parseFloat((endTime - startHour - breakNum).toFixed(2));

  await mondayQuery(
    `mutation ($id: ID!, $val: JSON!) {
      change_column_value(board_id: 5679186588, item_id: $id, column_id: "numbers__1", value: $val) {
        id
      }
    }`,
    { id: String(itemId), val: JSON.stringify(hours) }
  );

  return res.status(200).json({ success: true, hours });
}
