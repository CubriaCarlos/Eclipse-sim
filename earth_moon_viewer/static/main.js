import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- escala y constantes -----------------------------------------------------
const EARTH_R_KM = 6371.0;
const A_KM = 6378.137;            // WGS84
const B_KM = 6356.752314245;
const MOON_R_KM = 1737.4;
const SUN_R_KM = 695700.0;
const EARTH_UNITS = 10.0;                       // radio terrestre en unidades de escena
const KM_TO_UNIT = EARTH_UNITS / EARTH_R_KM;
const UNIT_TO_KM = 1.0 / KM_TO_UNIT;
const COMPRESSED_FACTOR = 0.25;                 // acerca la Luna sólo para encuadrarla
const LAYER_R = EARTH_UNITS * 1.0016;           // radio de las capas vectoriales

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const el = (id) => document.getElementById(id);
let toastTimer = null;
const toast = (msg) => {
  const t = el('toast');
  t.style.display = 'block';
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 5000);
};

// Mismo criterio de mapeo que la textura equirectangular: polo en +Y, lon 0 en +X.
function latLonToVec(lat, lon, r, out) {
  const cl = Math.cos(lat * D2R);
  return (out || new THREE.Vector3()).set(
    r * cl * Math.cos(lon * D2R),
    r * Math.sin(lat * D2R),
    -r * cl * Math.sin(lon * D2R),
  );
}

function vecToLatLon(v) {
  const hyp = Math.hypot(v.x, v.z);
  return [
    Math.atan2(v.y * A_KM * A_KM, hyp * B_KM * B_KM) * R2D,   // latitud geodésica
    Math.atan2(-v.z, v.x) * R2D,
  ];
}

// --- escena ------------------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.02, 150000);
camera.up.set(0, 0, 1);                          // ejes de escena = ICRF, polo celeste en +Z
camera.position.set(0, -34, 14);

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.05;
controls.maxDistance = 20000;
controls.zoomSpeed = 0.85;

const loader = new THREE.TextureLoader();
const tex = (f, srgb) => {
  const t = loader.load('assets/' + f);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
};

// --- Tierra: sombreado propio con oclusión real del disco solar --------------
const earthUniforms = {
  dayMap: { value: tex('earth-day.jpg', true) },
  nightMap: { value: tex('earth-night.jpg', true) },
  waterMap: { value: tex('earth-water.png', false) },
  topoMap: { value: tex('earth-topology.png', false) },
  sunKm: { value: new THREE.Vector3(1.5e8, 0, 0) },
  moonKm: { value: new THREE.Vector3(4e5, 0, 0) },
  poleW: { value: new THREE.Vector3(0, 0, 1) },
  eclipseOn: { value: 1.0 },
  nightOn: { value: 1.0 },
  relief: { value: 1.0 },
};

// three no define isPerspectiveMatrix para ShaderMaterial y logdepthbuf la necesita.
const LOGDEPTH_FIX = 'bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }';

const EARTH_VERT = /* glsl */`
  ${LOGDEPTH_FIX}
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  #include <logdepthbuf_pars_vertex>
  void main() {
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const EARTH_FRAG = /* glsl */`
  uniform sampler2D dayMap, nightMap, waterMap, topoMap;
  uniform vec3 sunKm, moonKm, poleW;
  uniform float eclipseOn, nightOn, relief;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  #include <logdepthbuf_pars_fragment>

  const float PI = 3.14159265359;

  // Fracción del disco solar tapada por la Luna vista desde un punto (km, ICRF).
  float occultation(vec3 p) {
    vec3 ds = sunKm - p, dm = moonKm - p;
    float ls = length(ds), lm = length(dm);
    float rs = asin(clamp(${SUN_R_KM.toFixed(1)} / ls, 0.0, 1.0));
    float rm = asin(clamp(${MOON_R_KM.toFixed(1)} / lm, 0.0, 1.0));
    float d = acos(clamp(dot(ds / ls, dm / lm), -1.0, 1.0));
    if (d >= rs + rm) return 0.0;
    if (d <= rm - rs) return 1.0;
    if (d <= rs - rm) return (rm * rm) / (rs * rs);
    float a1 = acos(clamp((d * d + rm * rm - rs * rs) / (2.0 * d * rm), -1.0, 1.0));
    float a2 = acos(clamp((d * d + rs * rs - rm * rm) / (2.0 * d * rs), -1.0, 1.0));
    float lens = rm * rm * a1 + rs * rs * a2
      - 0.5 * sqrt(max(0.0, (rm + rs - d) * (d + rm - rs) * (d - rm + rs) * (d + rm + rs)));
    return clamp(lens / (PI * rs * rs), 0.0, 1.0);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(vN);
    vec3 east = normalize(cross(poleW, n));
    vec3 north = cross(n, east);

    // Relieve a partir del mapa topográfico: gradiente en el plano tangente.
    float t = 1.0 / 1024.0;
    float hx = texture2D(topoMap, vUv + vec2(t, 0.0)).r - texture2D(topoMap, vUv - vec2(t, 0.0)).r;
    float hy = texture2D(topoMap, vUv + vec2(0.0, t)).r - texture2D(topoMap, vUv - vec2(0.0, t)).r;
    n = normalize(n + relief * 1.7 * (hx * east + hy * north));

    vec3 pkm = vW * ${UNIT_TO_KM.toFixed(6)};
    vec3 L = normalize(sunKm - pkm);
    float ndl = dot(n, L);
    float cov = eclipseOn > 0.5 ? occultation(pkm) : 0.0;
    // Curva perceptual: la penumbra apenas oscurece, la umbra sí; queda un resto de
    // luz para que la geografía siga leyéndose dentro de la sombra.
    float shade = 0.055 + 0.945 * pow(1.0 - cov, 0.55);
    float diff = clamp((ndl + 0.10) / 1.10, 0.0, 1.0);    // luz difusa del crepúsculo
    float lit = pow(diff, 0.85) * shade;

    vec3 day = texture2D(dayMap, vUv).rgb;
    vec3 night = texture2D(nightMap, vUv).rgb;
    float water = texture2D(waterMap, vUv).r;

    // Las luces de ciudad entran en el crepúsculo y también dentro de la umbra.
    float nightMix = smoothstep(0.14, -0.06, dot(normalize(vN), L));
    nightMix = max(nightMix, smoothstep(0.975, 1.0, cov) * 0.45);

    vec3 V = normalize(cameraPosition - vW);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(n, H), 0.0), 60.0) * water * max(ndl, 0.0) * (1.0 - cov);
    float sky = smoothstep(-0.25, 0.35, ndl);              // cielo iluminado sobre el terreno
    float fres = pow(1.0 - max(dot(normalize(vN), V), 0.0), 3.0);

    vec3 col = day * (0.05 + 1.30 * lit);
    col += vec3(0.10, 0.16, 0.30) * sky * shade * 0.35;
    col += night * vec3(1.0, 0.86, 0.62) * (nightOn * 0.9) * nightMix;
    col += vec3(1.0, 0.95, 0.86) * spec * 0.55;
    col += vec3(0.22, 0.42, 0.85) * fres * lit * 0.75;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const earthGroup = new THREE.Group();
