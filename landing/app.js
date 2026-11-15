const chat = document.getElementById('wa-chat');
const statusEl = document.getElementById('wa-status');
const iosStatusbar = document.getElementById('ios-statusbar');
const composerChrome = document.getElementById('wa-composer-chrome');
const inputHint = document.getElementById('wa-input-hint');
const inputTextEl = document.getElementById('wa-input-text');
const replayBtn = document.getElementById('wa-replay-btn');
const backBtn = document.getElementById('wa-back-btn');
const lockBtn = document.getElementById('wa-lock-btn');
const recTimerEl = document.getElementById('wa-rec-timer');
const recWaveEl = document.getElementById('wa-rec-wave');
const recSendBtn = document.getElementById('wa-rec-send');
const recTrashBtn = document.getElementById('wa-rec-trash');
const kbKeys = Array.from(document.querySelectorAll('#wa-keyboard .kb-row span'));
const navbar = document.getElementById('navbar');
const scrollRail = document.getElementById('scroll-rail');
const navLinksWrap = document.getElementById('nav-links');
const navPill = document.getElementById('nav-pill');
const pickerGrid = document.getElementById('picker-grid');
const pickerLens = document.getElementById('picker-lens');
const pickerCards = Array.from(document.querySelectorAll('.picker-card'));
const iphoneTilt = document.getElementById('iphone-tilt');

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let activePreset = 'clabe';
let demoTimers = [];
let sendPendingVoiceFn = null;
let lastHitKey = null;
let queuedFlow = null;

if (recWaveEl && !recWaveEl.children.length) {
  for (let i = 0; i < 24; i++) {
    const bar = document.createElement('i');
    bar.style.setProperty('--i', String(i));
    recWaveEl.appendChild(bar);
  }
}

function setInputText(text) {
  if (inputTextEl) {
    inputTextEl.textContent = text;
  } else if (inputHint) {
    inputHint.textContent = text;
  }
}

function resetComposerState() {
  sendPendingVoiceFn = null;
  if (composerChrome) {
    composerChrome.classList.remove('is-recording', 'is-keyboard-open', 'is-typing-send');
  }
  if (iosStatusbar) {
    iosStatusbar.classList.remove('is-mic-active');
  }
  if (replayBtn) replayBtn.classList.remove('is-tapping');
  if (recSendBtn) recSendBtn.classList.remove('is-tapping');
  if (lastHitKey) {
    lastHitKey.classList.remove('is-hit');
    lastHitKey = null;
  }
}

function clearDemoTimers() {
  demoTimers.forEach((id) => clearTimeout(id));
  demoTimers = [];
  queuedFlow = null;
  resetComposerState();
}

function scheduleDemo(fn, delay) {
  const id = setTimeout(fn, delay);
  demoTimers.push(id);
  return id;
}

function iconHtml(name) {
  return (window.REICONS && window.REICONS[name]) || '';
}

function hydrateReicons(root = document) {
  root.querySelectorAll('[data-reicon]').forEach((el) => {
    const name = el.getAttribute('data-reicon');
    const svg = iconHtml(name);
    if (svg) el.innerHTML = svg;
  });
}

hydrateReicons();

// Astryx Scroll Progress Rail + Sticky Navbar Elevation + Scroll-Driven #problemas Choreography
const problemsSection = document.getElementById('problemas');
const problemsGrid = document.getElementById('problems-grid');
const problemsPathsSvg = document.getElementById('problems-paths');
const problemsScrollFill = document.getElementById('problems-scroll-fill');
const navLinks = navLinksWrap ? Array.from(navLinksWrap.querySelectorAll('a')) : [];

const layout = {
  vh: window.innerHeight || 1,
  maxScroll: 1,
  problemsDocTop: 0,
  problemsTotalTravel: 1,
  probCards: Array.from(document.querySelectorAll('.prob-card')).map((el) => ({
    el,
    docTop: 0,
    height: 360,
    rowOffset: 0,
    lastP: '',
    lastEngaged: null,
  })),
  navRects: new WeakMap(),
  pickerRects: new WeakMap(),
  lastScrollProgress: '',
  lastProblemsP: '',
  lastPathsSig: '',
  lastScrolled: null,
};

