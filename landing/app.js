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
const dockStatus = document.getElementById('dock-status');
const dockStatusStep = document.getElementById('dock-status-step');
const dockChipsWrap = document.getElementById('dock-chips');
const dockChips = document.querySelectorAll('.dock-chip');
const dockReplay = document.getElementById('dock-replay');
const navbar = document.getElementById('navbar');
const scrollRail = document.getElementById('scroll-rail');
const navLinksWrap = document.getElementById('nav-links');
const navPill = document.getElementById('nav-pill');
const pickerGrid = document.getElementById('picker-grid');
const pickerLens = document.getElementById('picker-lens');
const pickerCards = document.querySelectorAll('.picker-card');
const iphoneTilt = document.getElementById('iphone-tilt');

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let activePreset = 'clabe';
let demoTimers = [];
let sendPendingVoiceFn = null;

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
  kbKeys.forEach((k) => k.classList.remove('is-hit'));
}

function clearDemoTimers() {
  demoTimers.forEach((id) => clearTimeout(id));
  demoTimers = [];
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
const problemsScrollFill = document.getElementById('problems-scroll-fill');
const probCards = Array.from(document.querySelectorAll('.prob-card'));

let scrollRaf = 0;
function updateScrollChrome() {
  scrollRaf = 0;
  const doc = document.documentElement;
  const vh = window.innerHeight || 1;
  const maxScroll = Math.max(1, doc.scrollHeight - vh);
  const progress = Math.min(1, Math.max(0, window.scrollY / maxScroll));
  if (scrollRail) {
    scrollRail.style.setProperty('--scroll-progress', progress.toFixed(4));
  }
  if (navbar) {
    navbar.classList.toggle('is-scrolled', window.scrollY > 12);
  }

  if (problemsSection) {
    const rect = problemsSection.getBoundingClientRect();
    const totalTravel = Math.max(1, rect.height + vh * 0.5);
    const traveled = vh * 0.85 - rect.top;
    const secP = Math.min(1, Math.max(0, traveled / totalTravel));
    problemsSection.style.setProperty('--problems-p', secP.toFixed(3));
    if (problemsScrollFill) {
      problemsScrollFill.style.setProperty('--problems-p', secP.toFixed(3));
    }
  }

  probCards.forEach((card, idx) => {
    if (prefersReducedMotion) {
      card.style.setProperty('--card-p', '1');
      card.classList.add('is-scroll-engaged');
      return;
    }
    const r = card.getBoundingClientRect();
    const rowOffset = (idx % 2) * 36;
    const startY = vh * 0.94 - rowOffset;
    const endY = vh * 0.38;
    const rawP = (startY - r.top) / Math.max(1, startY - endY);
    const cardP = Math.min(1, Math.max(0, rawP));
    card.style.setProperty('--card-p', cardP.toFixed(3));
    card.classList.toggle('is-scroll-engaged', cardP >= 0.58 && r.bottom > vh * 0.16);
  });
}

window.addEventListener(
  'scroll',
  () => {
    if (!scrollRaf) {
      scrollRaf = requestAnimationFrame(updateScrollChrome);
    }
  },
  { passive: true }
);
window.addEventListener('resize', () => {
  if (!scrollRaf) {
    scrollRaf = requestAnimationFrame(updateScrollChrome);
  }
});
updateScrollChrome();

// Astryx UISegmentedControl Sliding Nav Pill
if (navLinksWrap && navPill) {
  const navLinks = navLinksWrap.querySelectorAll('a');
  const moveNavPill = (linkEl) => {
    navPill.style.width = `${linkEl.offsetWidth}px`;
    navPill.style.height = `${linkEl.offsetHeight}px`;
    navPill.style.transform = `translate3d(${linkEl.offsetLeft}px, ${linkEl.offsetTop}px, 0)`;
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

// Astryx UISegmentedControl Sliding Lens for Scenario Picker (segmented.ts spring)
function movePickerLens(cardEl, immediate = false) {
  if (!pickerGrid || !pickerLens || !cardEl) return;
  if (immediate) {
    pickerLens.style.transition = 'none';
  }
  const x = cardEl.offsetLeft;
  const y = cardEl.offsetTop;
  pickerLens.style.width = `${cardEl.offsetWidth}px`;
  pickerLens.style.height = `${cardEl.offsetHeight}px`;
  pickerLens.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  pickerGrid.dataset.lensReady = 'true';
  if (immediate) {
    // Force layout flush so subsequent selections animate smoothly
    void pickerLens.offsetWidth;
    pickerLens.style.transition = '';
  }
}

const initialActiveCard = document.querySelector('.picker-card.active');
if (initialActiveCard) {
  requestAnimationFrame(() => movePickerLens(initialActiveCard, true));
}
if (typeof ResizeObserver !== 'undefined' && pickerGrid) {
  const ro = new ResizeObserver(() => {
    const cur = pickerGrid.querySelector('.picker-card.active');
    if (cur) movePickerLens(cur, true);
  });
  ro.observe(pickerGrid);
} else {
  window.addEventListener('resize', () => {
    const cur = document.querySelector('.picker-card.active');
    if (cur) movePickerLens(cur, true);
  });
}

// Bidirectional scroll reveal observer with Astryx stagger
const revealEls = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
        } else if (entry.boundingClientRect.top > (window.innerHeight || 800) * 0.88) {
          entry.target.classList.remove('is-visible');
        }
      });
    },
    { threshold: 0.08 }
  );
  revealEls.forEach((el) => observer.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add('is-visible'));
}

