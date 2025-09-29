const HARD_BASE = "apphe47UUcVkLGMRM";
const HARD_TXN_TABLE = "tbluB7cd68Oc843rn";

const { baseId = HARD_BASE, tableId = HARD_TXN_TABLE, month, timeZone = "America/Los_Angeles" } = req.query;

export default async function handler(req, res) {
  const { baseId, tableId, month, timeZone = "America/Los_Angeles" } = req.query;

  if (!baseId || !tableId || !month) {
    return res.status(400).json({ error: "Missing required params" });
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "Missing Airtable token env var" });
  }

  const AT = async (url) => {
    const r = await fetch(`https://api.airtable.com/v0${url}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    return j;
  };

  const filter = `DATETIME_FORMAT({Date}, 'YYYY-MM')='${month}'`;
  let url = `/${baseId}/${tableId}?pageSize=100&cellFormat=json&timeZone=${encodeURIComponent(
    timeZone
  )}&userLocale=en-us&filterByFormula=${encodeURIComponent(filter)}`;

  let offset, records = [], pages = 0;

  try {
    do {
      const page = await AT(url + (offset ? `&offset=${offset}` : ""));
      records.push(...(page.records || []));
      offset = page.offset;
      pages++;
    } while (offset);
  } catch (e) {
    return res.status(500).json({ error: "Airtable fetch failed", details: e.message });
  }

  const toCents = (v) => {
    if (v == null || v === "") return 0;
    const [a,b=""] = String(v).replace(/[$,]/g,"").split(".");
    return parseInt(a,10)*100 + parseInt((b+"00").slice(0,2),10);
  };

  const catIds = new Set();
  for (const r of records) {
    const cats = r.fields?.Category;
    if (Array.isArray(cats)) cats.forEach(id => catIds.add(id));
    else if (typeof cats === "string") catIds.add(cats);
  }

  const idToName = {};
  const idArr = Array.from(catIds);
  const categoryTableId = "tblLovH1h7C5npXlk"; // replace with your actual Categories table ID
  for (let i = 0; i < idArr.length; i += 50) {
    const chunk = idArr.slice(i, i+50);
    const orFilter = `OR(${chunk.map(id=>`RECORD_ID()='${id}'`).join(",")})`;
    const catUrl = `/${baseId}/${categoryTableId}?pageSize=100&filterByFormula=${encodeURIComponent(orFilter)}`;
    const data = await AT(catUrl);
    for (const rec of data.records || []) {
      idToName[rec.id] = rec.fields?.Name || rec.id;
    }
  }

  let totalCents = 0;
  const byCat = new Map();
  for (const rec of records) {
    const cents = toCents(rec.fields?.Amount);
    totalCents += cents;
    const cats = rec.fields?.Category;
    const list = Array.isArray(cats) ? cats : (cats ? [cats] : [null]);
    for (const id of list) {
      const key = id ? (idToName[id] || id) : "(Uncategorized)";
      const g = byCat.get(key) || { name: key, count: 0, totalCents: 0 };
      g.count++; g.totalCents += cents;
      byCat.set(key, g);
    }
  }

  const by_category = Array.from(byCat.values()).map(x => ({
    name: x.name,
    count: x.count,
    total: Number((x.totalCents/100).toFixed(2)),
  }));

  res.json({
    month,
    count: records.length,
    total: Number((totalCents/100).toFixed(2)),
    by_category,
    debug: { pages }
  });
}
