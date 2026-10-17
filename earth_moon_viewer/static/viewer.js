// Visor desde un punto de la Tierra: elige un punto en el mapa y mira cómo el Sol
// desaparece tras la Luna durante un eclipse solar.
'use strict';

const el = (id) => document.getElementById(id);
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// --- estado -----------------------------------------------------------------
let lat = 40.3, lon = -3.7;
let cur = Date.now();
let playing = false, dirSign = 1, speed = 30;   // segundos simulados por segundo real
let lastData = null, lastFetch = 0;

// Leer punto y fecha de la URL antes de montar el mapa.
{
  const q = new URLSearchParams(location.search);
  if (q.get('lat')) lat = Number(q.get('lat'));
  if (q.get('lon')) lon = Number(q.get('lon'));
  const d = q.get('date');
  const ms = d ? Date.parse(d.length <= 16 ? d + ':00Z' : d + 'Z') : NaN;
  if (!Number.isNaN(ms)) cur = ms;
  var urlZoom = q.get('zoom') ? Number(q.get('zoom')) : 5;
}

const fmtLatLon = (la, lo) =>
  `${Math.abs(la).toFixed(4)}°${la >= 0 ? 'N' : 'S'} ${Math.abs(lo).toFixed(4)}°${lo >= 0 ? 'E' : 'W'}`;
const toInput = (ms) => new Date(ms).toISOString().slice(0, 16);   // datetime-local (UTC)

// --- mapa (MapLibre GL: terreno 3D + base topográfica) -----------------------
const terrainSource = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  tileSize: 256,
  encoding: 'terrarium',
  maxzoom: 15,
  attribution: 'Elevación © AWS Terrain Tiles',
};

