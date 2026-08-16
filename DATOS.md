# Pipeline data contract

The aggregation pipeline reads two tabular sets of trip segments from
`src/json/segmentos/{buses,metro}.parquet`. This document describes the
columns that the source must deliver so the pipeline runs without changes to
the aggregation logic.

This is the **segment-level** contract, the lower of the two the system has.
The **trips + GTFS** contract (trip stages referenced to a GTFS feed, meant
for other cities to run the full conversion flow) is in
`preparar_datos/README.md`, section "Generic input contract".

Important: there is no database. The frontend reads precomputed JSON under
`src/json/`. The segment parquet files are only needed to **regenerate** that
JSON with new data, and the DTPM flow produces them.

> **To generate data from the DTPM trip records**, do not follow this document
> by hand: use the automated flow in `preparar_datos/` (see
> `preparar_datos/README.md`). It converts the DTPM records into the two
> segment parquet files described below and runs the whole pipeline. This
> document describes the low-level contract, useful if you bring data from
> another source.

## Single connection point

All data access goes through `src/FuenteDatos.py`, which exposes
`leer_segmentos_buses(hora)` and `leer_segmentos_metro(hora)` and reads the
parquet files. `CalcularGrillaBuses.py` and `CalcularGrillaMetro.py` only call
those functions. Each reader returns, per hour, an iterator of rows (tuples)
in the column order that the aggregation expects; reads are batched, so memory
does not depend on file size.

The parquet schema is in the "Intermediate schema" section of
`preparar_datos/README.md`. To bring data from another source (CSV, DuckDB,
etc.), it is enough to make `FuenteDatos.py` return the same tuples; the rest
of the pipeline operates on in-memory tuples.

> The SQL tables described below (`vectoresbuses*`, `vectoresmetro*`) are a
> historical reference for the column schema and the field semantics. The
> pipeline no longer uses PostgreSQL.

## Bus table

Historical name: `vectoresbuses082023` (the `082023` suffix means August
2023). The query in `CalcularGrillaBuses.py` was:

```sql
SELECT id, latinicial, loninicial, latfinal, lonfinal,
       tiempoinicial, tiempofinal, carga, horarango
FROM vectoresbuses082023
WHERE carga > 0 AND horarango = %s
  AND latinicial IS NOT NULL AND loninicial IS NOT NULL
  AND latfinal  IS NOT NULL AND lonfinal  IS NOT NULL
  AND tiempoinicial IS NOT NULL AND tiempofinal IS NOT NULL
  AND carga IS NOT NULL
```

Each row is a directed segment between two stops of a bus trip.

| Column | Type | Meaning |
|---|---|---|
| `id` | integer | Segment identifier. |
| `latinicial`, `loninicial` | float (WGS84) | Coordinate of the origin stop. |
| `latfinal`, `lonfinal` | float (WGS84) | Coordinate of the destination stop. |
| `tiempoinicial`, `tiempofinal` | timestamp | Departure and arrival time of the segment. |
| `carga` | number | Weight of the segment (expanded demand in the current flow). |
| `horarango` | integer 0-23 | Hour of the day. Partitions the processing. |

Filters the pipeline assumes: `carga > 0` and no null columns. If a new source
does not guarantee this, filter before delivering the rows.

## Metro table

Historical name: `vectoresmetro112023` (the `112023` suffix means November
2023). The query in `CalcularGrillaMetro.py` was:

```sql
SELECT estacioninicial, estacionfinal,
       latinicial, loninicial, latfinal, lonfinal,
       tiempoinicial, tiempofinal
FROM vectoresmetro112023
WHERE tipodia = 'LABORAL' AND horarango = %s
  AND latinicial IS NOT NULL AND loninicial IS NOT NULL
  AND latfinal  IS NOT NULL AND lonfinal  IS NOT NULL
  AND tiempoinicial IS NOT NULL AND tiempofinal IS NOT NULL
```

Each row is a station-to-station segment of a reconstructed route. Metro
trains expose no GPS, so the route is reconstructed beforehand (network graph
plus shortest path) and materialized in this table.

| Column | Type | Meaning |
|---|---|---|
| `estacioninicial`, `estacionfinal` | text | Origin and destination stations of the segment. |
| `latinicial`, `loninicial` | float (WGS84) | Coordinate of the origin station. |
| `latfinal`, `lonfinal` | float (WGS84) | Coordinate of the destination station. |
| `tiempoinicial`, `tiempofinal` | timestamp | Entry and exit time of the segment. |
| `horarango` | integer 0-23 | Hour of the day. Used in the `WHERE`. |
| `tipodia` | text | Day type. The pipeline filters `'LABORAL'`. |

Unlike buses, this historical table carried no `carga`, and the pipeline
assigned weight 1 to each Metro segment (weights not comparable across
modes). In the current flow this no longer applies: the Metro parquet carries
`peso` = `factor_expansion`, the same expanded-demand weight that buses use
(see `preparar_datos/README.md`).

## Notes

- The table-name suffix encodes the month and year of the extract (`082023` =
  August 2023). This is historical; the current flow derives its window from
  the extract itself (`metadatos.json`).
- `horarango` partitions all processing. `Main.py` runs the 24 hours in
  parallel, one per process.
- Coordinates must be WGS84 (latitude/longitude in degrees): the distance
  computation uses Haversine and the hexagonal grid assumes that system.