scene.add(earthGroup);

const earthMesh = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_UNITS, 256, 160),
  new THREE.ShaderMaterial({ uniforms: earthUniforms, vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG }),
);
earthGroup.add(earthMesh);

// Halo atmosférico: cáscara aditiva que no gira con la Tierra.
const atmo = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_UNITS * 1.026, 96, 64),
  new THREE.ShaderMaterial({
    uniforms: { sunKm: earthUniforms.sunKm },
    transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
    vertexShader: /* glsl */`
      ${LOGDEPTH_FIX}
      varying vec3 vN; varying vec3 vW;
      #include <logdepthbuf_pars_vertex>
      void main(){
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 sunKm; varying vec3 vN; varying vec3 vW;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vN), V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - abs(dot(n, V)), 2.6);
        // Se dibuja la cara trasera de la cáscara: reflejar la normal da la del lado
        // cercano, que es la que decide si ese borde está iluminado.
        vec3 nNear = reflect(-n, V);
        float lit = max(dot(nNear, normalize(sunKm - vW)), 0.0);
        gl_FragColor = vec4(vec3(0.32, 0.55, 1.0) * rim * pow(lit, 0.75) * 1.5, 1.0);
      }`,
  }),
);
scene.add(atmo);

// --- Luna: sombreado propio con la sombra de la Tierra (eclipse lunar) -------
const moonUniforms = {
  moonMap: { value: tex('moon.jpg', true) },
  sunKm: { value: new THREE.Vector3(1.5e8, 0, 0) },
  moonKm: { value: new THREE.Vector3(4e5, 0, 0) },
  moonScene: { value: new THREE.Vector3() },
};

const MOON_VERT = /* glsl */`
  ${LOGDEPTH_FIX}
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  #include <logdepthbuf_pars_vertex>
  void main() {
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const MOON_FRAG = /* glsl */`
  uniform sampler2D moonMap;
  uniform vec3 sunKm, moonKm, moonScene;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  #include <logdepthbuf_pars_fragment>

  const float PI = 3.14159265359;
  const float EARTH_R = ${EARTH_R_KM.toFixed(1)};
  const float SUN_R = ${SUN_R_KM.toFixed(1)};
  const float U2KM = ${UNIT_TO_KM.toFixed(6)};

  // Fracción del disco solar tapada por la Tierra visto desde p (km, geocéntrico).
  float earthOccult(vec3 p) {
    vec3 ds = sunKm - p, de = -p;          // hacia el Sol y hacia la Tierra (origen)
    float ls = length(ds), le = length(de);
    float rs = asin(clamp(SUN_R / ls, 0.0, 1.0));
    float re = asin(clamp(EARTH_R / le, 0.0, 1.0));
    float d = acos(clamp(dot(ds / ls, de / le), -1.0, 1.0));
    if (d >= rs + re) return 0.0;
    if (d <= re - rs) return 1.0;
    // Solapamiento parcial: el disco pequeño (Sol) queda tapado por el grande (Tierra).
    float a1 = acos(clamp((d * d + re * re - rs * rs) / (2.0 * d * re), -1.0, 1.0));
    float a2 = acos(clamp((d * d + rs * rs - re * re) / (2.0 * d * rs), -1.0, 1.0));
    float lens = re * re * a1 + rs * rs * a2
      - 0.5 * sqrt(max(0.0, (re + rs - d) * (d + re - rs) * (d - re + rs) * (d + re + rs)));
    return clamp(lens / (PI * rs * rs), 0.0, 1.0);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(vN);
    vec3 pkm = moonKm + (vW - moonScene) * U2KM;
    vec3 L = normalize(sunKm - pkm);
    float ndl = dot(n, L);
    float cov = earthOccult(pkm);
    float shade = 0.04 + 0.96 * pow(1.0 - cov, 0.55);
    float lit = clamp(ndl, 0.0, 1.0) * shade + 0.025;

    vec3 tex = texture2D(moonMap, vUv).rgb;
    vec3 col = tex * (1.15 * lit);

    // "Luna de sangre": la umbra se tiñe de rojo por la luz refractada en la atmósfera.
    float umb = smoothstep(0.85, 1.0, cov);
    col += tex * vec3(0.85, 0.22, 0.10) * umb * 0.75;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const moonMesh = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_UNITS * (MOON_R_KM / EARTH_R_KM), 96, 64),
  new THREE.ShaderMaterial({ uniforms: moonUniforms, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG }),
);
scene.add(moonMesh);