const style = {
  version: 8,
  sources: {
    topo: {
      type: 'raster',
      tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
      tileSize: 256, maxzoom: 17,
      attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) · &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    osm: {
      type: 'raster',
      tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256, maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256, maxzoom: 19,
      attribution: 'Tiles &copy; Esri',
    },
    terrain: terrainSource,
  },
  layers: [
    { id: 'topo', type: 'raster', source: 'topo' },
    { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
    { id: 'esri', type: 'raster', source: 'esri', layout: { visibility: 'none' } },
  ],
};

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [lon, lat],
  zoom: urlZoom,
  pitch: 45,
  maxPitch: 85,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

map.on('load', () => {
  map.setTerrain({ source: 'terrain', exaggeration: 1 });
  map.setLight({
    anchor: 'map',
    color: '#ffffff',
    intensity: 0.55,
    position: [1.5, 90, 55],   // [radial, azimuth, polar] — luz cenital ligeramente lateral
  });
});

// marcador del punto de observación
const markerEl = document.createElement('div');
markerEl.className = 'obs-marker';
markerEl.innerHTML = '<div class="dot"></div>';
const marker = new maplibregl.Marker({ element: markerEl, anchor: 'center' })
  .setLngLat([lon, lat])
  .addTo(map);

map.on('click', (e) => {
  lat = e.lngLat.lat;
  lon = e.lngLat.lng;
  marker.setLngLat([lon, lat]);
  syncLatLon();
  refresh(true);
});

// capa base + terreno
function setBase(id) {
  for (const layer of ['topo', 'osm', 'esri']) {
    map.setLayoutProperty(layer, 'visibility', layer === id ? 'visible' : 'none');
  }
}
function setExag(v) {
  map.setTerrain({ source: 'terrain', exaggeration: v });
}

function syncLatLon() {
  el('lat').textContent = `${lat.toFixed(4)}°${lat >= 0 ? 'N' : 'S'}`;
  el('lon').textContent = `${lon.toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
  const u = new URL(location.href);
  u.searchParams.set('lat', lat.toFixed(4));
  u.searchParams.set('lon', lon.toFixed(4));
  history.replaceState(null, '', u);
}
syncLatLon();

// --- petición al backend -----------------------------------------------------
async function refresh(force) {
  const now = performance.now();
  if (!force && now - lastFetch < 120) return;
  lastFetch = now;
  try {
    const iso = new Date(cur).toISOString().replace(/\.\d+Z$/, 'Z');
    const r = await fetch(`/api/observer?iso=${encodeURIComponent(iso)}&lat=${lat}&lon=${lon}`);
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    lastData = d;
    el('err').textContent = '';
    render(d);
  } catch (e) {
    el('err').textContent = 'Error: ' + e.message;
  }
}

// --- dibujo del cielo (bóveda polar) ----------------------------------------
const skyCv = el('sky'), skyG = skyCv.getContext('2d');
const CX = 150, CY = 150, R = 138;

function azAltToXY(az, alt) {
  const r = R * (1 - alt / 90);
  const a = az * D2R;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

function drawSky(d) {
  const g = skyG, W = 300, H = 300;
  g.clearRect(0, 0, W, H);

  // anillos de altura
  g.lineWidth = 1;
  for (const alt of [30, 60]) {
    const r = R * (1 - alt / 90);
    g.beginPath(); g.arc(CX, CY, r, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(255,255,255,0.10)'; g.stroke();
  }
  g.beginPath(); g.arc(CX, CY, R, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.stroke();

  // puntos cardinales
  g.fillStyle = '#8fa3c8'; g.font = '600 12px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('N', CX, CY - R - 12);
  g.fillText('E', CX + R + 16, CY);
  g.fillText('S', CX, CY + R + 12);
  g.fillText('W', CX - R - 16, CY);

  // Sol
  if (d.sun.alt >= -0.5) {
    const [x, y] = azAltToXY(d.sun.az, d.sun.alt);
    const rr = Math.max(5, d.sun.radius_deg * 30);
    const gl = g.createRadialGradient(x, y, 0, x, y, rr * 3.4);
    gl.addColorStop(0, 'rgba(255,220,150,0.9)');
    gl.addColorStop(0.35, 'rgba(255,180,80,0.28)');
    gl.addColorStop(1, 'rgba(255,180,80,0)');
    g.fillStyle = gl;
    g.beginPath(); g.arc(x, y, rr * 3.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff2c8';
    g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }

  // Luna (delante del Sol cuando lo oculta)
  if (d.moon.alt >= -0.5) {
    const [x, y] = azAltToXY(d.moon.az, d.moon.alt);
    const rr = Math.max(5, d.moon.radius_deg * 30);
    g.fillStyle = '#c8d0dc';
    g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(20,24,34,0.55)'; g.lineWidth = 1;
    g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.stroke();
  }
}

// --- dibujo del disco solar (la Luna tapando al Sol) -------------------------
const cuCv = el('closeup'), cuG = cuCv.getContext('2d');
const PX = 200;   // píxeles por grado en el acercamiento

function drawCloseup(d) {
  const g = cuG, W = 240, H = 240, c = 120;
  g.clearRect(0, 0, W, H);

  // cielo
  const bg = g.createRadialGradient(c, c, 10, c, c, 170);
  bg.addColorStop(0, '#0b1224');
  bg.addColorStop(1, '#05070d');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  const sunR = d.sun.radius_deg * PX;
  const moonR = d.moon.radius_deg * PX;
  const sep = d.separation_deg * PX;
  const pa = d.position_angle_deg * D2R;
  const mx = Math.sin(pa) * sep;
  const my = -Math.cos(pa) * sep;

  // Sol
  if (d.sun.alt >= -0.5) {
    const gl = g.createRadialGradient(c, c, sunR * 0.2, c, c, sunR * 3);
    gl.addColorStop(0, '#fffbe8');
    gl.addColorStop(0.35, '#ffe8a0');
    gl.addColorStop(0.75, 'rgba(255,200,90,0.35)');
    gl.addColorStop(1, 'rgba(255,200,90,0)');
    g.fillStyle = gl;
    g.beginPath(); g.arc(c, c, sunR * 3, 0, Math.PI * 2); g.fill();

    const core = g.createRadialGradient(c, c, 0, c, c, sunR);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(1, '#ffd76e');
    g.fillStyle = core;
    g.beginPath(); g.arc(c, c, sunR, 0, Math.PI * 2); g.fill();
  }

  // Luna tapando el Sol (nueva = disco oscuro)
  const mxc = c + mx, myc = c + my;
  const visible = Math.hypot(mx, my) < sunR + moonR + 2;   // solo dibujar si está cerca
  if (visible && d.moon.alt >= -0.5) {
    // corona en totalidad
    if (d.obscuration > 0.98) {
      const corona = g.createRadialGradient(c, c, sunR * 0.8, c, c, sunR * 1.6);
      corona.addColorStop(0, 'rgba(255,255,255,0.95)');
      corona.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = corona;
      g.beginPath(); g.arc(c, c, sunR * 1.6, 0, Math.PI * 2); g.fill();
    }
    const mg = g.createRadialGradient(mxc, myc, moonR * 0.4, mxc, myc, moonR);
    mg.addColorStop(0, '#05070c');
    mg.addColorStop(1, '#131826');
    g.fillStyle = mg;
    g.beginPath(); g.arc(mxc, myc, moonR, 0, Math.PI * 2); g.fill();
  }

  // retícula de escala (un radio solar = 15-16′)
  g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(c, 6); g.lineTo(c, 14); g.moveTo(c, H - 6); g.lineTo(c, H - 14);
  g.moveTo(6, c); g.lineTo(14, c); g.moveTo(W - 6, c); g.lineTo(W - 14, c); g.stroke();
}

// --- textos ----------------------------------------------------------------
function fmtDeg(deg) { return deg.toFixed(1) + '°'; }

function render(d) {
  el('utc').textContent = d.utc.replace('T', ' ').slice(0, 19);

  const obsc = d.obscuration;
  const o = el('obsc');
  if (obsc > 0.999) { o.textContent = 'TOTALIDAD'; o.className = 'total'; }
  else if (obsc > 0.001) { o.textContent = 'Parcial'; o.className = 'partial'; }
  else { o.textContent = 'Sin eclipse'; o.className = 'none'; }

  el('obscPct').innerHTML = obsc > 0.999
    ? '<span class="hot">100 % · eclipse total</span>'
    : `${(obsc * 100).toFixed(1)} %`;
  el('sep').textContent = (d.separation_deg * 60).toFixed(1) + '′';   // minutos de arco

  const sunBelow = d.sun.alt < 0;
  el('sunAltAz').innerHTML = sunBelow
    ? `<span class="warn">${fmtDeg(d.sun.alt)} (bajo el horizonte)</span>`
    : `${fmtDeg(d.sun.alt)} · ${fmtDeg(d.sun.az)}`;
  el('moonAltAz').textContent = `${fmtDeg(d.moon.alt)} · ${fmtDeg(d.moon.az)}`;
  el('radii').textContent = `${(d.sun.radius_deg * 60).toFixed(2)}′ / ${(d.moon.radius_deg * 60).toFixed(2)}′`;

  const frac = obsc > 0.001 ? (1 - obsc) : 1;   // fracción iluminada del Sol
  const phase = frac > 0.5 ? 'Sol visible' : (frac > 0.02 ? 'Sol menguante' : 'Sol cubierto');
  el('phase').textContent = phase;

  drawSky(d);
  drawCloseup(d);
}

// --- controles de tiempo -----------------------------------------------------
function setTimeUI() { el('date').value = toInput(cur); }
setTimeUI();

el('go').addEventListener('click', () => {
  const v = el('date').value;
  if (!v) return;
  const ms = Date.parse(v.length <= 16 ? v + ':00Z' : v + 'Z');
  if (Number.isNaN(ms)) return;
  cur = ms;
  refresh(true);
});
document.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => {
  cur += Number(b.dataset.jump) * 1000;
  setTimeUI();
  refresh(true);
}));

el('play').addEventListener('click', () => {
  playing = !playing;
  el('play').textContent = playing ? '⏸ Pausa' : '▶ Reproducir';
  el('play').classList.toggle('on', playing);
});
el('dir').addEventListener('click', () => {
  dirSign = -dirSign;
  el('dir').textContent = dirSign > 0 ? '▶ Adelante' : '◀ Atrás';
});
function fmtSpeed(v) {
  if (v < 60) return `${v.toFixed(0)} s/s`;
  if (v < 3600) return `${(v / 60).toFixed(1)} min/s`;
  return `${(v / 3600).toFixed(1)} h/s`;
}
el('speed').addEventListener('input', (e) => {
  speed = Math.pow(10, Number(e.target.value) / 100 * 6);
  el('speedLabel').textContent = fmtSpeed(speed) + (dirSign < 0 ? ' (hacia atrás)' : '');
});
el('speed').dispatchEvent(new Event('input'));

// --- terreno 3D -------------------------------------------------------------
el('tilt').addEventListener('click', () => map.easeTo({ pitch: 62, duration: 1200 }));
el('resetView').addEventListener('click', () =>
  map.easeTo({ center: [lon, lat], pitch: 0, bearing: 0, zoom: urlZoom, duration: 1000 }));
el('exag').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  setExag(v);
  el('exagLabel').textContent = v.toFixed(1) + '×';
});
el('base').addEventListener('change', (e) => setBase(e.target.value));

// --- bucle ------------------------------------------------------------------
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (playing) {
    cur += dt * speed * dirSign * 1000;
    setTimeUI();
    refresh(false);
  }
}
loop();
refresh(true);
