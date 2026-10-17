# Puesta en marcha

Visor 3D de la Tierra y la Luna con efemérides reales: dibuja la sombra de la Luna sobre la
superficie terrestre y la trayectoria de cualquier eclipse solar. Backend en Python (Flask +
Skyfield), frontend en three.js.

## 1. Requisitos

| | |
|---|---|
| Python | 3.12 o superior (`python --version`) |
| Navegador | Chrome, Edge o Firefox recientes, con WebGL activo |
| Disco | ~21 MB el proyecto + ~120 MB el entorno virtual |
| Red | sólo durante la instalación (y ver el punto 6) |

No hace falta Node, ni base de datos, ni cuenta de nada.

## 2. Instalación

### Windows (PowerShell)

```powershell
cd earth_moon_viewer
powershell -ExecutionPolicy Bypass -File .\setup_venv.ps1
```

### macOS / Linux

```bash
cd earth_moon_viewer
./setup_venv.sh
```

Ambos scripts crean `.venv/` e instalan las dependencias. Si prefieres hacerlo a mano:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # Windows
.venv/bin/python -m pip install -r requirements.txt         # macOS / Linux
```

## 3. Arrancar

```powershell
.\.venv\Scripts\python.exe app.py        # Windows
```
```bash
./.venv/bin/python app.py                # macOS / Linux
```

Abre <http://127.0.0.1:5000>. Para pararlo, `Ctrl+C` en la terminal.

Variables opcionales: `PORT` (por defecto 5000), `HOST` (`0.0.0.0` para que te vean desde otro
equipo de la red) y `FLASK_DEBUG=1` (recarga automática al editar el código).

```powershell
$env:PORT="5055"; .\.venv\Scripts\python.exe app.py
```

## 4. Comprobar que va bien

Al cargar deberías ver la Tierra texturizada con las fronteras de los países, el terminador
día/noche en su sitio y las luces de las ciudades en la cara nocturna. Arriba a la derecha, la
hora UTC avanzando y la distancia a la Luna (entre 356.000 y 407.000 km).

Prueba rápida del backend sin navegador:

```bash
curl "http://127.0.0.1:5000/api/state?iso=2026-08-12T18:29:00Z"
```

Debe responder un JSON con `"umbra"` no nulo, centrado en unos 42,7°N y 4,9°O — la sombra sobre
la provincia de Palencia.

## 5. Primer eclipse en un minuto: 12 de agosto de 2026

1. En **Eclipse solar**, abre el desplegable y elige `2026-08-12 · total · norte de España`.
   La app busca el eclipse de ese día, salta a su instante de máximo (17:46 UTC) y dibuja la
   trayectoria: línea central en rojo, límites de la banda de totalidad en naranja, huellas de
   la umbra con su hora y el contorno vivo de la sombra en ese instante.
2. Pulsa **Ir a la sombra** para acercar la cámara.
3. Escribe `12/08/2026 18:28:00` en el campo de fecha y pulsa **Ir**: la sombra está entrando por
   Asturias. O mueve el slider **Recorrer trayectoria** para ir minuto a minuto.
4. Activa **Seguir sombra** y dale a **▶ Reproducir** con la velocidad en ~1 min/s: la cámara
   persigue la umbra desde Groenlandia hasta el Mediterráneo.
5. Haz clic en tu ciudad sobre el globo. El panel de la derecha te da el porcentaje de Sol
   oculto y la altura del Sol en ese punto y ese instante. Madrid se queda en 99,98%: la
   totalidad le pasa por encima sin tocarla.

> **La fecha del campo es UTC**, no hora local. El panel de la derecha te da al lado la hora de
> Madrid: la totalidad en el norte de España cae sobre las 20:28 hora peninsular.

## 6. Controles

| Control | Qué hace |
|---|---|
| Campo de fecha + **Ir** | salta a cualquier instante, pasado o futuro (en UTC) |
| **−1 d … +1 d** | saltos de 10 s, 1 min, 10 min, 1 h y 1 día |
| **▶ Reproducir** / **◀ Atrás** | reproduce el tiempo; el segundo botón invierte la dirección |
| Deslizador de velocidad | de 1 s/s a ~11,6 días/s |
| **Calcular sombra de esta fecha** | busca un eclipse central en ±12 h de la fecha del campo |
| **Recorrer trayectoria** | recorre la línea central del eclipse cargado |
| **Seguir sombra** | la cámara persigue la umbra |
| Capas | fronteras, meridianos, trayectoria, banda de totalidad, sombra real, luces nocturnas, órbita lunar… |
| Clic sobre el globo | mide la ocultación del Sol en ese punto |
| Ratón | arrastrar orbita, rueda acerca |

Enlaces directos, útiles para mandar una vista concreta por chat:

```
http://127.0.0.1:5000/?date=2026-08-12T18:29:00&eclipse=1&view=shadow&zoom=0.5
```

`date` en UTC, `eclipse=1` calcula la trayectoria, `view` es `shadow`, `spain` o `earth`, y
`zoom` es la distancia a la superficie en radios terrestres.

## 7. Si algo no va

**No se ve nada / pantalla negra y "cargando texturas" sin fin.**
El navegador no tiene WebGL. Comprueba `chrome://gpu` (o `about:support` en Firefox) y que la
aceleración por hardware esté activada. Si la máquina es virtual, actívala en el hipervisor.

**El globo aparece pero sin fronteras ni relieve.**
Faltan los archivos de `static/assets/` (5 ficheros, ~4,5 MB). Deben viajar con el proyecto.

**`Address already in use` al arrancar.**
Otro proceso ocupa el 5000 (en macOS suele ser AirPlay). Arranca con otro puerto: `PORT=5055`.

**Se queda pensando al arrancar y luego falla.**
Falta `de421.bsp` (16 MB) en la raíz del proyecto: Skyfield intenta descargarlo de la NASA y si
no hay salida a internet, se cae. Ese fichero tiene que ir incluido.

**"Sin eclipse central ese día."**
Es lo normal: hay dos o tres eclipses solares al año. Usa el desplegable de eclipses destacados.

**Nada carga y en la consola del navegador hay errores contra `unpkg.com`.**
three.js se descarga de ese CDN al abrir la página. Si el proxy corporativo lo bloquea, hay que
guardar la librería en local; pídelo y se cambia en dos minutos.

**No me deja ir hacia atrás en el calendario.**
Sí deja: escribe la fecha en el campo y pulsa **Ir**, o usa los botones de salto negativo, o
pulsa **◀ Atrás** antes de reproducir. El rango útil va de 1900 a 2050 (límite de la efeméride
DE421).

## 8. Subirlo a un servidor

Ver la sección *Deploying* del [README](README.md): hay `Dockerfile` y `Procfile` listos, y la
app escucha en `$PORT` con gunicorn. Un aviso: **no lleva autenticación**, cualquiera con la URL
entra.

## 9. Qué hay en cada sitio

```
app.py                  API de efemérides y geometría de la sombra (Flask + Skyfield)
de421.bsp               efeméride JPL, 1900-2050 — imprescindible
requirements.txt         dependencias
static/index.html       interfaz y panel de controles
static/main.js          escena three.js, shader de la Tierra, capas del eclipse
static/assets/          texturas de la Tierra y la Luna + fronteras Natural Earth
Dockerfile, Procfile    despliegue en la nube
```
