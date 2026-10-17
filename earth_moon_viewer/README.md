# Earth & Moon Viewer

Flask + Skyfield backend with a three.js frontend that renders Earth and the Moon from real
ephemeris data, and draws the Moon's shadow on Earth for any solar eclipse.

Run:
```bash
python -m pip install -r requirements.txt
python app.py
# open http://127.0.0.1:5000
```

What it shows
-------------

* **Earth with real geography** — 4096×2048 Blue Marble day map, city-lights night map, ocean
  specular mask and a topographic relief pass, plus country/coastline outlines drawn from
  Natural Earth 50 m data (`static/assets/borders.json`) and an optional 15° graticule.
* **True Earth orientation** — the globe is oriented with the ICRF→ITRS rotation from Skyfield,
  so a given longitude really faces the Sun at a given UTC. The scene axes *are* ICRF
  (celestial north is +Z), which is why `camera.up` is `(0,0,1)`.
* **The Moon's shadow, computed per pixel** — the Earth's fragment shader evaluates how much of
  the solar disc the Moon covers at that exact point (circle–circle overlap of the two apparent
  discs), so the umbra, the antumbra and the whole penumbra gradient come out of the geometry
  instead of being painted on. Darkening uses a perceptual curve so the penumbra does not erase
  the map.
* **Eclipse path** — central line, band-of-totality limits, umbra footprints at intervals with
  UTC labels, and a live footprint outline for the current instant.
* **Time travel** — datetime field, ±10 s … ±1 day steps, forward/reverse playback from 1 s/s to
  ~11.6 days/s, a scrubber along the eclipse path, and a preset list of notable eclipses.
* **Click any point** on the globe for its obscuration percentage and Sun altitude at the
  current instant.

Deep links: `?date=2026-08-12T18:29:00&eclipse=1&view=shadow&zoom=0.5`
(`view` = `shadow` | `spain` | `earth`).

API
---

`GET /api/state?iso=2026-08-12T18:29:00Z`
: Moon and Sun geocentric ICRF positions (km), the 3×3 mesh→ICRF rotation for the globe, and the
  umbra centre (lat/lon, band width, duration, Sun altitude) if the shadow touches the ground.

`GET /api/series?start=<iso>&step_s=30&n=121`
: The same quantities for a uniform time grid. The frontend fetches one window and interpolates
  locally (lerp for positions, slerp for the Earth's rotation) so playback is smooth without a
  request per frame.

`GET /api/eclipse?iso=<iso>&window_h=24`
: Scans the window for a central eclipse and returns the greatest-eclipse instant, the central
  line at 20 s cadence (lat/lon, band width, duration, Sun altitude), the north/south limits of
  the band, and umbra footprint rings. `{"found": false}` when the shadow axis misses Earth.

Geometry notes
--------------

The umbral cone is built from the external tangents to the Sun and Moon spheres
(`sin f = (R_sun − R_moon) / d_sun-moon`), and its axis and boundary rays are intersected with
the WGS84 ellipsoid. The ground footprint is an ellipse: semi-minor `r`, semi-major `r/cos i`
along the tilt direction. *Band width* is the chord of that ellipse across the direction of
motion, and *duration* is the along-track chord divided by the umbra's ground speed (finite
differences in ECEF, so Earth's rotation is included).

Cross-checks for 2026-08-12: greatest eclipse 17:46 UTC at 65.19°N 25.23°W, 282 km band, 2m21s
(published: 17:46, 294 km, 2m18s). Oviedo 1m55s, Zaragoza 1m30s, Valencia 1m05s; Madrid 99.98%
and Barcelona 99.85% — both just outside totality, as they are in reality.

Frontend gotchas
----------------

* three.js r160 is loaded as an ES module through an importmap; `examples/js/` was removed in
  r148, so the old `<script src=".../examples/js/...">` pattern 404s and must not come back.
* `logarithmicDepthBuffer` is on (the scene spans 0.02 to 150000 units). three does not inject
  `isPerspectiveMatrix()` for `ShaderMaterial`, so the custom shaders declare it themselves
  before `#include <logdepthbuf_*>`.
* The atmosphere shell renders back faces, so its shader reflects the normal to recover the
  near-side one; otherwise the rim lights up on the night limb.
* Textures live in `static/assets/` (~4.7 MB) — no external CDN at runtime except three.js itself.

Deploying
---------

Local (dev): `python app.py` → http://127.0.0.1:5000. `FLASK_DEBUG=1` turns on the reloader,
`HOST` / `PORT` override the bind address.

Cloud: the `Dockerfile` serves the app with gunicorn on `$PORT`, which is what Azure Container
Apps, Azure App Service (Web App for Containers), Cloud Run, Fly and Render all inject. From this
directory:

```bash
az containerapp up -n eclipse-viewer -g <grupo> --source . --ingress external --target-port 8000
```

Render / Railway can instead build from the repo with no Dockerfile — they read `Procfile`.

Notes before publishing:

* `de421.bsp` (16 MB) must ship with the app; Skyfield would otherwise try to download it from
  NAIF at boot. `load.timescale()` uses built-in leap-second data, so it needs no network.
* Two gunicorn workers are enough — each loads its own copy of the 16 MB ephemeris kernel.
* There is no authentication. If the URL should be company-only, put Entra ID (Easy Auth) in
  front of it rather than adding logins to the app.
* Don't commit `earth_moon_viewer.zip` (`.gitignore` covers `*.zip`).

Packaging
---------

PowerShell:
```powershell
.\build_package.ps1 -OutName earth_moon_viewer.zip
```

macOS / Linux:
```bash
./build_package.sh
```

Note: `build_package.ps1` currently zips the whole directory (its `$items` filter is computed but
never used), so `.venv` and any previous zip end up inside the package.
