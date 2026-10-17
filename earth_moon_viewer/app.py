"""Backend de efemérides: posiciones reales y geometría del cono de sombra lunar."""
import os
from datetime import datetime

import numpy as np
from flask import Flask, jsonify, request, send_from_directory
from skyfield.api import load, wgs84
from skyfield.framelib import itrs

app = Flask(__name__, static_folder='static', static_url_path='')

ts = load.timescale()
eph = load('de421.bsp')
earth = eph['earth']
moon = eph['moon']
sun = eph['sun']

R_SUN_KM = 695700.0
R_MOON_KM = 1737.4
R_EARTH_KM = 6371.0        # radio medio para el cono de sombra terrestre
A_KM = 6378.137            # WGS84
B_KM = 6356.752314245
W_ELL = np.array([1.0 / A_KM ** 2, 1.0 / A_KM ** 2, 1.0 / B_KM ** 2])
# ECEF -> ejes locales de la esfera de three.js (polo en +Y, longitud 0 en +X, 90E en -Z)
P_MESH = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])


def _parse_iso(iso):
    """ts.now() si no hay fecha; lanza ValueError si el ISO es inválido."""
    if not iso:
        return ts.now()
    if iso.endswith('Z'):
        iso = iso[:-1] + '+00:00'
    return ts.from_datetime(datetime.fromisoformat(iso))


def _geometry(t):
    """Luna y Sol geocéntricos (ICRF y ECEF, km) + matriz malla->ICRF. t puede ser vectorial."""
    e = earth.at(t)
    m_icrf = e.observe(moon).position.km
    s_icrf = e.observe(sun).position.km
    rot = itrs.rotation_at(t)                       # ICRF -> ITRS
    if rot.ndim == 3:
        m_ecef = np.einsum('ijk,jk->ik', rot, m_icrf)
        s_ecef = np.einsum('ijk,jk->ik', rot, s_icrf)
        mesh = np.einsum('ij,jkn->ikn', P_MESH, rot).transpose(1, 0, 2)
    else:
        m_ecef = rot @ m_icrf
        s_ecef = rot @ s_icrf
        mesh = (P_MESH @ rot).T
    return m_icrf, s_icrf, m_ecef, s_ecef, mesh


def _normal(p):
    n = p * W_ELL
    return n / np.linalg.norm(n)


def _latlon(p):
    """Latitud geodésica / longitud de un punto que está sobre el elipsoide."""
    hyp = np.hypot(p[0], p[1])
    lat = np.degrees(np.arctan2(p[2] * A_KM ** 2, hyp * B_KM ** 2))
    lon = np.degrees(np.arctan2(p[1], p[0]))
    return float(lat), float(lon)


def _ellipsoid_roots(origin, direction):
    a = np.dot(W_ELL * direction, direction)
    b = 2.0 * np.dot(W_ELL * origin, direction)
    c = np.dot(W_ELL * origin, origin) - 1.0
    disc = b * b - 4.0 * a * c
    if disc <= 0.0:
        return None
    root = np.sqrt(disc)
    return ((-b - root) / (2.0 * a), (-b + root) / (2.0 * a))


def _cone(s_ecef, m_ecef):
    """Eje unitario Sol->Luna, distancia Sol-Luna y semiángulo del cono de umbra."""
    axis = m_ecef - s_ecef
    d_sm = float(np.linalg.norm(axis))
    axis = axis / d_sm
    sin_f = (R_SUN_KM - R_MOON_KM) / d_sm
    cos_f = np.sqrt(1.0 - sin_f * sin_f)
    return axis, d_sm, sin_f, cos_f


def _axis_miss_km(s_ecef, m_ecef):
    """Distancia perpendicular del eje de sombra al centro de la Tierra."""
    axis = m_ecef - s_ecef
    axis = axis / np.linalg.norm(axis)
    return float(np.linalg.norm(np.cross(m_ecef, axis)))


def _sub_axis_point(s_ecef, m_ecef):
    """Punto del elipsoide más cercano al eje de sombra (máximo de un eclipse parcial)."""
    axis = m_ecef - s_ecef
    axis = axis / np.linalg.norm(axis)
    p_close = m_ecef - np.dot(m_ecef, axis) * axis   # punto del eje más cercano al centro
    d = float(np.linalg.norm(p_close))
    if d < 1e-6:
        return None
    q = p_close / d
    return q / np.sqrt(np.dot(W_ELL * q, q))         # proyectado al elipsoide (ECEF, km)


