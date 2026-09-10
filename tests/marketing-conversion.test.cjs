const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const handler = require('../api/ads-booking-conversion.js');
const browserSource = fs.readFileSync(path.join(__dirname, '../assets/booking-conversion.js'), 'utf8');
const sid = 'cs_live_' + 'A'.repeat(40);
const validSession = () => ({
  id: sid, livemode: true, mode: 'payment', status: 'complete', payment_status: 'paid',
  amount_total: 8000, currency: 'usd', client_reference_id: 'DD-123456',
  success_url: 'https://www.dryerdudes.com/payment-success.html?session_id={CHECKOUT_SESSION_ID}',
  metadata: { offer_token: 'opaque-offer', appointment_type: 'standard', job_ref: 'DD-123456', email: 'private@example.com' },
  customer_email: 'private@example.com',
});
async function request(session = validSession(), overrides = {}, upstreamStatus = 200) {
  let calls = 0;
  const oldFetch = global.fetch;
  const oldKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'test-only-placeholder';
  global.fetch = async (url, opts) => {
    calls++;
    assert.equal(url, `https://api.stripe.com/v1/checkout/sessions/${sid}`);
    assert.equal(opts.method, 'GET');
    assert.equal(opts.body, undefined);
    return { ok: upstreamStatus === 200, status: upstreamStatus, json: async () => session };
  };
  const result = { headers: {} };
  const res = {
    setHeader(k, v) { result.headers[k] = v; },
    status(n) { result.status = n; return this; },
    json(payload) { result.payload = payload; return this; },
  };
  try {
    await handler({ method: 'POST', headers: { origin: 'https://www.dryerdudes.com' }, body: { session_id: sid }, ...overrides }, res);
    result.calls = calls;
    return result;
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldKey;
  }
}

test('verified live $80 booking returns actual value and only non-identifying fields', async () => {
  const r = await request();
  assert.equal(r.status, 200); assert.equal(r.payload.value, 80);
  assert.equal(r.payload.eligible, true); assert.match(r.payload.transaction_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(r.payload).sort(), ['currency', 'eligible', 'ok', 'transaction_id', 'value']);
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert(!JSON.stringify(r.payload).includes(sid)); assert(!JSON.stringify(r.payload).includes('private@example.com'));
});
test('Full Service records actual $100 paid, not the old $1 placeholder', async () => {
  const s = validSession(); s.amount_total = 10000; s.metadata.appointment_type = 'full_service';
  assert.equal((await request(s)).payload.value, 100);
});
test('same payment yields stable transaction ID', async () => {
  assert.equal((await request()).payload.transaction_id, (await request()).payload.transaction_id);
});
for (const [name, patch] of [
  ['unpaid', {payment_status: 'unpaid'}], ['pending', {status: 'open'}],
  ['test-mode session', {livemode: false}], ['subscription', {mode: 'subscription'}],
  ['wrong currency', {currency: 'eur'}], ['zero amount', {amount_total: 0}],
  ['invalid amount', {amount_total: 80.2}], ['mismatched session', {id: 'cs_live_other'}],
  ['unrelated metadata', {metadata: {}}], ['wrong site', {success_url: 'https://example.com/payment-success.html'}],
  ['wrong return page', {success_url: 'https://www.dryerdudes.com/parts-success.html'}],
  ['mismatched reference', {client_reference_id: 'DD-999999'}],
]) test(`rejects ${name}`, async () => {
  const r = await request({...validSession(), ...patch});
  assert.equal(r.payload.eligible, false); assert.equal(r.payload.value, undefined);
});
for (const [name, overrides, code] of [
  ['GET requests', {method: 'GET'}, 405],
  ['cross-origin browser', {headers: {origin: 'https://example.com'}}, 403],
  ['missing session', {body: {}}, 400],
  ['test session ID', {body: {session_id: 'cs_test_' + 'A'.repeat(40)}}, 400],
  ['array injection', {body: {session_id: [sid]}}, 400],
  ['path injection', {body: {session_id: '../charges'}}, 400],
]) test(`rejects ${name} before contacting Stripe`, async () => {
  const r = await request(validSession(), overrides);
  assert.equal(r.status, code); assert.equal(r.calls, 0);
});
test('upstream failure returns generic error without customer details', async () => {
  const r = await request(validSession(), {}, 500);
  assert.equal(r.status, 503); assert.deepEqual(r.payload, {ok:false,error:'measurement_unavailable'});
});
function browser({hostname='www.dryerdudes.com', search=`?session_id=${sid}`, result, error=false} = {}) {
  const events = []; let calls = 0;
  const window = {location: {hostname, search}, gtag: (...args) => events.push(args)};
  vm.runInNewContext(browserSource, {
    window, URLSearchParams, AbortSignal,
    fetch: async () => { calls++; if (error) throw Error('offline'); return {ok:true,json:async()=>result || {ok:true,eligible:true,value:80,currency:'USD',transaction_id:'a'.repeat(64)}}; },
  });
  return {window, events, calls:()=>calls};
}
test('page load does not fire a conversion', () => {
  const b=browser(); assert.equal(b.calls(),0); assert.equal(b.events.length,0);
});
test('confirmed active booking records once with no session credentials', async () => {
  const b=browser();
  await b.window.ddTrackConfirmedBooking({booking_status:'scheduled'});
  await b.window.ddTrackConfirmedBooking({booking_status:'scheduled'});
  assert.equal(b.events.length,1); assert.equal(b.calls(),1);
  assert.equal(b.events[0][1],'conversion'); assert.equal(b.events[0][2].value,80);
  assert(!JSON.stringify(b.events).includes(sid));
});
for (const status of ['cancelled','no_show','refunded','unknown']) test(`browser excludes ${status} bookings`, async () => {
  const b=browser(); await b.window.ddTrackConfirmedBooking({booking_status:status});
  assert.equal(b.calls(),0); assert.equal(b.events.length,0);
});
test('preview deployments do not send production conversions', async () => {
  const b=browser({hostname:'preview.vercel.app'}); await b.window.ddTrackConfirmedBooking({booking_status:'scheduled'}); assert.equal(b.calls(),0);
});
test('job reference without session never records purchase', async () => {
  const b=browser({search:'?job_ref=DD-123456'}); await b.window.ddTrackConfirmedBooking({booking_status:'scheduled'}); assert.equal(b.calls(),0);
});
test('measurement outage does not throw or mark conversion', async () => {
  const b=browser({error:true}); await b.window.ddTrackConfirmedBooking({booking_status:'scheduled'}); assert.equal(b.events.length,0);
});
test('unverified server response never records conversion', async () => {
  const b=browser({result:{ok:true,eligible:false}}); await b.window.ddTrackConfirmedBooking({booking_status:'scheduled'}); assert.equal(b.events.length,0);
});