// --- Sol y estrellas ---------------------------------------------------------
function glowSprite(size, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d').createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, color);
  g.addColorStop(1, 'rgba(255,200,120,0)');
  const ctx = c.getContext('2d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  s.scale.setScalar(size);
  return s;
}
const sunSprite = glowSprite(1500, 'rgba(255,236,190,0.95)');
scene.add(sunSprite);

const starGeo = new THREE.BufferGeometry();
{
  const n = 9000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 80000;
    const s = Math.sqrt(1 - u * u);
    pos.set([r * s * Math.cos(th), r * s * Math.sin(th), r * u], i * 3);
    const w = 0.55 + Math.random() * 0.45;
    col.set([w, w * (0.93 + Math.random() * 0.07), w * (0.9 + Math.random() * 0.1)], i * 3);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true }));
scene.add(stars);

// --- capas vectoriales sobre la Tierra ---------------------------------------
function polylineLayer(polys, color, opacity, radius) {
  const pts = [];
  const v = new THREE.Vector3();
  for (const poly of polys) {
    for (let i = 1; i < poly.length; i++) {
      latLonToVec(poly[i - 1][1], poly[i - 1][0], radius, v); pts.push(v.x, v.y, v.z);
      latLonToVec(poly[i][1], poly[i][0], radius, v); pts.push(v.x, v.y, v.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

let borders = null;
fetch('assets/borders.json').then(r => r.json()).then(data => {
  borders = polylineLayer(data, 0xbfe4ff, 0.34, LAYER_R);
  borders.visible = el('cBorders').checked;
  earthGroup.add(borders);
  el('loading').style.display = 'none';
}).catch(e => toast('No se pudieron cargar las fronteras: ' + e.message));

const graticule = (() => {
  const polys = [];
  for (let lon = -180; lon < 180; lon += 15) {
    const p = []; for (let lat = -90; lat <= 90; lat += 2) p.push([lon, lat]); polys.push(p);
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const p = []; for (let lon = -180; lon <= 180; lon += 2) p.push([lon, lat]); polys.push(p);
  }
  const l = polylineLayer(polys, 0x6f86ad, 0.22, LAYER_R * 1.0004);
  l.visible = false;
  return l;
})();
earthGroup.add(graticule);

// --- capa de eclipse: línea central, huellas, etiquetas, umbra viva ----------
const eclipseLayer = new THREE.Group();
earthGroup.add(eclipseLayer);
const labelLayer = new THREE.Group();
earthGroup.add(labelLayer);
let eclipseData = null;

function textSprite(text) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = '600 30px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  c.width = w; c.height = 40;
  const g = c.getContext('2d');
  g.font = '600 30px system-ui, sans-serif';
  g.fillStyle = 'rgba(8,10,16,0.45)';
  g.fillRect(0, 0, w, 40);
  g.fillStyle = '#ffd08a';
  g.textBaseline = 'middle';
  g.fillText(text, 8, 21);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), depthWrite: false, transparent: true,
  }));
  s.userData.aspect = w / 52;
  return s;
}

function drawEclipse(data) {
  eclipseLayer.clear();
  labelLayer.clear();
  eclipseData = data;
  const g = data.greatest;
  el('scrub').disabled = true;

  if (data.kind === 'partial') {
    el('eclInfo').innerHTML = `
      <div class="kv"><span class="dim">Tipo</span><b class="hot">Parcial</b></div>
      <div class="kv"><span class="dim">Máximo (UTC)</span><b>${g.utc.slice(11, 19)}</b></div>
      <div class="kv"><span class="dim">Sobre</span><b>${fmtLatLon(g.lat, g.lon)}</b></div>
      <div class="kv"><span class="dim">Sol oculto (máx.)</span><b>${(g.obscuration * 100).toFixed(1)} %</b></div>`;
    return;
  }

  const line = data.central_line;

  const band = new THREE.Group();
  band.add(polylineLayer([data.north_limit], 0xffa03c, 0.85, LAYER_R * 1.0008));
  band.add(polylineLayer([data.south_limit], 0xffa03c, 0.85, LAYER_R * 1.0008));
  band.name = 'band';
  band.visible = el('cBand').checked;
  eclipseLayer.add(band);

  const centre = polylineLayer([line.map(p => [p.lon, p.lat])], 0xff3b1f, 0.95, LAYER_R * 1.001);
  eclipseLayer.add(centre);

  const rings = new THREE.Group();
  for (const o of data.outlines) {
    const closed = o.ring.concat([o.ring[0]]);
    rings.add(polylineLayer([closed], 0xffe08a, 0.5, LAYER_R * 1.0012));
  }
  rings.visible = el('cOutlines').checked;
  rings.name = 'outlines';
  eclipseLayer.add(rings);

  const every = Math.max(1, Math.floor(line.length / 9));
  for (let i = 0; i < line.length; i += every) {
    const p = line[i];
    const s = textSprite(p.utc.slice(11, 16) + 'Z');
    latLonToVec(p.lat, p.lon, LAYER_R * 1.004, s.position);
    labelLayer.add(s);
  }
  labelLayer.visible = el('cLabels').checked;
  eclipseLayer.visible = el('cPath').checked;

  const sc = el('scrub');
  sc.max = line.length - 1; sc.disabled = false;
  sc.value = line.findIndex(p => p.utc === data.greatest.utc) || Math.floor(line.length / 2);

  el('eclInfo').innerHTML = `
    <div class="kv"><span class="dim">Tipo</span><b class="hot">${g.kind === 'total' ? 'Total' : 'Anular'}</b></div>
    <div class="kv"><span class="dim">Máximo (UTC)</span><b>${g.utc.slice(11, 19)}</b></div>
    <div class="kv"><span class="dim">Sobre</span><b>${fmtLatLon(g.lat, g.lon)}</b></div>
    <div class="kv"><span class="dim">Banda máx.</span><b>${g.width_km} km</b></div>
    <div class="kv"><span class="dim">Duración máx.</span><b>${fmtDur(g.duration_s)}</b></div>
    <div class="kv"><span class="dim">Sombra en tierra</span><b>${data.begin_utc.slice(11, 16)} → ${data.end_utc.slice(11, 16)}Z</b></div>`;
}

