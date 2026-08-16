# Preparing the visualizer data from DTPM

This folder converts the DTPM trip records into all the data that the
application needs, with no database. It replaces the historical source
(PostgreSQL tables) with parquet files.

## One-line result

```sh
bash preparar_datos/generar_todo.sh
```

This produces, under `src/json/`, the grid, the Metro inputs (topology,
coordinates, routing, and per-line trace), the bus network structure, the
per-hour matrices for buses and Metro, the demand counts, and
`particulasPrecalculadas.json`. After that, `npm start` runs the app with that
data. For a quick test without processing the full extract:

```sh
MUESTRA=2 bash preparar_datos/generar_todo.sh
```

## What the application needs

The app does not query any database: it reads precomputed JSON. The repo does
not version any data; `generar_todo.sh` rebuilds everything from two external
sources: the DTPM trip records (parquet) and the DTPM GTFS feed.

| Artifact | File | Origin |
|---|---|---|
| Hexagonal grid | `src/json/Hexagon_r<res>.json` | `CreacionGrilla.py` (geometry), step 2. |
| Metro network topology | `src/json/RedMetro.json` | `gtfs_a_metro.py` from GTFS (route_type 1), step 3. |
| Station coordinates | `src/json/MetroParaderos.json` | `gtfs_a_metro.py` from GTFS, step 3. |
| Metro routes over the grid | `src/json/HexMetro_r<res>.json` | `gtfs_a_metro.py` from GTFS + grid, step 3. |
| Per-line Metro trace | `src/json/LineasMetro.json` | `gtfs_a_metro.py` from GTFS, step 3. |
| Bus network structure | `src/json/LineasBuses.json` | `gtfs_a_recorridos.py` from GTFS, step 4. |
| Segments | `src/json/segmentos/{buses,metro}.parquet` | `dtpm_a_segmentos.py` from DTPM, step 5. |
| Per-hour matrices | `src/json/{buses,metro}/<h>/Matriz*.json` | `Main.py`, step 6. |
| Demand counts | `src/json/CantidadViajes.json` | `dtpm_a_segmentos.py`. |
| Particles | `src/particulasPrecalculadas.json` | `CalcularParticulas.js`, step 7. |

None of this is versioned. Bus stops come from the DTPM parquet (or from the
GTFS, see below), and the Metro coordinates and routing come from the GTFS.

## Input data (specification)

### 1. DTPM trip records (partitioned parquet)

Each row is one trip with up to four stages. A stage is a leg on one mode (bus
or Metro). The columns in use, for stage `k` from 1 to 4:

| Column | Content |
|---|---|
| `tipo_transporte_k` | Mode of the stage: `1` = RED bus, `2` = Metro, `3` = other buses, `4` = suburban rail. |
| `paradero_subida_k` | Boarding stop or station. Bus: stop code (e.g. `L-11-30-36-NS`). Metro: station name (e.g. `IRARRAZAVAL`). |
| `paradero_bajada_k` | Alighting stop or station. `-` when no alighting was inferred. |
| `tiempo_subida_k` | Boarding timestamp (`YYYY-MM-DD HH:MM:SS`). |
| `tiempo_bajada_k` | Alighting timestamp. |

And two trip-level columns:

| Column | Content |
|---|---|
| `factor_expansion` | How many real trips the record represents. This is the weight. |
| `tipodia` | Day type. Working day = `0` in the 2023 data. |

Note on the extract used for the published data: despite covering year 2023,
it contains ten working days (the weeks of April 17 and August 7, 2023). The
pipeline normalizes all weights by the number of working days, so the
aggregates represent an average working day.

### 2. Stop catalog (`dtpm-paraderos.parquet`)

Geolocates the bus stop codes. Columns in use: `codigo_ts` (the code that
appears in `paradero_subida/bajada` for bus stages; the older column name
`Código paradero TS` is also accepted), `geometry` (point in UTM 19S,
EPSG:32719, reprojected to WGS84), and, for the GTFS path
(`--paraderos-gtfs`), `codigo_usuario` (the `stop_id` of the feed). Join
coverage with the bus stages: about 99%.

### 3. Metro station coordinates

`src/json/MetroParaderos.json`, with the list
`metros: [{nombre, latitud, longitud}]`. Names are uppercase without accents
and match the DTPM Metro stages and the network graph.