function renderProblemsPaths() {
  if (!problemsGrid || !problemsPathsSvg || layout.probCards.length < 2) return;
  const gw = Math.round(problemsGrid.offsetWidth);
  const gh = Math.round(problemsGrid.offsetHeight);
  if (!gw || !gh) return;

  const boxes = layout.probCards.map((m) => ({
    x: Math.round(m.el.offsetLeft),
    y: Math.round(m.el.offsetTop),
    w: Math.round(m.el.offsetWidth),
    h: Math.round(m.el.offsetHeight),
  }));
  const sig =
    `${gw}x${gh}|${prefersReducedMotion ? '1' : '0'}|` +
    boxes.map((b) => `${b.x},${b.y},${b.w},${b.h}`).join(';');
  if (sig === layout.lastPathsSig) return;
  layout.lastPathsSig = sig;

  problemsPathsSvg.setAttribute('viewBox', `0 0 ${gw} ${gh}`);

  const parts = [];
  for (let i = 0; i < boxes.length - 1; i += 1) {
    const a = boxes[i];
    const b = boxes[i + 1];
    const staggered = Math.abs(a.x - b.x) > 40;
    let d = '';
    let sx = 0;
    let sy = 0;
    let ex = 0;
    let ey = 0;

    if (staggered) {
      const dir = b.x > a.x ? 1 : -1;
      sx = dir === 1 ? a.x + a.w + 10 : a.x - 10;
      sy = Math.round(a.y + a.h * 0.46);
      ex = Math.round(b.x + b.w * 0.5);
      ey = Math.round(b.y - 12);
      const horiz = Math.abs(ex - sx);
      const vert = Math.max(0, ey - sy);
      const r = Math.min(44, Math.max(12, Math.floor(Math.min(horiz, vert) * 0.42)));
      const curveEndX = ex - dir * r;
      const curveEndY = sy + r;
      d = `M ${sx} ${sy} L ${curveEndX} ${sy} Q ${ex} ${sy} ${ex} ${curveEndY} L ${ex} ${ey - 1}`;
    } else {
      ex = Math.round(b.x + b.w * 0.5);
      sx = ex;
      sy = Math.round(a.y + a.h + 8);
      ey = Math.round(b.y - 8);
      if (ey <= sy + 8) continue;
      d = `M ${sx} ${sy} L ${ex} ${ey - 1}`;
    }

    const arrowPath = `M ${ex - 5} ${ey - 6} L ${ex} ${ey} L ${ex + 5} ${ey - 6}`;
    const dur = staggered ? '2.8s' : '1.4s';
    const begin = `${(i * 0.65).toFixed(2)}s`;
    const runnerMarkup = prefersReducedMotion
      ? ''
      : `<g class="prob-path-runner-group" opacity="0">` +
        `<circle cx="0" cy="0" r="6" class="prob-path-runner-halo"/>` +
        `<circle cx="0" cy="0" r="3.2" class="prob-path-runner"/>` +
        `<animateMotion dur="${dur}" begin="${begin}" repeatCount="indefinite" path="${d}"/>` +
        `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.14;0.84;1" dur="${dur}" begin="${begin}" repeatCount="indefinite"/>` +
        `</g>`;

    parts.push(
      `<g class="prob-path-seg">` +
      `<path class="prob-path-guide" d="${d}"/>` +
      `<path class="prob-path-dash" d="${d}"/>` +
      `<path class="prob-path-arrow" d="${arrowPath}"/>` +
      `<circle class="prob-path-node" cx="${sx}" cy="${sy}" r="4.2"/>` +
      runnerMarkup +
      `</g>`
    );
  }

  problemsPathsSvg.innerHTML = parts.join('');
}

function measureLayout() {
  const sy = window.scrollY || 0;
  const doc = document.documentElement;
  layout.vh = window.innerHeight || 1;
  layout.maxScroll = Math.max(1, doc.scrollHeight - layout.vh);

  if (problemsSection) {
    const rect = problemsSection.getBoundingClientRect();
    layout.problemsDocTop = rect.top + sy;
    layout.problemsTotalTravel = Math.max(1, rect.height + layout.vh * 0.5);
  }

  layout.probCards.forEach((m) => {
    const r = m.el.getBoundingClientRect();
    m.docTop = r.top + sy;
    m.height = r.height || 360;
  });

  renderProblemsPaths();

  navLinks.forEach((link) => {
    layout.navRects.set(link, {
      left: link.offsetLeft,
      top: link.offsetTop,
      width: link.offsetWidth,
      height: link.offsetHeight,
    });
  });

  pickerCards.forEach((card) => {
    layout.pickerRects.set(card, {
      left: card.offsetLeft,
      top: card.offsetTop,
      width: card.offsetWidth,
      height: card.offsetHeight,
    });
  });
}

let scrollRaf = 0;
let scrollYNow = window.scrollY || 0;
function updateScrollChrome() {
  scrollRaf = 0;
  const sy = scrollYNow;
  const vh = layout.vh;
  const progress = Math.min(1, Math.max(0, sy / layout.maxScroll)).toFixed(4);
  if (scrollRail && progress !== layout.lastScrollProgress) {
    layout.lastScrollProgress = progress;
    scrollRail.style.setProperty('--scroll-progress', progress);
  }

  const isScrolled = sy > 12;
  if (navbar && isScrolled !== layout.lastScrolled) {
    layout.lastScrolled = isScrolled;
    navbar.classList.toggle('is-scrolled', isScrolled);
  }

  if (problemsSection) {
    const traveled = vh * 0.85 - (layout.problemsDocTop - sy);
    const secP = Math.min(1, Math.max(0, traveled / layout.problemsTotalTravel)).toFixed(3);
    if (secP !== layout.lastProblemsP) {
      layout.lastProblemsP = secP;
      // Solo en la barrita: ponerla en la sección recalculaba estilos de todo su contenido
      if (problemsScrollFill) {
        problemsScrollFill.style.setProperty('--problems-p', secP);
      }
    }
  }

  const startBase = vh * 0.94;
  const endY = vh * 0.38;
  layout.probCards.forEach((m) => {
    if (prefersReducedMotion) {
      if (m.lastP !== '1') {
        m.lastP = '1';
        m.el.style.setProperty('--card-p', '1');
        m.el.classList.add('is-scroll-engaged');
      }
      return;
    }
    const top = m.docTop - sy;
    const bottom = top + m.height;
    const startY = startBase - m.rowOffset;
    const rawP = (startY - top) / Math.max(1, startY - endY);
    const cardPNum = Math.min(1, Math.max(0, rawP));
    const cardP = cardPNum.toFixed(3);
    if (cardP !== m.lastP) {
      m.lastP = cardP;
      m.el.style.setProperty('--card-p', cardP);
    }
    const engaged = cardPNum >= 0.58 && bottom > vh * 0.16;
    if (engaged !== m.lastEngaged) {
      m.lastEngaged = engaged;
      m.el.classList.toggle('is-scroll-engaged', engaged);
    }
  });
}

function scheduleScrollChrome() {
  scrollYNow = window.scrollY || 0;
  if (!scrollRaf) {
    scrollRaf = requestAnimationFrame(updateScrollChrome);
  }
}

measureLayout();
updateScrollChrome();