// Contorno vivo de la umbra: cono tangente Sol-Luna contra el elipsoide, en ejes de malla.
const umbraRing = new THREE.LineLoop(
  new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(96 * 3), 3)),
  new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.9 }),
);
const umbraGlow = new THREE.LineLoop(umbraRing.geometry, new THREE.LineBasicMaterial({ color: 0xff3b1f, transparent: true, opacity: 0.85 }));
earthGroup.add(umbraRing, umbraGlow);

const W_MESH = new THREE.Vector3(1 / (A_KM * A_KM), 1 / (B_KM * B_KM), 1 / (A_KM * A_KM));
function ellipsoidRoots(o, d) {
  const a = W_MESH.x * d.x * d.x + W_MESH.y * d.y * d.y + W_MESH.z * d.z * d.z;
  const b = 2 * (W_MESH.x * o.x * d.x + W_MESH.y * o.y * d.y + W_MESH.z * o.z * d.z);
  const c = W_MESH.x * o.x * o.x + W_MESH.y * o.y * o.y + W_MESH.z * o.z * o.z - 1;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return null;
  const r = Math.sqrt(disc);
  return [(-b - r) / (2 * a), (-b + r) / (2 * a)];
}

const _tmp = Array.from({ length: 8 }, () => new THREE.Vector3());
function updateUmbraRing(sunMesh, moonMesh_km) {
  const axis = _tmp[0].copy(moonMesh_km).sub(sunMesh);
  const dsm = axis.length();
  axis.divideScalar(dsm);
  const sinF = (SUN_R_KM - MOON_R_KM) / dsm, cosF = Math.sqrt(1 - sinF * sinF);
  const apex = _tmp[1].copy(axis).multiplyScalar(MOON_R_KM * cosF / sinF).add(moonMesh_km);
  const ref = Math.abs(axis.y) > 0.9 ? _tmp[2].set(1, 0, 0) : _tmp[2].set(0, 1, 0);
  const w1 = _tmp[3].crossVectors(axis, ref).normalize();
  const w2 = _tmp[4].crossVectors(axis, w1);
  const arr = umbraRing.geometry.attributes.position.array;
  let ok = 0;
  const d = _tmp[5], p = _tmp[6], q = _tmp[7];
  for (let i = 0; i < 96; i++) {
    const th = i / 96 * Math.PI * 2;
    d.copy(axis).multiplyScalar(cosF)
      .addScaledVector(w1, -sinF * Math.cos(th))
      .addScaledVector(w2, -sinF * Math.sin(th));
    const roots = ellipsoidRoots(apex, d);
    if (!roots) break;
    p.copy(d).multiplyScalar(roots[0]).add(apex);
    q.copy(d).multiplyScalar(roots[1]).add(apex);
    if (q.distanceTo(moonMesh_km) < p.distanceTo(moonMesh_km)) p.copy(q);
    const [lat, lon] = vecToLatLon(p);
    latLonToVec(lat, lon, LAYER_R * 1.0006, q);
    arr.set([q.x, q.y, q.z], i * 3);
    ok++;
  }
  const visible = ok === 96;
  umbraRing.visible = umbraGlow.visible = visible;
  if (visible) umbraRing.geometry.attributes.position.needsUpdate = true;
}

// --- traza de la órbita lunar ------------------------------------------------
const TRAIL_MAX = 6000;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
trailGeo.setDrawRange(0, 0);
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x5a9bff, transparent: true, opacity: 0.45 }));
trail.visible = false;
scene.add(trail);
let trailCount = 0;
function pushTrail(v) {
  const arr = trailGeo.attributes.position.array;
  if (trailCount === TRAIL_MAX) { arr.copyWithin(0, 3); trailCount--; }
  arr.set([v.x, v.y, v.z], trailCount * 3);
  trailCount++;
  trailGeo.setDrawRange(0, trailCount);
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.computeBoundingSphere();
}
const clearTrail = () => { trailCount = 0; trailGeo.setDrawRange(0, 0); };

// --- marcador de punto elegido ----------------------------------------------
const pickMarker = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_UNITS * 0.006, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x66ffcc }),
);
pickMarker.visible = false;
earthGroup.add(pickMarker);
let pickLatLon = null;

// --- efemérides: serie interpolada localmente -------------------------------
let currentMs = Date.now();
let playing = false, dirSign = 1, speed = 1, realScale = true;
let ser = null, serPromise = null;

