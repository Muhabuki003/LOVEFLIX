// Shared navigation component — included by every page after loveflix.js.
// Renders the full nav bar into #site-nav (or prepends to body), handles
// active-link detection, hero-page scroll effects, and avatar painting.
(function () {
  var NAV_PAGES = [
    { id: 'home',      label: 'Home',      href: 'home.html'      },
    { id: 'browse',    label: 'Browse',    href: 'browse.html'    },
    { id: 'music',     label: 'Music',     href: 'music.html'     },
    { id: 'our-story', label: 'Our Story', href: 'our-story.html' },
    { id: 'my-list',   label: 'My List',   href: 'my-list.html'   },
  ];

  var filename = (location.pathname.split('/').pop() || 'home.html').replace('.html', '') || 'home';

  if (!document.getElementById('lf-nav-style')) {
    var s = document.createElement('style');
    s.id = 'lf-nav-style';
    s.textContent = [
      'nav.lf-topnav{position:fixed;top:0;left:0;right:0;padding:18px 48px;z-index:50;display:flex;align-items:center;justify-content:space-between;background:rgba(10,10,10,0.95);transition:background .25s ease}',
      'nav.lf-topnav.lf-hero{background:linear-gradient(to bottom,rgba(0,0,0,0.85),transparent)}',
      'nav.lf-topnav.lf-hero.lf-scrolled{background:rgba(10,10,10,0.95)}',
      '.lf-nav-left{display:flex;align-items:center;gap:40px}',
      '.lf-nf-logo{font-family:"Bebas Neue",sans-serif;font-size:36px;color:var(--brand-accent,#e50914);letter-spacing:3px;line-height:1;text-decoration:none}',
      '.lf-nf-logo .lf-heart{color:#fff;font-size:24px;vertical-align:middle;transform:translateY(-2px);display:inline-block;margin:0 2px}',
      '.lf-nav-links{display:flex;gap:22px}',
      '.lf-nav-links a{font-size:14px;color:#d4d4d4;transition:color .18s ease;text-decoration:none}',
      '.lf-nav-links a:hover{color:#fff}',
      '.lf-nav-links a.lf-active{color:#fff;font-weight:600}',
      '.lf-nav-right{display:flex;align-items:center;gap:18px}',
      '.lf-icon-btn{background:none;border:none;color:#fff;width:24px;height:24px;padding:0;cursor:pointer}',
      '.lf-icon-btn svg{width:100%;height:100%;fill:#fff}',
      '.lf-nav-avatar{width:32px;height:32px;border-radius:4px;background:radial-gradient(circle at 30% 25%,#ffb3c7 0%,transparent 55%),linear-gradient(135deg,#ff5f8f 0%,#d6336c 55%,#8f1d4a 100%);display:flex;align-items:center;justify-content:center;font-family:"Bebas Neue",sans-serif;font-size:18px;letter-spacing:1px;color:#fff;text-decoration:none}',
      '@media(max-width:900px){nav.lf-topnav{padding:14px 24px}}',
      '@media(max-width:720px){nav.lf-topnav{padding:12px 16px}.lf-nav-left{gap:18px}.lf-nf-logo{font-size:28px}.lf-nf-logo .lf-heart{font-size:20px}.lf-nav-links{display:none}.lf-nav-right{gap:12px}}',
    ].join('');
    document.head.appendChild(s);
  }

  var links = NAV_PAGES.map(function (p) {
    var active = p.id === filename || (filename === '' && p.id === 'home');
    return '<a href="' + p.href + '"' + (active ? ' class="lf-active"' : '') + '>' + p.label + '</a>';
  }).join('');

  var nav = document.createElement('nav');
  nav.className = 'lf-topnav';
  nav.id = 'lf-topnav';
  nav.innerHTML =
    '<div class="lf-nav-left">' +
      '<a href="home.html" class="lf-nf-logo" aria-label="LoveFlix home">LOVE<span class="lf-heart">♥</span>FLIX</a>' +
      '<div class="lf-nav-links">' + links + '</div>' +
    '</div>' +
    '<div class="lf-nav-right">' +
      '<button class="lf-icon-btn" aria-label="Search"><svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg></button>' +
      '<button class="lf-icon-btn" aria-label="Notifications"><svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 002-2h-4a2 2 0 002 2zm6-6V11a6 6 0 10-12 0v5l-2 2v1h16v-1l-2-2z"/></svg></button>' +
      '<a href="whos_watching.html" class="lf-nav-avatar" id="lf-navAvatar" title="Switch profile">M</a>' +
    '</div>';

  var placeholder = document.getElementById('site-nav');
  if (placeholder) {
    placeholder.parentNode.replaceChild(nav, placeholder);
  } else {
    document.body.insertBefore(nav, document.body.firstChild);
  }

  // Hero pages: transparent nav that becomes solid on scroll
  if (document.querySelector('.hero')) {
    nav.classList.add('lf-hero');
    window.addEventListener('scroll', function () {
      nav.classList.toggle('lf-scrolled', window.scrollY > 60);
    }, { passive: true });
  }

  if (window.LoveFlix && LoveFlix.paintNavAvatar) {
    LoveFlix.paintNavAvatar(document.getElementById('lf-navAvatar'));
  }
})();
