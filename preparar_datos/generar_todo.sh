#!/usr/bin/env bash
# Generates, from the DTPM trip records and the DTPM GTFS, all the data that
# the application needs. It requires no PostgreSQL and no versioned data:
# grid -> Metro inputs (GTFS) -> segments -> per-hour matrices -> particles.
#
# Usage:
#   bash preparar_datos/generar_todo.sh
#   MUESTRA=2 bash preparar_datos/generar_todo.sh   # quick test with 2 fragments
#
# All paths and parameters are controlled by the environment variables below.

set -euo pipefail

# --- Configuration -----------------------------------------------------------
PREP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESIS_DIR="$(cd "$PREP_DIR/.." && pwd)"
SRC_DIR="$TESIS_DIR/src"

# DTPM input data. Override if stored elsewhere.
GDS_DATA="${GDS_DATA:-$HOME/repositories/gds-course-materials/data}"
VIAJES="${VIAJES:-$GDS_DATA/dtpm-viajes/dtpm-2023.parquet}"
PARADEROS="${PARADEROS:-$GDS_DATA/dtpm-paraderos.parquet}"

# Sample: 0 = all fragments (real run, heavy). >0 = quick test.
MUESTRA="${MUESTRA:-0}"

# H3 resolution of the grid (configurable). res 9 ~= 15,060 cells over Greater
# Santiago; RESOLUCION_H3=10 recomputes everything on a finer grid. It is
# exported because CreacionGrilla.py and Main.py read it from the environment.
export RESOLUCION_H3="${RESOLUCION_H3:-9}"

echo "============================================================"
echo "Generating the visualizer data from DTPM"
echo "  Trips:     $VIAJES"
echo "  Stops:     $PARADEROS"
echo "  Output:    $SRC_DIR/json"
echo "  Sample:    ${MUESTRA} (0 = all fragments)"
echo "  H3 resolution: ${RESOLUCION_H3}"
echo "============================================================"

# DTPM GTFS to derive the Metro inputs (coords + routing). The feed version
# fixes the network date; keep one compatible with the DTPM data in use.
GTFS_URL="${GTFS_URL:-https://dtpm.cl/descargas/gtfs/GTFS_20260530_v2.zip}"

# --- 1. Python environment ---------------------------------------------------
echo; echo ">>> [1/7] Syncing the Python environment (uv sync)"
( cd "$PREP_DIR" && uv sync )

# --- 2. H3 hexagonal grid (Hexagon_r<res>.json) ------------------------------
# CreacionGrilla.py generates the H3 grid at resolution RESOLUCION_H3.
echo; echo ">>> [2/7] Generating H3 grid at res ${RESOLUCION_H3} (CreacionGrilla.py)"
( cd "$SRC_DIR" && uv run --project "$PREP_DIR" python CreacionGrilla.py )

# --- 3. GTFS -> Metro inputs (RedMetro, MetroParaderos, HexMetro, LineasMetro) ---
# gtfs_a_metro.py downloads the GTFS and derives the topology, the station
# coords, the Metro->hex routing, and the per-line trace.
echo; echo ">>> [3/7] Deriving the Metro inputs from GTFS (gtfs_a_metro.py)"
( cd "$PREP_DIR" && uv run python gtfs_a_metro.py --gtfs-url "$GTFS_URL" --salida-dir "$SRC_DIR/json" --resolucion "$RESOLUCION_H3" )

# --- 4. GTFS -> bus network (LineasBuses.json) -------------------------------
# gtfs_a_recorridos.py extracts the bus route geometries as a context layer.
echo; echo ">>> [4/7] Deriving the bus network from GTFS (gtfs_a_recorridos.py)"
( cd "$PREP_DIR" && uv run python gtfs_a_recorridos.py --gtfs-url "$GTFS_URL" --salida-dir "$SRC_DIR/json" --resolucion "$RESOLUCION_H3" )

# --- 5. DTPM -> segments (+ CantidadViajes.json) -----------------------------
echo; echo ">>> [5/7] Converting DTPM trips into segments"
( cd "$PREP_DIR" && uv run python dtpm_a_segmentos.py \
    --viajes "$VIAJES" --paraderos "$PARADEROS" \
    --metro-coords "$SRC_DIR/json/MetroParaderos.json" \
    --metro-red "$SRC_DIR/json/RedMetro.json" \
    --salida "$SRC_DIR/json/segmentos" --muestra "$MUESTRA" )

# --- 6. Segments -> per-hour matrices ----------------------------------------
# Main.py reads the parquet through FuenteDatos and parallelizes by hour.
echo; echo ">>> [6/7] Aggregating per-hour matrices (Main.py)"
( cd "$SRC_DIR" && uv run --project "$PREP_DIR" python Main.py )

# --- 7. Matrices -> precomputed particles ------------------------------------
echo; echo ">>> [7/7] Precomputing particles (CalcularParticulas.js)"
( cd "$SRC_DIR" && node CalcularParticulas.js )

echo; echo "============================================================"
echo "Done. Data generated in $SRC_DIR/json and particulasPrecalculadas.json"
echo "To run the application:  cd $TESIS_DIR && npm install && npm start"
echo "============================================================"