window.addEventListener('scroll', scheduleScrollChrome, { passive: true });
window.addEventListener(
  'resize',
  () => {
    measureLayout();
    scheduleScrollChrome();
  },
  { passive: true }
);
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    measureLayout();
    scheduleScrollChrome();
  }).observe(document.body);
}
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    measureLayout();
    scheduleScrollChrome();
  });
}
window.addEventListener(
  'load',
  () => {
    measureLayout();
    scheduleScrollChrome();
  },
  { once: true }
);

// Astryx UISegmentedControl Sliding Nav Pill (rects pre-cached)
if (navLinksWrap && navPill && navLinks.length) {
  const moveNavPill = (linkEl) => {
    let r = layout.navRects.get(linkEl);
    if (!r) {
      r = { left: linkEl.offsetLeft, top: linkEl.offsetTop, width: linkEl.offsetWidth, height: linkEl.offsetHeight };
      layout.navRects.set(linkEl, r);
    }
    navPill.style.width = `${r.width}px`;
    navPill.style.height = `${r.height}px`;
    navPill.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
    navPill.style.opacity = '1';
  };
  navLinks.forEach((link) => {
    link.addEventListener('mouseenter', () => moveNavPill(link));
    link.addEventListener('focus', () => moveNavPill(link));
  });
  navLinksWrap.addEventListener('mouseleave', () => {
    navPill.style.opacity = '0';
  });
}

// Astryx UISegmentedControl Sliding Lens for Scenario Picker (cero reflows síncronos)
function movePickerLens(cardEl, immediate = false) {
  if (!pickerGrid || !pickerLens || !cardEl) return;
  let r = layout.pickerRects.get(cardEl);
  if (!r || immediate) {
    r = { left: cardEl.offsetLeft, top: cardEl.offsetTop, width: cardEl.offsetWidth, height: cardEl.offsetHeight };
    layout.pickerRects.set(cardEl, r);
  }
  if (immediate) {
    pickerLens.style.transition = 'none';
  }
  pickerLens.style.width = `${r.width}px`;
  pickerLens.style.height = `${r.height}px`;
  pickerLens.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
  pickerGrid.dataset.lensReady = 'true';
  if (immediate) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pickerLens.style.transition = '';
      });
    });
  }
}

const initialActiveCard = document.querySelector('.picker-card.active');
if (initialActiveCard) {
  requestAnimationFrame(() => movePickerLens(initialActiveCard, true));
}
if (typeof ResizeObserver !== 'undefined' && pickerGrid) {
  const ro = new ResizeObserver(() => {
    measureLayout();
    const cur = pickerGrid.querySelector('.picker-card.active');
    if (cur) movePickerLens(cur, true);
  });
  ro.observe(pickerGrid);
} else {
  window.addEventListener(
    'resize',
    () => {
      const cur = document.querySelector('.picker-card.active');
      if (cur) movePickerLens(cur, true);
    },
    { passive: true }
  );
}

// Bidirectional scroll reveal observer with Astryx stagger
const revealEls = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
        } else if (entry.boundingClientRect.top > layout.vh * 0.88) {
          entry.target.classList.remove('is-visible');
        }
      });
    },
    { threshold: 0.08 }
  );
  revealEls.forEach((el) => observer.observe(el));

  const heroMark = document.querySelector('.h-mark');
  if (heroMark && !prefersReducedMotion) {
    let markLeftViewport = false;
    new IntersectionObserver(
      (entries) => {
        const visible = entries[0].isIntersecting;
        if (!visible) {
          markLeftViewport = true;
          heroMark.classList.remove('is-replay');
          heroMark.classList.add('is-waiting');
        } else if (markLeftViewport) {
          markLeftViewport = false;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              heroMark.classList.remove('is-waiting');
              heroMark.classList.add('is-replay');
            });
          });
        }
      },
      { threshold: 0.2 }
    ).observe(heroMark);
  }
} else {
  revealEls.forEach((el) => el.classList.add('is-visible'));
}

// Astryx Pointer Specular Spotlight (rAF-throttled + cached rect on enter)
if (window.matchMedia('(pointer: fine)').matches && !prefersReducedMotion) {
  let spotEl = null;
  let spotRect = null;
  let spotDirty = true;
  let spotX = 0;
  let spotY = 0;
  let spotRaf = 0;

  window.addEventListener(
    'scroll',
    () => {
      spotDirty = true;
    },
    { passive: true }
  );

  function flushSpotlight() {
    spotRaf = 0;
    if (!spotEl) return;
    if (spotDirty || !spotRect) {
      spotRect = spotEl.getBoundingClientRect();
      spotDirty = false;
    }
    if (!spotRect.width || !spotRect.height) return;
    const x = (((spotX - spotRect.left) / spotRect.width) * 100).toFixed(1);
    const y = (((spotY - spotRect.top) / spotRect.height) * 100).toFixed(1);
    spotEl.style.setProperty('--mx', `${x}%`);
    spotEl.style.setProperty('--my', `${y}%`);
  }

  document.querySelectorAll('.card, .card-dark').forEach((card) => {
    card.addEventListener('pointerenter', () => {
      spotEl = card;
      spotRect = card.getBoundingClientRect();
      spotDirty = false;
    });
    card.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        spotEl = card;
        spotX = e.clientX;
        spotY = e.clientY;
        if (!spotRaf) spotRaf = requestAnimationFrame(flushSpotlight);
      },
      { passive: true }
    );
    card.addEventListener('pointerleave', () => {
      if (spotEl === card) {
        spotEl = null;
        spotRect = null;
      }
    });
  });

  if (iphoneTilt && !iphoneTilt.classList.contains('is-3d')) {
    const bezel = iphoneTilt.querySelector('.iphone-bezel');
    let tiltRect = null;
    iphoneTilt.addEventListener('pointerenter', () => {
      if (!iphoneTilt.classList.contains('is-3d')) {
        tiltRect = iphoneTilt.getBoundingClientRect();
      }
    });
    iphoneTilt.addEventListener(
      'pointermove',
      (e) => {
        if (iphoneTilt.classList.contains('is-3d')) return;
        const rect = tiltRect || iphoneTilt.getBoundingClientRect();
        tiltRect = rect;
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        iphoneTilt.style.transform = `rotateY(${x * 8}deg) rotateX(${-y * 8}deg)`;
        if (bezel) {
          bezel.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`);
          bezel.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`);
        }
      },
      { passive: true }
    );
    iphoneTilt.addEventListener('pointerleave', () => {
      tiltRect = null;
      iphoneTilt.style.transform = 'rotateY(0deg) rotateX(0deg)';
    });
  }
}