def _obscuration(p, s_ecef, m_ecef):
    """Fracción del disco solar tapada por la Luna visto desde p (km, ECEF)."""
    ds = s_ecef - p
    dm = m_ecef - p
    ls = float(np.linalg.norm(ds))
    lm = float(np.linalg.norm(dm))
    rs = np.arcsin(min(R_SUN_KM / ls, 1.0))
    rm = np.arcsin(min(R_MOON_KM / lm, 1.0))
    ds = ds / ls
    dm = dm / lm
    d = float(np.arccos(np.clip(np.dot(ds, dm), -1.0, 1.0)))
    if d >= rs + rm:
        return 0.0
    if d <= rm - rs:
        return 1.0
    if d <= rs - rm:
        return float(rm * rm) / float(rs * rs)
    a1 = np.arccos(np.clip((d * d + rm * rm - rs * rs) / (2.0 * d * rm), -1.0, 1.0))
    a2 = np.arccos(np.clip((d * d + rs * rs - rm * rm) / (2.0 * d * rs), -1.0, 1.0))
    lens = rm * rm * a1 + rs * rs * a2 \
        - 0.5 * np.sqrt(max(0.0, (rm + rs - d) * (d + rm - rs) * (d - rm + rs) * (d + rm + rs)))
    return float(np.clip(lens / (np.pi * rs * rs), 0.0, 1.0))


def _lens_overlap(rs, rm, d):
    """Fracción del disco de radio `rs` tapada por un disco de radio `rm` a separación `d` (radianes)."""
    if d >= rs + rm:
        return 0.0
    if d <= rm - rs:
        return 1.0
    if d <= rs - rm:
        return float(rm * rm) / float(rs * rs)
    a1 = np.arccos(np.clip((d * d + rm * rm - rs * rs) / (2.0 * d * rm), -1.0, 1.0))
    a2 = np.arccos(np.clip((d * d + rs * rs - rm * rm) / (2.0 * d * rs), -1.0, 1.0))
    lens = rm * rm * a1 + rs * rs * a2 \
        - 0.5 * np.sqrt(max(0.0, (rm + rs - d) * (d + rm - rs) * (d - rm + rs) * (d + rm + rs)))
    return float(np.clip(lens / (np.pi * rs * rs), 0.0, 1.0))


def _position_angle(alt1, az1, alt2, az2):
    """Ángulo de posición del cuerpo 2 respecto al 1: desde el norte hacia el este, grados."""
    a1, a2 = np.radians(alt1), np.radians(alt2)
    daz = np.radians(az2 - az1)
    y = np.sin(daz) * np.cos(a2)
    x = np.cos(a1) * np.sin(a2) - np.sin(a1) * np.cos(a2) * np.cos(daz)
    return float(np.degrees(np.arctan2(y, x)))


def _umbra_center(s_ecef, m_ecef):
    """Corte del eje de sombra con el elipsoide. None si la sombra no toca la Tierra."""
    axis, d_sm, sin_f, cos_f = _cone(s_ecef, m_ecef)
    roots = _ellipsoid_roots(m_ecef, axis)
    if roots is None or roots[0] <= 0.0:
        # roots[0] <= 0 => la Luna está del lado opuesto al Sol (luna llena): no hay eclipse solar.
        return None
    dist = roots[0]                                  # cara iluminada
    p = m_ecef + dist * axis
    r_perp = R_MOON_KM - dist * (sin_f / cos_f)      # <0 => antumbra (anular)
    n = _normal(p)
    cos_i = max(float(-np.dot(axis, n)), 1e-3)
    to_sun = s_ecef - p
    lat, lon = _latlon(p)
    # La huella es una elipse: semieje menor r_perp, mayor r_perp/cos(i) en la dirección
    # de inclinación del eje sobre el plano tangente.
    tilt = axis - np.dot(axis, n) * n
    if np.linalg.norm(tilt) < 1e-9:
        tilt = np.cross(n, [0.0, 0.0, 1.0])
    a_hat = tilt / np.linalg.norm(tilt)
    return {
        'lat': lat,
        'lon': lon,
        'p': p,
        'n': n,
        'a_hat': a_hat,
        'b_hat': np.cross(n, a_hat),
        'semi_major': abs(float(r_perp)) / cos_i,
        'semi_minor': abs(float(r_perp)),
        'kind': 'total' if r_perp >= 0 else 'annular',
        'sun_alt': float(np.degrees(np.arcsin(np.dot(n, to_sun / np.linalg.norm(to_sun))))),
    }