const SER_N = 121;
const stepForSpeed = () => Math.min(3600, Math.max(1, Math.round(Math.abs(speed) * 0.3)));

function ensureSeries(ms) {
  const step = stepForSpeed();
  if (ser && ser.stepS === step && ms > ser.t0 + ser.stepMs && ms < ser.t1 - ser.stepMs) return Promise.resolve();
  if (serPromise) return serPromise;
  serPromise = (async () => {
    const spanMs = step * (SER_N - 1) * 1000;
    const t0 = Math.round((ms - spanMs * (playing ? (dirSign > 0 ? 0.25 : 0.75) : 0.5)) / 1000) * 1000;
    const iso = new Date(t0).toISOString().replace(/\.\d+Z$/, 'Z');
    const r = await fetch(`/api/series?start=${encodeURIComponent(iso)}&step_s=${step}&n=${SER_N}`);
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    ser = {
      t0, stepS: step, stepMs: step * 1000, n: d.n,
      t1: t0 + step * (d.n - 1) * 1000,
      moon: d.moon_km.map(v => new THREE.Vector3(v[0], v[1], v[2])),
      sun: d.sun_km.map(v => new THREE.Vector3(v[0], v[1], v[2])),
      quat: d.earth_mesh.map(m => new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1))),
      umbra: d.umbra,
    };
  })().catch(e => toast('Error pidiendo efemérides: ' + e.message))
      .finally(() => { serPromise = null; });
  return serPromise;
}