// Astryx AnimatedLayout Edge Reveal for FAQ <details> (sin clipPath redundante)
document.querySelectorAll('.faq-item').forEach((details) => {
  const summary = details.querySelector('summary');
  const body = details.querySelector('.faq-body');
  if (!summary || !body) return;

  let anim = null;
  let isClosing = false;
  let isExpanding = false;

  summary.addEventListener('click', (e) => {
    if (prefersReducedMotion || typeof body.animate !== 'function') return;
    e.preventDefault();

    if (anim) anim.cancel();

    if (isClosing || !details.open) {
      isClosing = false;
      isExpanding = true;
      details.open = true;
      const fullHeight = body.scrollHeight;
      body.style.willChange = 'height, opacity';
      anim = body.animate(
        [
          { height: '0px', opacity: 0.001 },
          { height: `${fullHeight}px`, opacity: 1 },
        ],
        { duration: 340, easing: 'cubic-bezier(0.24, 1, 0.4, 1)' }
      );
      const cleanup = () => {
        isExpanding = false;
        anim = null;
        body.style.height = '';
        body.style.willChange = 'auto';
      };
      anim.onfinish = cleanup;
      anim.oncancel = cleanup;
    } else if (isExpanding || details.open) {
      isExpanding = false;
      isClosing = true;
      const startHeight = body.offsetHeight;
      body.style.willChange = 'height, opacity';
      anim = body.animate(
        [
          { height: `${startHeight}px`, opacity: 1 },
          { height: '0px', opacity: 0.001 },
        ],
        { duration: 210, easing: 'cubic-bezier(0.3, 0, 0.6, 0.6)' }
      );
      const cleanup = (finish) => {
        if (finish) details.open = false;
        isClosing = false;
        anim = null;
        body.style.willChange = 'auto';
      };
      anim.onfinish = () => cleanup(true);
      anim.oncancel = () => cleanup(false);
    }
  });
});

function setStageChip() {}

// ─────────────────────────────────────────────────────────────────────────────
// Demo del chat: cada ejemplo arranca en un chat recién abierto, se escribe (o se
// graba) en vivo, se envía y Zaldo contesta. Nunca se borra el chat a media escena.
// ─────────────────────────────────────────────────────────────────────────────
const PLACEHOLDER = 'Mensaje';
const kbSpace = document.querySelector('#wa-keyboard .kb-space');
const kbNumKey = document.querySelector('#wa-keyboard .kb-key-wide');
const KEY_FOR = new Map();
kbKeys.forEach((el) => {
  const label = el.textContent.trim();
  if (label.length === 1) KEY_FOR.set(label, el);
});

function scrollChatToEnd() {
  const top = chat.scrollHeight - chat.clientHeight;
  if (top <= 0) return;
  if (prefersReducedMotion || typeof chat.scrollTo !== 'function') {
    chat.scrollTop = top;
  } else {
    chat.scrollTo({ top, behavior: 'smooth' });
  }
}

function appendMessage(html, type = 'bot', extraClass = '') {
  const div = document.createElement('div');
  div.className = `msg msg-${type} ${extraClass}`.trim();
  const checks = type === 'user' ? `<span class="checks">${iconHtml('check-read')}</span>` : '';
  div.innerHTML = `${html}<div class="msg-meta"><span>9:41</span>${checks}</div>`;
  chat.appendChild(div);
  scrollChatToEnd();
  return div;
}

function appendTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'msg msg-bot msg-typing';
  div.setAttribute('aria-label', 'Zaldo está escribiendo');
  div.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  chat.appendChild(div);
  scrollChatToEnd();
  return div;
}

function bindCardButtons(methodLabel, amountLabel, conceptLabel, payerLabel) {
  const confirmBtn = chat.querySelector('#btn-confirm');
  const cancelBtn = chat.querySelector('#btn-cancel');
  if (!confirmBtn || !cancelBtn) return;

  confirmBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = 'escribiendo…';
    setInputText('Generando cobro…');
    setStageChip('Generando cobro CoDi');

    const typing1 = appendTypingIndicator();

    scheduleDemo(() => {
      typing1.remove();
      if (methodLabel === 'QR CoDi') {
        appendMessage(
          `<div>Aquí tienes tu QR CoDi de <strong>${amountLabel}</strong> · ${conceptLabel}</div>
           <div class="qr-mock">
             <img class="qr-code-img" src="assets/qr-ejemplo.png" alt="Código QR CoDi de ejemplo" width="108" height="108" />
             Muéstralo para que escaneen
           </div>`,
          'bot'
        );
      } else if (methodLabel === 'Link de pago') {
        appendMessage(
          `Listo. Reenvía este link por <strong>${amountLabel}</strong> (${conceptLabel}):<br><span style="color:#4cc3ff;text-decoration:underline;">https://pey.mx/p/zld-8492</span>`,
          'bot'
        );
      } else {
        appendMessage(
          `Listo. Le mandé el cobro CoDi a ${payerLabel} por <strong>${amountLabel}</strong>. Te aviso en cuanto caiga.`,
          'bot'
        );
      }

      statusEl.textContent = 'esperando al banco…';
      setInputText('Esperando el pago…');
      setStageChip('Esperando pago bancario');

      scheduleDemo(() => {
        statusEl.textContent = 'escribiendo…';
        const typing2 = appendTypingIndicator();
        scheduleDemo(() => {
          typing2.remove();
          appendMessage(
            `<div class="paid-badge-line">${iconHtml('check-circle')} ¡Ya cayó!</div>
             <strong>${amountLabel}</strong> de ${payerLabel} · ${conceptLabel} directo en tu banco.`,
            'bot',
            'msg-paid'
          );
          statusEl.textContent = 'en línea';
          setInputText('Toca para repetir');
          setStageChip('Ya cayó en tu cuenta', true);
        }, 720);
      }, 1650);
    }, 760);
  });

  cancelBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    appendMessage('Cobro cancelado. No se mandó nada.', 'bot');
    setInputText('Toca para repetir');
    setStageChip('Cancelado antes de cobrar');
  });
}