def _ellipse_radius(c, direction):
    """Semicuerda de la huella elíptica en una dirección del plano tangente."""
    ca = np.dot(direction, c['a_hat']) / c['semi_major']
    cb = np.dot(direction, c['b_hat']) / c['semi_minor']
    return float(1.0 / np.sqrt(ca * ca + cb * cb))


def _umbra_metrics(c, prev, nxt, dt):
    """Anchura de la banda y duración en el punto central a partir de la velocidad en suelo."""
    out = {'lat': round(c['lat'], 4), 'lon': round(c['lon'], 4), 'kind': c['kind'],
           'sun_alt': round(c['sun_alt'], 2), 'width_km': None, 'duration_s': None}
    if prev is None or nxt is None:
        return out
    vel = (nxt['p'] - prev['p']) / dt
    speed = float(np.linalg.norm(vel))
    if speed < 1e-6:
        return out
    v_hat = vel / speed
    v_hat = v_hat - np.dot(v_hat, c['n']) * c['n']
    v_hat /= np.linalg.norm(v_hat)
    w_hat = np.cross(c['n'], v_hat)
    half = _ellipse_radius(c, w_hat)
    out['width_km'] = round(2.0 * half, 1)
    out['duration_s'] = round(2.0 * _ellipse_radius(c, v_hat) / speed, 1)
    # Bordes de la banda: se proyectan de vuelta al elipsoide antes de sacar lat/lon.
    out['edges'] = []
    for sign in (1.0, -1.0):
        q = c['p'] + sign * half * w_hat
        q = q / np.sqrt(np.dot(W_ELL * q, q))
        lat, lon = _latlon(q)
        out['edges'].append([round(lat, 4), round(lon, 4)])
    return out


def _umbra_at(t):
    """Umbra en un instante; muestrea t±10 s para tener velocidad en superficie."""
    tt = ts.tt_jd(t.tt + np.array([-10.0, 0.0, 10.0]) / 86400.0)
    _, _, m, s, _ = _geometry(tt)
    c = [_umbra_center(s[:, i], m[:, i]) for i in range(3)]
    if c[1] is None:
        return None
    return _umbra_metrics(c[1], c[0], c[2], 20.0)


def _umbra_outline(s_ecef, m_ecef, n_az=96):
    """Huella de la umbra: rayos del borde del cono desde su vértice contra el elipsoide."""
    axis, d_sm, sin_f, cos_f = _cone(s_ecef, m_ecef)
    apex = m_ecef + (R_MOON_KM * cos_f / sin_f) * axis
    ref = np.array([0.0, 0.0, 1.0])
    if abs(float(np.dot(ref, axis))) > 0.9:
        ref = np.array([1.0, 0.0, 0.0])
    w1 = np.cross(axis, ref)
    w1 /= np.linalg.norm(w1)
    w2 = np.cross(axis, w1)
    ring = []
    for th in np.linspace(0.0, 2.0 * np.pi, n_az, endpoint=False):
        d = cos_f * axis - sin_f * (np.cos(th) * w1 + np.sin(th) * w2)
        roots = _ellipsoid_roots(apex, d)
        if roots is None:
            continue
        p = min((apex + r * d for r in roots),
                key=lambda q: float(np.linalg.norm(q - m_ecef)))   # cara vista desde la Luna
        lat, lon = _latlon(p)
        ring.append([round(lon, 4), round(lat, 4)])
    return ring


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/viewer')
def viewer():
    return send_from_directory('static', 'viewer.html')


@app.route('/api/state')
def state():
    """Posiciones (km) en ICRF geocéntrico y orientación de la Tierra para un ISO 8601."""
    try:
        t = _parse_iso(request.args.get('iso'))
    except ValueError:
        return jsonify({'error': 'invalid date format, use ISO 8601'}), 400

    m_icrf, s_icrf, m_ecef, s_ecef, mesh = _geometry(t)
    return jsonify({
        'moon_km': m_icrf.tolist(),
        'sun_km': s_icrf.tolist(),
        'moon_distance_km': float(np.linalg.norm(m_icrf)),
        'earth_mesh': mesh.flatten().tolist(),
        'umbra': _umbra_at(t),
        'utc': t.utc_strftime('%Y-%m-%dT%H:%M:%SZ'),
    })


