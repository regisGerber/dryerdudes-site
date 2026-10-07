(()=>{
 'use strict';
 const byId=id=>document.getElementById(id);const money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(c)/100);
 const token=new URLSearchParams(location.hash.slice(1)).get('bill');
 // The capability stays in the URL fragment so refresh and Stripe return work;
 // fragments are never sent to the server or as HTTP referrers.
 async function call(action,extra={}){const r=await fetch('/api/pm-guest-bill',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action,...extra})});const data=await r.json().catch(()=>({error:'The bill is temporarily unavailable.'}));if(!r.ok||!data.ok)throw Error(data.error || 'Unable to load your bill.');return data;}
 function error(e){byId('bill-error').textContent=e.message;byId('bill-error').hidden=false;}
 function render(data){
  const bill=data.invoice;byId('bill-loading').hidden=true;byId('bill-view').hidden=false;byId('bill-error').hidden=true;
  byId('bill-title').textContent=bill.status==='pending_approval'?'Repair approval requested':bill.status==='paid'?'Payment received':'Your repair bill';
  byId('bill-job').textContent=[bill.company_name,bill.job_ref].filter(Boolean).join(' · ');byId('bill-address').textContent=bill.address;byId('bill-summary').textContent=bill.summary;
  const rows=[['Diagnostic & labor',bill.base_fee_cents],['Full Service',bill.full_service_cents]];
  if(bill.parts?.length){for(const part of bill.parts)rows.push([`${part.description} (${part.quantity} × ${money(part.unit_cost_cents)})`,part.line_total_cents]);}else rows.push(['Parts',bill.parts_cost_cents]);
  rows.push(['Repair total',bill.total_cents],['Already paid',bill.status==='paid'?bill.total_cents:bill.collected_cents],['Balance due',bill.amount_due_cents]);
  const table=byId('bill-lines');table.replaceChildren();for(const [label,value]of rows){const tr=document.createElement('tr');if(label==='Repair total'||label==='Balance due')tr.className='total';const th=document.createElement('th');th.scope='row';th.textContent=label;const td=document.createElement('td');td.textContent=money(value);tr.append(th,td);table.append(tr);}
  const approval=bill.status==='pending_approval',pay=['ready','payment_pending'].includes(bill.status)&&bill.amount_due_cents>0;
  for(const id of ['approve-agreement','approve-bill','decline-bill'])byId(id).hidden=!approval;
  byId('confirm-decline').hidden=true;byId('pay-bill').hidden=!pay;byId('approval-checkbox').checked=false;
  byId('approval-label').textContent=`I authorize the proposed total of ${money(bill.total_cents)} for this repair, which exceeds my original ${money(bill.approval_limit_cents)} approval limit.`;
  byId('bill-status').textContent=approval?`The proposed total exceeds your ${money(bill.approval_limit_cents)} limit. Please approve or decline it. No card will be charged when you approve.`:bill.status==='denied'?'You declined this proposed repair. Please email info@dryerdudes.com to discuss the next step.':bill.status==='paid'?'Payment confirmed. There is no balance due.':bill.parts_on_order?'Your repair charges are approved. Parts are on order; this payment covers the charges shown above.':'Your repair charges are approved. You can pay the balance securely with Stripe.';
 }
 async function refresh(){try{render(await call('review'));}catch(e){byId('bill-loading').hidden=true;error(e);}}
 async function act(action){byId('bill-error').hidden=true;const buttons=[...document.querySelectorAll('button')];buttons.forEach(x=>x.disabled=true);try{
   const data=await call(action,{confirm:true});
   if(data.checkout_url){const url=new URL(data.checkout_url);if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com')throw Error('The payment link is unavailable. Please contact info@dryerdudes.com.');location.assign(url.href);return;}
   if(data.paid)await refresh();else render(data);
  }catch(e){error(e);}finally{buttons.forEach(x=>x.disabled=false);}}
 function ready(){
  if(!token){byId('bill-loading').hidden=true;error(Error('Open the secure bill link in your Dryer Dudes email.'));return;}
  byId('approve-bill').addEventListener('click',()=>{if(!byId('approval-checkbox').checked){error(Error('Check the authorization box to approve this total.'));return;}act('approve');});
  byId('decline-bill').addEventListener('click',()=>{byId('confirm-decline').hidden=false;byId('bill-status').textContent='Declining will pause this proposed repair. Confirm below, or refresh to keep reviewing.';});
  byId('confirm-decline').addEventListener('click',()=>act('decline'));byId('pay-bill').addEventListener('click',()=>act('pay'));byId('refresh-bill').addEventListener('click',refresh);refresh();
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();