function bindClabeButtons() {
  const confirmBtn = chat.querySelector('#btn-confirm');
  const cancelBtn = chat.querySelector('#btn-cancel');
  if (!confirmBtn || !cancelBtn) return;

  confirmBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = 'vinculando tu cuenta…';
    setInputText('Conectando tu CLABE…');
    setStageChip('Conectando CLABE');

    const typing1 = appendTypingIndicator();
    scheduleDemo(() => {
      typing1.remove();
      appendMessage(
        'CLABE terminación <strong>30417</strong> vinculada (sin contraseñas de tu banco) y tu número de WhatsApp quedó autorizado.',
        'bot'
      );
      statusEl.textContent = 'activando cobros CoDi…';
      scheduleDemo(() => {
        const typing2 = appendTypingIndicator();
        scheduleDemo(() => {
          typing2.remove();
          appendMessage(
            `<div class="paid-badge-line">${iconHtml('check-circle')} ¡Listo! Ya puedes cobrar</div>
             Ahora sí: pídeme un cobro por audio, QR o link — o dime si deseas vincular otro celular de confianza.`,
            'bot',
            'msg-paid'
          );
          statusEl.textContent = 'en línea';
          setInputText('Listo · prueba un cobro');
          setStageChip('CLABE conectada', true);
        }, 740);
      }, 1300);
    }, 780);
  });

  cancelBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    appendMessage('Vinculación cancelada. No se guardó ninguna cuenta.', 'bot');
    setInputText('Toca para repetir');
    setStageChip('Cancelado');
  });
}

function prependChatChrome() {
  const datePill = document.createElement('div');
  datePill.className = 'wa-date-pill';
  datePill.textContent = 'Hoy';

  const notice = document.createElement('div');
  notice.className = 'wa-notice-card';
  notice.innerHTML =
    'Solo conectas tu CLABE una vez. Los cobros CoDi caen directo a tu cuenta; Zaldo <strong>nunca pide claves</strong>.';

  chat.appendChild(datePill);
  chat.appendChild(notice);
}

function appendOpeningSplash(subtitle) {
  const splash = document.createElement('div');
  splash.className = 'wa-chat-opening';
  splash.innerHTML = `
    <div class="wa-opening-orb"><img src="assets/zaldo-cube.png" alt="" /></div>
    <div class="wa-opening-title">Tu chat directo con Zaldo</div>
    <div class="wa-opening-sub">${subtitle}</div>
  `;
  chat.appendChild(splash);
  return splash;
}

// Chat nuevo: fecha, aviso de seguridad y la presentación de Zaldo, sin mensajes todavía
function openFreshChat(cfg) {
  chat.innerHTML = '';
  prependChatChrome();
  appendOpeningSplash(cfg.splash);
  chat.scrollTop = 0;
}

// Al mandar el primer mensaje la presentación se desvanece en su sitio (fuera del
// flujo), para que el globo entre justo debajo del aviso sin brincos
function dismissSplash() {
  const splash = chat.querySelector('.wa-chat-opening');
  if (!splash) return;
  if (prefersReducedMotion) {
    splash.remove();
    return;
  }
  splash.style.top = `${splash.offsetTop}px`;
  splash.classList.add('is-leaving');
  setTimeout(() => splash.remove(), 240);
}

const VOICE_HEIGHTS = [5, 9, 14, 8, 12, 16, 7, 11, 15, 13, 6, 10, 14, 9, 16, 11, 7, 13, 10, 8, 12, 6];

function createVoiceNoteHtml(transcript, duration = '0:03') {
  const barsHtml = VOICE_HEIGHTS.map(
    (h, idx) => `<span style="height:${h}px;--i:${idx}" class="${idx < 9 ? 'is-played' : ''}"></span>`
  ).join('');
  return `
    <div class="voice-note-card">
      <div class="voice-note-row">
        <button type="button" class="voice-play-btn" aria-label="Reproducir nota de voz">
          <span class="vn-play-ic">${iconHtml('play')}</span>
          <span class="vn-pause-ic">${iconHtml('pause')}</span>
        </button>
        <div class="voice-track">
          <div class="voice-wave-bars" aria-hidden="true">${barsHtml}</div>
          <div class="voice-submeta">
            <span>${duration}</span>
            <span>Audio WhatsApp</span>
          </div>
        </div>
      </div>
      <div class="voice-transcript">«${transcript}»</div>
    </div>
  `;
}