@app.route('/api/observer')
def observer():
    """Vista topocéntrica desde un punto (lat/lon): alt/az del Sol y la Luna, ocultación y tipo.

    Devuelve la fracción del disco solar tapada por la Luna visto desde el suelo,
    junto con los datos para dibujar el cielo (acimut, altura, radios angulares).
    """
    try:
        t = _parse_iso(request.args.get('iso'))
    except ValueError:
        return jsonify({'error': 'invalid date format, use ISO 8601'}), 400
    try:
        lat = float(request.args.get('lat'))
        lon = float(request.args.get('lon'))
    except (TypeError, ValueError):
        return jsonify({'error': 'invalid lat/lon'}), 400
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return jsonify({'error': 'lat/lon fuera de rango'}), 400

    topo = wgs84.latlon(lat, lon)
    obs = earth + topo
    tt = ts.tt_jd(t.tt)
    sun_app = obs.at(tt).observe(sun).apparent()
    moon_app = obs.at(tt).observe(moon).apparent()

    sun_alt, sun_az, sun_dist = sun_app.altaz(temperature_C='standard')
    moon_alt, moon_az, moon_dist = moon_app.altaz(temperature_C='standard')

    sun_rad = float(np.degrees(np.arcsin(min(R_SUN_KM / sun_dist.km, 1.0))))
    moon_rad = float(np.degrees(np.arcsin(min(R_MOON_KM / moon_dist.km, 1.0))))
    sep = float(sun_app.separation_from(moon_app).degrees)
    obsc = _lens_overlap(np.radians(sun_rad), np.radians(moon_rad), np.radians(sep))
    pa = _position_angle(sun_alt.degrees, sun_az.degrees, moon_alt.degrees, moon_az.degrees)

    return jsonify({
        'utc': t.utc_strftime('%Y-%m-%dT%H:%M:%SZ'),
        'lat': lat,
        'lon': lon,
        'sun': {'alt': round(float(sun_alt.degrees), 4), 'az': round(float(sun_az.degrees), 4),
                'radius_deg': round(sun_rad, 5), 'dist_km': round(float(sun_dist.km), 0)},
        'moon': {'alt': round(float(moon_alt.degrees), 4), 'az': round(float(moon_az.degrees), 4),
                 'radius_deg': round(moon_rad, 5), 'dist_km': round(float(moon_dist.km), 0)},
        'separation_deg': round(sep, 5),
        'position_angle_deg': round(pa, 3),
        'obscuration': round(obsc, 5),
    })


@app.route('/api/series')
def series():
    """Serie uniforme de muestras para que el cliente interpole sin pedir cada frame."""
    try:
        t0 = _parse_iso(request.args.get('start'))
    except ValueError:
        return jsonify({'error': 'invalid date format, use ISO 8601'}), 400
    step_s = float(request.args.get('step_s', 30))
    n = min(max(int(request.args.get('n', 121)), 2), 600)

    t = ts.tt_jd(t0.tt + np.arange(n) * (step_s / 86400.0))
    m_icrf, s_icrf, m_ecef, s_ecef, mesh = _geometry(t)

    umbra = []
    for i in range(n):
        c = _umbra_center(s_ecef[:, i], m_ecef[:, i])
        umbra.append(None if c is None else [round(c['lat'], 4), round(c['lon'], 4)])

    return jsonify({
        'start': t0.utc_strftime('%Y-%m-%dT%H:%M:%SZ'),
        'step_s': step_s,
        'n': n,
        'moon_km': m_icrf.T.tolist(),
        'sun_km': s_icrf.T.tolist(),
        'earth_mesh': mesh.transpose(2, 0, 1).reshape(n, 9).tolist(),
        'umbra': umbra,
    })


