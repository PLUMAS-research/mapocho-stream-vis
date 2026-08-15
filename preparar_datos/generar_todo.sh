#!/usr/bin/env bash
# Genera, desde los viajes DTPM y el GTFS de DTPM, todos los datos que la
# aplicación necesita para operar. No requiere PostgreSQL ni datos versionados:
# grilla -> insumos de Metro (GTFS) -> segmentos -> matrices por hora -> partículas.
#
# Uso:
#   bash preparar_datos/generar_todo.sh
#   MUESTRA=2 bash preparar_datos/generar_todo.sh   # prueba rápida con 2 fragmentos
#
# Todas las rutas y parámetros se controlan por variables de entorno abajo.

set -euo pipefail

# --- Configuración -----------------------------------------------------------
PREP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESIS_DIR="$(cd "$PREP_DIR/.." && pwd)"
SRC_DIR="$TESIS_DIR/src"

# Datos DTPM de entrada (un año). Sobreescribir si están en otra ruta.
GDS_DATA="${GDS_DATA:-$HOME/repositories/gds-course-materials/data}"
VIAJES="${VIAJES:-$GDS_DATA/dtpm-viajes/dtpm-2023.parquet}"
PARADEROS="${PARADEROS:-$GDS_DATA/dtpm-paraderos.parquet}"

# Muestra: 0 = todos los fragmentos (corrida real, pesada). >0 = prueba rápida.
MUESTRA="${MUESTRA:-0}"

# Resolución H3 de la grilla (configurable). res 9 ~= 15.060 celdas sobre el
# Gran Santiago; RESOLUCION_H3=10 recalcula todo con una grilla más fina. La
# leen CreacionGrilla.py y Main.py desde el entorno, por eso se exporta.
export RESOLUCION_H3="${RESOLUCION_H3:-9}"

echo "============================================================"
echo "Generación de datos del visualizador desde DTPM"
echo "  Viajes:    $VIAJES"
echo "  Paraderos: $PARADEROS"
echo "  Salida:    $SRC_DIR/json"
echo "  Muestra:   ${MUESTRA} (0 = todos los fragmentos)"
echo "  Resolución H3: ${RESOLUCION_H3}"
echo "============================================================"

# GTFS de DTPM para derivar los insumos de Metro (coords + ruteo). La versión del
# feed fija la fecha de la red; mantener una compatible con los datos DTPM usados.
GTFS_URL="${GTFS_URL:-https://dtpm.cl/descargas/gtfs/GTFS_20260530_v2.zip}"

# --- 1. Entorno Python -------------------------------------------------------
echo; echo ">>> [1/6] Sincronizando entorno Python (uv sync)"
( cd "$PREP_DIR" && uv sync )

# --- 2. Grilla hexagonal H3 (Hexagon_r<res>.json) ----------------------------
# CreacionGrilla.py genera la grilla H3 a la resolución RESOLUCION_H3.
echo; echo ">>> [2/7] Generando grilla H3 res ${RESOLUCION_H3} (CreacionGrilla.py)"
( cd "$SRC_DIR" && uv run --project "$PREP_DIR" python CreacionGrilla.py )

# --- 3. GTFS -> insumos de Metro (MetroParaderos.json, HexMetro_r<res>.json, LineasMetro.json) ---
# gtfs_a_metro.py baja el GTFS y deriva coords de estaciones, ruteo Metro->hex y trazado por línea.
echo; echo ">>> [3/7] Derivando insumos de Metro desde GTFS (gtfs_a_metro.py)"
( cd "$PREP_DIR" && uv run python gtfs_a_metro.py --gtfs-url "$GTFS_URL" --salida-dir "$SRC_DIR/json" --resolucion "$RESOLUCION_H3" )

# --- 4. GTFS -> red de buses (LineasBuses.json) ------------------------------
# gtfs_a_recorridos.py extrae las geometrías de las rutas de bus como capa de contexto.
echo; echo ">>> [4/7] Derivando la red de buses desde GTFS (gtfs_a_recorridos.py)"
( cd "$PREP_DIR" && uv run python gtfs_a_recorridos.py --gtfs-url "$GTFS_URL" --salida-dir "$SRC_DIR/json" )

# --- 5. DTPM -> segmentos (+ CantidadViajes.json) ----------------------------
echo; echo ">>> [5/7] Convirtiendo viajes DTPM en segmentos"
( cd "$PREP_DIR" && uv run python dtpm_a_segmentos.py \
    --viajes "$VIAJES" --paraderos "$PARADEROS" \
    --metro-coords "$SRC_DIR/json/MetroParaderos.json" \
    --metro-red "$SRC_DIR/json/RedMetro.json" \
    --salida "$SRC_DIR/json/segmentos" --muestra "$MUESTRA" )

# --- 6. Segmentos -> matrices por hora ---------------------------------------
# Main.py lee los parquet vía FuenteDatos y paraleliza por hora.
echo; echo ">>> [6/7] Agregando matrices por hora (Main.py)"
( cd "$SRC_DIR" && uv run --project "$PREP_DIR" python Main.py )

# --- 7. Matrices -> partículas precalculadas ---------------------------------
echo; echo ">>> [7/7] Precalculando partículas (CalcularParticulas.js)"
( cd "$SRC_DIR" && node CalcularParticulas.js )

echo; echo "============================================================"
echo "Listo. Datos generados en $SRC_DIR/json y particulasPrecalculadas.json"
echo "Para ver la aplicación:  cd $TESIS_DIR && npm install && npm start"
echo "============================================================"