function bindVoiceNotePlayer(msgEl) {
  const card = msgEl.querySelector('.voice-note-card');
  const playBtn = msgEl.querySelector('.voice-play-btn');
  if (!card || !playBtn) return () => {};

  const bars = Array.from(card.querySelectorAll('.voice-wave-bars span'));
  let playTimerIds = [];

  const stopPlayback = () => {
    playTimerIds.forEach((id) => clearTimeout(id));
    playTimerIds = [];
    card.classList.remove('is-playing');
  };

  const startPlayback = () => {
    stopPlayback();
    card.classList.add('is-playing');
    bars.forEach((b) => b.classList.remove('is-played'));
    bars.forEach((bar, idx) => {
      const tid = setTimeout(() => {
        bar.classList.add('is-played');
      }, idx * 135);
      playTimerIds.push(tid);
      demoTimers.push(tid);
    });
    const endId = setTimeout(() => {
      stopPlayback();
    }, bars.length * 135 + 240);
    playTimerIds.push(endId);
    demoTimers.push(endId);
  };

  playBtn.addEventListener('click', () => {
    if (card.classList.contains('is-playing')) {
      stopPlayback();
      return;
    }
    startPlayback();
  });

  return startPlayback;
}

function buildConfirmCard({ title, rows, extraHtml = '' }) {
  const rowsHtml = rows
    .map(([k, v]) => `<div class="confirm-row"><span>${k}</span><strong>${v}</strong></div>`)
    .join('');
  return `<div class="confirm-card">
    <div class="confirm-title">${title}</div>
    ${rowsHtml}
    ${extraHtml}
    <div class="confirm-actions">
      <button type="button" class="wa-btn wa-btn-confirm" id="btn-confirm">${iconHtml('check-circle')} Confirmar</button>
      <button type="button" class="wa-btn wa-btn-cancel" id="btn-cancel">${iconHtml('close-circle')} Cancelar</button>
    </div>
  </div>`;
}

function getPresetConfig(preset) {
  if (preset === 'clabe') {
    return {
      mode: 'text',
      splash: 'Conecta tu CLABE una sola vez, sin contraseñas bancarias.',
      openingChip: 'Abriendo chat con Zaldo',
      userPrompt: 'Hola Zaldo, quiero conectar mi CLABE: 012180015482930417 · Ana López',
      readyHint: 'Toca Confirmar arriba…',
      readyChip: '1 paso · Conectar CLABE',
      deliverReply() {
        appendMessage(
          buildConfirmCard({
            title: '¿Conectamos esta cuenta CLABE?',
            rows: [
              ['CLABE', '•••• 30417 (18 díg.)'],
              ['Titular', 'Ana López'],
              ['WhatsApp', 'Este número vinculado'],
              ['Clave banco', 'No se requiere'],
            ],
          }),
          'bot'
        );
        bindClabeButtons();
      },
    };
  }
  if (preset === 'push') {
    return {
      mode: 'voice',
      splash: 'Graba una nota de voz natural para mandar un cobro CoDi.',
      openingChip: 'Grabando nota de voz',
      voiceTranscript: 'Cóbrale $350 a Sofi por las uñas.',
      readyHint: 'Toca Confirmar arriba…',
      readyChip: 'Listo para confirmar',
      deliverReply() {
        appendMessage(
          buildConfirmCard({
            title: '¿Confirmamos este cobro?',
            rows: [
              ['Monto', '$350.00 MXN'],
              ['Para', 'Sofi'],
              ['Concepto', 'Uñas'],
            ],
          }),
          'bot'
        );
        bindCardButtons('Push CoDi', '$350.00', 'Uñas', 'Sofi');
      },
    };
  }
  if (preset === 'qr') {
    return {
      mode: 'text',
      splash: 'Genera un QR CoDi al momento para mostrar en persona.',
      openingChip: 'Abriendo chat con Zaldo',
      userPrompt: 'Zaldo, mándame un QR de $180 para tacos',
      readyHint: 'Toca Confirmar arriba…',
      readyChip: 'Listo para confirmar',
      deliverReply() {
        appendMessage(
          buildConfirmCard({
            title: '¿Confirmamos este QR?',
            rows: [
              ['Monto', '$180.00 MXN'],
              ['Concepto', 'Tacos'],
              ['Método', 'QR CoDi'],
            ],
          }),
          'bot'
        );
        bindCardButtons('QR CoDi', '$180.00', 'Tacos', 'cliente');
      },
    };
  }
  if (preset === 'link') {
    return {
      mode: 'text',
      splash: 'Crea un link de pago CoDi listo para reenviar por chat.',
      openingChip: 'Abriendo chat con Zaldo',
      userPrompt: 'Mándame un link de $1,200 por el diseño',
      readyHint: 'Toca Confirmar arriba…',
      readyChip: 'Listo para confirmar',
      deliverReply() {
        appendMessage(
          buildConfirmCard({
            title: '¿Confirmamos este link?',
            rows: [
              ['Monto', '$1,200.00 MXN'],
              ['Concepto', 'Diseño'],
              ['Método', 'Link de pago'],
            ],
          }),
          'bot'
        );
        bindCardButtons('Link de pago', '$1,200.00', 'Diseño', 'cliente');
      },
    };
  }
  return {
    mode: 'text',
    splash: 'Consulta cuánto has cobrado hoy sin entrar a apps bancarias.',
    openingChip: 'Consultando resumen en vivo',
    userPrompt: '¿Cómo va mi zaldo hoy?',
    readyHint: 'Toca para repetir',
    readyChip: 'Saldo actualizado',
    doneChip: true,
    deliverReply() {
      appendMessage(
        `<div class="paid-badge-line">${iconHtml('wallet-money')} Resumen de hoy</div>
         Llevas <strong>$1,730.00 MXN</strong> cobrados en 3 pagos. Tienes 1 cobro pendiente de $300.00 (Juan) y anotaste $120.00 de gasolina.`,
        'bot',
        'msg-paid'
      );
    },
  };
}

