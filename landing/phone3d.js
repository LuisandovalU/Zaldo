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
const VIEW_H = 800;
const MAX_SCALE = 1.08;
const FOV = 30;
const PHONE_Y = 24;
const FLOOR_GAP = 26;
// La escena se adelanta respecto al plano de proyección del CSS3D: el navegador no
// registra clics en lo que queda detrás de ese plano al inclinar el teléfono.
const Z_FRONT = 190;
const SPRING = { stiffness: 120, damping: 14 };

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
    bevelSegments: 8,
    curveSegments: 28,
  });
  bodyGeo.translate(0, 0, -(D - BEVEL * 2) / 2);
  const body = new THREE.Mesh(bodyGeo, titanium);
  body.castShadow = true;
  phone.add(body);

  // Cristal frontal (el marco negro alrededor de la pantalla)
  const glassShape = roundedRect(W - BEVEL * 2 + 1.2, H - BEVEL * 2 + 1.2, R - BEVEL + 0.6);
  const front = new THREE.Mesh(new THREE.ShapeGeometry(glassShape, 28), frontGlass);
  front.position.z = D / 2 + 0.2;
  phone.add(front);

  // Parte trasera: cristal mate + módulo de cámaras
  const back = new THREE.Group();
  back.rotation.y = Math.PI;
  phone.add(back);

  const backPlate = new THREE.Mesh(new THREE.ShapeGeometry(glassShape, 28), backGlass);
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
      bevelSegments: 4,
      curveSegments: 20,
    }),
    backGlass.clone()
  );
  plateau.material.roughness = 0.22;
  plateau.position.set(camX, camY, D / 2 + 0.2);
  plateau.castShadow = true;
  back.add(plateau);

  const lensZ = D / 2 + 4;
  const addLens = (x, y) => {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(25, 26, 7, 48), titanium);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y, lensZ + 2);
    back.add(ring);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(21, 48), lensGlass);
    glass.position.set(x, y, lensZ + 5.7);
    back.add(glass);
    const iris = new THREE.Mesh(new THREE.RingGeometry(8, 14, 40), matteBlack);
    iris.position.set(x, y, lensZ + 5.8);
    back.add(iris);
    const core = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), lensGlass);
    core.rotation.x = Math.PI / 2;
    core.scale.y = 0.35;
    core.position.set(x, y, lensZ + 5.8);
    back.add(core);
  };
  addLens(camX - 29, camY + 29);
  addLens(camX - 29, camY - 29);
  addLens(camX + 27, camY);

  const flash = new THREE.Mesh(
    new THREE.CircleGeometry(7.5, 32),
    new THREE.MeshStandardMaterial({ color: 0xe9e4d4, roughness: 0.35, emissive: 0x2a2820 })
  );
  flash.position.set(camX + 34, camY + 38, lensZ + 0.3);
  back.add(flash);
  const lidar = new THREE.Mesh(new THREE.CircleGeometry(6.5, 32), matteBlack);
  lidar.position.set(camX + 34, camY - 38, lensZ + 0.3);
  back.add(lidar);

  // Botones físicos en relieve
  const addButton = (side, topPx, len) => {
    const geo = new THREE.ExtrudeGeometry(roundedRect(8.4, len, 4.2), {
      depth: 1.9,
      bevelEnabled: true,
      bevelThickness: 0.8,
      bevelSize: 0.8,
      bevelSegments: 3,
      curveSegments: 10,
    });
    const btn = new THREE.Mesh(geo, titanium);
    btn.rotation.y = (side * Math.PI) / 2;
    btn.position.set(side * (W / 2 - 0.4), H / 2 - topPx - len / 2, 0);
    btn.castShadow = true;
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

function init() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();

  // Iluminación de estudio basada en imagen (HDRI procedural, sin red)
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-340, 520, 760);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 1.6);
  rim.position.set(520, 180, -260);
  scene.add(rim);

  // Luz cenital que proyecta la sombra del teléfono sobre el piso
  const top = new THREE.DirectionalLight(0xffffff, 0.5);
  top.position.set(-40, 900, -70);
  top.castShadow = true;
  top.shadow.mapSize.set(512, 512);
  top.shadow.camera.left = -460;
  top.shadow.camera.right = 460;
  top.shadow.camera.top = 460;
  top.shadow.camera.bottom = -460;
  top.shadow.camera.near = 200;
  top.shadow.camera.far = 2000;
  top.shadow.radius = 26;
  top.shadow.blurSamples = 25;
  top.shadow.bias = -0.0004;
  scene.add(top);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1500, 900), new THREE.ShadowMaterial({ opacity: 0.3 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = PHONE_Y - H / 2 - FLOOR_GAP;
  floor.receiveShadow = true;

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

  wrap.classList.add('is-3d');
  if (stageEl) stageEl.classList.add('has-3d');
  wrap.appendChild(viewport);

  const screenObj = new CSS3DObject(screenEl);
  screenObj.position.set(0, 0, D / 2 + 0.6);
  phone.add(screenObj);
  screenEl.style.pointerEvents = 'auto';

  let viewW = 0;
  function resize() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight || VIEW_H;
    if (!w || (w === viewW && h === camera.userData.h)) return;
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
    const fit = Math.min(MAX_SCALE, (w - 46) / W);
    rigGroup.scale.setScalar(fit);
    floor.position.y = PHONE_Y - (H / 2) * fit - FLOOR_GAP;
    needsRender = true;
  }

  // Rig con resortes: comienza de perfil (-Math.PI / 2) en el tope y al hacer scroll gira al frente (0)
  const PROFILE_YAW = -Math.PI / 2 + 0.03;
  const rig = { yaw: reduceMotion ? 0 : PROFILE_YAW, pitch: 0, vyaw: 0, vpitch: 0 };
  const pointer = { x: 0, y: 0, overScreen: false };
  let dragYaw = 0;
  let dragging = false;
  let dragLastX = 0;
  let scrollP = 0;
  let unfoldP = reduceMotion ? 1 : 0;
  let kickDir = 1;
  let needsRender = true;
  let visible = true;
  let raf = 0;
  let last = 0;
  let lastGlare = '';

  const finePointer = window.matchMedia('(pointer: fine)').matches;
  if (finePointer && heroEl && !reduceMotion) {
    heroEl.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const r = viewport.getBoundingClientRect();
      pointer.x = THREE.MathUtils.clamp((e.clientX - (r.left + r.width / 2)) / (window.innerWidth * 0.5), -1, 1);
      pointer.y = THREE.MathUtils.clamp((e.clientY - (r.top + r.height / 2)) / (window.innerHeight * 0.6), -1, 1);
      pointer.overScreen = screenEl.contains(e.target);
    });
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

  // Cada cambio de escenario gira ligeramente el teléfono
  window.addEventListener('zaldo:preset', () => {
    if (reduceMotion) return;
    kickDir = -kickDir;
    rig.vyaw += kickDir * 2.2;
    rig.vpitch -= 0.5;
  });

  // Giro por scroll: en scrollY=0 comienza de perfil (PROFILE_YAW) y al bajar se pone de frente (0)
  function readScroll() {
    const sy = Math.max(0, window.scrollY || window.pageYOffset || 0);
    const rawUnfold = THREE.MathUtils.clamp(sy / 180, 0, 1);
    unfoldP = reduceMotion ? 1 : rawUnfold * rawUnfold * (3 - 2 * rawUnfold);
    scrollP = 0;
  }
  window.addEventListener('scroll', readScroll, { passive: true });
  window.addEventListener('resize', readScroll);
  readScroll();
  rig.yaw = reduceMotion ? 0 : PROFILE_YAW * (1 - unfoldP);

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    resize();

    const t = now / 1000;
    const hoverK = pointer.overScreen ? 0.3 : 1;
    const idle = reduceMotion ? 0 : 1;
    const baseYaw = PROFILE_YAW * (1 - unfoldP);
    const pointerInfluence = unfoldP * 0.32 * hoverK;
    const targetYaw = baseYaw + pointer.x * pointerInfluence + dragYaw + Math.sin(t * 0.55) * 0.018 * idle * unfoldP;
    const targetPitch = pointer.y * 0.12 * hoverK * unfoldP + Math.cos(t * 0.45) * 0.01 * idle * unfoldP;

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

    // Reflejo del cristal y de la lente frontal acoplados al giro
    const glare = `${(34 - rig.yaw * 150).toFixed(1)}%`;
    if (glare !== lastGlare) {
      lastGlare = glare;
      screenEl.style.setProperty('--glare-x', glare);
      screenEl.style.setProperty('--glare-o', Math.min(0.9, 0.3 + Math.abs(rig.yaw) * 1.6).toFixed(2));
      screenEl.style.setProperty('--lens-x', `${(38 - rig.yaw * 60).toFixed(1)}%`);
    }

    renderer.render(scene, camera);
    cssRenderer.render(scene, camera);
    needsRender = false;

    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!raf && visible && !document.hidden) {
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
      if (needsRender) start();
    }).observe(viewport);
  }

  resize();
  start();

  window.ZaldoPhone3D = { rig, renderer, phone, camera };
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (err) {
    return false;
  }
}

if (wrap && screenEl && webglAvailable()) {
  try {
    init();
  } catch (err) {
    // Sin WebGL utilizable: se queda el teléfono CSS original, intacto
    wrap.classList.remove('is-3d');
    if (stageEl) stageEl.classList.remove('has-3d');
    const bezel = wrap.querySelector('.iphone-bezel');
    const viewport = wrap.querySelector('.phone3d-viewport');
    if (bezel && screenEl.parentElement !== bezel) bezel.appendChild(screenEl);
    if (viewport) viewport.remove();
    screenEl.removeAttribute('style');
    console.warn('Zaldo 3D: se usa el teléfono 2D de respaldo.', err);
  }
}
