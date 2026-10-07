import crypto from 'node:crypto';

export const clean = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const esc = value => String(value ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
export function validateGuest(body) {
  const data = {};
  for (const name of ['company_name','contact_name','manager_email','manager_phone','billing_address_line_1','billing_address_line_2','billing_city','billing_state','billing_zip','tenant_name','tenant_phone','tenant_email','service_address','address_line1','address_city','address_state','address_zip','unit','dryer_type']) data[name] = clean(body[name]);
  data.problem = clean(body.problem, 1500);
  data.access_notes = clean(body.access_notes, 1500);
  for (const field of ['company_name','contact_name','manager_email','billing_address_line_1','billing_city','billing_state','billing_zip','tenant_name','tenant_phone','tenant_email','service_address','address_line1','address_city','address_state','address_zip','problem']) {
    if (!data[field]) throw new Error('Please complete the manager, billing, tenant, address, and dryer problem fields.');
  }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const field of ['manager_email','tenant_email']) {
    data[field] = data[field].toLowerCase();
    if (!emailPattern.test(data[field]) || data[field].length > 254) throw new Error('Enter valid manager and tenant email addresses.');
  }
  for (const field of ['manager_phone','tenant_phone']) {
    const digits = data[field].replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
    if ((data[field] || field === 'tenant_phone') && digits.length !== 10) throw new Error('Enter a 10-digit US phone number.');
    data[field] = digits ? `+1${digits}` : '';
  }
  if (!/^[A-Za-z]{2}$/.test(data.billing_state) || !/^\d{5}(?:-\d{4})?$/.test(data.billing_zip)) throw new Error('Enter a two-letter billing state and valid ZIP code.');
  if (!['electric','gas','unknown'].includes(data.dryer_type)) throw new Error('Select the dryer type.');
  if (body.stacked !== false) throw new Error('This form is for free-standing residential dryers. Please contact us about stacked units.');
  if (body.billing_agreed !== true || body.tenant_contact_agreed !== true) throw new Error('Confirm payment responsibility and permission to contact the tenant.');
  data.total_job_approval_limit_cents = Number(body.total_job_approval_limit_cents);
  if (![15000,17500,20000,22500,25000].includes(data.total_job_approval_limit_cents)) throw new Error('Choose a repair approval limit from $150 to $250.');
  data.full_service_requested = body.full_service_requested === true;
  return data;
}
export async function db(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Server configuration unavailable');
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json', Prefer:'return=representation', ...options.headers},
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Guest request database error (${response.status})`);
  return response.status === 204 ? [] : response.json();
}
export async function sendEmail({to,subject,html,id}) {
  if (!process.env.RESEND_API_KEY) throw new Error('Email delivery unavailable');
  const response = await fetch('https://api.resend.com/emails', {
    method:'POST', headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type':'application/json', 'Idempotency-Key':id},
    body: JSON.stringify({from:'Dryer Dudes <scheduling@dryerdudes.com>', reply_to:'info@dryerdudes.com', to:[to],subject,html}),
    signal:AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Email delivery failed (${response.status})`);
}
export function origin() {
  return (process.env.SITE_ORIGIN || 'https://www.dryerdudes.com').replace(/\/+$/, '');
}
export function allowedOrigin(req) {
  const requestOrigin = req.headers?.origin;
  return !requestOrigin || [origin(), 'https://www.dryerdudes.com','https://dryerdudes.com'].includes(requestOrigin);
}