// El mensaje ya salió: Zaldo lo lee (palomitas azules), escribe y contesta
function finishBotExchange(cfg, userMsg) {
  statusEl.textContent = 'en línea';
  scheduleDemo(() => {
    if (userMsg) userMsg.classList.remove('is-unread');
    statusEl.textContent = 'escribiendo…';
    const typing = appendTypingIndicator();
    scheduleDemo(() => {
      typing.remove();
      cfg.deliverReply();
      statusEl.textContent = 'en línea';
      setInputText(cfg.readyHint);
      setStageChip(cfg.readyChip, Boolean(cfg.doneChip));
    }, 940);
  }, 600);
}

// Tecla del teclado que corresponde a cada carácter (números y símbolos: «123»)
function keyFor(ch) {
  if (ch === ' ') return kbSpace;
  const base =
    ch === 'ñ' || ch === 'Ñ'
      ? 'Ñ'
      : ch
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toUpperCase();
  return KEY_FOR.get(base) || kbNumKey;
}

function hitKey(el) {
  if (lastHitKey) lastHitKey.classList.remove('is-hit');
  lastHitKey = el || null;
  if (lastHitKey) lastHitKey.classList.add('is-hit');
}

// Escribe letra por letra con ritmo humano. Cada tecla agenda la siguiente, así un
// tirón del navegador solo retrasa la escritura: nunca suelta varias letras de golpe.
function typePrompt(text, done) {
  const perChar = Math.min(44, Math.max(22, 2000 / text.length));
  let i = 0;
  const next = () => {
    const ch = text[i];
    i += 1;
    if (i === 1 && composerChrome) composerChrome.classList.add('is-typing-send');
    setInputText(text.slice(0, i));
    hitKey(keyFor(ch));
    if (i >= text.length) {
      scheduleDemo(() => {
        hitKey(null);
        done();
      }, 260);
      return;
    }
    let wait = perChar * (0.7 + Math.random() * 0.6);
    if (/[,.:·?]/.test(ch)) wait += 140;
    else if (ch === ' ') wait += 26;
    scheduleDemo(next, wait);
  };
  next();
}

function sendTypedMessage(cfg) {
  if (replayBtn) replayBtn.classList.add('is-tapping');
  scheduleDemo(() => {
    if (replayBtn) replayBtn.classList.remove('is-tapping');
    if (composerChrome) composerChrome.classList.remove('is-typing-send');
    setInputText(PLACEHOLDER);
    dismissSplash();
    const sent = appendMessage(cfg.userPrompt, 'user', 'is-unread');
    scheduleDemo(() => {
      if (composerChrome) composerChrome.classList.remove('is-keyboard-open');
    }, 300);
    finishBotExchange(cfg, sent);
  }, 160);
}

function runTextLiveFlow(cfg) {
  if (prefersReducedMotion) {
    chat.innerHTML = '';
    prependChatChrome();
    appendMessage(cfg.userPrompt, 'user');
    cfg.deliverReply();
    setInputText(cfg.readyHint);
    setStageChip(cfg.readyChip, Boolean(cfg.doneChip));
    return;
  }

  setStageChip(cfg.openingChip);
  // Toca la caja de texto: sube el teclado y empieza a escribir
  scheduleDemo(() => {
    if (composerChrome) composerChrome.classList.add('is-keyboard-open');
  }, 420);
  scheduleDemo(() => typePrompt(cfg.userPrompt, () => sendTypedMessage(cfg)), 420 + 320);
}

function runVoiceLiveFlow(cfg) {
  if (prefersReducedMotion) {
    chat.innerHTML = '';
    prependChatChrome();
    const vnMsg = appendMessage(createVoiceNoteHtml(cfg.voiceTranscript, '0:03'), 'user');
    bindVoiceNotePlayer(vnMsg);
    cfg.deliverReply();
    setInputText(cfg.readyHint);
    setStageChip(cfg.readyChip);
    return;
  }

  setStageChip(cfg.openingChip);

  const sendRecordedVoice = () => {
    resetComposerState();
    setInputText(PLACEHOLDER);
    dismissSplash();
    const vnMsg = appendMessage(createVoiceNoteHtml(cfg.voiceTranscript, '0:03'), 'user', 'is-unread');
    const startPlayback = bindVoiceNotePlayer(vnMsg);
    scheduleDemo(startPlayback, 260);
    finishBotExchange(cfg, vnMsg);
  };

  sendPendingVoiceFn = () => {
    clearDemoTimers();
    sendRecordedVoice();
  };

  const recStart = 660;
  scheduleDemo(() => {
    if (replayBtn) replayBtn.classList.add('is-tapping');
  }, 460);

  scheduleDemo(() => {
    if (replayBtn) replayBtn.classList.remove('is-tapping');
    if (composerChrome) composerChrome.classList.add('is-recording');
    if (iosStatusbar) iosStatusbar.classList.add('is-mic-active');
    if (recTimerEl) recTimerEl.textContent = '0:00';
    setStageChip('Nota de voz 0:00…');
    statusEl.textContent = 'grabando audio…';
  }, recStart);

  // El cronómetro corre en segundos reales: una nota de 0:03 dura tres segundos
  [1, 2, 3].forEach((sec) => {
    scheduleDemo(() => {
      if (recTimerEl) recTimerEl.textContent = `0:0${sec}`;
      setStageChip(`Nota de voz 0:0${sec}…`);
      if (sec === 3 && recSendBtn) recSendBtn.classList.add('is-tapping');
    }, recStart + sec * 1000);
  });

  scheduleDemo(sendRecordedVoice, recStart + 3000 + 360);
}

// El demo solo corre cuando el teléfono está listo y a la vista: en celular queda
// debajo del texto, así que espera a que llegues a él en vez de reproducirse a ciegas.
let phoneReady = !window.WebGLRenderingContext;
let phoneInView = !(iphoneTilt && 'IntersectionObserver' in window);

