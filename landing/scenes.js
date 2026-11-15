/*
 * Zaldo Motion — motor de composiciones por frame inspirado en Remotion.
 * Cada escena es una función pura de `frame` (0..120 a 60fps) que usa
 * interpolate() y spring() con la misma semántica que Remotion.
 * El frame se sincroniza con el scroll de cada tarjeta y, una vez visible,
 * se reproduce en bucle continuo (y se reinicia al pasar el cursor).
 */
(function () {
  'use strict';

  const FPS = 60;
  const DURATION = 120;
  const SPRING_CONFIG = { damping: 14, stiffness: 120, mass: 1 };

  const Easing = {
    linear: (t) => t,
    in: (t) => t * t * t,
    out: (t) => 1 - Math.pow(1 - t, 3),
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  };

  // interpolate(frame, [0, 60], [0, 1], { extrapolateRight: 'clamp' })
  function interpolate(input, inputRange, outputRange, options) {
    const opts = options || {};
    const left = opts.extrapolateLeft || 'extend';
    const right = opts.extrapolateRight || 'extend';
    let i = 1;
    while (i < inputRange.length - 1 && input > inputRange[i]) i++;
    const inMin = inputRange[i - 1];
    const inMax = inputRange[i];
    const outMin = outputRange[i - 1];
    const outMax = outputRange[i];
    let v = input;
    if (v < inMin) {
      if (left === 'identity') return v;
      if (left === 'clamp') v = inMin;
    }
    if (v > inMax) {
      if (right === 'identity') return v;
      if (right === 'clamp') v = inMax;
    }
    if (outMin === outMax || inMin === inMax) return outMin;
    let t = (v - inMin) / (inMax - inMin);
    if (opts.easing) t = opts.easing(t);
    return outMin + t * (outMax - outMin);
  }

  // spring({ frame, fps, config: { damping, stiffness, mass } }) — solución analítica
  function spring(params) {
    const fps = params.fps || FPS;
    const cfg = params.config || {};
    const damping = cfg.damping === undefined ? 10 : cfg.damping;
    const mass = cfg.mass === undefined ? 1 : cfg.mass;
    const stiffness = cfg.stiffness === undefined ? 100 : cfg.stiffness;
    const from = params.from === undefined ? 0 : params.from;
    const to = params.to === undefined ? 1 : params.to;
    const t = (params.frame - (params.delay || 0)) / fps;
    if (t <= 0) return from;
    const w0 = Math.sqrt(stiffness / mass);
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    const x0 = to - from;
    let rest;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      rest = Math.exp(-zeta * w0 * t) * (x0 * Math.cos(wd * t) + ((zeta * w0 * x0) / wd) * Math.sin(wd * t));
    } else {
      rest = Math.exp(-w0 * t) * (x0 + w0 * x0 * t);
    }
    let v = to - rest;
    if (cfg.overshootClamping) v = to >= from ? Math.min(v, to) : Math.max(v, to);
    return v;
  }

  window.ZaldoMotion = { interpolate, spring, Easing, FPS, DURATION };

  // Atajos de composición
  const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
  const I = (f, a, b, from, to, easing) =>
    interpolate(f, [a, b], [from === undefined ? 0 : from, to === undefined ? 1 : to], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing,
    });
  const S = (f, delay) => spring({ frame: f, fps: FPS, delay: delay || 0, config: SPRING_CONFIG });
  const mix = (a, b, t) => a + (b - a) * t;
  const icon = (name) => (window.REICONS && window.REICONS[name]) || '';
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US') + '.00';

  const CLABE = '012180015482930417';

  const SCENES = {
    // 1 · Los 18 dígitos de tu cuenta bancaria (no tarjeta) se guardan en un solo sello
    clabe: {
      html() {
        const digits = CLABE.split('')
          .map((d, i) => `<span class="${i === 3 || i === 6 || i === 17 ? 'gap' : ''}">${d}</span>`)
          .join('');
        return `
          <div class="s1-card" data-r="card">
            <div class="s1-card-top">
              <div class="s1-acct-head">
                <span class="s1-bank">${icon('bank')}</span>
                <div class="s1-acct-meta">
                  <strong>Estado de cuenta</strong>
                  <span>SPEI · CoDi Banxico</span>
                </div>
              </div>
              <span class="s1-acct-pill">18 dígitos</span>
            </div>
            <div class="s1-acct-box">
              <div class="s1-label">CLABE interbancaria</div>
              <div class="s1-digits" data-r="digits">${digits}</div>
            </div>
            <div class="s1-acct-foot">
              <span class="s1-name">Titular: <b>Ana López</b></span>
              <span class="s1-copy-tag">Copiar CLABE</span>
            </div>
          </div>
          <div class="s1-seal" data-r="seal">
            <div class="s1-orb">
              <svg class="s1-ring" viewBox="0 0 100 100" data-r="ring"><circle cx="50" cy="50" r="47" pathLength="1"/></svg>
              <img src="assets/zaldo-cube.png" width="44" height="44" decoding="async" alt="" data-r="cube" />
              <span class="s1-check" data-r="check">${icon('check-circle-filled')}</span>
            </div>
            <div class="s1-seal-text" data-r="text"><strong>CLABE guardada</strong><span>1 vez</span></div>
          </div>
          <div class="s1-sweep" data-r="sweep"></div>`;
      },
      setup(r) {
        r.digitEls = Array.from(r.digits.children);
        r.ringCircle = r.ring.querySelector('circle');
      },
      render(f, r) {
        const enter = S(f, 0);
        const flat = I(f, 44, 58, 0, 1, Easing.inOut);
        const wipe = I(f, 58, 92, 0, 100, Easing.inOut);
        r.card.style.opacity = I(f, 0, 8);
        r.card.style.transform = `translate3d(0, ${mix(26, 0, enter).toFixed(2)}px, 0) rotate(${(mix(-7, -3, enter) * (1 - flat)).toFixed(2)}deg)`;
        const cardClip = wipe > 0 ? `inset(0 0 0 ${wipe.toFixed(1)}%)` : 'none';
        if (cardClip !== r._cardClip) {
          r._cardClip = cardClip;
          r.card.style.clipPath = cardClip;
        }
        r.digitEls.forEach((el, i) => {
          const p = I(f, 2 + i * 1.1, 7 + i * 1.1);
          el.style.opacity = mix(0.32, 1, p);
          el.style.transform = `translate3d(0, ${((1 - p) * 4).toFixed(2)}px, 0)`;
        });

        const sealClip = wipe < 100 ? `inset(0 ${(100 - wipe).toFixed(1)}% 0 0)` : 'none';
        if (sealClip !== r._sealClip) {
          r._sealClip = sealClip;
          r.seal.style.clipPath = sealClip;
        }
        r.seal.style.opacity = wipe > 0 ? 1 : 0;
        r.sweep.style.transform = `translate3d(${((wipe / 100) * 274).toFixed(1)}px, 0, 0)`;
        r.sweep.style.opacity = interpolate(f, [56, 62, 88, 94], [0, 1, 1, 0], CLAMP);

        const pop = S(f, 86);
        const cs = mix(0.86, 1, pop).toFixed(3);
        r.cube.style.transform = `scale3d(${cs}, ${cs}, 1) translate3d(0, ${(Math.sin((f / DURATION) * Math.PI * 2) * 1.5).toFixed(2)}px, 0)`;
        r.ringCircle.style.strokeDashoffset = 1 - I(f, 82, 112, 0, 1, Easing.out);
        r.ring.style.transform = `rotate(${(-90 + f * 0.6).toFixed(1)}deg)`;
        const ch = S(f, 94).toFixed(3);
        r.check.style.transform = `scale3d(${ch}, ${ch}, 1)`;
        const tp = I(f, 92, 106, 0, 1, Easing.out);
        r.text.style.opacity = tp;
        r.text.style.transform = `translate3d(0, ${((1 - tp) * 8).toFixed(2)}px, 0)`;
      },
    },

    // 2 · El comprobante dudoso se va; llega el aviso real con el saldo subiendo
    verified: {
      html() {
        return `
          <div class="s2-receipt" data-r="receipt">
            <div class="s2-r-head"><i></i><span>Comprobante</span></div>
            <div class="s2-r-amount">$350.00</div>
            <div class="s2-r-lines"><i></i><i></i><i></i><i></i></div>
            <div class="s2-r-tag" data-r="tag">Captura sin confirmar</div>
          </div>
          <div class="s2-notif" data-r="notif">
            <span class="s2-n-icon">${icon('whatsapp')}</span>
            <div class="s2-n-body">
              <div class="s2-n-top"><strong>Zaldo</strong><span>ahora</span></div>
              <div class="s2-n-msg">¡Ya cayó! <b>$350.00 MXN</b></div>
            </div>
            <span class="s2-n-check" data-r="ncheck">${icon('check-circle-filled')}</span>
          </div>
          <div class="s2-chart" data-r="chart">
            <div class="s2-c-head"><span>Tu saldo de hoy</span><strong data-r="total">$1,380.00</strong></div>
            <svg viewBox="0 0 268 56" preserveAspectRatio="none">
              <defs><linearGradient id="s2-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#0a0a0c" stop-opacity="0.14"/><stop offset="1" stop-color="#0a0a0c" stop-opacity="0"/>
              </linearGradient></defs>
              <path class="s2-area" data-r="area" d="M2 50 C40 48 56 40 86 38 S136 34 160 26 S214 22 232 10 L266 5 L266 56 L2 56 Z" fill="url(#s2-fill)"/>
              <path class="s2-line" data-r="line" pathLength="1" d="M2 50 C40 48 56 40 86 38 S136 34 160 26 S214 22 232 10 L266 5"/>
            </svg>
            <span class="s2-dot" data-r="dot"></span>
          </div>`;
      },
      render(f, r) {
        const enter = S(f, 0);
        const out = I(f, 30, 60, 0, 1, Easing.in);
        r.receipt.style.opacity = I(f, 0, 8) * (1 - out);
        const rFilter = out > 0.02 && out < 0.99 ? `blur(${(Math.round(mix(0.6, 9, out) * 2) / 2).toFixed(1)}px)` : 'none';
        if (rFilter !== r._rFilter) {
          r._rFilter = rFilter;
          r.receipt.style.filter = rFilter;
        }
        const rs = (1 - out * 0.08).toFixed(3);
        r.receipt.style.transform = `translate3d(0, ${(mix(22, 0, enter) + out * 14).toFixed(2)}px, 0) rotate(${mix(-9, -5, enter).toFixed(2)}deg) scale3d(${rs}, ${rs}, 1)`;
        r.tag.style.opacity = I(f, 14, 24);

        const drop = S(f, 46);
        r.notif.style.opacity = I(f, 46, 54);
        const ns = mix(0.9, 1, drop).toFixed(3);
        r.notif.style.transform = `translate3d(0, ${mix(-70, 0, drop).toFixed(2)}px, 0) scale3d(${ns}, ${ns}, 1)`;
        const nc = S(f, 62).toFixed(3);
        r.ncheck.style.transform = `scale3d(${nc}, ${nc}, 1)`;

        const cp = I(f, 54, 70, 0, 1, Easing.out);
        r.chart.style.opacity = cp;
        r.chart.style.transform = `translate3d(0, ${((1 - cp) * 18).toFixed(2)}px, 0)`;
        const draw = I(f, 62, 110, 0, 1, Easing.inOut);
        r.line.style.strokeDashoffset = 1 - draw;
        r.area.style.opacity = I(f, 84, 112);
        setText(r.total, money(mix(1380, 1730, I(f, 66, 110, 0, 1, Easing.out))));
        const ds = S(f, 104).toFixed(3);
        r.dot.style.transform = `scale3d(${ds}, ${ds}, 1)`;
      },
    },

    // 3 · Las apps y formularios desaparecen; solo quedan WhatsApp y Zaldo
    'zero-install': {
      html() {
        const tiles = [
          ['notebook', -178, -48],
          ['card', -72, -80],
          ['bank', 72, -80],
          ['store', 178, -48],
          ['user', -160, 50],
          ['link', 160, 50],
        ]
          .map(([name, x, y], i) => `<span class="s3-tile" data-x="${x}" data-y="${y}" data-i="${i}">${icon(name)}<i></i></span>`)
          .join('');
        return `
          ${tiles}
          <span class="s3-halo" data-r="halo"></span>
          <div class="s3-duo" data-r="duo">
            <span class="s3-app s3-wa" data-r="wa">${icon('whatsapp')}</span>
            <span class="s3-app s3-z" data-r="z"><img src="assets/zaldo-cube.png" width="44" height="44" decoding="async" alt="" /></span>
          </div>
          <div class="s3-label" data-r="label">${icon('check-circle-filled')}<span>Solo tu WhatsApp</span></div>`;
      },
      setup(r, root) {
        r.tiles = Array.from(root.querySelectorAll('.s3-tile')).map((el) => ({
          el,
          x: Number(el.dataset.x),
          y: Number(el.dataset.y),
          i: Number(el.dataset.i),
          lastFilter: '',
        }));
      },
      render(f, r) {
        const order = [0, 3, 4, 1, 5, 2];
        r.tiles.forEach((t) => {
          const k = order.indexOf(t.i);
          const pop = S(f, k * 2);
          const out = I(f, 30 + k * 7, 54 + k * 7, 0, 1, Easing.in);
          const spread = 1 + out * 0.32;
          t.el.style.opacity = Math.min(1, pop * 1.4) * (1 - out);
          const flt = out > 0.02 && out < 0.99 ? `blur(${(Math.round(out * 10) / 2).toFixed(1)}px)` : 'none';
          if (flt !== t.lastFilter) {
            t.lastFilter = flt;
            t.el.style.filter = flt;
          }
          const ts = (mix(0.5, 1, pop) * (1 - out * 0.45)).toFixed(3);
          t.el.style.transform = `translate3d(${(t.x * spread).toFixed(1)}px, ${(t.y * spread + out * 10).toFixed(1)}px, 0) scale3d(${ts}, ${ts}, 1) rotate(${(out * (t.x > 0 ? 16 : -16)).toFixed(1)}deg)`;
        });

        const join = S(f, 72);
        const gap = mix(22, 7, join).toFixed(2);
        const ds = mix(0.8, 1, join).toFixed(3);
        r.duo.style.opacity = mix(0.42, 1, I(f, 60, 80));
        r.duo.style.transform = `scale3d(${ds}, ${ds}, 1)`;
        r.wa.style.transform = `translate3d(-${gap}px, 0, 0) rotate(${mix(-6, 0, join).toFixed(2)}deg)`;
        r.z.style.transform = `translate3d(${gap}px, 0, 0) rotate(${mix(6, 0, join).toFixed(2)}deg)`;
        const hp = I(f, 74, 110, 0, 1, Easing.out);
        r.halo.style.opacity = hp > 0 ? (1 - hp) * 0.55 : 0;
        const hs = mix(0.6, 1.7, hp).toFixed(3);
        r.halo.style.transform = `scale3d(${hs}, ${hs}, 1)`;
        const lp = S(f, 92);
        r.label.style.opacity = I(f, 92, 102);
        r.label.style.transform = `translate3d(0, ${mix(12, 0, lp).toFixed(2)}px, 0)`;
      },
    },

    // 4 · Candado blindado + flujo: tu celular vinculado -> confirmar cobro
    security: {
      html() {
        return `
          <span class="s4-glow"></span>
          <img class="s4-cube" src="assets/zaldo-cube.png" width="46" height="46" decoding="async" alt="" data-r="cube" />
          <svg class="s4-link" viewBox="0 0 90 8" data-r="link"><path d="M2 4 H88" pathLength="1"/></svg>
          <div class="s4-lock" data-r="lock">
            <span class="s4-pulse" data-r="pulse"></span>
            <svg viewBox="0 0 96 96">
              <path class="s4-shield" data-r="shield" pathLength="1" d="M48 6 L84 19 V46 C84 68 68.5 83.5 48 90 C27.500 83.5 12 68 12 46 V19 Z"/>
              <path class="s4-shackle" data-r="shackle" d="M38 44 V36 a10 10 0 0 1 20 0 V44"/>
              <rect class="s4-body" x="31" y="43" width="34" height="27" rx="7"/>
              <circle class="s4-key" data-r="key" cx="48" cy="54.5" r="3.6"/>
              <rect class="s4-key" data-r="keystem" x="46.600" y="56" width="2.8" height="7.5" rx="1.4"/>
            </svg>
            <span class="s4-badge" data-r="badge">${icon('check-circle-filled')}</span>
          </div>
          <div class="s4-flow">
            <span class="s4-pill" data-r="p1">${icon('whatsapp')}<span>Tu celular vinculado</span></span>
            <span class="s4-arrow" data-r="arrow"><i data-r="arrowline"></i>${icon('arrow-right')}</span>
            <span class="s4-pill s4-pill-ok" data-r="p2">${icon('check-circle')}<span>Confirmar cobro</span></span>
          </div>`;
      },
      render(f, r) {
        const cubeIn = S(f, 0);
        r.cube.style.opacity = I(f, 0, 10);
        const cs = mix(0.78, 1, cubeIn).toFixed(3);
        r.cube.style.transform = `translate3d(0, ${(Math.sin((f / DURATION) * Math.PI * 2) * 3).toFixed(2)}px, 0) scale3d(${cs}, ${cs}, 1) rotate(${mix(-10, 0, cubeIn).toFixed(2)}deg)`;

        r.link.style.opacity = I(f, 18, 24);
        r.link.firstElementChild.style.strokeDashoffset = 1 - I(f, 18, 42, 0, 1, Easing.inOut);

        r.lock.style.opacity = I(f, 12, 22);
        const ls = mix(0.84, 1, S(f, 12)).toFixed(3);
        r.lock.style.transform = `scale3d(${ls}, ${ls}, 1)`;
        r.shield.style.strokeDashoffset = 1 - I(f, 14, 50, 0, 1, Easing.inOut);
        const close = S(f, 48);
        r.shackle.style.transform = `translate3d(0, ${mix(-8, 0, close).toFixed(2)}px, 0) rotate(${mix(-24, 0, close).toFixed(2)}deg)`;
        const armed = I(f, 54, 64);
        r.key.style.opacity = armed;
        r.keystem.style.opacity = armed;
        const pp = I(f, 54, 86, 0, 1, Easing.out);
        r.pulse.style.opacity = pp > 0 ? (1 - pp) * 0.5 : 0;
        const ps = mix(0.7, 1.55, pp).toFixed(3);
        r.pulse.style.transform = `scale3d(${ps}, ${ps}, 1)`;
        const bs = S(f, 60).toFixed(3);
        r.badge.style.transform = `scale3d(${bs}, ${bs}, 1)`;

        const a = S(f, 62);
        r.p1.style.opacity = I(f, 62, 70);
        r.p1.style.transform = `translate3d(${mix(-18, 0, a).toFixed(2)}px, 0, 0)`;
        const ar = I(f, 74, 92, 0, 1, Easing.inOut);
        r.arrow.style.opacity = I(f, 74, 80);
        r.arrowline.style.transform = `scale3d(${ar.toFixed(3)}, 1, 1)`;
        const b = S(f, 86);
        r.p2.style.opacity = I(f, 86, 94);
        const p2s = mix(0.94, 1, b).toFixed(3);
        r.p2.style.transform = `translate3d(${mix(18, 0, b).toFixed(2)}px, 0, 0) scale3d(${p2s}, ${p2s}, 1)`;
        const ok = I(f, 100, 114).toFixed(3);
        if (ok !== r._ok) {
          r._ok = ok;
          r.p2.style.setProperty('--ok', ok);
        }
      },
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // #como-funciona — 4 pasos conectados. Un solo timeline maestro (4 x 120 frames)
  // recorre los pasos en orden: cada escena se reproduce cuando le toca y, al
  // concluir, ilumina el tramo del riel hacia el siguiente nodo.
  // ───────────────────────────────────────────────────────────────────────────
  const STEP_SCENES = {
    // Paso 1 · mensaje con los 18 dígitos -> chip «CLABE conectada»
    'step-clabe': {
      html() {
        return `
          <div class="st-bubble st-out st1-bubble" data-r="bubble">
            <div class="st1-digits">012 180 015482930417</div>
            <div class="st1-name">Ana López</div>
            <div class="st-meta"><span>9:41</span><span class="st-ticks" data-r="ticks">${icon('check-read')}</span></div>
          </div>
          <div class="st1-chip" data-r="chip">
            <img src="assets/zaldo-cube.png" width="28" height="28" decoding="async" alt="" />
            <div class="st1-chip-text"><strong>CLABE ····30417</strong><span data-r="status">por conectar</span></div>
            <span class="st1-check" data-r="check">${icon('check-circle-filled')}</span>
          </div>`;
      },
      render(f, r) {
        const send = S(f, 8);
        r.bubble.style.opacity = mix(0.5, 1, I(f, 8, 18));
        const bs = mix(0.96, 1, send).toFixed(3);
        r.bubble.style.transform = `translate3d(0, ${mix(16, 0, send).toFixed(2)}px, 0) scale3d(${bs}, ${bs}, 1)`;
        const tickColor = f >= 36 ? '#53bdeb' : 'rgba(255, 255, 255, 0.55)';
        if (tickColor !== r._tickColor) {
          r._tickColor = tickColor;
          r.ticks.style.color = tickColor;
        }

        const land = S(f, 54);
        r.chip.style.opacity = mix(0.4, 1, I(f, 54, 66));
        const cs = mix(0.97, 1, land).toFixed(3);
        r.chip.style.transform = `translate3d(0, ${mix(8, 0, land).toFixed(2)}px, 0) scale3d(${cs}, ${cs}, 1)`;
        const ok = I(f, 72, 94).toFixed(3);
        if (ok !== r._ok) {
          r._ok = ok;
          r.chip.style.setProperty('--ok', ok);
        }
        setText(r.status, f >= 72 ? 'conectada' : 'por conectar');
        const ch = S(f, 74).toFixed(3);
        r.check.style.transform = `scale3d(${ch}, ${ch}, 1)`;
      },
    },

    // Paso 2 · nota de voz con ondas + toque en «Confirmar»
    'step-voz': {
      heights: [6, 11, 16, 9, 14, 20, 8, 13, 18, 15, 7, 12, 17, 10, 20, 13, 8, 15, 11, 9, 14, 7],
      html() {
        return `
          <div class="st-bubble st-out st2-voice" data-r="voice">
            <div class="st2-row">
              <span class="st2-play">${icon('play')}</span>
              <div class="st2-bars" data-r="bars">${this.heights.map(() => '<i></i>').join('')}</div>
              <span class="st2-time">0:03</span>
            </div>
            <div class="st2-quote">«Cóbrale $350 a Sofi»</div>
          </div>
          <div class="st-bubble st-in st2-card" data-r="card">
            <div class="st2-amt"><strong>$350.00</strong><span>para Sofi</span></div>
            <div class="st2-actions">
              <span class="st2-btn" data-r="btn">${icon('check-circle')}<b data-r="label">Confirmar</b></span>
              <span class="st2-btn-ghost">Cancelar</span>
            </div>
            <span class="st2-tap" data-r="tap"></span>
          </div>`;
      },
      setup(r) {
        r.barEls = Array.from(r.bars.children);
        r.barEls.forEach((el, i) => {
          el.style.height = `${this.heights[i]}px`;
        });
      },
      render(f, r) {
        r.voice.style.opacity = mix(0.55, 1, I(f, 0, 10));
        const head = I(f, 8, 58) * this.heights.length;
        const playing = f > 8 && f < 58;
        r.barEls.forEach((el, i) => {
          const wobble = playing ? (1 + 0.3 * Math.sin(f * 0.45 + i * 1.3)).toFixed(3) : '1';
          el.style.transform = wobble !== '1' ? `scale3d(1, ${wobble}, 1)` : 'none';
          el.style.opacity = i < head ? 1 : 0.38;
        });

        const land = S(f, 56);
        r.card.style.opacity = mix(0.36, 1, I(f, 56, 68));
        r.card.style.transform = `translate3d(0, ${mix(10, 0, land).toFixed(2)}px, 0)`;

        const press = interpolate(f, [84, 90, 100], [0, 1, 0], CLAMP);
        const bs = (1 - press * 0.07).toFixed(3);
        r.btn.style.transform = `scale3d(${bs}, ${bs}, 1)`;
        const ok = I(f, 92, 106).toFixed(3);
        if (ok !== r._ok) {
          r._ok = ok;
          r.btn.style.setProperty('--ok', ok);
        }
        setText(r.label, f >= 94 ? 'Confirmado' : 'Confirmar');
        const ring = I(f, 86, 110, 0, 1, Easing.out);
        r.tap.style.opacity = ring > 0 && ring < 1 ? (1 - ring) * 0.85 : 0;
        const ts = mix(0.3, 1.7, ring).toFixed(3);
        r.tap.style.transform = `scale3d(${ts}, ${ts}, 1)`;
      },
    },

    // Paso 3 · QR real con barrido de escaneo -> «Aprobado en su banco»
    'step-pago': {
      html() {
        return `
          <div class="st3-qr" data-r="qr">
            <img src="assets/qr-ejemplo.png" width="183" height="184" decoding="async" alt="" />
            <span class="st3-scan" data-r="scan"></span>
          </div>
          <div class="st3-info">
            <span class="st3-pill">CoDi · SPEI</span>
            <strong class="st3-amt">$350.00</strong>
            <span class="st3-status" data-r="status">
              <span class="st3-mark"><span class="st3-dot" data-r="dot"></span><span class="st3-check" data-r="check">${icon('check-circle-filled')}</span></span>
              <b data-r="label">Esperando pago</b>
            </span>
          </div>
          <div class="st3-flow">
            <span class="st3-end">${icon('bank')}Su banco</span>
            <span class="st3-track" data-r="track"><i data-r="fill"></i><em data-r="coin"></em></span>
            <span class="st3-end"><img src="assets/zaldo-cube.png" width="18" height="18" decoding="async" alt="" />Tu cuenta</span>
          </div>`;
      },
      render(f, r) {
        r.qr.style.opacity = mix(0.62, 1, I(f, 4, 14));
        r.scan.style.transform = `translate3d(0, ${interpolate(f, [10, 40, 70], [0, 96, 0], { ...CLAMP, easing: Easing.inOut }).toFixed(2)}px, 0)`;
        r.scan.style.opacity = interpolate(f, [8, 14, 66, 74], [0, 1, 1, 0], CLAMP);

        const ok = f >= 76;
        setText(r.label, ok ? 'Aprobado en su banco' : 'Esperando pago');
        const stOk = I(f, 76, 92).toFixed(3);
        if (stOk !== r._ok) {
          r._ok = stOk;
          r.status.style.setProperty('--ok', stOk);
        }
        r.dot.style.opacity = ok ? 0 : 0.55 + 0.45 * Math.sin(f * 0.28);
        const cs = S(f, 76).toFixed(3);
        r.check.style.transform = `scale3d(${cs}, ${cs}, 1)`;

        const go = I(f, 84, 116, 0, 1, Easing.inOut);
        r.fill.style.transform = `scale3d(${go.toFixed(3)}, 1, 1)`;
        r.coin.style.transform = `translate3d(${(go * (r.trackWidth || 0)).toFixed(2)}px, 0, 0)`;
        r.coin.style.opacity = interpolate(f, [84, 88, 112, 118], [0, 1, 1, 0], CLAMP);
      },
    },

    // Paso 4 · notificación «¡Ya cayó!» y saldo subiendo
    'step-cayo': {
      bars: [0.34, 0.5, 0.42, 0.62, 0.55, 0.7, 1],
      html() {
        return `
          <span class="st4-halo" data-r="halo"></span>
          <div class="st4-ghost" data-r="ghost">Esperando el pago</div>
          <div class="st4-notif" data-r="notif">
            <span class="st4-icon">${icon('whatsapp')}</span>
            <div class="st4-body">
              <div class="st4-top"><strong>Zaldo</strong><span>ahora</span></div>
              <div class="st4-msg"><span class="st4-badge" data-r="badge">${icon('check-circle-filled')}¡Ya cayó!</span><b>+$350.00 MXN</b></div>
            </div>
          </div>
          <div class="st4-balance">
            <span>Tu saldo de hoy</span>
            <div class="st4-total"><strong data-r="total">$1,380.00</strong><em data-r="delta">+$350.00</em></div>
            <div class="st4-bars" data-r="bars">${this.bars.map(() => '<i></i>').join('')}</div>
          </div>`;
      },
      setup(r) {
        r.barEls = Array.from(r.bars.children);
        r.barEls.forEach((el, i) => {
          el.style.height = `${Math.round(this.bars[i] * 26)}px`;
        });
      },
      render(f, r) {
        const drop = S(f, 10);
        r.ghost.style.opacity = 1 - I(f, 6, 16);
        r.notif.style.opacity = I(f, 10, 18);
        const ns = mix(0.92, 1, drop).toFixed(3);
        r.notif.style.transform = `translate3d(0, ${mix(-46, 0, drop).toFixed(2)}px, 0) scale3d(${ns}, ${ns}, 1)`;
        const bs = mix(0.6, 1, S(f, 30)).toFixed(3);
        r.badge.style.transform = `scale3d(${bs}, ${bs}, 1)`;
        r.halo.style.opacity = I(f, 26, 70);

        const rise = I(f, 50, 110, 0, 1, Easing.out);
        setText(r.total, money(mix(1380, 1730, rise)));
        const dp = I(f, 46, 58, 0, 1, Easing.out);
        r.delta.style.opacity = dp;
        r.delta.style.transform = `translate3d(0, ${((1 - dp) * 6).toFixed(2)}px, 0)`;
        r.barEls[r.barEls.length - 1].style.transform = `scale3d(1, ${mix(0.5, 1, rise).toFixed(3)}, 1)`;
      },
    },
  };

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  (function initHowFlow() {
    const flow = document.getElementById('how-flow');
    const section = document.getElementById('como-funciona');
    if (!flow || !section) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const steps = Array.from(flow.querySelectorAll('.how-step'))
      .map((el) => {
        const stage = el.querySelector('.step-stage[data-scene]');
        const def = stage && STEP_SCENES[stage.dataset.scene];
        if (!def) return null;
        const root = document.createElement('div');
        root.className = `scene scene-step scene-${stage.dataset.scene}`;
        root.innerHTML = def.html();
        stage.appendChild(root);
        const refs = {};
        root.querySelectorAll('[data-r]').forEach((node) => {
          refs[node.dataset.r] = node;
        });
        if (def.setup) def.setup(refs, root);
        return { el, stage, root, def, refs, shown: -1, width: 0, state: '', docTop: 0, lastSeg: '' };
      })
      .filter(Boolean);
    if (!steps.length) return;

    const SEG = DURATION;
    const TOTAL = SEG * steps.length;
    const PLAY = 0.5; // 120 frames en ~4 s por paso: pausado, sin prisa
    const HOLD = 300; // sostiene el desenlace ~5 s
    const REST = 50;
    let lastFlowT = '';

    function apply(T) {
      steps.forEach((s, i) => {
        const f = Math.min(SEG, Math.max(0, T - i * SEG));
        const q = Math.round(f * 4) / 4;
        if (q !== s.shown) {
          s.shown = q;
          s.def.render(q, s.refs);
          s.stage.dataset.frame = String(Math.round(q));
          const seg = I(q, 72, 118, 0, 1, Easing.inOut).toFixed(3);
          if (seg !== s.lastSeg) {
            s.lastSeg = seg;
            s.el.style.setProperty('--seg', seg);
          }
        }
        const lit = T > 0.5 && T >= i * SEG;
        const done = T >= (i + 1) * SEG - 0.5;
        const state = `${lit ? 'L' : ''}${lit && !done ? 'A' : ''}${done ? 'D' : ''}`;
        if (state !== s.state) {
          s.state = state;
          s.el.classList.toggle('is-lit', lit);
          s.el.classList.toggle('is-active', lit && !done);
          s.el.classList.toggle('is-done', done);
        }
      });
      const roundedT = String(Math.round(T));
      if (roundedT !== lastFlowT) {
        lastFlowT = roundedT;
        flow.dataset.t = roundedT;
      }
    }

    let cachedVh = window.innerHeight || 1;
    let stacked = false;
    let flowDocTop = 0;
    let flowHeight = 400;

    function fit() {
      cachedVh = window.innerHeight || 1;
      const sy = window.scrollY || 0;
      const fRect = flow.getBoundingClientRect();
      flowDocTop = fRect.top + sy;
      flowHeight = fRect.height || 400;
      stacked = steps.length > 1 && steps[1].el.offsetTop > steps[0].el.offsetTop + 10;
      steps.forEach((s) => {
        const w = s.stage.clientWidth;
        if (w && w !== s.width) {
          s.width = w;
          s.root.style.setProperty('--scene-s', (w / 300).toFixed(4));
        }
        if (s.refs.track) {
          s.refs.trackWidth = s.refs.track.clientWidth || 100;
        }
        s.docTop = s.el.getBoundingClientRect().top + sy;
      });
    }
    fit();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(fit);
      ro.observe(document.body);
      steps.forEach((s) => ro.observe(s.stage));
    } else {
      window.addEventListener('resize', fit, { passive: true });
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fit);
    }
    window.addEventListener('load', fit, { once: true });

    if (reduce) {
      apply(TOTAL);
      return;
    }
    apply(0);

    let T = 0;
    let phase = 'play';
    let phaseClock = 0;
    let hoverAuto = false;
    let raf = 0;
    let last = 0;
    let visible = false;
    let lastY = window.scrollY || 0;
    let scrolledAt = -1e9;

    window.addEventListener(
      'scroll',
      () => {
        const y = window.scrollY || 0;
        if (Math.abs(y - lastY) > 0.5) {
          lastY = y;
          scrolledAt = performance.now();
          hoverAuto = false;
        }
      },
      { passive: true }
    );

    // Hover: resalta ese paso y lo reproduce desde su inicio
    steps.forEach((s, i) => {
      s.el.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse') return;
        T = i * SEG + 1;
        phase = 'play';
        hoverAuto = true;
      });
    });

    const clamp01 = (v) => Math.min(1, Math.max(0, v));

    // A dónde debería ir el timeline según la posición de scroll (cero reflows en rAF)
    function scrollTarget(vh, sy) {
      if (stacked) {
        // En columna: cada tarjeta avanza su paso al cruzar la zona media de la pantalla
        for (let i = 0; i < steps.length; i++) {
          const top = steps[i].docTop - sy;
          const q = clamp01((vh * 0.8 - top) / (vh * 0.45));
          if (q < 1) return i * SEG + q * SEG;
        }
        return TOTAL;
      }
      const rectTop = flowDocTop - sy;
      return clamp01((vh * 0.86 - rectTop) / (flowHeight + vh * 0.1)) * TOTAL;
    }

    function tick(now) {
      raf = 0;
      const dt = Math.min(4, last ? (now - last) / (1000 / FPS) : 1);
      last = now;
      const sy = lastY;
      const scrolling = now - scrolledAt < 260;
      const target = scrollTarget(cachedVh, sy);
      const settled = target >= TOTAL * 0.3;

      if (!stacked && (hoverAuto || (!scrolling && settled))) {
        // Escritorio en reposo: reproducción continua 1 -> 4, sostiene y reinicia
        if (phase === 'play') {
          T += PLAY * dt;
          if (T >= TOTAL) {
            T = TOTAL;
            phase = 'hold';
            phaseClock = 0;
          }
        } else if (phase === 'hold') {
          phaseClock += dt;
          if (phaseClock > HOLD) phase = 'rewind';
        } else if (phase === 'rewind') {
          T -= 14 * dt;
          if (T <= 0) {
            T = 0;
            phase = 'rest';
            phaseClock = 0;
          }
        } else {
          phaseClock += dt;
          if (phaseClock > REST) phase = 'play';
        }
      } else {
        // El scroll dirige el avance, con velocidad acotada para que nunca se sienta brusco
        phase = 'play';
        const delta = target - T;
        T += Math.max(-5 * dt, Math.min((stacked ? 0.9 : 1.5) * dt, delta));
      }
      apply(T);
      if (visible && !document.hidden) raf = requestAnimationFrame(tick);
    }

    function start() {
      if (!raf && visible && !document.hidden) {
        last = 0;
        raf = requestAnimationFrame(tick);
      }
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(
        (entries) => {
          visible = entries[0].isIntersecting;
          start();
        },
        { rootMargin: '80px 0px' }
      ).observe(section);
    } else {
      visible = true;
      start();
    }
    document.addEventListener('visibilitychange', start);
  })();

  // Línea de tiempo en bucle pausado: reproducir lento -> sostener estado inicial -> sostener estado final -> rebobinar suave
  const PLAY_SPEED = 0.42; // ~2.4x más lento para apreciar cada detalle ("antes" y "después")
  const HOLD = 135;        // ~5.3 segundos sosteniendo el resultado final
  const REWIND = 46;       // rebobinado suave de regreso al estado inicial
  const REST = 68;         // ~2.7 segundos sosteniendo la imagen inicial ("antes") antes de volver a transformar
  const MIN_FRAME = 22;    // Nunca caer en 0 (cuadro vacío): siempre mantener visible la imagen inicial ("antes") con los 18 dígitos completos
  const LOOP = DURATION + HOLD + REWIND + REST;
  function loopFrame(clock) {
    if (clock < MIN_FRAME) return MIN_FRAME;
    if (clock < DURATION) return clock;
    if (clock < DURATION + HOLD) return DURATION;
    if (clock < DURATION + HOLD + REWIND) {
      return interpolate(clock, [DURATION + HOLD, DURATION + HOLD + REWIND], [DURATION, MIN_FRAME], { easing: Easing.inOut });
    }
    return MIN_FRAME;
  }

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const players = [];

  document.querySelectorAll('.prob-stage[data-scene]').forEach((stage) => {
    const def = SCENES[stage.dataset.scene];
    if (!def) return;
    const root = document.createElement('div');
    root.className = `scene scene-${stage.dataset.scene}`;
    root.innerHTML = def.html();
    stage.appendChild(root);

    const refs = {};
    root.querySelectorAll('[data-r]').forEach((el) => {
      refs[el.dataset.r] = el;
    });
    if (def.setup) def.setup(refs, root);

    const player = { stage, root, def, refs, frame: -1, shown: -1, clock: 0, playing: false, scale: 0, docTop: 0, height: 260 };
    player.draw = (frame) => {
      const q = Math.round(frame * 4) / 4;
      if (q === player.shown) return;
      player.shown = q;
      def.render(q, refs);
      stage.dataset.frame = String(Math.round(q));
    };
    const card = stage.closest('.prob-card') || stage;
    card.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse' && player.playing) player.clock = MIN_FRAME;
    });
    players.push(player);
    player.draw(reduceMotion ? DURATION : MIN_FRAME);
  });

  if (!players.length) return;

  let cachedVh = window.innerHeight || 1;
  function fitScenes() {
    cachedVh = window.innerHeight || 1;
    const sy = window.scrollY || 0;
    players.forEach((p) => {
      const rect = p.stage.getBoundingClientRect();
      p.docTop = rect.top + sy;
      p.height = rect.height || 260;
      const w = Math.round(rect.width);
      if (w && w !== p.scale) {
        p.scale = w;
        p.root.style.setProperty('--scene-s', (w / 480).toFixed(4));
      }
    });
  }
  fitScenes();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(fitScenes);
    ro.observe(document.body);
    players.forEach((p) => ro.observe(p.stage));
  } else {
    window.addEventListener('resize', fitScenes, { passive: true });
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(fitScenes);
  }
  window.addEventListener('load', fitScenes, { once: true });

  if (reduceMotion) return;

  let raf = 0;
  let last = 0;
  let sectionVisible = false;
  let lastScrollY = window.scrollY || 0;
  let lastScrollAt = 0;

  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY || 0;
      if (Math.abs(y - lastScrollY) > 0.5) {
        lastScrollY = y;
        lastScrollAt = performance.now();
      }
    },
    { passive: true }
  );

  function tick(now) {
    raf = 0;
    const dt = Math.min(4, last ? (now - last) / (1000 / FPS) : 1);
    last = now;
    const vh = cachedVh;
    const sy = lastScrollY;
    const isActivelyScrolling = now - lastScrollAt < 260;

    players.forEach((p) => {
      const top = p.docTop - sy;
      const bottom = top + p.height;
      if (bottom < -40 || top > vh + 40) return;

      // Rango amplio de scroll (de 92% a 22% de la pantalla) para que el scroll anime las 4 tarjetas gradualmente
      const start = vh * 0.92;
      const end = vh * 0.22;
      const scrollP = Math.min(1, Math.max(0, (start - top) / Math.max(1, start - end)));

      if (isActivelyScrolling && scrollP > 0.02 && scrollP < 0.98) {
        // Mientras haces scroll, la posición de la página controla el avance con suavizado lento
        p.playing = false;
        const target = MIN_FRAME + scrollP * (DURATION - MIN_FRAME);
        p.frame = p.frame < 0 ? target : p.frame + (target - p.frame) * Math.min(1, 0.085 * dt);
        p.clock = p.frame;
      } else if (scrollP <= 0.08 && !p.playing) {
        // Apenas asomándose abajo: mostrar el estado inicial ("antes") claramente sin dejarlo en blanco
        const target = MIN_FRAME + scrollP * 100;
        p.frame = p.frame < 0 ? target : p.frame + (target - p.frame) * Math.min(1, 0.1 * dt);
        p.clock = p.frame;
      } else {
        // Reproducción continua y pausada (~2.4x más lenta) para apreciar cada etapa
        p.playing = true;
        p.clock = (p.clock + dt * PLAY_SPEED) % LOOP;
        p.frame = loopFrame(p.clock);
      }
      p.draw(p.frame);
    });
    if (sectionVisible && !document.hidden) raf = requestAnimationFrame(tick);
  }

  function start() {
    if (!raf && sectionVisible && !document.hidden) {
      last = 0;
      raf = requestAnimationFrame(tick);
    }
  }

  const section = document.getElementById('problemas');
  if ('IntersectionObserver' in window && section) {
    new IntersectionObserver(
      (entries) => {
        sectionVisible = entries[0].isIntersecting;
        start();
      },
      { rootMargin: '80px 0px' }
    ).observe(section);
  } else {
    sectionVisible = true;
    start();
  }
  document.addEventListener('visibilitychange', start);
})();
