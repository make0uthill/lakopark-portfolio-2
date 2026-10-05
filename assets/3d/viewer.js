// A lakópark 3D modellje: three.js viewer for assets/3d/site.glb (buildings, paths, terrain) + veg.glb (instanced trees).
// Model space: glTF Y-up, metres, origin = site centre (Blender x −14, y −93); north = −Z.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = (s) => document.querySelector(s);
const coarse = matchMedia("(pointer: coarse)").matches;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
// file list + sizes come from modell.html (written by build.py): GitHub loads one meshopt-compressed site.glb,
// the claude.ai artifact loads uncompressed parts (no WebAssembly decoder needed there)
const CFG = window.MODEL_CFG || { meshopt: true, files: [["assets/3d/site.glb", 14824668], ["assets/3d/veg.glb", 1511320]] };
const FILES = CFG.files;                         // the last file is the vegetation
const BOUNDS = { x: 942, z: 628, yMin: -5, yMax: 90 };          // target stays above the terrain plate
const SUN_FROM = new THREE.Vector3(-0.4925, 0.643, -0.587).normalize();   // the render sun (north-west, 40° high)
// satellite image on the terrain: the Blender material maps it by world position, u = x·a + b, v = y·c + d (Blender metres);
// model space is x_b = X − 14, y_b = −Z − 93. It loads as a plain image (CFG.sat), not embedded in the GLB.
const SAT_MAP = [0.0005307515966705978, 0.5074324011802673, 0.0007961274241097271, 0.5737457871437073];

const load = $("#load"), loadBar = $("#load-bar"), loadN = $("#load-n"), loadT = $("#load-t");
function fail(msg) {
  load.classList.add("err"); loadT.textContent = msg; loadN.textContent = "";
}

// ------------------------------------------------------------------ renderer
const canvas = $("#c");
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
} catch (e) {
  fail("Ez a böngésző nem támogatja a WebGL-t, ezért a 3D modell nem jeleníthető meg.");
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 2, 9000);

// image-based light from a simple sky gradient (reflections on glass, metal and PV panels)
{
  const s = new THREE.Scene();
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: "varying vec3 v; void main(){ v = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "varying vec3 v; void main(){ float h = v.y; vec3 top = vec3(0.32, 0.47, 0.70); vec3 hor = vec3(0.86, 0.88, 0.87);" +
      " vec3 gnd = vec3(0.16, 0.18, 0.14); vec3 c = h > 0.0 ? mix(hor, top, pow(h, 0.55)) : mix(hor, gnd, pow(-h, 0.35)); gl_FragColor = vec4(c, 1.0); }",
  });
  s.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), m));
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(s, 0.03).texture;
  scene.environmentIntensity = 0.55;
  pm.dispose();
}
const hemi = new THREE.HemisphereLight(0xe4edf3, 0x4d5842, 0.85);
const sun = new THREE.DirectionalLight(0xfff0dc, 3.1);
sun.castShadow = true;
const SM = coarse ? 2048 : 4096;
sun.shadow.mapSize.set(SM, SM);
sun.shadow.bias = -0.0003;
scene.add(hemi, sun, sun.target);

// ------------------------------------------------------------------ controls
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.085;
controls.screenSpacePanning = false;            // pan along the ground
controls.maxPolarAngle = THREE.MathUtils.degToRad(83);
controls.minDistance = 10;
controls.maxDistance = 3600;
controls.zoomToCursor = true;
controls.rotateSpeed = 0.7;
controls.keyPanSpeed = 30;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.listenToKeyEvents(window);

// ------------------------------------------------------------------ views
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const VIEWS = {
  attekintes: { t: V(190, 0, -90), p: V(-90, 560, 520), fit: true },
  heviz:      { t: V(-171, 8, -263), p: V(-123, 147, -442) },
  hazak:      { t: V(89, 4, -127), p: V(-6, 143, 9) },
  keszthely:  { t: V(544, 8, -43), p: V(581, 116, -182) },
  felul:      { t: V(190, 0, -50), p: V(190, 1180, -49.9), fit: true },
};
function viewPose(name) {
  const v = VIEWS[name];
  const t = v.t.clone(), p = v.p.clone();
  if (v.fit) {                                   // narrow screens: step back until the horizontal field matches 16:9
    const hf = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
    const k = THREE.MathUtils.clamp(Math.tan(THREE.MathUtils.degToRad(31.2)) / Math.tan(hf), 1, 1.8);
    p.sub(t).multiplyScalar(k).add(t);
  }
  return { t, p };
}
let tween = null;
function goTo(pose, ms = 1500) {
  if (reduceMotion || ms === 0) {
    camera.position.copy(pose.p); controls.target.copy(pose.t); controls.update(); dirty = true; return;
  }
  tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pose.p, t1: pose.t, start: performance.now(), ms };
}
function setPressed(name) {
  document.querySelectorAll(".views button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.v === name));
    if (b.dataset.v === name) b.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  });
}
document.querySelectorAll(".views button").forEach((b) => b.addEventListener("click", () => {
  setPressed(b.dataset.v); goTo(viewPose(b.dataset.v));
}));
controls.addEventListener("start", () => { tween = null; setPressed(null); hideHelpSoon(); });