// Astryx Pointer Specular Spotlight on Monochrome Cards & Stage
if (window.matchMedia('(pointer: fine)').matches && !prefersReducedMotion) {
  document.querySelectorAll('.card, .card-dark').forEach((card) => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      card.style.setProperty('--mx', `${x.toFixed(1)}%`);
      card.style.setProperty('--my', `${y.toFixed(1)}%`);
    });
  });

  if (iphoneTilt && !iphoneTilt.classList.contains('is-3d')) {
    const bezel = iphoneTilt.querySelector('.iphone-bezel');
    iphoneTilt.addEventListener('mousemove', (e) => {
      if (iphoneTilt.classList.contains('is-3d')) return;
      const rect = iphoneTilt.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      iphoneTilt.style.transform = `rotateY(${x * 8}deg) rotateX(${-y * 8}deg)`;
      if (bezel) {
        bezel.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`);
        bezel.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`);
      }
    });
    iphoneTilt.addEventListener('mouseleave', () => {
      iphoneTilt.style.transform = 'rotateY(0deg) rotateX(0deg)';
    });
  }
}

// Astryx AnimatedLayout Edge Reveal for FAQ <details>
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
      anim = body.animate(
        [
          { height: '0px', opacity: 0.001, clipPath: 'inset(0 0 100% 0)' },
          { height: `${fullHeight}px`, opacity: 1, clipPath: 'inset(0 0 0% 0)' },
        ],
        { duration: 340, easing: 'cubic-bezier(0.24, 1, 0.4, 1)' }
      );
      anim.onfinish = () => {
        isExpanding = false;
        anim = null;
        body.style.height = '';
      };
    } else if (isExpanding || details.open) {
      isExpanding = false;
      isClosing = true;
      const startHeight = body.offsetHeight;
      anim = body.animate(
        [
          { height: `${startHeight}px`, opacity: 1, clipPath: 'inset(0 0 0% 0)' },
          { height: '0px', opacity: 0.001, clipPath: 'inset(0 0 100% 0)' },
        ],
        { duration: 210, easing: 'cubic-bezier(0.3, 0, 0.6, 0.6)' }
      );
      anim.onfinish = () => {
        details.open = false;
        isClosing = false;
        anim = null;
      };
    }
  });
});

// Estado en vivo del dock, sincronizado con lo que pasa en el teléfono
function setStageChip(label, done = false) {
  if (!dockStatus) return;
  if (dockStatusStep) dockStatusStep.textContent = label;
  dockStatus.classList.toggle('is-done', done);
}

