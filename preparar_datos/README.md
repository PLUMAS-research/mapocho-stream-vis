# Preparar datos del visualizador desde DTPM

Esta carpeta convierte los viajes DTPM en todos los datos que la aplicación
necesita para operar, sin PostgreSQL. Reemplaza la fuente histórica (tablas en
una base de datos) por archivos parquet.

## Resultado en una línea

```sh
bash preparar_datos/generar_todo.sh
```

Esto produce, en `src/json/`, la grilla, los insumos de Metro (coordenadas, ruteo y
trazado por línea), la estructura de la red de buses, las matrices por hora de buses
y Metro, los conteos de demanda, y `particulasPrecalculadas.json`. Después, `npm
start` levanta la app con esos datos. Para una prueba rápida sin procesar el año
completo:

```sh
MUESTRA=2 bash preparar_datos/generar_todo.sh
```

## Qué necesita la aplicación para operar

La app no consulta ninguna base de datos: lee JSON precalculados. El repo no
versiona ningún dato; `generar_todo.sh` reconstruye todo desde dos fuentes
externas: los viajes DTPM (parquet) y el feed GTFS de DTPM.

| Artefacto | Archivo | Origen |
|---|---|---|
| Grilla hexagonal | `src/json/Hexagon02.json` | `CreacionGrilla.py` (geometría), paso 2. |
| Topología de la red de Metro | `src/json/RedMetro.json` | `gtfs_a_metro.py` desde GTFS (route_type 1), paso 3. |
| Coordenadas de estaciones | `src/json/MetroParaderos.json` | `gtfs_a_metro.py` desde GTFS, paso 3. |
| Rutas de Metro | `src/json/HexMetro_02.json` | `gtfs_a_metro.py` desde GTFS + grilla, paso 3. |
| Trazado de Metro por línea | `src/json/LineasMetro.json` | `gtfs_a_metro.py` desde GTFS, paso 3. |
| Estructura de la red de buses | `src/json/LineasBuses.json` | `gtfs_a_recorridos.py` desde GTFS, paso 4. |
| Segmentos | `src/json/segmentos/{buses,metro}.parquet` | `dtpm_a_segmentos.py` desde DTPM, paso 5. |
| Matrices por hora | `src/json/{buses,metro}/<h>/Matriz*.json` | `Main.py`, paso 6. |
| Conteos de demanda | `src/json/CantidadViajes.json` | `dtpm_a_segmentos.py`. |
| Partículas | `src/particulasPrecalculadas.json` | `CalcularParticulas.js`, paso 7. |

Nada de esto se versiona. Los paraderos de bus salen del parquet DTPM y las
coordenadas y el ruteo de Metro del GTFS; ninguno es un archivo versionado.

## Datos de entrada (especificación)

### 1. Viajes DTPM (parquet, un año)

Un parquet particionado donde cada fila es un viaje con hasta cuatro etapas. Cada
etapa es un tramo en un modo (bus o Metro). Las columnas que se usan, por etapa
`k` de 1 a 4:

| Columna | Contenido |
|---|---|
| `tipo_transporte_k` | Modo de la etapa: `1` = bus RED, `2` = Metro, `3` = otros buses, `4` = tren suburbano. |
| `paradero_subida_k` | Paradero o estación de subida. Bus: código (ej. `L-11-30-36-NS`). Metro: nombre de estación (ej. `IRARRAZAVAL`). |
| `paradero_bajada_k` | Paradero o estación de bajada. `-` si no hay bajada inferida. |
| `tiempo_subida_k` | Timestamp de subida (`YYYY-MM-DD HH:MM:SS`). |
| `tiempo_bajada_k` | Timestamp de bajada. |

Y dos columnas globales del viaje:

| Columna | Contenido |
|---|---|
| `factor_expansion` | Cuántos viajes reales representa el registro. Es el peso. |
| `tipodia` | Tipo de día. Laboral = `0` en los datos 2023. |

### 2. Catálogo de paraderos (`dtpm-paraderos.parquet`)

Geolocaliza los códigos de paradero de bus. Columnas usadas: `codigo_ts` (el
código que aparece en `paradero_subida/bajada` de las etapas de bus; se acepta
también el nombre antiguo `Código paradero TS`), `geometry` (punto en UTM 19S,
EPSG:32719; se reproyecta a WGS84) y, para el camino GTFS (`--paraderos-gtfs`),
`codigo_usuario` (el `stop_id` del feed). Cobertura del join con las etapas de
bus: cerca del 99%.

### 3. Coordenadas de estaciones de Metro

`src/json/MetroParaderos.json`, con la lista `metros: [{nombre, latitud, longitud}]`.
Los nombres están en mayúsculas sin acentos y coinciden con los de las etapas de
Metro DTPM y con el grafo de la red en `metro_red.py`.

## Cómo se mapea cada etapa a un segmento

Una etapa de viaje es un segmento dirigido (subida -> bajada). El peso de todos
los segmentos de un viaje es su `factor_expansion`.

