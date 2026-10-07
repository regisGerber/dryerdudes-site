(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  let selectedAddress = false;
  window.initGuestAddressAutocomplete = () => {
    const input = byId('service-address');
    if (!input || !window.google?.maps?.places) return;
    const autocomplete = new google.maps.places.Autocomplete(input,{types:['address'],componentRestrictions:{country:'us'},fields:['address_components','formatted_address']});
    autocomplete.addListener('place_changed',() => {
      const place = autocomplete.getPlace();
      const components = place.address_components || [];
      const component = (type,short=false) => {const item = components.find(x => x.types.includes(type));return item ? (short ? item.short_name : item.long_name) : '';};
      const fields = {address_line1:[component('street_number'),component('route')].filter(Boolean).join(' '),address_city:component('locality') || component('postal_town') || component('sublocality'),address_state:component('administrative_area_level_1',true),address_zip:component('postal_code')};
      for (const [name,value] of Object.entries(fields)) byId('guest-form').elements[name].value=value;
      selectedAddress = !!component('street_number') && Object.values(fields).every(Boolean);
      if (selectedAddress) input.value = place.formatted_address;
      byId('address-help').textContent = selectedAddress ? 'Address selected. Service availability is checked when your request is confirmed.' : 'Please select a complete street address.';
    });
    input.addEventListener('input',() => { selectedAddress=false; for(const name of ['address_line1','address_city','address_state','address_zip']) byId('guest-form').elements[name].value=''; });
  };
  const showError = (id,message) => { byId(id).textContent=message;byId(id).hidden=false; };
  async function api(url,options) {
    const response = await fetch(url,options);
    const data = await response.json().catch(()=>({error:'The server did not respond. Please try again shortly.'}));
    if (!response.ok || !data.ok) throw new Error(data.error || data.message || 'Could not complete the request.');
    return data;
  }
  function ready() {
    const form = byId('guest-form');
    form.addEventListener('submit',async event => {
      event.preventDefault();byId('form-error').hidden=true;
      if (!selectedAddress) {showError('form-error','Choose a complete service address from the dropdown suggestions. If suggestions do not load, refresh this page.');byId('service-address').focus();return;}
      const payload = Object.fromEntries(new FormData(form));
      for (const name of ['full_service_requested','billing_agreed','tenant_contact_agreed']) payload[name]=form.elements[name].checked;
      payload.stacked=!form.elements.freestanding.checked;
      const button=byId('submit-request');button.disabled=true;button.textContent='Sending confirmation…';
      try {
        await api('/api/pm-guest-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        byId('sent-email').textContent=payload.manager_email;byId('request-view').hidden=true;byId('email-view').hidden=false;byId('email-view').focus();
      } catch(error){showError('form-error',error.message);} finally {button.disabled=false;button.textContent='Send confirmation email';}
    });
    byId('edit-request').addEventListener('click',()=>{byId('email-view').hidden=true;byId('request-view').hidden=false;form.elements.manager_email.focus();});
    let token = new URLSearchParams(location.hash.slice(1)).get('verify');
    if (!token) return;
    // Keep the email-verification capability out of history and external referrers.
    history.replaceState(null,'',location.pathname);
    byId('request-view').hidden=true;byId('verify-view').hidden=false;
    const finish = data => {
      byId('verify-status').hidden=true;byId('review-details').hidden=true;byId('confirm-request').hidden=true;byId('confirmed').hidden=false;
      byId('verify-view').querySelector('h2').hidden=true;
      const deliveries = data.email_sent && data.sms_sent ? 'email and text' : data.email_sent ? 'email' : data.sms_sent ? 'text' : '';
      byId('delivery-status').textContent=deliveries ? `Your tenant received the scheduling link by ${deliveries}. They can now choose an appointment.` : 'The tenant email and text did not send. Please copy the scheduling link below and send it to your tenant.';
      byId('tenant-link').href=data.booking_page_url;
      byId('confirmed').scrollIntoView({block:'nearest'});
    };
    api('/api/pm-guest-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'review'})}).then(data=>{
      if(data.already_confirmed){finish(data);return;}
      byId('verify-status').textContent='Review the details below. Confirming authorizes the repair within your selected limit and sends your tenant a scheduling link.';
      const r=data.review;
      const details=[['Company',r.company_name],['Billing / manager email',r.manager_email],['Tenant',r.tenant_name],['Service address',r.service_address+(r.unit ? `, Unit ${r.unit}` : '')],['Dryer problem',r.problem],['Price',`$80 diagnostic and labor; parts extra${r.full_service_requested ? '; Full Service +$20' : ''}`],['Total repair approval limit',`$${r.total_job_approval_limit_cents/100}`]];
      const dl=byId('review-details');for(const [label,value] of details){const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;dl.append(dt,dd);}dl.hidden=false;byId('confirm-request').hidden=false;
    }).catch(error=>{byId('verify-status').hidden=true;showError('verify-error',error.message);});
    byId('confirm-request').addEventListener('click',async()=>{
      const button=byId('confirm-request');if(button.dataset.checkStatus){location.hash=`verify=${token}`;location.reload();return;}button.disabled=true;button.textContent='Confirming request…';byId('verify-error').hidden=true;
      try{const data=await api('/api/pm-guest-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,confirm:true})});finish(data);}
      catch(error){showError('verify-error',error.message);button.textContent='Check confirmation status';button.dataset.checkStatus='true';}
      finally{button.disabled=false;}
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();
