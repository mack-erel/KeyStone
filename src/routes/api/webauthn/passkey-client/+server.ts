import type { RequestHandler } from "@sveltejs/kit";
import { translate } from "$lib/i18n/server";
import type { Locale } from "$lib/i18n/core";

// 클라이언트로 내려가는 스크립트는 서버에서 locale 별 사용자 문구를 주입해 생성한다.
// 사용자 대면 문자열(취소/실패)은 translate 로 해석한 뒤 JSON.stringify 로 안전하게 임베드한다.
function buildScript(cancelledMsg: string, failedMsg: string): string {
    return `
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
    // 1) 스킨이 제공하는 #flash 우선 사용 (로그인 실패와 동일한 UX)
    var flash=document.getElementById('flash');
    var flashMsg=document.getElementById('flash-msg');
    if(flash&&flashMsg){
      flashMsg.textContent=msg;
      flash.classList.add('show');
      clearTimeout(flash._t);flash._t=setTimeout(function(){flash.classList.remove('show');},4000);
      return;
    }
    // 2) fallback: 스킨에 #flash 가 없을 때만 토스트 생성
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
      if(!assertion)throw new Error(${JSON.stringify(cancelledMsg)});
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
      var dest=data&&data.redirectTo?data.redirectTo:'/';
      try{
        if(typeof dest!=='string'||!dest.length||dest.charAt(0)!=='/'||dest.indexOf('//')===0||dest.indexOf('\\\\')!==-1){
          dest='/';
        }
      }catch(_){dest='/';}
      window.location.href=dest;
    }catch(e){
      btn.disabled=false;btn.textContent=orig;
      showError(e&&e.message?e.message:${JSON.stringify(failedMsg)});
    }
  }
  // ctrls H-FRONT-2: redirectTo 를 더 이상 DOM input 에서 읽지 않는다.
  // 외부 스킨이 hidden input 을 임의 값으로 채울 수 있어 (XSS-after-defense 등)
  // 사용자가 의도하지 않은 내부 경로로 강제 이동될 면적이 있다. URL 의 query
  // string 만 신뢰 — 서버가 OIDC/SAML 흐름에서 명시적으로 설정한 redirectTo
  // 만 사용. 추가로 서버 측 sanitizeRedirectTarget 가 최종 검증한다.
  function readRedirectFromUrl(){
    try{
      var u=new URL(window.location.href);
      var r=u.searchParams.get('redirectTo')||'';
      if(typeof r!=='string')return '';
      // 절대 URL / scheme-relative / 백슬래시 모두 거절. 내부 경로만 허용.
      if(!r.length||r.charAt(0)!=='/'||r.indexOf('//')===0||r.indexOf('\\\\')!==-1)return '';
      return r;
    }catch(_){return '';}
  }
  function init(){
    var btn=document.getElementById('idp-passkey-btn');
    if(btn){
      btn.addEventListener('click',function(){passkeyLogin(btn,readRedirectFromUrl());});
    }
    // 커스텀 스킨(skin-scripts)이 호출할 수 있도록 전역 함수 노출
    window.idpPasskeyLogin=function(){
      var b=document.getElementById('passkey')||document.getElementById('idp-passkey-btn')||document.createElement('button');
      passkeyLogin(b,readRedirectFromUrl());
    };
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init);
  }else{
    init();
  }
})();
`;
}

export const GET: RequestHandler = ({ locals }) => {
    const locale: Locale = locals.locale;
    const script = buildScript(translate(locale, "webauthn.errors.auth_cancelled"), translate(locale, "webauthn.errors.auth_failed"));
    return new Response(script, {
        headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
            // locale 별로 사용자 문구가 달라지므로 캐시 키를 locale 결정 입력(쿠키/Accept-Language)으로 분리.
            Vary: "Cookie, Accept-Language",
        },
    });
};
