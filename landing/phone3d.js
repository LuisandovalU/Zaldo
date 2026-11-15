/*
 * Zaldo · iPhone Pro 3D (Titanio Negro) — malla paramétrica PBR en Three.js.
 * La pantalla de WhatsApp es el mismo DOM vivo (.iphone-screen) montado sobre
 * la cara frontal con CSS3DRenderer: comparte cámara y rig con el WebGL, así
 * que sigue siendo 100% interactiva mientras el teléfono rota.
 * Si WebGL no está disponible, se conserva el teléfono CSS original.
 */
import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from './vendor/CSS3DRenderer.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

const wrap = document.getElementById('iphone-tilt');
const screenEl = wrap && wrap.querySelector('.iphone-screen');
const stageEl = wrap && wrap.closest('.hero-stage');
const heroEl = document.querySelector('.hero');

// Medidas en px de diseño: 1 unidad 3D = 1 px CSS en el plano z = 0
const W = 304;
const H = 642;
const D = 35;
const R = 47;
const BEVEL = 4;
const SCREEN_W = 289;
const SCREEN_H = 627;
const VIEW_H = 740;
const MAX_SCALE = 1.0;
const FOV = 30;
const PHONE_Y = 6;
const FLOOR_GAP = 24;
// La escena se adelanta respecto al plano de proyección del CSS3D: el navegador no
// registra clics en lo que queda detrás de ese plano al inclinar el teléfono.
const Z_FRONT = 190;
const SPRING = { stiffness: 168, damping: 18 };

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