## How each stage maps to a segment

A trip stage becomes a directed segment (boarding -> alighting). All segments
of a trip carry its `factor_expansion` as weight.

- **Bus** (`tipo_transporte = 1`): the boarding and alighting codes are
  geolocated with the catalog (or with the GTFS `stops.txt`). The segment is
  the straight chord between the two stops; the pipeline rasterizes the
  hexagons along that chord. The segment hour is the boarding hour.
- **Metro** (`tipo_transporte = 2`): the stage goes from boarding station to
  alighting station, which need not be adjacent. It is routed over the network
  graph (shortest path with a transfer penalty) and split into
  station-to-station segments, with the stage time divided uniformly. Each
  segment inherits the `factor_expansion` of its stage.
- **Modes 3 and 4** are excluded by default, to keep the two-layer design
  (RED bus + Metro). To include other buses, add `"3"` to `MODOS_BUS` in
  `dtpm_a_segmentos.py`.
- Stages without alighting (`-`), with `factor_expansion <= 0`, or with
  invalid timestamps are discarded.

### Intermediate schema (the contract with the pipeline)

The converter writes two parquet files under `src/json/segmentos/`. This is
the contract that the aggregation reads (`src/FuenteDatos.py`, parquet
backend):

`buses.parquet`: `id`, `latinicial`, `loninicial`, `latfinal`, `lonfinal`,
`tiempoinicial` (timestamp), `tiempofinal` (timestamp),
`carga` (= factor_expansion), `horarango` (0-23).

`metro.parquet`: `estacioninicial`, `estacionfinal`, `latinicial`,
`loninicial`, `latfinal`, `lonfinal`, `tiempoinicial` (`HH:MM:SS`),
`tiempofinal` (`HH:MM:SS`), `horarango`, `tipodia` (`LABORAL`),
`peso` (= factor_expansion).

Next to the parquet files, `metadatos.json` stores `dias_laborales` (distinct
working days in the extract) and the date range. `FuenteDatos.py` divides the
weights by that number on read, so the aggregated matrices and
`CantidadViajes.json` represent an average working day, not the sum of the
extract.

## Generic input contract: trips + GTFS (for other cities)

The pipeline has two input seams, and they should be kept apart:

1. **Segment level** (exists today): the "Intermediate schema" above. Anyone
   with their own data can write a converter to those two parquet files and
   run the aggregation and the app without touching anything else. This is
   the minimal contract, but it leaves out the heavy work (geolocation, Metro
   routing, normalization), which each adopter would have to redo.
2. **Trips + GTFS level** (the target contract): the input is trip stages
   referenced to a GTFS feed, and the converter in this folder does the rest.
   Two inputs, both standard or close to it:

**Trip stages** (one row per stage; the physical format does not matter,
parquet or CSV):

| Column | Content |
|---|---|
| `modo` | `bus` or `rail`. |
| `subida`, `bajada` | Boarding and alighting stop or station, as `stop_id` of the GTFS feed. |
| `t_subida`, `t_bajada` | Boarding and alighting timestamps. |
| `factor_expansion` | How many real trips the record represents (the weight). |
| `tipo_dia` | Day-type label; the pipeline uses the working days. |

Plus one metadata value for the extract: the number of working days it
contains, to normalize the aggregates to an average working day.

**The GTFS feed** of the same network provides everything else: `stops.txt`
gives the coordinates of stops and stations (and the spatial extent of the
grid); `trips.txt` + `stop_times.txt` with `route_type` 1 give the rail
topology (station sequence per line; transfers via `parent_station`), which
feeds the routing graph; `shapes.txt` and the route colors give the context
layers (line traces and bus network). OSM is not an input: nothing in the
pipeline consumes it (bus chords are straight by design, and the geometries
come from the GTFS).

**Current state against that contract.** The Metro topology is derived from
the GTFS: `gtfs_a_metro.py` builds the lines from the `route_type` 1 routes
and their `stop_times`, and materializes them in `src/json/RedMetro.json`,
which `dtpm_a_segmentos.py` uses to build the routing graph. There are no
hand-written station lists; what remains Santiago-specific in that step are
`ALIAS_GTFS` (GTFS spellings -> DTPM names, part of the adapter) and
`ORDEN_GRAFO` (a reproducibility anchor for the tie-breaking of equal-cost
routes; see its comment in `gtfs_a_metro.py`). Equivalence against the
previous hand-written topology was verified: same stations and coordinates,
same trace and same HexMetro pairs (modulo line orientation, which affects
nothing), and 0 routing differences over the 7875 station pairs, so the
segments and the matrices do not change.