def _partial_eclipse(times, s_ecef, m_ecef):
    """Eclipse parcial: la umbra no toca el suelo pero la penumbra sí. Devuelve el máximo."""
    miss = np.array([_axis_miss_km(s_ecef[:, i], m_ecef[:, i]) for i in range(times.tt.size)])
    i_min = int(np.argmin(miss))
    half = 6.0 / 1440.0                                     # ±6 min, en días
    fine = ts.tt_jd(times.tt[i_min] + np.linspace(-half, half, 37))
    _, _, m_f, s_f, _ = _geometry(fine)
    miss_f = [_axis_miss_km(s_f[:, j], m_f[:, j]) for j in range(fine.tt.size)]
    j_min = int(np.argmin(miss_f))

    surf = _sub_axis_point(s_f[:, j_min], m_f[:, j_min])
    if surf is None or _obscuration(surf, s_f[:, j_min], m_f[:, j_min]) <= 0.0:
        return jsonify({'found': False, 'axis_min_km': round(float(miss_f[j_min]), 1),
                        'note': 'la umbra no toca la Tierra en esta ventana'})

    lat, lon = _latlon(surf)
    return jsonify({
        'found': True,
        'kind': 'partial',
        'greatest': {
            'utc': fine[j_min].utc_strftime('%Y-%m-%dT%H:%M:%SZ'),
            'lat': round(lat, 4),
            'lon': round(lon, 4),
            'obscuration': round(_obscuration(surf, s_f[:, j_min], m_f[:, j_min]), 4),
            'axis_miss_km': round(float(miss_f[j_min]), 1),
        },
        'central_line': [], 'outlines': [], 'north_limit': [], 'south_limit': [],
        'begin_utc': None, 'end_utc': None,
    })


@app.route('/api/eclipse')
def eclipse():
    """Trayectoria de la umbra alrededor de `iso`: línea central, huellas y máximo."""
    try:
        t_mid = _parse_iso(request.args.get('iso'))
    except ValueError:
        return jsonify({'error': 'invalid date format, use ISO 8601'}), 400
    window_h = min(max(float(request.args.get('window_h', 10)), 1.0), 48.0)

    half = window_h / 48.0                                   # en días
    coarse = ts.tt_jd(t_mid.tt + np.linspace(-half, half, int(window_h * 30) + 1))
    _, _, m_c, s_c, _ = _geometry(coarse)
    hits = [i for i in range(coarse.tt.size)
            if _umbra_center(s_c[:, i], m_c[:, i]) is not None]

    if not hits:
        return _partial_eclipse(coarse, s_c, m_c)

    pad = 300.0 / 86400.0
    step = 20.0 / 86400.0
    fine = ts.tt_jd(np.arange(coarse.tt[hits[0]] - pad, coarse.tt[hits[-1]] + pad + step, step))
    _, _, m_f, s_f, _ = _geometry(fine)

    centers = [_umbra_center(s_f[:, i], m_f[:, i]) for i in range(fine.tt.size)]
    line = []
    for i, c in enumerate(centers):
        if c is None:
            continue
        prev = centers[i - 1] if i > 0 else None
        nxt = centers[i + 1] if i + 1 < len(centers) else None
        point = _umbra_metrics(c, prev, nxt, 40.0)
        point['utc'] = fine[i].utc_strftime('%Y-%m-%dT%H:%M:%SZ')
        line.append(point)

    miss = [_axis_miss_km(s_f[:, i], m_f[:, i]) for i in range(fine.tt.size)]
    i_max = min((i for i, c in enumerate(centers) if c), key=lambda i: miss[i])

    idx = sorted({int(round(v)) for v in np.linspace(0, fine.tt.size - 1, 14)} | {i_max})
    outlines = []
    for i in idx:
        if centers[i] is None:
            continue
        ring = _umbra_outline(s_f[:, i], m_f[:, i])
        if len(ring) > 3:
            outlines.append({'utc': fine[i].utc_strftime('%H:%MZ'), 'ring': ring})

    greatest = _umbra_metrics(centers[i_max], centers[i_max - 1], centers[i_max + 1], 40.0)
    greatest['utc'] = fine[i_max].utc_strftime('%Y-%m-%dT%H:%M:%SZ')
    return jsonify({
        'found': True,
        'greatest': greatest,
        'begin_utc': line[0]['utc'],
        'end_utc': line[-1]['utc'],
        'central_line': line,
        'outlines': outlines,
        'north_limit': [[p['edges'][0][1], p['edges'][0][0]] for p in line if p.get('edges')],
        'south_limit': [[p['edges'][1][1], p['edges'][1][0]] for p in line if p.get('edges')],
    })