async function waitForSeries(ms) {
  for (let i = 0; i < 10; i++) {
    await ensureSeries(ms);
    if (ser && ms > ser.t0 && ms < ser.t1) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

const moonKm = new THREE.Vector3(), sunKm = new THREE.Vector3(), earthQuat = new THREE.Quaternion();
let umbraLatLon = null;

function lerpLatLon(a, b, f) {
  if (!a) return b; if (!b) return a;
  let dlon = b[1] - a[1];
  if (dlon > 180) dlon -= 360; else if (dlon < -180) dlon += 360;
  return [a[0] + (b[0] - a[0]) * f, a[1] + dlon * f];
}

function sampleEphemeris(ms) {
  if (!ser) return false;
  const f = (ms - ser.t0) / ser.stepMs;
  const i = Math.max(0, Math.min(ser.n - 2, Math.floor(f)));
  const a = Math.max(-1, Math.min(2, f - i));
  moonKm.lerpVectors(ser.moon[i], ser.moon[i + 1], a);
  sunKm.lerpVectors(ser.sun[i], ser.sun[i + 1], a);
  earthQuat.slerpQuaternions(ser.quat[i], ser.quat[i + 1], Math.max(0, Math.min(1, a)));
  umbraLatLon = lerpLatLon(ser.umbra[i], ser.umbra[i + 1], Math.max(0, Math.min(1, a)));
  return true;
}

function applyEphemeris() {
  const f = realScale ? KM_TO_UNIT : KM_TO_UNIT * COMPRESSED_FACTOR;
  moonMesh.position.copy(moonKm).multiplyScalar(f);
  earthGroup.quaternion.copy(earthQuat);
  earthUniforms.sunKm.value.copy(sunKm);
  earthUniforms.moonKm.value.copy(moonKm);
  earthUniforms.poleW.value.set(0, 1, 0).applyQuaternion(earthQuat);

  moonUniforms.sunKm.value.copy(sunKm);
  moonUniforms.moonKm.value.copy(moonKm);
  moonUniforms.moonScene.value.copy(moonMesh.position);

  const sdir = _sun.copy(sunKm).normalize();
  sunSprite.position.copy(sdir).multiplyScalar(60000);

  // Cara visible de la Luna siempre hacia la Tierra (sin libración).
  const x = _mx.copy(moonMesh.position).negate().normalize();
  const z = _mz.crossVectors(x, _up).normalize();
  moonMesh.quaternion.setFromRotationMatrix(_m4.makeBasis(x, _my.crossVectors(z, x), z));

  // La umbra se calcula en ejes de malla: Sol y Luna llevados al marco terrestre.
  const inv = _q.copy(earthQuat).invert();
  updateUmbraRing(_sm.copy(sunKm).applyQuaternion(inv), _mm.copy(moonKm).applyQuaternion(inv));
}
const _sun = new THREE.Vector3(), _mx = new THREE.Vector3(), _my = new THREE.Vector3(),
  _mz = new THREE.Vector3(), _up = new THREE.Vector3(0, 0, 1), _m4 = new THREE.Matrix4(),
  _q = new THREE.Quaternion(), _sm = new THREE.Vector3(), _mm = new THREE.Vector3();

// --- HUD ---------------------------------------------------------------------
const fmtLatLon = (lat, lon) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
const fmtDur = (s) => s == null ? '—' : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
const isoUTC = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const madridFmt = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', hour12: false, day: '2-digit', month: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function occultation(pkm) {
  const ds = _o1.copy(sunKm).sub(pkm), dm = _o2.copy(moonKm).sub(pkm);
  const rs = Math.asin(SUN_R_KM / ds.length()), rm = Math.asin(MOON_R_KM / dm.length());
  const d = Math.acos(Math.max(-1, Math.min(1, ds.normalize().dot(dm.normalize()))));
  if (d >= rs + rm) return 0;
  if (d <= rm - rs) return 1;
  if (d <= rs - rm) return (rm * rm) / (rs * rs);
  const a1 = Math.acos(Math.max(-1, Math.min(1, (d * d + rm * rm - rs * rs) / (2 * d * rm))));
  const a2 = Math.acos(Math.max(-1, Math.min(1, (d * d + rs * rs - rm * rm) / (2 * d * rs))));
  const lens = rm * rm * a1 + rs * rs * a2
    - 0.5 * Math.sqrt(Math.max(0, (rm + rs - d) * (d + rm - rs) * (d - rm + rs) * (d + rm + rs)));
  return Math.max(0, Math.min(1, lens / (Math.PI * rs * rs)));
}
const _o1 = new THREE.Vector3(), _o2 = new THREE.Vector3(), _pw = new THREE.Vector3();

// Estado del eclipse lunar en el instante actual (magnitudes = fracción del diámetro).
const _lv = new THREE.Vector3();
function lunarEclipseState() {
  const dse = sunKm.length(), dem = moonKm.length();
  if (dem < 1e-6 || dse < 1e-6) return null;
  const axis = _lv.copy(sunKm).negate().normalize();
  const miss = Math.sqrt(Math.max(0, moonKm.lengthSq() - moonKm.dot(axis) * moonKm.dot(axis)));
  const rUmb = EARTH_R_KM - dem * (SUN_R_KM - EARTH_R_KM) / dse;
  const rPen = EARTH_R_KM + dem * (SUN_R_KM + EARTH_R_KM) / dse;
  return {
    umbral: (rUmb + MOON_R_KM - miss) / (2 * MOON_R_KM),
    penumbral: (rPen + MOON_R_KM - miss) / (2 * MOON_R_KM),
  };
}

function nearestLinePoint(ms) {
  if (!eclipseData) return null;
  const line = eclipseData.central_line;
  if (!line.length) return null;
  const i0 = Math.round((ms - Date.parse(line[0].utc)) / 20000);
  if (i0 < -3 || i0 > line.length + 2) return null;
  for (const i of [i0, i0 - 1, i0 + 1, i0 - 2, i0 + 2]) {
    if (line[i] && line[i].width_km) return line[i];
  }
  return null;
}

function updateHUD() {
  el('utc').textContent = isoUTC(currentMs);
  el('local').textContent = madridFmt.format(new Date(currentMs));
  el('dist').textContent = Math.round(moonKm.length()).toLocaleString('es-ES') + ' km';

  if (umbraLatLon) {
    el('umbra').textContent = fmtLatLon(umbraLatLon[0], umbraLatLon[1]);
    const p = nearestLinePoint(currentMs);
    el('umbraW').innerHTML = p && p.width_km
      ? `<span class="hot">${p.width_km} km · ${fmtDur(p.duration_s)}</span>`
      : '<span class="dim">calcula la trayectoria</span>';
  } else {
    el('umbra').innerHTML = '<span class="dim">no toca la Tierra</span>';
    el('umbraW').textContent = '—';
  }

  const lun = lunarEclipseState();
  if (!lun || lun.penumbral <= 0) {
    el('lunar').innerHTML = '<span class="dim">no</span>';
  } else if (lun.umbral >= 1) {
    el('lunar').innerHTML = '<span class="hot">TOTAL</span>';
  } else if (lun.umbral > 0) {
    el('lunar').innerHTML = `<span class="hot">parcial · ${(lun.umbral * 100).toFixed(0)} %</span>`;
  } else {
    el('lunar').textContent = 'penumbral';
  }

  if (pickLatLon) {
    latLonToVec(pickLatLon[0], pickLatLon[1], EARTH_UNITS, _pw);
    _pw.applyQuaternion(earthQuat).multiplyScalar(UNIT_TO_KM);
    const cov = occultation(_pw);
    const n = _o1.copy(_pw).normalize();
    const alt = Math.asin(n.dot(_o2.copy(sunKm).sub(_pw).normalize())) * R2D;
    el('pickPos').textContent = fmtLatLon(pickLatLon[0], pickLatLon[1]);
    el('pickCov').innerHTML = cov > 0.999 ? '<span class="hot">100% · TOTAL</span>'
      : `${(cov * 100).toFixed(1)} %`;
    el('pickAlt').innerHTML = alt < 0 ? `<span class="warn">${alt.toFixed(1)}° (bajo el horizonte)</span>`
      : `${alt.toFixed(1)}°`;
  }
}

// --- UI ----------------------------------------------------------------------
const toInput = (ms) => new Date(ms).toISOString().slice(0, 19);
function setTime(ms, refetch) {
  currentMs = ms;
  el('date').value = toInput(ms);
  if (refetch) ser = null;
}

el('go').addEventListener('click', () => {
  const v = el('date').value;
  if (!v) return;
  const ms = Date.parse(v.length <= 16 ? v + ':00Z' : v + 'Z');
  if (Number.isNaN(ms)) return toast('Fecha no válida');
  clearTrail();
  setTime(ms, true);
});
el('now').addEventListener('click', () => { clearTrail(); setTime(Date.now(), true); });

document.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => {
  setTime(currentMs + Number(b.dataset.jump) * 1000, true);
}));

el('play').addEventListener('click', () => {
  playing = !playing;
  el('play').textContent = playing ? '⏸ Pausa' : '▶ Reproducir';
  el('play').classList.toggle('on', playing);
});
el('dir').addEventListener('click', () => {
  dirSign = -dirSign;
  el('dir').textContent = dirSign > 0 ? '▶ Adelante' : '◀ Atrás';
  ser = null;
});

