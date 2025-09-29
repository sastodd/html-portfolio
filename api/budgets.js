// api/budgets.js
// POST to create budget rows in Airtable via your proxy.
// Query params (required): baseId, budgetsTableId, categoriesTableId
// Body: { "rows": [ { "Month":"2025-10", "CategoryId":"rec...", "Planned": 450, "Notes":"..." },
//                   { "Month":"2025-10", "CategoryName":"Travel", "Planned": 800 } ] }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Optional simple auth: set Vercel env X_API_KEY and send header x-api-key
    const requiredKey = process.env.X_API_KEY;
    if (requiredKey && req.headers["x-api-key"] !== requiredKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { baseId, budgetsTableId, categoriesTableId } = req.query || {};
    if (!baseId || !budgetsTableId || !categoriesTableId) {
      return res.status(400).json({ error: "Missing baseId/budgetsTableId/categoriesTableId" });
    }

    // Parse JSON body robustly
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString("utf8");
      body = text ? JSON.parse(text) : {};
    }
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "Body must include non-empty rows[]" });

    const token = process.env.AIRTABLE_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing Airtable token env var" });

    const AT = async (path, init = {}) => {
      const r = await fetch(`https://api.airtable.com/v0${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers || {})
        }
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || JSON.stringify(j));
      return j;
    };

    // 1) Load ALL categories once → {nameLower -> recId}
    const nameToId = {};
    let offset;
    do {
      const page = await AT(
        `/${baseId}/${categoriesTableId}?pageSize=100&cellFormat=json&userLocale=en-us${offset ? `&offset=${offset}` : ""}`
      );
      for (const rec of page.records || []) {
        const name = rec.fields?.Name ?? rec.fields?.Category ?? rec.id;
        nameToId[String(name).toLowerCase()] = rec.id;
      }
      offset = page.offset;
    } while (offset);

    // 2) Build Airtable-ready records (resolve Category)
    const toNumber = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
    const failures = [];
    const recordsToCreate = [];

    for (const [i, row] of rows.entries()) {
      const month = row.Month;
      const planned = toNumber(row.Planned);
      const notes = row.Notes;

      let catId = row.CategoryId;
      if (!catId && row.CategoryName) {
        catId = nameToId[String(row.CategoryName).toLowerCase()];
      }
      if (!catId) {
        failures.push({ index: i, reason: "Missing CategoryId/CategoryName or not found" });
        continue;
      }
      recordsToCreate.push({
        fields: {
          "Month": month,
          "Category": [catId],       // Link field
          "Planned $": planned,      // <-- adjust if your field is named differently
          ...(notes ? { "Notes": notes } : {})
        }
      });
    }

    // 3) Batch POST in chunks of ≤10
    const created = [];
    for (let i = 0; i < recordsToCreate.length; i += 10) {
      const chunk = recordsToCreate.slice(i, i + 10);
      const resp = await AT(
        `/${baseId}/${budgetsTableId}`,
        { method: "POST", body: JSON.stringify({ records: chunk, typecast: true }) }
      );
      created.push(...(resp.records || []));
    }

    return res.json({
      created_count: created.length,
      failed_count: failures.length,
      failures,
      records: created.map(r => ({ id: r.id, fields: r.fields }))
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