// north up: keep distance and tilt, turn the view to face north
$("#compass").addEventListener("click", () => {
  const off = camera.position.clone().sub(controls.target);
  const r = Math.hypot(off.x, off.z);
  goTo({ t: controls.target.clone(), p: controls.target.clone().add(V(0, off.y, Math.max(r, 0.01))) }, 900);
});

// double click / double tap: centre on the picked point and move closer
const ray = new THREE.Raycaster();
let siteRoot = null;
function focusAt(cx, cy) {
  if (!siteRoot) return;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObject(siteRoot, true)[0];
  if (!hit) return;
  const off = camera.position.clone().sub(controls.target);
  const d = Math.max(off.length() * 0.5, 45);
  off.setLength(d);
  setPressed(null);
  goTo({ t: hit.point.clone(), p: hit.point.clone().add(off) }, 1100);
}
canvas.addEventListener("dblclick", (e) => focusAt(e.clientX, e.clientY));
let lastTap = 0, lastXY = [0, 0];
canvas.addEventListener("pointerup", (e) => {
  if (e.pointerType !== "touch") return;
  const now = performance.now();
  if (now - lastTap < 320 && Math.hypot(e.clientX - lastXY[0], e.clientY - lastXY[1]) < 30) { focusAt(e.clientX, e.clientY); lastTap = 0; }
  else { lastTap = now; lastXY = [e.clientX, e.clientY]; }
});

// ------------------------------------------------------------------ help text
const help = $("#help");
help.innerHTML = coarse
  ? "<b>Forgatás:</b> egy ujjal. <b>Mozgatás és nagyítás:</b> két ujjal. <b>Dupla koppintás:</b> a kiválasztott pont kerül középre."
  : "<b>Forgatás:</b> bal egérgomb. <b>Mozgatás:</b> jobb egérgomb vagy nyilak. <b>Nagyítás:</b> görgő. <b>Dupla kattintás:</b> a kiválasztott pont kerül középre.";
let helpTimer = 0;
function hideHelpSoon() {
  if (helpTimer || !matchMedia("(max-width: 760px)").matches) return;
  helpTimer = setTimeout(() => help.classList.add("gone"), 2500);
}

// ------------------------------------------------------------------ toggles
let veg = null;
$("#t-veg").addEventListener("change", (e) => { if (veg) veg.visible = e.target.checked; dirty = true; });
$("#t-sh").addEventListener("change", (e) => { sun.castShadow = e.target.checked; dirty = true; });

// ------------------------------------------------------------------ size + shadow fit
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // keep at least ~40° horizontal field on portrait screens
  const hv = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(20)) / camera.aspect);
  camera.fov = Math.max(38, Math.min(THREE.MathUtils.radToDeg(hv), 70));
  camera.updateProjectionMatrix();
  dirty = true;
}
window.addEventListener("resize", resize);

function fitShadow() {
  const d = camera.position.distanceTo(controls.target);
  const half = THREE.MathUtils.clamp(d * 0.8, 45, 1150);
  const c = sun.shadow.camera;
  c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.near = 10; c.far = 5000;
  // snap the centre to the shadow texel grid so edges do not shimmer while panning
  const texel = (2 * half) / SM;
  const t = controls.target;
  const sx = Math.round(t.x / texel) * texel, sz = Math.round(t.z / texel) * texel;
  sun.target.position.set(sx, 0, sz);
  sun.position.set(sx, 0, sz).addScaledVector(SUN_FROM, 2400);
  sun.shadow.normalBias = texel * 1.1;
  c.updateProjectionMatrix();
}

function clampTarget() {
  const t = controls.target;
  const cx = THREE.MathUtils.clamp(t.x, -BOUNDS.x, BOUNDS.x), cz = THREE.MathUtils.clamp(t.z, -BOUNDS.z, BOUNDS.z);
  const cy = THREE.MathUtils.clamp(t.y, BOUNDS.yMin, BOUNDS.yMax);
  if (cx !== t.x || cz !== t.z || cy !== t.y) {
    const dx = cx - t.x, dy = cy - t.y, dz = cz - t.z;
    t.set(cx, cy, cz); camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
  }
  if (camera.position.y < 3) camera.position.y = 3;
}