// Textura de titanio cepillado: vetas finas que modulan la rugosidad
function brushedTexture() {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const ctx = c.getContext('2d');
  for (let y = 0; y < c.height; y++) {
    const v = 178 + Math.round(Math.random() * 70);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(0, y, c.width, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 60, 1 / 22);
  return tex;
}

// Sombra de contacto suave procedural en canvas: evita shadow maps costosos en cada frame
function contactShadowTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.translate(128, 64);
  ctx.scale(1, 0.5);
  const grad = ctx.createRadialGradient(0, 0, 8, 0, 0, 118);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.34)');
  grad.addColorStop(0.32, 'rgba(0, 0, 0, 0.2)');
  grad.addColorStop(0.68, 'rgba(0, 0, 0, 0.06)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(-128, -128, 256, 256);
  ctx.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildPhone() {
  const phone = new THREE.Group();

  const titanium = new THREE.MeshPhysicalMaterial({
    color: 0x34343a,
    metalness: 0.88,
    roughness: 0.24,
    roughnessMap: brushedTexture(),
    envMapIntensity: 1.25,
  });
  const frontGlass = new THREE.MeshPhysicalMaterial({
    color: 0x030304,
    metalness: 0,
    roughness: 0.06,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.1,
  });
  const backGlass = new THREE.MeshPhysicalMaterial({
    color: 0x1b1b1f,
    metalness: 0.25,
    roughness: 0.42,
    clearcoat: 0.35,
    clearcoatRoughness: 0.5,
  });
  const plateauGlass = new THREE.MeshPhysicalMaterial({
    color: 0x1b1b1f,
    metalness: 0.25,
    roughness: 0.22,
    clearcoat: 0.35,
    clearcoatRoughness: 0.5,
  });
  const lensGlass = new THREE.MeshPhysicalMaterial({
    color: 0x05060c,
    metalness: 0.2,
    roughness: 0.03,
    clearcoat: 1,
    clearcoatRoughness: 0,
    envMapIntensity: 1.8,
  });
  const matteBlack = new THREE.MeshStandardMaterial({ color: 0x020203, roughness: 0.9, metalness: 0 });

  // Chasis de titanio con canto biselado y grosor real
  const bodyGeo = new THREE.ExtrudeGeometry(roundedRect(W - BEVEL * 2, H - BEVEL * 2, R - BEVEL), {
    depth: D - BEVEL * 2,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelSegments: 5,
    curveSegments: 20,
  });
  bodyGeo.translate(0, 0, -(D - BEVEL * 2) / 2);
  phone.add(new THREE.Mesh(bodyGeo, titanium));

  // Cristal frontal (el marco negro alrededor de la pantalla)
  const glassGeo = new THREE.ShapeGeometry(
    roundedRect(W - BEVEL * 2 + 1.2, H - BEVEL * 2 + 1.2, R - BEVEL + 0.6),
    20
  );
  const front = new THREE.Mesh(glassGeo, frontGlass);
  front.position.z = D / 2 + 0.2;
  phone.add(front);

  // Parte trasera: cristal mate + módulo de cámaras
  const back = new THREE.Group();
  back.rotation.y = Math.PI;
  phone.add(back);

  const backPlate = new THREE.Mesh(glassGeo, backGlass);
  backPlate.position.z = D / 2 + 0.2;
  back.add(backPlate);

  const camX = -(W / 2 - 22 - 64);
  const camY = H / 2 - 22 - 64;
  const plateau = new THREE.Mesh(
    new THREE.ExtrudeGeometry(roundedRect(125, 125, 36), {
      depth: 2.4,
      bevelEnabled: true,
      bevelThickness: 1.6,
      bevelSize: 1.6,
      bevelSegments: 3,
      curveSegments: 16,
    }),
    plateauGlass
  );
  plateau.position.set(camX, camY, D / 2 + 0.2);
  back.add(plateau);

  // Geometrías compartidas para las 3 lentes
  const lensZ = D / 2 + 4;
  const lensRingGeo = new THREE.CylinderGeometry(25, 26, 7, 36);
  const lensGlassGeo = new THREE.CircleGeometry(21, 36);
  const lensIrisGeo = new THREE.RingGeometry(8, 14, 32);
  const lensCoreGeo = new THREE.SphereGeometry(8, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const addLens = (x, y) => {
    const ring = new THREE.Mesh(lensRingGeo, titanium);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y, lensZ + 2);
    back.add(ring);
    const glass = new THREE.Mesh(lensGlassGeo, lensGlass);
    glass.position.set(x, y, lensZ + 5.7);
    back.add(glass);
    const iris = new THREE.Mesh(lensIrisGeo, matteBlack);
    iris.position.set(x, y, lensZ + 5.8);
    back.add(iris);
    const core = new THREE.Mesh(lensCoreGeo, lensGlass);
    core.rotation.x = Math.PI / 2;
    core.scale.y = 0.35;
    core.position.set(x, y, lensZ + 5.8);
    back.add(core);
  };
  addLens(camX - 29, camY + 29);
  addLens(camX - 29, camY - 29);
  addLens(camX + 27, camY);

  const flash = new THREE.Mesh(
    new THREE.CircleGeometry(7.5, 24),
    new THREE.MeshStandardMaterial({ color: 0xe9e4d4, roughness: 0.35, emissive: 0x2a2820 })
  );
  flash.position.set(camX + 34, camY + 38, lensZ + 0.3);
  back.add(flash);
  const lidar = new THREE.Mesh(new THREE.CircleGeometry(6.5, 24), matteBlack);
  lidar.position.set(camX + 34, camY - 38, lensZ + 0.3);
  back.add(lidar);

  // Botones físicos en relieve (comparten geometría los de igual largo)
  const btnGeos = new Map();
  const addButton = (side, topPx, len) => {
    let geo = btnGeos.get(len);
    if (!geo) {
      geo = new THREE.ExtrudeGeometry(roundedRect(8.4, len, 4.2), {
        depth: 1.9,
        bevelEnabled: true,
        bevelThickness: 0.8,
        bevelSize: 0.8,
        bevelSegments: 2,
        curveSegments: 8,
      });
      btnGeos.set(len, geo);
    }
    const btn = new THREE.Mesh(geo, titanium);
    btn.rotation.y = (side * Math.PI) / 2;
    btn.position.set(side * (W / 2 - 0.4), H / 2 - topPx - len / 2, 0);
    phone.add(btn);
  };
  addButton(-1, 112, 24); // botón de acción
  addButton(-1, 152, 42); // volumen +
  addButton(-1, 204, 42); // volumen -
  addButton(1, 170, 64); // encendido

  // Puerto y bocinas en el canto inferior
  const port = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(36, 10, 5), 12), matteBlack);
  port.rotation.x = Math.PI / 2;
  port.position.y = -H / 2 - 0.15;
  phone.add(port);
  const holeGeo = new THREE.CircleGeometry(2.5, 16);
  [-74, -62, -50, -38, 38, 50, 62, 74].forEach((x) => {
    const hole = new THREE.Mesh(holeGeo, matteBlack);
    hole.rotation.x = Math.PI / 2;
    hole.position.set(x, -H / 2 - 0.15, 0);
    phone.add(hole);
  });

  return phone;
}