function fmtSpeed(v) {
  if (v < 60) return `${v.toFixed(v < 10 ? 1 : 0)} s/s`;
  if (v < 3600) return `${(v / 60).toFixed(1)} min/s`;
  if (v < 86400) return `${(v / 3600).toFixed(1)} h/s`;
  return `${(v / 86400).toFixed(2)} d/s`;
}
el('speed').addEventListener('input', (e) => {
  speed = Math.pow(10, Number(e.target.value) / 100 * 6);
  el('speedLabel').textContent = fmtSpeed(speed) + (dirSign < 0 ? ' (hacia atrás)' : '');
  ser = null;
});
el('speed').dispatchEvent(new Event('input'));

el('preset').addEventListener('change', (e) => {
  if (!e.target.value) return;
  el('date').value = e.target.value + 'T12:00:00';
  findEclipse();
});

el('lunarPreset').addEventListener('change', (e) => {
  if (!e.target.value) return;
  el('date').value = e.target.value + 'T12:00:00';
  findLunarEclipse();
});

async function findEclipse() {
  const v = el('date').value || toInput(currentMs);
  const iso = v.slice(0, 10) + 'T12:00:00Z';
  el('find').textContent = 'Calculando…';
  try {
    const r = await fetch(`/api/eclipse?iso=${encodeURIComponent(iso)}&window_h=24`);
    const d = await r.json();
    if (!d.found) {
      eclipseData = null;
      eclipseLayer.clear(); labelLayer.clear();
      el('eclInfo').innerHTML = `<span class="warn">Sin eclipse solar ese día.</span>
        <span class="dim">El eje de sombra pasa a ${Math.round(d.axis_min_km / 1000)} mil km del centro de la Tierra.</span>`;
      el('scrub').disabled = true;
      return;
    }
    drawEclipse(d);
    setTime(Date.parse(d.greatest.utc), true);
    playing = false;
    el('play').textContent = '▶ Reproducir';
    el('play').classList.remove('on');
    el('speed').value = 30; el('speed').dispatchEvent(new Event('input'));
    await waitForSeries(currentMs);
    sampleEphemeris(currentMs); applyEphemeris();
    if (d.kind === 'partial') focusLatLon(d.greatest.lat, d.greatest.lon, 2.4);
    else focusShadow(2.4);
  } catch (e) {
    toast('Error calculando el eclipse: ' + e.message);
  } finally {
    el('find').textContent = 'Calcular sombra de esta fecha';
  }
}
el('find').addEventListener('click', findEclipse);

async function findLunarEclipse() {
  const v = el('lunarPreset').value || el('date').value.slice(0, 10);
  const iso = v.slice(0, 10) + 'T12:00:00Z';
  el('findLunar').textContent = 'Calculando…';
  try {
    const r = await fetch(`/api/lunar_eclipse?iso=${encodeURIComponent(iso)}&window_h=24`);
    const d = await r.json();
    if (!d.found) {
      el('lunarInfo').innerHTML = '<span class="warn">Sin eclipse lunar ese día.</span>';
      return;
    }
    const g = d.greatest;
    const kindTxt = d.kind === 'total' ? 'Total' : d.kind === 'partial' ? 'Parcial' : 'Penumbral';
    el('lunarInfo').innerHTML = `
      <div class="kv"><span class="dim">Tipo</span><b class="hot">${kindTxt}</b></div>
      <div class="kv"><span class="dim">Máximo (UTC)</span><b>${g.utc.slice(11, 19)}</b></div>
      <div class="kv"><span class="dim">Magnitud umbral</span><b>${g.umbral_magnitude.toFixed(2)}</b></div>
      <div class="kv"><span class="dim">Magnitud penumbral</span><b>${g.penumbral_magnitude.toFixed(2)}</b></div>
      <div class="kv"><span class="dim">Sombra sobre la Luna</span><b>${d.begin_utc ? d.begin_utc.slice(11, 16) + ' → ' + d.end_utc.slice(11, 16) + 'Z' : '—'}</b></div>`;
    setTime(Date.parse(g.utc), true);
    playing = false;
    el('play').textContent = '▶ Reproducir';
    el('play').classList.remove('on');
    await waitForSeries(currentMs);
    sampleEphemeris(currentMs); applyEphemeris();
    focusMoon(7);
  } catch (e) {
    toast('Error calculando el eclipse lunar: ' + e.message);
  } finally {
    el('findLunar').textContent = 'Calcular eclipse lunar';
  }
}
el('findLunar').addEventListener('click', findLunarEclipse);

el('scrub').addEventListener('input', (e) => {
  if (!eclipseData) return;
  const p = eclipseData.central_line[Number(e.target.value)];
  playing = false;
  el('play').textContent = '▶ Reproducir';
  el('play').classList.remove('on');
  setTime(Date.parse(p.utc), true);
});

el('clearPath').addEventListener('click', () => {
  eclipseData = null;
  eclipseLayer.clear(); labelLayer.clear();
  el('eclInfo').innerHTML = '';
  el('scrub').disabled = true;
});