// compass needle: rotate with the view azimuth
const compassSvg = $("#compass svg");
function updateCompass() {
  const az = controls.getAzimuthalAngle();          // 0 = camera south of target, looking north
  compassSvg.style.transform = `rotate(${THREE.MathUtils.radToDeg(az)}deg)`;
}

// ------------------------------------------------------------------ loop (renders only when something changed)
let dirty = true;
controls.addEventListener("change", () => { dirty = true; });
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
renderer.setAnimationLoop(() => {
  if (tween) {
    const k = Math.min((performance.now() - tween.start) / tween.ms, 1), e = ease(k);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (k >= 1) tween = null;
    dirty = true;
  }
  controls.update();
  if (dirty) {
    clampTarget();
    fitShadow();
    updateCompass();
    renderer.render(scene, camera);
    dirty = false;
  }
});

// ------------------------------------------------------------------ load
resize();
goTo(viewPose("attekintes"), 0);
const loader = new GLTFLoader();
const got = FILES.map(() => 0);
const SAT = CFG.sat || ["assets/3d/muhold.jpg", 5592696];
got.push(0);                                     // the last slot: the satellite image
const total = FILES.reduce((a, f) => a + (Array.isArray(f) ? f[1] : f.size), 0) + SAT[1];
function progress() {
  const p = Math.min(got.reduce((a, b) => a + b, 0) / total, 1);
  loadBar.style.width = (p * 100).toFixed(1) + "%";
  loadN.textContent = Math.round(p * 100) + " %";
}
const maxAniso = renderer.capabilities.getMaxAnisotropy();
// the claude.ai artifact serves no .glb files: there each GLB comes as base64 text in one or more .txt chunks
async function loadB64(f, i) {
  let text = "";
  for (const url of f.b64) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " " + r.status);
    const rd = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      got[i] += value.length; progress();
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
  }
  const bin = atob(text.replace(/\s+/g, ""));
  const buf = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
  return loader.parseAsync(buf.buffer, "");
}

async function decoder() {
  if (!CFG.meshopt) return;
  const { MeshoptDecoder } = await import("three/addons/libs/meshopt_decoder.module.js");
  await MeshoptDecoder.ready;
  loader.setMeshoptDecoder(MeshoptDecoder);
}
decoder()
  .then(() => Promise.all([...FILES.map((f, i) => (Array.isArray(f)
    ? loader.loadAsync(f[0], (e) => { got[i] = e.loaded; progress(); })
    : loadB64(f, i))),
    new THREE.TextureLoader().loadAsync(SAT[0]).then((t) => { got[got.length - 1] = SAT[1]; progress(); return t; })]))
  .then((res) => {
    const sat = res.pop();
    sat.colorSpace = THREE.SRGBColorSpace;
    sat.flipY = false;
    sat.wrapS = sat.wrapT = THREE.ClampToEdgeWrapping;
    sat.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const vegG = res.pop();
    siteRoot = new THREE.Group();
    res.forEach((r) => siteRoot.add(r.scene));
    siteRoot.updateMatrixWorld(true);
    const wp = new THREE.Vector3();
    siteRoot.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (m.name === "muhold") {                  // terrain: UVs from world x/z, then the satellite image
        const pos = o.geometry.attributes.position, uv = new Float32Array(pos.count * 2);
        for (let k = 0; k < pos.count; k++) {
          wp.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld);
          uv[2 * k] = (wp.x - 14) * SAT_MAP[0] + SAT_MAP[1];
          uv[2 * k + 1] = 1 - ((-wp.z - 93) * SAT_MAP[2] + SAT_MAP[3]);
        }
        o.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        m.map = sat; m.needsUpdate = true;
      }
      o.receiveShadow = true;
      o.castShadow = !m.transparent;
      if (m.map) { m.map.anisotropy = maxAniso; }
      if (m.transparent) { m.depthWrite = false; o.renderOrder = 2; }
    });
    veg = vegG.scene;
    veg.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = !coarse;
      o.receiveShadow = true;
      o.raycast = () => {};                       // picking ignores the trees
    });
    scene.add(siteRoot, veg);
    dirty = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      load.classList.add("done");
      window.__modelReady = true;
    }));
  })
  .catch((e) => {
    console.error(e);
    fail("A modell betöltése nem sikerült. Az oldal újratöltése általában megoldja.");
  });

// hooks for automated screenshots
window.__view = (name) => { setPressed(name); goTo(viewPose(name), 0); };
window.__pose = (p, t) => { setPressed(null); goTo({ p: V(...p), t: V(...t) }, 0); };
window.__render = () => { dirty = true; };
window.__fov = (f) => { camera.fov = f; camera.updateProjectionMatrix(); dirty = true; };