// Cede el hilo entre etapas pesadas del montaje: deja pintar y atender el scroll
const breathe = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

async function init() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const glareEl = screenEl.querySelector('.screen-glare');
  const lensEl = screenEl.querySelector('.island-cam');

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;
  await breathe();

  const scene = new THREE.Scene();

  // Iluminación de estudio basada en imagen (HDRI procedural, sin red)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  envScene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });
  pmrem.dispose();
  await breathe();

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-340, 520, 760);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 1.6);
  rim.position.set(520, 180, -260);
  scene.add(rim);

  // Sombra de contacto ligera sobre el piso (sin renderizar shadow maps en cada frame)
  const floorMat = new THREE.MeshBasicMaterial({
    map: contactShadowTexture(),
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(460, 210), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = PHONE_Y - H / 2 - FLOOR_GAP;

  const world = new THREE.Group();
  world.position.z = Z_FRONT;
  scene.add(world);
  world.add(floor);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 10, 5000);

  const rigGroup = new THREE.Group();
  rigGroup.position.y = PHONE_Y;
  world.add(rigGroup);
  const phone = buildPhone();
  rigGroup.add(phone);

  // Viewport: canvas WebGL + capa CSS3D con la pantalla viva
  const viewport = document.createElement('div');
  viewport.className = 'phone3d-viewport';
  viewport.appendChild(renderer.domElement);

  const cssRenderer = new CSS3DRenderer();
  cssRenderer.domElement.classList.add('phone3d-css');
  viewport.appendChild(cssRenderer.domElement);

  wrap.classList.remove('is-2d');
  wrap.classList.add('is-3d');
  if (stageEl) {
    stageEl.classList.remove('has-2d');
    stageEl.classList.add('has-3d');
  }
  wrap.appendChild(viewport);

  const screenObj = new CSS3DObject(screenEl);
  screenObj.position.set(0, 0, D / 2 + 0.6);
  phone.add(screenObj);
  screenEl.style.pointerEvents = 'auto';

  let viewW = 0;
  let vpCenterX = 0;
  let vpDocCenterY = 0;
  let winW = window.innerWidth || 1200;
  let winH = window.innerHeight || 800;

  function measureViewport() {
    winW = window.innerWidth || 1200;
    winH = window.innerHeight || 800;
    const r = viewport.getBoundingClientRect();
    vpCenterX = r.left + r.width * 0.5;
    vpDocCenterY = r.top + window.scrollY + r.height * 0.5;
  }

  // En celular/tableta (hero en columna) el teléfono se ajusta también al alto visible,
  // para que quepa entero bajo la barra y la tira de ejemplos. En escritorio no cambia.
  const stackedMq = window.matchMedia('(max-width: 960px)');
  function fitFor(w) {
    let f = Math.min(MAX_SCALE, (w - 46) / W);
    if (stackedMq.matches) {
      const roomH = (document.documentElement.clientHeight || winH) - 132;
      f = Math.min(f, Math.max(0.8, roomH / (H + 20)));
    }
    return f;
  }

  let fit = 1;
  function resize() {
    const w = viewport.clientWidth;
    if (!w) return;
    const nextFit = fitFor(w);
    viewport.style.height = stackedMq.matches ? `${Math.round(VIEW_H - H + H * nextFit)}px` : '';
    const h = viewport.clientHeight || VIEW_H;
    if (w === viewW && h === camera.userData.h) return;
    viewW = w;
    camera.userData.h = h;
    camera.aspect = w / h;
    // Distancia a la que 1 unidad = 1 px en z = 0, para que el DOM se vea nítido
    const dist = h / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    camera.position.set(0, 0, dist);
    // Compensa el acercamiento para conservar la escala 1:1 en pantalla
    world.scale.setScalar((dist - Z_FRONT) / dist);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    cssRenderer.setSize(w, h);
    // Más grande en escritorio; en pantallas angostas se ajusta al ancho sin tocar el desvanecido lateral
    fit = nextFit;
    rigGroup.scale.setScalar(fit);
    floor.position.y = PHONE_Y - (H / 2) * fit - FLOOR_GAP;
    measureViewport();
    needsRender = true;
  }

  // Comienza en ángulo 3/4 (-0.86 rad, mostrando pantalla + canto de titanio) y gira rápido al frente (0)
  const START_YAW = -0.86;
  const START_PITCH = 0.07;
  const rig = {
    yaw: reduceMotion ? 0 : START_YAW,
    pitch: reduceMotion ? 0 : START_PITCH,
    vyaw: 0,
    vpitch: 0,
  };
  const pointer = { x: 0, y: 0, overScreen: false };
  let dragYaw = 0;
  let dragging = false;
  let dragLastX = 0;
  let scrollP = 0;
  let introStart = 0;
  let kickDir = 1;
  let needsRender = true;
  let live = false;
  let visible = true;
  let raf = 0;
  let last = 0;
  let lastGlareX = NaN;
  let lastGlareO = NaN;
  let lastLensX = NaN;

  const finePointer = window.matchMedia('(pointer: fine)').matches;
  if (finePointer && heroEl && !reduceMotion) {
    heroEl.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        pointer.x = THREE.MathUtils.clamp((e.clientX - vpCenterX) / (winW * 0.5), -1, 1);
        pointer.y = THREE.MathUtils.clamp((e.clientY - (vpDocCenterY - window.scrollY)) / (winH * 0.6), -1, 1);
        pointer.overScreen = screenEl.contains(e.target);
      },
      { passive: true }
    );
    heroEl.addEventListener('pointerleave', () => {
      pointer.x = 0;
      pointer.y = 0;
      pointer.overScreen = false;
    });
  }

  // Arrastre libre fuera de la pantalla para girar el teléfono 360°
  viewport.addEventListener('pointerdown', (e) => {
    if (screenEl.contains(e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    dragging = true;
    dragLastX = e.clientX;
    viewport.classList.add('is-dragging');
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragYaw += (e.clientX - dragLastX) * 0.011;
    dragLastX = e.clientX;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    viewport.classList.remove('is-dragging');
    // Regresa por el camino más corto hacia el frente
    const turns = Math.round(dragYaw / (Math.PI * 2)) * Math.PI * 2;
    rig.yaw -= turns;
    dragYaw = 0;
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  // Cada cambio de escenario da un giro rápido y ágil al teléfono
  window.addEventListener('zaldo:preset', () => {
    if (reduceMotion) return;
    kickDir = -kickDir;
    rig.vyaw += kickDir * 2.8;
    rig.vpitch -= 0.55;
  });

  // Leve respuesta al scroll sin perder la vista frontal (cero reflows en scroll)
  function readScroll() {
    const offset = (winH * 0.5 - (vpDocCenterY - window.scrollY)) / winH;
    const dead = 0.14;
    const eased = Math.sign(offset) * Math.max(0, Math.abs(offset) - dead);
    scrollP = THREE.MathUtils.clamp(eased * 1.2, -1, 1);
  }
  window.addEventListener('scroll', readScroll, { passive: true });
  window.addEventListener('resize', () => {
    resize();
    measureViewport();
    readScroll();
  }, { passive: true });

  function frame(now) {
    raf = 0;
    if (!introStart) introStart = now;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
    last = now;

    const t = now / 1000;
    const hoverK = pointer.overScreen ? 0.3 : 1;
    const idle = reduceMotion ? 0 : 1;
    // Mantiene la pose inicial 3/4 por 130ms y luego suelta el resorte rápido hacia el frente (0)
    const inIntroHold = !reduceMotion && now - introStart < 130;
    const targetYaw = inIntroHold
      ? START_YAW
      : pointer.x * 0.34 * hoverK + scrollP * 0.22 + dragYaw + Math.sin(t * 0.55) * 0.024 * idle;
    const targetPitch = inIntroHold
      ? START_PITCH
      : pointer.y * 0.14 * hoverK - Math.abs(scrollP) * 0.06 + Math.cos(t * 0.45) * 0.01 * idle;

    // Integración semi-implícita en subpasos para estabilidad
    const steps = 2;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      rig.vyaw += (SPRING.stiffness * (targetYaw - rig.yaw) - SPRING.damping * rig.vyaw) * h;
      rig.yaw += rig.vyaw * h;
      rig.vpitch += (SPRING.stiffness * (targetPitch - rig.pitch) - SPRING.damping * rig.vpitch) * h;
      rig.pitch += rig.vpitch * h;
    }

    phone.rotation.set(rig.pitch, rig.yaw, 0);
    phone.position.y = Math.sin(t * 0.9) * 4 * idle;
    // Compensa el acercamiento en perspectiva del canto lateral cuando está de perfil
    rigGroup.position.z = -Math.sin(Math.min(Math.PI / 2, Math.abs(rig.yaw))) * 115;

    // Sombra de contacto modulada por giro y flotación sin shadow maps
    floor.scale.set(fit * (0.45 + 0.55 * Math.abs(Math.cos(rig.yaw))), fit, 1);
    floorMat.opacity = 0.88 - phone.position.y * 0.015;

    // Reflejo del cristal por compositor (transform/opacity) y lente cuantizada
    if (glareEl) {
      const gx = Math.round((-16 - rig.yaw * 150) * 2.89 * 2) / 2;
      const go = Math.round(Math.min(0.9, 0.3 + Math.abs(rig.yaw) * 1.6) * 50) / 50;
      if (gx !== lastGlareX) {
        lastGlareX = gx;
        glareEl.style.transform = `translate3d(${gx}px, 0, 0)`;
      }
      if (go !== lastGlareO) {
        lastGlareO = go;
        glareEl.style.opacity = String(go);
      }
    }
    if (lensEl) {
      const lx = Math.round((38 - rig.yaw * 60) * 2) / 2;
      if (lx !== lastLensX) {
        lastLensX = lx;
        lensEl.style.setProperty('--lens-x', `${lx}%`);
      }
    }

    renderer.render(scene, camera);
    cssRenderer.render(scene, camera);
    needsRender = false;

    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!raf && live && visible && !document.hidden) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        start();
      },
      { rootMargin: '120px 0px' }
    ).observe(viewport);
  }
  document.addEventListener('visibilitychange', start);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      resize();
      measureViewport();
      readScroll();
      if (needsRender) start();
    }).observe(heroEl || viewport);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      measureViewport();
      readScroll();
    });
  }

  resize();
  measureViewport();
  readScroll();

  // Los shaders se compilan en paralelo (sin congelar la página) y el teléfono aparece
  // ya con su primer cuadro listo; ahí arranca el giro de entrada y se avisa al demo.
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    live = true;
    introStart = 0;
    start();
    requestAnimationFrame(() => {
      viewport.classList.add('is-ready');
      window.dispatchEvent(new CustomEvent('zaldo:phone-ready'));
    });
  };
  if (typeof renderer.compileAsync === 'function') {
    renderer.compileAsync(scene, camera).then(reveal, reveal);
    setTimeout(reveal, 2500);
  } else {
    reveal();
  }

  window.ZaldoPhone3D = { rig, renderer, phone, camera };
}

