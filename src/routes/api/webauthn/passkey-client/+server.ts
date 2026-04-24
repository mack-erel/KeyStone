import type { RequestHandler } from "@sveltejs/kit";

const script = `
(function(){
  function b64uToBuf(b64u){
    var b64=b64u.replace(/-/g,'+').replace(/_/g,'/');
    var bin=atob(b64);var arr=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    return arr.buffer;
  }
  function bufToB64u(buf){
    var arr=new Uint8Array(buf);var bin='';
    for(var i=0;i<arr.length;i++)bin+=String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
  }
  function showError(msg){
    var t=document.getElementById('idp-passkey-err');
    if(!t){
      t=document.createElement('div');t.id='idp-passkey-err';
      t.style.cssText='position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:9999;padding:.75rem 1.25rem;background:#fef2f2;border:1px solid #fecaca;color:#dc2626;border-radius:8px;font-size:.8125rem;box-shadow:0 4px 12px rgba(0,0,0,.15);white-space:nowrap';
      document.body.appendChild(t);
    }
    t.textContent=msg;
    clearTimeout(t._t);t._t=setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t);},4000);
  }
  async function passkeyLogin(btn,redirectTo){
    btn.disabled=true;var orig=btn.textContent;btn.textContent='authenticating...';
    try{
      var optRes=await fetch('/api/webauthn/authenticate/options',{method:'POST'});
      if(!optRes.ok)throw new Error(await optRes.text());
      var opts=await optRes.json();
      opts.challenge=b64uToBuf(opts.challenge);
      if(opts.allowCredentials)opts.allowCredentials=opts.allowCredentials.map(function(c){return Object.assign({},c,{id:b64uToBuf(c.id)});});
      var assertion=await navigator.credentials.get({publicKey:opts});
      if(!assertion)throw new Error('패스키 인증이 취소되었습니다.');
      var body={
        id:assertion.id,rawId:bufToB64u(assertion.rawId),type:assertion.type,
        response:{
          authenticatorData:bufToB64u(assertion.response.authenticatorData),
          clientDataJSON:bufToB64u(assertion.response.clientDataJSON),
          signature:bufToB64u(assertion.response.signature),
          userHandle:assertion.response.userHandle?bufToB64u(assertion.response.userHandle):null
        },
        clientExtensionResults:assertion.getClientExtensionResults(),
        _redirectTo:redirectTo||''
      };
      var verRes=await fetch('/api/webauthn/authenticate/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!verRes.ok)throw new Error(await verRes.text());
      var data=await verRes.json();
      window.location.href=data.redirectTo||'/';
    }catch(e){
      btn.disabled=false;btn.textContent=orig;
      showError(e&&e.message?e.message:'패스키 인증에 실패했습니다.');
    }
  }
  function init(){
    var btn=document.getElementById('idp-passkey-btn');
    if(!btn)return;
    var redir=(document.querySelector('[name="redirectTo"]')||{}).value||'';
    btn.addEventListener('click',function(){passkeyLogin(btn,redir);});
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init);
  }else{
    init();
  }
})();
`;

export const GET: RequestHandler = () =>
    new Response(script, {
        headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
        },
    });