// Cámara: reencuadres y seguimiento de la sombra.
let follow = false;
const _t = new THREE.Vector3();
function focusWorld(target, distFactor) {
  const dir = target.length() > 1e-3
    ? target.clone().normalize()
    : camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(target);
  camera.position.copy(target).addScaledVector(dir, EARTH_UNITS * distFactor);
  controls.update();
}
function focusLatLon(lat, lon, distFactor) {
  latLonToVec(lat, lon, EARTH_UNITS, _t).applyQuaternion(earthQuat);
  focusWorld(_t, distFactor);
}
function focusShadow(distFactor, quiet) {
  if (!umbraLatLon) {
    if (!quiet) toast('La sombra no toca la Tierra en este instante');
    return;
  }
  focusLatLon(umbraLatLon[0], umbraLatLon[1], distFactor ?? 1.2);
}
el('focusShadow').addEventListener('click', () => focusShadow(0.9));
el('follow').addEventListener('click', (e) => {
  follow = !follow;
  e.target.classList.toggle('on', follow);
  if (follow) focusShadow(0.9, true);
});
el('viewEarth').addEventListener('click', () => { follow = false; el('follow').classList.remove('on'); focusWorld(_t.set(0, 0, 0), 2.6); });
el('viewSpain').addEventListener('click', () => { follow = false; el('follow').classList.remove('on'); focusLatLon(40.3, -3.7, 1.1); });
function focusMoon(dist) {
  follow = false; el('follow').classList.remove('on');
  controls.target.copy(moonMesh.position);
  const dir = moonMesh.position.lengthSq() > 1e-3
    ? _t.copy(moonMesh.position).normalize()
    : _t.set(0, 0, 1);
  camera.position.copy(moonMesh.position).addScaledVector(dir, dist ?? 14);
  controls.update();
}
el('viewMoon').addEventListener('click', () => focusMoon(14));

// Abre el visor en tierra pasando el punto elegido (o un valor por defecto) y la fecha actual.
el('openViewer').addEventListener('click', () => {
  const la = pickLatLon ? pickLatLon[0] : 40.3;
  const lo = pickLatLon ? pickLatLon[1] : -3.7;
  location.href = `/viewer?lat=${la.toFixed(4)}&lon=${lo.toFixed(4)}&date=${encodeURIComponent(toInput(currentMs))}`;
});
el('viewSide').addEventListener('click', () => {
  follow = false; el('follow').classList.remove('on');
  controls.target.set(0, 0, 0);
  const d = moonMesh.position.length() * 1.25 + 40;
  camera.position.copy(_t.crossVectors(moonMesh.position, _up).normalize().multiplyScalar(d)).setZ(d * 0.25);
});

const bind = (id, fn) => el(id).addEventListener('change', (e) => fn(e.target.checked));
bind('cBorders', v => { if (borders) borders.visible = v; });
bind('cGrid', v => { graticule.visible = v; });
bind('cPath', v => { eclipseLayer.visible = v; });
bind('cOutlines', v => { const g = eclipseLayer.getObjectByName('outlines'); if (g) g.visible = v; });
bind('cBand', v => { const g = eclipseLayer.getObjectByName('band'); if (g) g.visible = v; });
bind('cLabels', v => { labelLayer.visible = v; });
bind('cShadow', v => { earthUniforms.eclipseOn.value = v ? 1 : 0; });
bind('cNight', v => { earthUniforms.nightOn.value = v ? 1 : 0; });
bind('cTrail', v => { trail.visible = v; });
bind('cStars', v => { stars.visible = v; });
bind('cScale', v => { realScale = v; clearTrail(); });

// Clic sobre la Tierra: mide la ocultación en ese punto.
const ray = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObject(earthMesh, false)[0];
  if (!hit) return;
  pickLatLon = vecToLatLon(earthMesh.worldToLocal(hit.point.clone()));
  latLonToVec(pickLatLon[0], pickLatLon[1], LAYER_R, pickMarker.position);
  pickMarker.visible = true;
  el('pickBox').style.display = 'block';
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- enlace directo: ?date=2026-08-12T18:28:00&eclipse=1&view=shadow&zoom=0.6 -
let last = performance.now(), hudAcc = 0, trailAcc = 0;
setTime(currentMs, true);

(async () => {
  const q = new URLSearchParams(location.search);
  const d = q.get('date');
  const ms = d ? Date.parse(d.length <= 16 ? d + ':00Z' : d + 'Z') : NaN;
  if (!Number.isNaN(ms)) setTime(ms, true);
  if (q.get('eclipse')) await findEclipse();
  if (!Number.isNaN(ms)) setTime(ms, true);      // findEclipse salta al máximo
  await waitForSeries(currentMs);
  sampleEphemeris(currentMs);
  applyEphemeris();
  const zoom = Number(q.get('zoom')) || undefined;
  const view = q.get('view');
  if (view === 'shadow') focusShadow(zoom ?? 0.9);
  else if (view === 'spain') focusLatLon(40.3, -3.7, zoom ?? 1.1);
  else if (view === 'earth') focusWorld(_t.set(0, 0, 0), zoom ?? 2.6);
  window.__ready = true;
})();

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (playing) setTime(currentMs + dt * speed * dirSign * 1000, false);
  ensureSeries(currentMs);

  if (sampleEphemeris(currentMs)) {
    applyEphemeris();
    if (follow && umbraLatLon) {
      const before = _t.copy(controls.target);
      latLonToVec(umbraLatLon[0], umbraLatLon[1], EARTH_UNITS, controls.target).applyQuaternion(earthQuat);
      camera.position.add(_t.copy(controls.target).sub(before));
    }
    trailAcc += dt;
    if (trail.visible && trailAcc > 0.05) { trailAcc = 0; pushTrail(moonMesh.position); }
  }

  hudAcc += dt;
  if (hudAcc > 0.1) { hudAcc = 0; updateHUD(); }

  // Etiquetas de hora a tamaño aparente constante.
  const camDist = camera.position.length();
  for (const s of labelLayer.children) {
    const k = Math.max(0.02, camDist - EARTH_UNITS) * 0.018;
    s.scale.set(k * s.userData.aspect, k, 1);
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();