// No se crea un contexto WebGL de prueba (costaba ~medio segundo): si el renderer no
// puede crearse, lanza y se conserva el teléfono 2D.
function boot() {
  init().catch((err) => {
    // Sin WebGL utilizable: se queda el teléfono CSS original, intacto
    wrap.classList.remove('is-3d');
    wrap.classList.add('is-2d');
    if (stageEl) {
      stageEl.classList.remove('has-3d');
      stageEl.classList.add('has-2d');
    }
    const bezel = wrap.querySelector('.iphone-bezel');
    const viewport = wrap.querySelector('.phone3d-viewport');
    if (bezel && screenEl.parentElement !== bezel) bezel.appendChild(screenEl);
    if (viewport) viewport.remove();
    screenEl.removeAttribute('style');
    window.dispatchEvent(new CustomEvent('zaldo:phone-ready'));
    console.warn('Zaldo 3D: se usa el teléfono 2D de respaldo.', err);
  });
}

if (wrap && screenEl) {
  if (window.WebGLRenderingContext) {
    // Deja pintar primero el texto del hero; el 3D se monta en el siguiente cuadro
    requestAnimationFrame(() => setTimeout(boot, 0));
  } else {
    wrap.classList.add('is-2d');
    if (stageEl) stageEl.classList.add('has-2d');
    window.dispatchEvent(new CustomEvent('zaldo:phone-ready'));
  }
}