function flushQueuedFlow() {
  if (!queuedFlow || !phoneReady || !phoneInView) return;
  const run = queuedFlow;
  queuedFlow = null;
  run();
}

function markPhoneReady() {
  if (phoneReady) return;
  phoneReady = true;
  flushQueuedFlow();
}

window.addEventListener('zaldo:phone-ready', markPhoneReady, { once: true });
// Si el 3D no llega (sin WebGL, red lenta), se muestra el teléfono 2D y el demo sigue
setTimeout(() => {
  if (iphoneTilt && !iphoneTilt.classList.contains('is-3d')) {
    iphoneTilt.classList.add('is-2d');
    const stage = iphoneTilt.closest('.hero-stage');
    if (stage) stage.classList.add('has-2d');
  }
  markPhoneReady();
}, 6000);

if (iphoneTilt && 'IntersectionObserver' in window) {
  new IntersectionObserver(
    (entries) => {
      phoneInView = entries[entries.length - 1].intersectionRatio >= 0.55;
      flushQueuedFlow();
    },
    { threshold: [0, 0.55, 0.9] }
  ).observe(iphoneTilt);
}

function renderPreset(preset) {
  clearDemoTimers();
  activePreset = preset;
  window.dispatchEvent(new CustomEvent('zaldo:preset', { detail: { preset } }));
  statusEl.textContent = 'en línea';
  const cfg = getPresetConfig(preset);
  const play = () => (cfg.mode === 'voice' ? runVoiceLiveFlow(cfg) : runTextLiveFlow(cfg));
  if (prefersReducedMotion) {
    play();
    return;
  }
  openFreshChat(cfg);
  setInputText(PLACEHOLDER);
  queuedFlow = play;
  flushQueuedFlow();
}

if (pickerLens) {
  window.addEventListener('pointerup', () => pickerLens.classList.remove('is-pressing'));
  window.addEventListener('pointercancel', () => pickerLens.classList.remove('is-pressing'));
}

// En celular y tableta el selector es una barra de pestañas fija sobre el teléfono
const stackedMq = window.matchMedia('(max-width: 960px)');

pickerCards.forEach((card) => {
  card.addEventListener('pointerdown', () => {
    if (pickerLens) pickerLens.classList.add('is-pressing');
  });
  card.addEventListener('click', () => selectPreset(card.dataset.preset, { reveal: stackedMq.matches }));
});

// Selector de escenario: mantiene sincronizados el picker y el teléfono
function selectPreset(preset, { reveal = false } = {}) {
  pickerCards.forEach((c) => {
    const on = c.dataset.preset === preset;
    c.classList.toggle('active', on);
    c.setAttribute('aria-checked', String(on));
    if (on) movePickerLens(c);
  });
  renderPreset(preset);
  if (reveal) revealPhone();
}

// Si el teléfono no se ve completo, hace scroll suave hasta él
function revealPhone() {
  if (!iphoneTilt) return;
  const rect = iphoneTilt.getBoundingClientRect();
  const vh = layout.vh;
  let topLimit = navbar ? navbar.offsetHeight : 0;
  if (stackedMq.matches && pickerGrid) topLimit += pickerGrid.offsetHeight + 10;
  const visible = Math.min(rect.bottom, vh) - Math.max(rect.top, topLimit);
  if (visible >= Math.min(rect.height, vh - topLimit) * 0.8) return;
  const target = window.scrollY + rect.top - Math.max(topLimit + 8, (vh - rect.height) / 2);
  window.scrollTo({ top: Math.max(0, target), behavior: prefersReducedMotion ? 'auto' : 'smooth' });
}

// Marca la tira cuando queda pegada bajo la barra, para darle fondo y sombra
if (pickerGrid && 'IntersectionObserver' in window) {
  let stuckIo = null;
  const watchStuck = () => {
    if (stuckIo) stuckIo.disconnect();
    stuckIo = null;
    pickerGrid.classList.remove('is-stuck');
    if (!stackedMq.matches) return;
    const stickyTop = parseFloat(getComputedStyle(pickerGrid).top) || 0;
    stuckIo = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        pickerGrid.classList.toggle('is-stuck', e.intersectionRatio < 1 && e.boundingClientRect.top <= stickyTop + 2);
      },
      { rootMargin: `${-(stickyTop + 1)}px 0px 0px 0px`, threshold: [1] }
    );
    stuckIo.observe(pickerGrid);
  };
  watchStuck();
  if (stackedMq.addEventListener) stackedMq.addEventListener('change', watchStuck);
  window.addEventListener('orientationchange', watchStuck);
}

if (recSendBtn) {
  recSendBtn.addEventListener('click', () => {
    if (typeof sendPendingVoiceFn === 'function') sendPendingVoiceFn();
  });
}
if (recTrashBtn) {
  recTrashBtn.addEventListener('click', () => {
    clearDemoTimers();
    dismissSplash();
    appendMessage('Nota de voz descartada. Toca el micrófono para grabar otra vez.', 'bot');
    statusEl.textContent = 'en línea';
    setInputText('Toca para reintentar');
    setStageChip('Audio descartado');
  });
}
if (replayBtn) {
  replayBtn.addEventListener('click', () => renderPreset(activePreset));
}
if (inputHint) {
  inputHint.addEventListener('click', () => renderPreset(activePreset));
}
if (backBtn) {
  backBtn.addEventListener('click', () => renderPreset(activePreset));
}
if (lockBtn) {
  lockBtn.addEventListener('click', () => {
    const notice = chat.querySelector('.wa-notice-card');
    if (!notice) return;
    chat.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    notice.classList.remove('is-highlighted');
    requestAnimationFrame(() => {
      notice.classList.add('is-highlighted');
    });
    scheduleDemo(() => notice.classList.remove('is-highlighted'), 950);
  });
}

renderPreset('clabe');
