// Post-build: inject the LoveFlix shell into the freshly built browse/index.html.
//
// Vite emits a clean index.html with hashed asset URLs on every build, so this
// runs after `vite build` to add (idempotently):
//   - the standard LoveFlix unlock gate (waitlist cookie),
//   - an auth guard that redirects to the login screen when signed out,
//   - the accent-color bootstrap used across LoveFlix,
//   - brand fonts (Bebas Neue + Inter) for the loading/empty overlay,
//   - a LoveFlix title.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexPath = resolve(__dirname, '../../browse/index.html')

const GATE = `<!-- LF_GATE_START --><script>(function(){try{var u=new URL(location.href);var k=u.searchParams.get('unlock');if(k){u.searchParams.delete('unlock');fetch('/api/unlock?code='+encodeURIComponent(k)).then(function(r){return r.json()}).then(function(d){if(d.ok){setTimeout(function(){location=u.pathname+(u.search?u.search:'')+u.hash},100)}else{location.replace('/waitlist.html')}}).catch(function(){location.replace('/waitlist.html')});return}var c=document.cookie.match(/(?:^|;\\s*)lf_unlock=([^;]*)/);if(!c||c[1]!=='1'){location.replace('/waitlist.html')}}catch(e){location.replace('/waitlist.html')}})();</script><!-- LF_GATE_END -->`

const AUTH = `<!-- LF_AUTH_START --><script>(function(){try{if(!localStorage.getItem('loveflix_token')){location.replace('/loveflix_login_screen.html')}}catch(e){}})();</script><!-- LF_AUTH_END -->`

const ACCENT = `<script>(function(){try{var s=JSON.parse(localStorage.getItem('loveflix_settings')||'{}');var h=s.accentColor||s.brand_accent_color||'';if(/^#[0-9a-fA-F]{6}$/.test(h)){document.documentElement.style.setProperty('--brand-accent',h);document.documentElement.style.setProperty('--red',h);}}catch(e){}})();</script>`

const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />`

let html = readFileSync(indexPath, 'utf8')

if (!html.includes('LF_GATE_START')) {
  html = html.replace(/<head>/, `<head>\n    ${GATE}\n    ${AUTH}\n    ${ACCENT}\n    ${FONTS}`)
}

html = html.replace(
  /<title>[^<]*<\/title>/,
  '<title>LoveFlix — Browse</title>',
)

writeFileSync(indexPath, html)
console.log('Injected LoveFlix shell into browse/index.html')