The other two gaps are closed through explicit options, and in both cases the
Santiago default stays intact so the published matrices do not change:

- **Bus stops from the GTFS**: `dtpm_a_segmentos.py --paraderos-gtfs
  <feed.zip>` geolocates with `stops.txt`; the DTPM catalog then serves only
  as a code map (`codigo_ts` -> `codigo_usuario`, which is the `stop_id` of
  the feed), that is, as the code adapter the contract asks for. Measured
  against the catalog (2026 feed): the same location in practice (median 0 m,
  p99 8.3 m) and stage coverage of 99.1% against 99.2%. Because the
  coordinates are not bit-identical, the default remains the catalog
  geometry: it is what reproduces the published data exactly.
- **Grid bounding box from the GTFS**: `CreacionGrilla.py` accepts
  `BBOX="minLat,maxLat,minLon,maxLon"` or `BBOX_GTFS=feed.zip` (the extent of
  the stops plus a margin, `BBOX_GTFS_MARGEN`). Without those variables it
  uses the usual Greater Santiago bbox (verified: byte-identical grid).

With this, a city with stages referenced to its GTFS feed can run the full
flow; what remains as the DTPM adapter is the reader of the trip format (the
per-stage columns above) and the TS code map. The verification of each
refactor was the same: with the same Santiago data, the same matrices.

## Differences from the historical version

- **The Metro weight is no longer 1**. Each Metro segment used to weigh 1
  (a segment count). It now weighs `factor_expansion` (expanded demand), the
  same as buses. This makes the two layers comparable and removes the
  asymmetry of the original thesis.
- **Buses no longer use on-board load**. The DTPM source has no occupancy;
  the weight is expanded demand. The bus segment is the boarding-to-alighting
  chord, a coarser primitive than the stop-by-stop legs of the historical
  source.
- There is no temporal-window mismatch: buses and Metro come from the same
  DTPM extract, the same year, and the same working days.

## Individual steps (without the orchestrator)

```sh
# 1. Environment
cd preparar_datos && uv sync

# 2. Hexagonal grid (from src/)
cd ../src && uv run --project ../preparar_datos python CreacionGrilla.py

# 3. Metro inputs from GTFS (from preparar_datos/)
cd ../preparar_datos && uv run python gtfs_a_metro.py

# 4. Bus network structure from GTFS
uv run python gtfs_a_recorridos.py

# 5. DTPM -> segments + CantidadViajes.json
uv run python dtpm_a_segmentos.py --muestra 0          # 0 = full extract

# 6. Segments -> per-hour matrices (from src/)
cd ../src && uv run --project ../preparar_datos python Main.py

# 7. Matrices -> particles
node CalcularParticulas.js
```

## Data source seam

`src/FuenteDatos.py` reads the segments from
`src/json/segmentos/{buses,metro}.parquet`. No database. The parquet path is
controlled with `DIR_SEGMENTOS` (default `json/segmentos`). The GTFS for the
Metro inputs is controlled with `GTFS_URL` (see `gtfs_a_metro.py`).

## Notes

- **Memory**: the converter processes the parquet fragment by fragment, so
  memory does not grow with the extract size. The aggregation (`Main.py`)
  parallelizes by hour (processes = CPU - 3, configurable with the `PROCESOS`
  environment variable) and reads the segments in batches (`FuenteDatos.py`,
  batch size via `TAMANO_LOTE`), so each process stays under ~0.6 GB even at
  the peak hour of the full extract (~20 M Metro segments).
- **Cost**: the full extract generates millions of segments (mostly Metro,
  because each stage splits into several legs). Use `--muestra` or filter to
  one day to iterate fast.
- **Another city / another rail network**: see "Generic input contract"
  above. The rail topology comes from the city's GTFS (`gtfs_a_metro.py`),
  the grid can be derived from the same feed (`BBOX_GTFS` in
  `CreacionGrilla.py`), and the bus stops can be geolocated with `stops.txt`
  (`--paraderos-gtfs`). What has to be written is the adapter from the city's
  own trip records to the stage schema (and its code map to `stop_id`).
