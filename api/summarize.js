// api/summarize.js
// Summarize all transactions for a month. IDs are hard-coded.
// Query: ?month=YYYY-MM[&timeZone=America/Los_Angeles]
// Optional header: x-api-key: my-super-secret-key-valle

const HARD_BASE = "apphe47UUcVkLGMRM";
const HARD_TXN_TABLE = "tbluB7cd68Oc843rn";
const HARD_CATEGORIES_TABLE = "tblLovH1h7C5npXlk";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Optional simple auth
    const requiredKey = process.env.X_API_KEY;
    if (requiredKey && req.headers["x-api-key"] !== requiredKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      month,
      timeZone = "America/Los_Angeles",
      baseId = HARD_BASE,
      tableId = HARD_TXN_TABLE
    } = req.query || {};

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "Missing or invalid month (YYYY-MM)" });
    }

    const token = process.env.AIRTABLE_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing Airtable token env var" });

    const AT = async (path) => {
      const r = await fetch(`https://api.airtable.com/v0${path}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || JSON.stringify(j));
      return j;
    };

    // Pull ALL pages for the month (YYYY-MM match on {Date})
    const filter = `DATETIME_FORMAT({Date}, 'YYYY-MM')='${month}'`;
    let url = `/${baseId}/${tableId}?pageSize=100&cellFormat=json&userLocale=en-us&timeZone=${encodeURIComponent(
      timeZone
    )}&filterByFormula=${encodeURIComponent(filter)}`;

    let offset;
    const records = [];
    let pages = 0;
    do {
      const page = await AT(url + (offset ? `&offset=${offset}` : ""));
      records.push(...(page.records || []));
      offset = page.offset;
      pages++;
    } while (offset);

    // Collect category IDs present
    const catIds = new Set();
    for (const r of records) {
      const cats = r.fields?.Category;
      if (Array.isArray(cats)) cats.forEach((id) => catIds.add(id));
      else if (typeof cats === "string") catIds.add(cats);
    }

    // Map Category IDs → Names (fetch only those we saw)
    const idToName = {};
    if (catIds.size) {
      const ids = Array.from(catIds);
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const orFilter = `OR(${chunk.map((id) => `RECORD_ID()='${id}'`).join(",")})`;
        const cats = await AT(
          `/${baseId}/${HARD_CATEGORIES_TABLE}?pageSize=100&filterByFormula=${encodeURIComponent(orFilter)}`
        );
        for (const rec of cats.records || []) {
          idToName[rec.id] = rec.fields?.Name || rec.id;
        }
      }
    }

    // Sum in integer cents (robust against "$", commas, strings)
    const toCents = (v) => {
      if (v == null || v === "") return 0;
      const [a, b = ""] = String(v).replace(/[$,]/g, "").split(".");
      const int = parseInt(a, 10) || 0;
      const dec = parseInt((b + "00").slice(0, 2), 10) || 0;
      return int * 100 + dec;
    };

    let totalCents = 0;
    const byCat = new Map();

    for (const rec of records) {
      const cents = toCents(rec.fields?.Amount);
      totalCents += cents;

      const cats = rec.fields?.Category;
      const list = Array.isArray(cats) ? cats : cats ? [cats] : [null];

      for (const id of list) {
        const key = id ? idToName[id] || id : "(Uncategorized)";
        const g = byCat.get(key) || { name: key, count: 0, totalCents: 0 };
        g.count += 1;
        g.totalCents += cents;
        byCat.set(key, g);
      }
    }

    const by_category = Array.from(byCat.values()).map((x) => ({
      name: x.name,
      count: x.count,
      total: Number((x.totalCents / 100).toFixed(2))
    }));

    return res.json({
      month,
      count: records.length,
      total: Number((totalCents / 100).toFixed(2)),
      by_category,
      debug: { pages }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