- **Bus** (`tipo_transporte = 1`): se geolocalizan los códigos de subida y bajada
  con el catálogo. El segmento es la cuerda recta entre ambos paraderos; el
  pipeline rasteriza los hexágonos sobre esa recta. La hora del segmento es la
  hora de subida.
- **Metro** (`tipo_transporte = 2`): la etapa va de estación de subida a estación
  de bajada, que pueden no ser contiguas. Se rutea por el grafo de la red (camino
  más corto con penalización de transbordo) y se parte en segmentos estación a
  estación, repartiendo el tiempo de la etapa de forma uniforme. Cada segmento
  hereda el `factor_expansion` de la etapa.
- **Modos 3 y 4** quedan fuera por defecto, para mantener el diseño de dos capas
  (bus RED + Metro). Para incluir otros buses, agrega `"3"` a `MODOS_BUS` en
  `dtpm_a_segmentos.py`.
- Se descartan etapas sin bajada (`-`), con `factor_expansion <= 0`, o con tiempos
  inválidos.

### Esquema intermedio (el contrato con el pipeline)

El conversor escribe dos parquet en `src/json/segmentos/`. Este es el contrato que
lee la agregación (`src/FuenteDatos.py`, backend parquet):

`buses.parquet`: `id`, `latinicial`, `loninicial`, `latfinal`, `lonfinal`,
`tiempoinicial` (timestamp), `tiempofinal` (timestamp), `carga` (= factor_expansion),
`horarango` (0–23).

`metro.parquet`: `estacioninicial`, `estacionfinal`, `latinicial`, `loninicial`,
`latfinal`, `lonfinal`, `tiempoinicial` (`HH:MM:SS`), `tiempofinal` (`HH:MM:SS`),
`horarango`, `tipodia` (`LABORAL`), `peso` (= factor_expansion).

Junto a los parquet queda `metadatos.json` con `dias_laborales` (días distintos
del extracto) y el rango de fechas. `FuenteDatos.py` divide los pesos por ese
número al leer, así que las matrices agregadas y `CantidadViajes.json`
representan un día laboral promedio, no la suma del extracto.

## Contrato de entrada genérico: viajes + GTFS (para otras ciudades)

El pipeline tiene dos costuras de entrada, y conviene distinguirlas:

1. **Nivel segmentos** (existe hoy): el "Esquema intermedio" de arriba. Quien
   tenga sus propios datos puede escribir un conversor a esos dos parquet y
   correr la agregación y la app sin tocar nada más. Es el contrato mínimo,
   pero deja fuera el trabajo pesado (geolocalización, ruteo de Metro,
   normalización), que cada adoptante tendría que rehacer.
2. **Nivel viajes + GTFS** (el contrato objetivo): la entrada son las etapas de
   viaje referidas a un feed GTFS, y el conversor de esta carpeta hace el resto.
   Dos insumos, ambos estándar o casi:

**Etapas de viaje** (una fila por etapa; el formato físico da lo mismo, parquet
o CSV):

| Columna | Contenido |
|---|---|
| `modo` | `bus` o `rail`. |
| `subida`, `bajada` | Parada o estación de subida y bajada, como `stop_id` del feed GTFS. |
| `t_subida`, `t_bajada` | Timestamps de subida y bajada. |
| `factor_expansion` | Cuántos viajes reales representa el registro (el peso). |
| `tipo_dia` | Etiqueta de tipo de día; el pipeline usa los días laborales. |

Más un metadato del extracto: el número de días laborales que contiene, para
normalizar los agregados a día laboral promedio.

**El feed GTFS** de la misma red aporta todo lo demás: `stops.txt` da las
coordenadas de paradas y estaciones (y la extensión espacial de la grilla);
`trips.txt` + `stop_times.txt` con `route_type` 1 dan la topología de la red de
rail (secuencia de estaciones por línea; transbordos por `parent_station`), que
alimenta el grafo de ruteo; `shapes.txt` y los colores de ruta dan las capas de
contexto (trazado de líneas y red de buses). OSM no es insumo: nada del
pipeline lo consume (las cuerdas de bus son rectas por diseño y las geometrías
salen del GTFS).

**Estado actual frente a ese contrato.** La topología de la red de Metro ya se
deriva del GTFS (agosto 2026): `gtfs_a_metro.py` construye las líneas desde las
rutas `route_type` 1 y sus `stop_times`, y las materializa en
`src/json/RedMetro.json`, que `dtpm_a_segmentos.py` usa para armar el grafo de
ruteo. No quedan listas de estaciones escritas a mano; lo Santiago-específico
que sobrevive en ese paso son `ALIAS_GTFS` (ortografías GTFS -> nombres DTPM,
parte del adaptador) y `ORDEN_GRAFO` (ancla de reproducibilidad del desempate
de rutas de igual costo; ver su comentario en `gtfs_a_metro.py`). La
equivalencia se verificó contra la topología anterior: mismas estaciones y
coordenadas, mismo trazado y mismos pares de HexMetro (módulo orientación de
línea, que no afecta nada), y 0 diferencias de ruteo en los 7875 pares de
estaciones, así que los segmentos y las matrices no cambian.

