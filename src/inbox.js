'use strict';
// Inbox triage: classify inbound messages (order / enquiry / follow-up / MDM request), extract the details needed to act,
// and map MDM requests onto a pre-filled intake request. Rule-based and transparent (every decision shows its evidence).
const { comparePair } = require('./matching');
const { normUen } = require('./rules');

const LABELS = ['PO', 'enquiry', 'follow-up', 'MDM request'];
const COUNTRY = { singapore: 'SG', malaysia: 'MY', indonesia: 'ID', thailand: 'TH', vietnam: 'VN' };

// Order matters: first match wins. Follow-ups are checked before orders because they quote PO numbers.
const RULES = [
  ['follow-up', 'chasing / reminder / "any update" / "checking if you received"', /(following up|chasing again|gentle reminder|checking if you received|any update on|revert urgently|still waiting)/],
  ['MDM request', 'asks to create, update, merge or deactivate an account', /(update our (uen|registration)|new customer registration|please create an account|account seems to be duplicated|merge them|changed our company name|formerly|kindly deactivate|ceased operations|update our billing address)/],
  ['PO', 'order wording with quantities (place an order / PO attached / PO# / confirming our order)', /(place an order|please find our po|po#\s*\d|confirming our order|purchase order attached)/],
  ['enquiry', 'asks about price, specs, shipping, lead time or differences', /(price list|spec sheet|msds|difference between|do you ship|lead time|volume discount|quotation|\bquote\b)/],
];

const strip = t => String(t || '').replace(/^\s*fw:\s*/i, '').trim();

function classify(text) {
  const t = strip(text).toLowerCase();
  for (const [label, why, re] of RULES) if (re.test(t)) return { label, evidence: why, matched: (t.match(re) || [])[0] };
  return { label: 'other', evidence: 'no rule matched', matched: null };
}

const mkMatcher = model => {
  const customers = [...model.customers.values()];
  return (name, country) => {
    if (!name) return null;
    let best = null;
    for (const c of customers) {
      if (country && c.country !== country) continue;
      const s = comparePair({ name, country }, { name: c.name, country }).nameSim;
      if (!best || s > best.score) best = { customer_id: c.customer_id, name: c.name, country: c.country, golden_id: model.golden.get(c.customer_id), score: s };
    }
    return best && best.score >= 0.8 ? { ...best, score: Number(best.score.toFixed(2)) } : null;
  };
};

function extractOrder(text) {
  const t = strip(text);
  const qtys = [...t.matchAll(/(?:qty\s*|for\s+|order for\s+|^|\s)(\d{1,6})\s*(?:units|pcs|x)\b/gi)].map(m => Number(m[1]));
  const q2 = [...t.matchAll(/qty\s*(\d+)/gi)].map(m => Number(m[1]));
  const q3 = [...t.matchAll(/(\d+)\s*x\s*product/gi)].map(m => Number(m[1]));
  const prods = [...t.matchAll(/product\s+([abc])\b/gi)].map(m => m[1].toUpperCase());
  const alt = [...t.matchAll(/(?:pcs|units)\s+of\s+([abc])\b/gi)].map(m => m[1].toUpperCase());
  const company = (t.match(/PO#\d+\s*-\s*(.+?)\s*-\s*Product/i) || t.match(/(?:Invoice|Bill) to\s+(.+?)\.\s*(?:Kindly|$)/i) || t.match(/Regards,\s*[^()]+\(([^)]+)\)?/i) || [])[1];
  const lines = (q2.length ? q2 : q3.length ? q3 : qtys).slice(0);
  const products = prods.length ? prods : alt;
  return { lines: lines.map((q, i) => ({ qty: q, product: products[i] || products[0] || null })), company: company ? company.trim() : null };
}

function extractMdm(text, match) {
  const t = strip(text);
  let m;
  if ((m = t.match(/update our (?:UEN|registration[^ ]*)[^.]*? to (\S+?) for (.+?)\.(?:\s|$)/i))) {
    const c = match(m[2]);
    return { kind: 'update_uen', request_type: 'update_customer', company: m[2], customer: c, prefill: { field: 'uen', new_value: normUen(m[1]), target_customer_id: c?.customer_id } };
  }
  if ((m = t.match(/update our billing address to (.+?)\.\s*Company:\s*(.+?)\.\s*UEN unchanged/i))) {
    const c = match(m[2]);
    return { kind: 'update_address', request_type: 'update_customer', company: m[2], customer: c, prefill: { field: 'address', new_value: m[1].trim(), target_customer_id: c?.customer_id } };
  }
  if ((m = t.match(/changed our company name to (.+?) \(formerly (.+?)\)/i))) {
    const c = match(m[2]);
    return { kind: 'update_name', request_type: 'update_customer', company: m[2], customer: c, prefill: { field: 'name', new_value: m[1].trim(), target_customer_id: c?.customer_id } };
  }
  if ((m = t.match(/duplicated in your system \((.+?)\)/i))) {
    const c = match(m[1]);
    return { kind: 'merge', request_type: 'merge_customer', company: m[1], customer: c, prefill: { target_customer_id: c?.customer_id, into_golden_id: c?.golden_id } };
  }
  if ((m = t.match(/deactivate the account for (.+?),\s*we have ceased operations in (\w+)/i))) {
    const c = match(m[1]);
    return { kind: 'deactivate', request_type: 'deactivate_customer', company: m[1], customer: c, prefill: { target_customer_id: c?.customer_id, reason: `Ceased operations in ${m[2]} (customer email)` } };
  }
  if ((m = t.match(/new customer registration:\s*(.+?),\s*([A-Za-z]+),\s*reg no\s*(\S+?)\.\s*Please create an account under (\w+)/i))) {
    const ctry = COUNTRY[m[2].toLowerCase()];
    const c = match(m[1], ctry);
    return { kind: 'create', request_type: 'create_customer', company: m[1], customer: c, existing: !!c,
      prefill: { name: m[1].replace(/\s+/g, ' ').trim(), country: ctry, uen: normUen(m[3]), entity: m[4].toUpperCase() } };
  }
  return { kind: 'unparsed', request_type: null, company: null, customer: null, prefill: {} };
}

const cache = new WeakMap();

function triage(model, db) {
  if (cache.has(model)) return cache.get(model);
  const match = mkMatcher(model);
  const poIds = new Map(model.pos.map(p => [p.po_id.toLowerCase(), p]));
  const msgs = db.prepare('SELECT * FROM md_inbox ORDER BY received_at').all();
  const items = msgs.map(msg => {
    const c = classify(msg.text);
    const it = { msg_id: msg.msg_id, received_at: msg.received_at, from_email: msg.from_email, text: msg.text, true_label: msg.true_label, predicted: c.label, evidence: c.evidence, correct: c.label === msg.true_label };
    if (c.label === 'PO') {
      const o = extractOrder(msg.text);
      const cust = match(o.company);
      it.order = { ...o, customer: cust, units: o.lines.reduce((s, l) => s + l.qty, 0) };
    } else if (c.label === 'MDM request') it.mdm = extractMdm(msg.text, match);
    else if (c.label === 'follow-up') {
      const ref = (msg.text.match(/PO-\d{4}-\d+/i) || [])[0];
      it.followUp = { poRef: ref || null, poFound: ref ? poIds.has(ref.toLowerCase()) : null, po: ref ? poIds.get(ref.toLowerCase()) ?? null : null,
        topic: ref ? 'order status' : /address change/i.test(msg.text) ? 'MDM change status' : /price list/i.test(msg.text) ? 'pricing' : 'other' };
    }
    return it;
  });
  const conf = Object.fromEntries(LABELS.map(a => [a, Object.fromEntries([...LABELS, 'other'].map(b => [b, 0]))]));
  items.forEach(i => { (conf[i.true_label] ??= {})[i.predicted] = ((conf[i.true_label] ??= {})[i.predicted] || 0) + 1; });
  const mdm = items.filter(i => i.mdm), po = items.filter(i => i.order);
  const summary = {
    total: items.length, accuracy: items.filter(i => i.correct).length / (items.length || 1),
    perClass: LABELS.map(l => {
      const tp = items.filter(i => i.predicted === l && i.true_label === l).length, pr = items.filter(i => i.predicted === l).length, ac = items.filter(i => i.true_label === l).length;
      return { label: l, actual: ac, predicted: pr, precision: pr ? tp / pr : null, recall: ac ? tp / ac : null };
    }),
    confusion: conf,
    extraction: {
      mdmTotal: mdm.length, mdmParsed: mdm.filter(i => i.mdm.kind !== 'unparsed').length, mdmTargetResolved: mdm.filter(i => i.mdm.customer || i.mdm.kind === 'create').length,
      orderTotal: po.length, orderCompanyFound: po.filter(i => i.order.company).length, orderCustomerResolved: po.filter(i => i.order.customer).length,
      followUpPoRefs: items.filter(i => i.followUp?.poRef).length, followUpPoFound: items.filter(i => i.followUp?.poFound).length,
    },
  };
  const out = { items, summary };
  cache.set(model, out);
  return out;
}

module.exports = { classify, triage, extractOrder, LABELS };