def _lunar_state(m_icrf, s_icrf):
    """Estado del eclipse lunar en un instante (geocéntrico ICRF, km).

    La sombra de la Tierra es un cono cuyo eje es la dirección antisolar desde el
    centro de la Tierra. Devuelve magnitudes (fracción del diámetro lunar) y tipo.
    """
    d_se = float(np.linalg.norm(s_icrf))
    d_em = float(np.linalg.norm(m_icrf))
    axis = -s_icrf / d_se                         # eje antisolar, pasa por la Tierra
    miss = float(np.linalg.norm(np.cross(m_icrf, axis)))
    r_umbra = R_EARTH_KM - d_em * (R_SUN_KM - R_EARTH_KM) / d_se
    r_pen = R_EARTH_KM + d_em * (R_SUN_KM + R_EARTH_KM) / d_se
    umb_mag = (r_umbra + R_MOON_KM - miss) / (2.0 * R_MOON_KM)
    pen_mag = (r_pen + R_MOON_KM - miss) / (2.0 * R_MOON_KM)
    if umb_mag >= 1.0:
        kind = 'total'
    elif umb_mag > 0.0:
        kind = 'partial'
    elif pen_mag > 0.0:
        kind = 'penumbral'
    else:
        kind = None
    return {'miss_km': miss, 'umbra_radius_km': r_umbra, 'penumbra_radius_km': r_pen,
            'umbral_magnitude': umb_mag, 'penumbral_magnitude': pen_mag, 'kind': kind}


@app.route('/api/lunar_eclipse')
def lunar_eclipse():
    """Eclipse lunar alrededor de `iso`: instante de máximo, magnitudes y tipo."""
    try:
        t_mid = _parse_iso(request.args.get('iso'))
    except ValueError:
        return jsonify({'error': 'invalid date format, use ISO 8601'}), 400
    window_h = min(max(float(request.args.get('window_h', 10)), 1.0), 48.0)

    half = window_h / 48.0
    coarse = ts.tt_jd(t_mid.tt + np.linspace(-half, half, int(window_h * 30) + 1))
    m_i, s_i, _, _, _ = _geometry(coarse)
    mags = [_lunar_state(m_i[:, i], s_i[:, i]) for i in range(coarse.tt.size)]

    i_max = max(range(coarse.tt.size), key=lambda i: mags[i]['umbral_magnitude'])
    fine = ts.tt_jd(coarse.tt[i_max] + np.linspace(-6.0, 6.0, 37) / 1440.0)   # ±6 min
    m_f, s_f, _, _, _ = _geometry(fine)
    mags_f = [_lunar_state(m_f[:, j], s_f[:, j]) for j in range(fine.tt.size)]

    j_max = max(range(fine.tt.size), key=lambda j: mags_f[j]['umbral_magnitude'])
    if mags_f[j_max]['umbral_magnitude'] <= 0.0:
        j_max = max(range(fine.tt.size), key=lambda j: mags_f[j]['penumbral_magnitude'])

    st = mags_f[j_max]
    if st['kind'] is None:
        return jsonify({'found': False, 'note': 'no hay eclipse lunar en esta ventana'})

    contacts = [i for i in range(coarse.tt.size) if mags[i]['penumbral_magnitude'] > 0.0]
    return jsonify({
        'found': True,
        'kind': st['kind'],
        'greatest': {
            'utc': fine[j_max].utc_strftime('%Y-%m-%dT%H:%M:%SZ'),
            'umbral_magnitude': round(st['umbral_magnitude'], 4),
            'penumbral_magnitude': round(st['penumbral_magnitude'], 4),
            'miss_km': round(st['miss_km'], 1),
            'umbra_radius_km': round(st['umbra_radius_km'], 1),
            'penumbra_radius_km': round(st['penumbra_radius_km'], 1),
            'moon_distance_km': round(float(np.linalg.norm(m_f[:, j_max])), 1),
        },
        'begin_utc': ts.tt_jd(coarse.tt[contacts[0]]).utc_strftime('%Y-%m-%dT%H:%M:%SZ') if contacts else None,
        'end_utc': ts.tt_jd(coarse.tt[contacts[-1]]).utc_strftime('%Y-%m-%dT%H:%M:%SZ') if contacts else None,
    })


if __name__ == '__main__':
    # En la nube arranca gunicorn (ver Dockerfile/Procfile); esto es sólo para local.
    app.run(host=os.environ.get('HOST', '127.0.0.1'),
            port=int(os.environ.get('PORT', 5000)),
            debug=os.environ.get('FLASK_DEBUG') == '1')