Las otras dos brechas se cerraron con opciones explícitas (agosto 2026), y en
ambas el default de Santiago queda intacto para no alterar las matrices
publicadas:

- **Paraderos de bus desde el GTFS**: `dtpm_a_segmentos.py --paraderos-gtfs
  <feed.zip>` geolocaliza con `stops.txt`; el catálogo DTPM queda solo como
  mapa de códigos (`codigo_ts` -> `codigo_usuario`, que es el `stop_id` del
  feed), o sea como el adaptador de códigos que pide el contrato. Medido
  contra el catálogo (feed 2026): misma ubicación en la práctica (mediana 0 m,
  p99 8.3 m) y cobertura de etapas 99.1% contra 99.2%. Como las coordenadas no
  son bit a bit iguales, el default sigue siendo la geometría del catálogo:
  es lo que reproduce exactamente los datos publicados.
- **Bounding box de la grilla desde el GTFS**: `CreacionGrilla.py` acepta
  `BBOX="minLat,maxLat,minLon,maxLon"` o `BBOX_GTFS=feed.zip` (extensión de
  las paradas más un margen, `BBOX_GTFS_MARGEN`). Sin esas variables usa el
  bbox del Gran Santiago de siempre (verificado: grilla byte-idéntica).

Con esto, una ciudad con etapas referidas a su feed GTFS puede correr el flujo
completo; lo que queda como adaptador DTPM es la lectura del formato de viajes
(las columnas por etapa de arriba) y el mapa de códigos TS. La verificación de
cada refactor fue la misma: con los mismos datos de Santiago, mismas matrices.

## Diferencias respecto a la versión histórica

- **El peso del Metro deja de ser 1**. Antes cada segmento de Metro pesaba 1
  (cuenta de tramos). Ahora pesa `factor_expansion` (demanda expandida), igual que
  los buses. Esto hace comparables las dos capas y elimina la asimetría que tenía
  la tesis.
- **El bus ya no usa carga a bordo**. La fuente DTPM no trae ocupación; el peso es
  demanda expandida. El segmento de bus es la cuerda subida->bajada, más gruesa que
  los tramos paradero a paradero de la fuente histórica.
- No hay discrepancia de ventana temporal: bus y Metro salen del mismo extracto
  DTPM, del mismo año y los mismos días laborales.

## Pasos individuales (si no usas el orquestador)

```sh
# 1. Entorno
cd preparar_datos && uv sync

# 2. Grilla hexagonal (desde src/)
cd ../src && uv run --project ../preparar_datos python CreacionGrilla.py

# 3. Insumos de Metro desde GTFS (desde preparar_datos/)
cd ../preparar_datos && uv run python gtfs_a_metro.py

# 4. Estructura de la red de buses desde GTFS
uv run python gtfs_a_recorridos.py

# 5. DTPM -> segmentos + CantidadViajes.json
uv run python dtpm_a_segmentos.py --muestra 0          # 0 = año completo

# 6. Segmentos -> matrices por hora (desde src/)
cd ../src && uv run --project ../preparar_datos python Main.py

# 7. Matrices -> partículas
node CalcularParticulas.js
```

## Fuente de datos

`src/FuenteDatos.py` lee los segmentos desde `src/json/segmentos/{buses,metro}.parquet`.
No usa base de datos. La ruta de los parquet se controla con la variable
`DIR_SEGMENTOS` (por defecto `json/segmentos`). El GTFS para los insumos de Metro
se controla con `GTFS_URL` (ver `gtfs_a_metro.py`).

## Notas

- **Memoria**: el conversor procesa el parquet fragmento por fragmento, así que la
  memoria no crece con el tamaño del año. La agregación (`Main.py`) paraleliza por
  hora (procesos = CPU − 3, configurable con la variable de entorno `PROCESOS`) y
  lee los segmentos por lotes (`FuenteDatos.py`, lote configurable con
  `TAMANO_LOTE`), de modo que cada proceso queda bajo ~0.6 GB incluso en la hora
  pico del año completo (~20 M de segmentos de Metro).
- **Costo**: el año completo genera millones de segmentos (sobre todo Metro, porque
  cada etapa se parte en varios tramos). Usa `--muestra` o filtra a un día para
  iterar rápido.
- **Otra ciudad / otra red de Metro**: ver "Contrato de entrada genérico" más
  arriba. La topología de rail sale del GTFS de la ciudad (`gtfs_a_metro.py`),
  la grilla puede derivarse del mismo feed (`BBOX_GTFS` en `CreacionGrilla.py`)
  y las paradas de bus pueden geolocalizarse con `stops.txt`
  (`--paraderos-gtfs`). Lo que hay que escribir es el adaptador de los viajes
  propios al esquema de etapas (y su mapa de códigos a `stop_id`).