function appendMessage(html, type = 'bot', extraClass = '') {
  const div = document.createElement('div');
  div.className = `msg msg-${type} ${extraClass}`.trim();
  const checks = type === 'user' ? `<span class="checks">${iconHtml('check-read')}</span>` : '';
  div.innerHTML = `${html}<div class="msg-meta"><span>9:41</span>${checks}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function appendTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'msg msg-bot msg-typing';
  div.setAttribute('aria-label', 'Zaldo está escribiendo');
  div.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
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
    setInputText('Generando cobro CoDi…');
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

      statusEl.textContent = 'esperando confirmación del banco…';
      setInputText('Esperando confirmación bancaria…');
      setStageChip('Esperando pago bancario');

      scheduleDemo(() => {
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
          setInputText('Pago confirmado · Toca para repetir');
          setStageChip('Ya cayó en tu cuenta', true);
        }, 720);
      }, 1650);
    }, 760);
  });

  cancelBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    appendMessage('Cobro cancelado. No se mandó nada.', 'bot');
    setInputText('Cancelado · Toca para repetir o elige otro');
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
    setInputText('Conectando tu CLABE de forma segura…');
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
          setInputText('CLABE conectada · Prueba un cobro a la izquierda');
          setStageChip('CLABE conectada', true);
        }, 740);
      }, 1300);
    }, 780);
  });

  cancelBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    appendMessage('Vinculación cancelada. No se guardó ninguna cuenta.', 'bot');
    setInputText('Cancelado · Toca para repetir');
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
      readyHint: 'Toca Confirmar arriba para conectar la CLABE…',
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
      readyHint: 'Toca Confirmar arriba para probar…',
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
      readyHint: 'Toca Confirmar arriba para generar el QR…',
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
      readyHint: 'Toca Confirmar arriba para crear el link…',
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
    readyHint: 'Saldo al día · Toca para repetir',
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

function finishBotExchange(cfg) {
  statusEl.textContent = 'en línea';
  setInputText(cfg.readyHint);
  scheduleDemo(() => {
    statusEl.textContent = 'escribiendo…';
    const typing = appendTypingIndicator();
    scheduleDemo(() => {
      typing.remove();
      cfg.deliverReply();
      statusEl.textContent = 'en línea';
      setStageChip(cfg.readyChip, Boolean(cfg.doneChip));
    }, 960);
  }, 260);
}

function runTextLiveFlow(cfg) {
  if (prefersReducedMotion) {
    prependChatChrome();
    appendMessage(cfg.userPrompt, 'user');
    cfg.deliverReply();
    setInputText(cfg.readyHint);
    setStageChip(cfg.readyChip, Boolean(cfg.doneChip));
    return;
  }

  appendOpeningSplash(cfg.splash);
  statusEl.textContent = 'abriendo chat…';
  setStageChip(cfg.openingChip);
  setInputText('');

  const splashDelay = 520;
  const steps = 16;
  const stepMs = 95;
  const fullText = cfg.userPrompt;

  scheduleDemo(() => {
    if (composerChrome) {
      composerChrome.classList.add('is-keyboard-open', 'is-typing-send');
    }
    statusEl.textContent = 'en línea';
  }, splashDelay);

  for (let s = 1; s <= steps; s++) {
    scheduleDemo(() => {
      const end = Math.ceil((fullText.length * s) / steps);
      setInputText(fullText.slice(0, end));
      if (kbKeys.length) {
        kbKeys.forEach((k) => k.classList.remove('is-hit'));
        const hitKey = kbKeys[(s * 7) % kbKeys.length];
        if (hitKey) hitKey.classList.add('is-hit');
      }
    }, splashDelay + s * stepMs);
  }

  const typingDoneAt = splashDelay + steps * stepMs;

  scheduleDemo(() => {
    kbKeys.forEach((k) => k.classList.remove('is-hit'));
    if (replayBtn) replayBtn.classList.add('is-tapping');
  }, typingDoneAt + 140);

  scheduleDemo(() => {
    resetComposerState();
    chat.innerHTML = '';
    prependChatChrome();
    appendMessage(cfg.userPrompt, 'user');
    finishBotExchange(cfg);
  }, typingDoneAt + 380);
}

function runVoiceLiveFlow(cfg) {
  if (prefersReducedMotion) {
    prependChatChrome();
    const vnMsg = appendMessage(createVoiceNoteHtml(cfg.voiceTranscript, '0:03'), 'user');
    bindVoiceNotePlayer(vnMsg);
    cfg.deliverReply();
    setInputText(cfg.readyHint);
    setStageChip(cfg.readyChip);
    return;
  }

  appendOpeningSplash(cfg.splash);
  statusEl.textContent = 'abriendo chat…';
  setStageChip(cfg.openingChip);
  setInputText('Mantén presionado para audio…');

  const sendRecordedVoice = () => {
    resetComposerState();
    chat.innerHTML = '';
    prependChatChrome();
    const vnMsg = appendMessage(createVoiceNoteHtml(cfg.voiceTranscript, '0:03'), 'user');
    const startPlayback = bindVoiceNotePlayer(vnMsg);
    scheduleDemo(startPlayback, 260);
    finishBotExchange(cfg);
  };

  sendPendingVoiceFn = () => {
    clearDemoTimers();
    sendRecordedVoice();
  };

  scheduleDemo(() => {
    if (replayBtn) replayBtn.classList.add('is-tapping');
  }, 480);

  scheduleDemo(() => {
    if (replayBtn) replayBtn.classList.remove('is-tapping');
    if (composerChrome) composerChrome.classList.add('is-recording');
    if (iosStatusbar) iosStatusbar.classList.add('is-mic-active');
    if (recTimerEl) recTimerEl.textContent = '0:00';
    setStageChip('Nota de voz 0:00…');
    statusEl.textContent = 'grabando audio…';
  }, 680);

  scheduleDemo(() => { if (recTimerEl) recTimerEl.textContent = '0:01'; setStageChip('Nota de voz 0:01…'); }, 1380);
  scheduleDemo(() => { if (recTimerEl) recTimerEl.textContent = '0:02'; setStageChip('Nota de voz 0:02…'); }, 2080);
  scheduleDemo(() => {
    if (recTimerEl) recTimerEl.textContent = '0:03';
    setStageChip('Nota de voz 0:03…');
    if (recSendBtn) recSendBtn.classList.add('is-tapping');
  }, 2780);

  scheduleDemo(sendRecordedVoice, 3260);
}

function renderPreset(preset) {
  clearDemoTimers();
  activePreset = preset;
  window.dispatchEvent(new CustomEvent('zaldo:preset', { detail: { preset } }));
  chat.innerHTML = '';
  statusEl.textContent = 'en línea';
  const cfg = getPresetConfig(preset);
  if (cfg.mode === 'voice') {
    runVoiceLiveFlow(cfg);
  } else {
    runTextLiveFlow(cfg);
  }
}

if (pickerLens) {
  window.addEventListener('pointerup', () => pickerLens.classList.remove('is-pressing'));
  window.addEventListener('pointercancel', () => pickerLens.classList.remove('is-pressing'));
}

pickerCards.forEach((card) => {
  card.addEventListener('pointerdown', () => {
    if (pickerLens) pickerLens.classList.add('is-pressing');
  });
  card.addEventListener('click', () => selectPreset(card.dataset.preset));
});

// Selector único de escenario: mantiene sincronizados el picker, el dock y el teléfono
function selectPreset(preset, { reveal = false } = {}) {
  pickerCards.forEach((c) => {
    const on = c.dataset.preset === preset;
    c.classList.toggle('active', on);
    c.setAttribute('aria-checked', String(on));
    if (on) movePickerLens(c);
  });
  dockChips.forEach((chip) => {
    const on = chip.dataset.preset === preset;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', String(on));
    if (on && dockChipsWrap && dockChipsWrap.scrollWidth > dockChipsWrap.clientWidth) {
      const left = chip.offsetLeft - (dockChipsWrap.clientWidth - chip.offsetWidth) / 2;
      dockChipsWrap.scrollTo({ left, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    }
  });
  renderPreset(preset);
  if (reveal) revealPhone();
}

// Si el teléfono no se ve completo, hace scroll suave hasta él
function revealPhone() {
  if (!iphoneTilt) return;
  const rect = iphoneTilt.getBoundingClientRect();
  const vh = window.innerHeight || 1;
  const topLimit = navbar ? navbar.offsetHeight : 0;
  const visible = Math.min(rect.bottom, vh) - Math.max(rect.top, topLimit);
  if (visible >= Math.min(rect.height, vh - topLimit) * 0.8) return;
  const target = window.scrollY + rect.top - Math.max(topLimit + 8, (vh - rect.height) / 2);
  window.scrollTo({ top: Math.max(0, target), behavior: prefersReducedMotion ? 'auto' : 'smooth' });
}

dockChips.forEach((chip) => {
  chip.addEventListener('click', () => selectPreset(chip.dataset.preset, { reveal: true }));
});
if (dockReplay) {
  dockReplay.addEventListener('click', () => {
    renderPreset(activePreset);
    revealPhone();
  });
}

if (recSendBtn) {
  recSendBtn.addEventListener('click', () => {
    if (typeof sendPendingVoiceFn === 'function') sendPendingVoiceFn();
  });
}
if (recTrashBtn) {
  recTrashBtn.addEventListener('click', () => {
    clearDemoTimers();
    chat.innerHTML = '';
    prependChatChrome();
    appendMessage('Nota de voz descartada. Toca el micrófono para grabar otra vez.', 'bot');
    statusEl.textContent = 'en línea';
    setInputText('Nota cancelada · Toca para reintentar');
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
    void notice.offsetWidth;
    notice.classList.add('is-highlighted');
    scheduleDemo(() => notice.classList.remove('is-highlighted'), 950);
  });
}

renderPreset('clabe');
