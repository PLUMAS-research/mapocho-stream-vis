// App.css goes after the MapLibre CSS so it can override the position of its
// controls (scale and attribution) in the cascade.
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';
// Self-hosted typography (no CDN, consistent with an app without external
// runtime dependencies).
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import { Map, ScaleControl, AttributionControl } from 'react-map-gl/maplibre';
import DeckGL, { PolygonLayer, PathLayer, HeatmapLayer, TextLayer, ScatterplotLayer, TripsLayer, MapView} from 'deck.gl';
import React, { useState, useEffect, useCallback, useRef, useMemo} from 'react';
import { GL } from '@luma.gl/constants';
import * as h3 from 'h3-js';

import cantidadViajesData from './json/CantidadViajes.json';
import particulasPrecalculadas from './particulasPrecalculadas.json';

// H3 grid and context layers (independent of the hour). The per-hour
// matrices, including the initial one, load lazily (they are not bundled).
import hexGridData from './json/Hexagon_r10.json';
import metroParaderosData from './json/MetroParaderos.json';
import lineasMetroData from './json/LineasMetro.json';
import lineasBusesData from './json/LineasBuses.json';
import { CAPAS_EXTRA } from './capasExtra';

// The H3 grid is stored minimal (only the indices in `celdas`). Here, once at
// load time, we derive the geometry the rest uses: per cell its center and its
// neighbors (by local id), and the H3 index -> local id map. It takes ~0.4 s
// for 105k cells at res 10, covered by the loading splash.
const hexagonosData = hexGridData.celdas.map((idx, id) => {
  const [lat, lon] = h3.cellToLatLng(idx);
  return { id, h3: idx, c: [lon, lat] };
});
// Plain object, not a native Map: the react-map-gl Map component shadows the
// global Map constructor in this module.
const h3ToId = Object.create(null);
hexGridData.celdas.forEach((idx, id) => { h3ToId[idx] = id; });
hexagonosData.forEach((hex) => {
  hex.vecinos = h3.gridDisk(hex.h3, 1)
    .filter((c) => c !== hex.h3 && c in h3ToId)
    .map((c) => h3ToId[c]);
});



// Map parameters
// Carto styles served as style.json: MapLibre renders them without a token.
// Labeled variants to show street and place names.
const EstiloMapaClaro = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const EstiloMapaOscuro = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
// Carto raster styles: the same maps, as image tiles. They render under
// headless Chromium (SwiftShader), where the vector style does not, so they
// are the basis of the paper's reproducible captures. Enabled with
// ?estilo=raster (light) and ?estilo=raster-oscuro.
const crearEstiloRaster = (capa) => ({
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: ['a', 'b', 'c'].map(
        (s) => `https://${s}.basemaps.cartocdn.com/${capa}/{z}/{x}/{y}@2x.png`
      ),
      tileSize: 256,
      attribution: '© OpenStreetMap contributors, © CARTO',
    },
  },
  layers: [{ id: 'carto-raster', type: 'raster', source: 'carto' }],
});
const EstiloMapaRaster = crearEstiloRaster('light_all');
const EstiloMapaRasterOscuro = crearEstiloRaster('dark_all');

// URL parameters to reproduce an exact view (paper captures and shareable
// links). Example:
//   ?hora=7&modo=buses&lat=-33.527&lon=-70.696&zoom=12.6
//   &particulas=1&heatmap=1&trazado=0&redbuses=0&nombres=0
//   &vectbuses=0&vectmetro=0&panel=0&ui=0&estilo=raster
// Without parameters, the app behaves as always.
// H3 resolution suffix of the per-hour matrices. It must match the static
// imports above and the pipeline's RESOLUCION_H3. Changing the resolution
// requires regenerating the data and updating both.
const SUFIJO_RES = 'r10';

const PARAMS_URL = new URLSearchParams(window.location.search);
const paramBool = (clave, porDefecto) =>
  PARAMS_URL.has(clave) ? PARAMS_URL.get(clave) === '1' : porDefecto;
const paramNum = (clave, porDefecto) => {
  const v = parseFloat(PARAMS_URL.get(clave));
  return Number.isFinite(v) ? v : porDefecto;
};
// Valid hour (integer 0-23). Clamps and rounds; used for the URL and for the
// value stored in localStorage, which may come corrupted.
const clampHora = (v) => Math.max(0, Math.min(23, Math.round(v)));
// ui=0 hides all the chrome (bar, panels, legends) for clean captures.
const MOSTRAR_UI = paramBool('ui', true);

// Shared style of the floating chrome: a single source of backgrounds,
// borders, and control sizes, so boxes and buttons stay consistent.
const UI_ACENTO = '#0e7490';
const UI_ACENTO_SUAVE = 'rgba(14, 116, 144, 0.55)';
const UI_TEXTO = '#d5d9e0';
const CAJA_UI = {
  background: 'rgba(22, 24, 32, 0.92)',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  borderRadius: '2px',
  boxShadow: '0 2px 10px rgba(0, 0, 0, 0.35)',
  backdropFilter: 'blur(6px)',
};
// Standalone button (with its own box).
const BOTON_UI = {
  ...CAJA_UI,
  color: 'white',
  cursor: 'pointer',
  padding: '6px 12px',
  fontSize: '12px',
  fontWeight: '600',
};
// Button inside a box (inherits the container background).
const BOTON_PLANO = {
  background: 'transparent',
  border: 'none',
  borderRadius: '2px',
  color: 'white',
  cursor: 'pointer',
  padding: '5px 10px',
  fontSize: '12px',
  fontWeight: '500',
};

// Metro stations (id, name, latitude, longitude) for the labels.
const ESTACIONES_METRO = metroParaderosData.metros || [];
// Metro line traces: per line, [lon, lat] polylines and the official color.
const LINEAS_METRO = lineasMetroData.lineas || [];
// Physical structure of the bus network: context routes [[lon, lat], ...].
const RECORRIDOS_BUSES = lineasBusesData.recorridos || [];
// Initial heatmap zoom level. The resolution is set with a slider, independent
// of the camera, so the heatmap's geographic footprint does not change while
// navigating the map.
const NIVEL_HEATMAP_INICIAL = 13;
// Base radius of the heatmap kernel, in pixels, measured at the chosen level.
const RADIO_BASE_HEATMAP = 120;
// Reference latitude (Santiago) to convert the zoom level into a radius in meters.
const LAT_REF_HEATMAP = -33.45;
// Geographic radius (m) of the kernel for a given zoom level, per the Web Mercator scale.
const radioHeatmapMetros = (nivel) =>
  RADIO_BASE_HEATMAP * 156543.03392 * Math.cos(LAT_REF_HEATMAP * Math.PI / 180) / Math.pow(2, nivel);
// Below this zoom the 126 Metro labels saturate the view, so they only appear when zooming in.
const ZOOM_MIN_ETIQUETAS_METRO = 12.5;
// Mobile profile: narrow viewport OR coarse-pointer device. A phone in
// landscape exceeds 700px but is still low-end, so both signals combine to
// keep it inside the light profile.
const CONSULTA_MOVIL = '(max-width: 700px), (pointer: coarse)';


// Key visualization values
const valoresVisualizacion = {
  GranSantiago: {
    CantidadParticulas: 49, // Number of particles to show
    VidaParticulasMinima: 1500,
    VidaParticulasMaxima: 4000, // Lifetime range in ms
    DuracionMuerteParticula: 500, // Fade-out duration of a dead particle
    tiempoActualizacion: 100,    // Value update interval
    transparenciaInicial: 235,   // particle opacity factor, over 255; higher means more color
    Vista: {                     // Default view: Metro Universidad de Chile (downtown)
      latitude: -33.4439,
      longitude: -70.6507,
      zoom: 11,
      bearing: 0,
      pitch: 0,
    },
  },
};
// Camera limits per zoom level
const limitesPorZoomLevel = {
  1: { // Far zoom: the center can travel almost the whole city bbox.
    minLon: -70.80, maxLon: -70.57, minLat: -33.60, maxLat: -33.39
  },
  2: { // Medium zoom
    minLon: -70.83, maxLon: -70.54, minLat: -33.63, maxLat: -33.36
  },
  3: { // Near zoom: close-up exploration, so panning is the widest.
    minLon: -70.87, maxLon: -70.50, minLat: -33.67, maxLat: -33.33
  }
};

// Loads the per-hour data dynamically
const cargarDatos = async (hora) => {
  try {
    // Extract only the hour number (e.g. "8" from "08:00")
    const horaNum = parseInt(hora.split(':')[0], 10);
    
    // Import using the hour number directly
    const vectoresBuses = await import(`./json/buses/${horaNum}/MatrizVectoresBuses_${SUFIJO_RES}_${horaNum}.json`);
    const pesosBuses = await import(`./json/buses/${horaNum}/MatrizPesosBuses_${SUFIJO_RES}_${horaNum}.json`);
    const vectoresMetro = await import(`./json/metro/${horaNum}/MatrizVectoresMetro_${SUFIJO_RES}_${horaNum}.json`);
    const pesosMetro = await import(`./json/metro/${horaNum}/MatrizPesosMetro_${SUFIJO_RES}_${horaNum}.json`);
    
    return {
      status: 'success',
      MatrizVectoresBuses: vectoresBuses.default,
      MatrizPesosBuses: pesosBuses.default,
      MatrizVectoresMetro: vectoresMetro.default,
      MatrizPesosMetro: pesosMetro.default,
    };
  } catch (error) {
    console.error("Error loading data:", error);
    return {
      status: 'error',
      message: `No se encontraron datos para las ${hora}`
    };
  }
};




// Interpolates a color within a palette of stops {limite, color, opacity}.
// Clamps out of range (like the particle layer). Returns [r, g, b].
function interpolarColorStops(peso, colorStops) {
  if (peso <= colorStops[0].limite) return colorStops[0].color;
  const ultimo = colorStops[colorStops.length - 1];
  if (peso >= ultimo.limite) return ultimo.color;
  let lower = colorStops[0], upper = ultimo;
  for (let k = 0; k < colorStops.length - 1; k++) {
    if (peso >= colorStops[k].limite && peso <= colorStops[k + 1].limite) {
      lower = colorStops[k];
      upper = colorStops[k + 1];
      break;
    }
  }
  const span = upper.limite - lower.limite;
  const t = span > 0 ? (peso - lower.limite) / span : 0;
  return lower.color.map((c0, i) => Math.round(c0 + t * (upper.color[i] - c0)));
}

// Builds the data (path + color) of the vector layer. It only includes
// hexagons with a nonzero vector, to avoid drawing thousands of zero-length
// arrows. The result is memoized upstream (useMemo) so it is not rebuilt on
// every animation frame.
function construirDatosVectores(vectores, pesos, hexagonos, colorStops, escala) {
  const datos = [];
  for (let hexId = 0; hexId < vectores.length; hexId++) {
    const vector = vectores[hexId];
    if (!vector || (vector[0] === 0 && vector[1] === 0)) continue;
    const centro = hexagonos[hexId].c;
    datos.push({
      path: [centro, [centro[0] + vector[0] * escala, centro[1] + vector[1] * escala]],
      color: interpolarColorStops(pesos[hexId], colorStops),
    });
  }
  return datos;
}


// --- Streamlines (precomputed flow trajectories) ------------------------------
// The flow animates on the GPU with TripsLayer over fixed trajectories. Each
// trajectory is computed once per hour by advecting a seed through the vector
// field; animating only advances a clock (currentTime), with no per-frame
// geometry recomputation in JavaScript.
const STREAMLINE_MAX_PASOS = 100;    // maximum vertices per trajectory
const STREAMLINE_PASO = 0.00045;     // advance per step, in degrees (~half a hex radius)
const STREAMLINE_ESTELA = 24;        // visible trail length (trailLength)
// The animation advances proportional to the local field magnitude: each step
// lasts dt = 0.5/factor with the factor clamped to [1/DT_MAX, DT_MAX]. Trails
// thus run fast along strong-flow corridors and slowly in weak zones.
const STREAMLINE_DT_MAX = 2;
// Fixed clock period. Each trail reappears several times per cycle with
// random phase and pause (continuous respawn), and appearances that cross the
// cycle boundary are duplicated with an offset: the on-screen density is
// stationary and the clock wrap does not cut trails midway.
const STREAMLINE_LOOP = 240;
const STREAMLINE_PAUSA_MIN = 20;     // minimum pause between reappearances
const STREAMLINE_PAUSA_MAX = 60;     // maximum pause between reappearances
// Guards against orbits around sinks: the trajectory stops if the direction
// reverses abruptly or the SIGNED accumulated turning exceeds ~0.85 turns
// (S-curves cancel out; a circle never manages to close).
const STREAMLINE_REVERSA_COS = -0.6;
const STREAMLINE_GIRO_MAX = 1.7 * Math.PI;
// Less flow is seeded on mobile. The trajectory precomputation is synchronous
// (up to 100 steps per seed on the main thread) and the TripsLayer geometry
// is what crashes low-end devices.
const CANTIDAD_PARTICULAS_MOVIL = 1500;
// Minimum weight for a hexagon to contribute flow or color (below this the
// particle would be invisible). It must match the threshold used in
// CalcularParticulas.js.
const PESO_MINIMO_VISIBLE = 10;

// Split map: context layers (independent of the hour) drawn in BOTH views.
// Hour-dependent layers use the '-der' suffix for hour B and are routed to
// their view; see filtrarCapaPorVista.
const CAPAS_CONTEXTO_COMPARACION = new Set([
  'red-buses', 'trazado-metro', 'estaciones-metro', 'etiquetas-metro',
]);

// Is the point inside the polygon? (ray casting). To seed inside the hex.
function puntoEnPoligono(punto, polygon) {
  let dentro = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > punto[1]) !== (yj > punto[1])) &&
      (punto[0] < (xj - xi) * (punto[1] - yi) / (yj - yi) + xi);
    if (intersect) dentro = !dentro;
  }
  return dentro;
}

// A random point inside the cell (spreads the seeds of one cell). The
// vertices come from H3 (cellToBoundary); they are not stored.
function muestrearEnHex(hexagon) {
  const vs = h3.cellToBoundary(hexagon.h3).map(([lat, lon]) => [lon, lat]);
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [x, y] of vs) {
    if (x < minLon) minLon = x;
    if (x > maxLon) maxLon = x;
    if (y < minLat) minLat = y;
    if (y > maxLat) maxLat = y;
  }
  for (let intento = 0; intento < 20; intento++) {
    const lon = minLon + Math.random() * (maxLon - minLon);
    const lat = minLat + Math.random() * (maxLat - minLat);
    if (puntoEnPoligono([lon, lat], vs)) return [lon, lat];
  }
  return hexagon.c;
}

// Local id of the H3 cell containing (lon, lat), via h3-js and the h3ToId
// map. Returns -1 outside the grid.
function posicionAHexId(lon, lat, g) {
  const celda = h3.latLngToCell(lat, lon, g.resolucion);
  const id = g.h3ToId[celda];
  return id === undefined ? -1 : id;
}

// Median field magnitude over the active cells: reference for the relative
// animation speed of the trails.
function magnitudMediana(vectores, pesos) {
  const mags = [];
  for (let i = 0; i < vectores.length; i++) {
    const v = vectores[i];
    if (!v || (v[0] === 0 && v[1] === 0) || pesos[i] < PESO_MINIMO_VISIBLE) continue;
    mags.push(Math.hypot(v[0], v[1]));
  }
  if (mags.length === 0) return 1;
  mags.sort((a, b) => a - b);
  return mags[mags.length >> 1];
}

// Field vector at a point, interpolated by inverse distance between the
// centers of the cell containing the point and its H3 neighbors (precomputed
// in the grid). It smooths the direction transitions between cells.
function vectorEnPunto(lon, lat, vectores, g) {
  const celda = h3.latLngToCell(lat, lon, g.resolucion);
  const id = g.h3ToId[celda];
  if (id === undefined) return null;
  const hex = g.hexagonos[id];
  let sx = 0, sy = 0, sw = 0;
  const ids = [id, ...hex.vecinos];
  for (const i of ids) {
    const v = vectores[i];
    if (!v || (v[0] === 0 && v[1] === 0)) continue;
    const c = g.hexagonos[i].c;
    const dLon = lon - c[0];
    const dLat = lat - c[1];
    const w = 1 / (dLon * dLon + dLat * dLat + 1e-9);
    sx += v[0] * w;
    sy += v[1] * w;
    sw += w;
  }
  if (sw === 0) return null;
  return [sx / sw, sy / sw];
}

// Advects a seed through the interpolated field and returns the polyline
// with its step times: dt inversely proportional to the local magnitude
// (relative to the median), clamped to avoid stalled or fleeting trails. It
// stops when leaving the grid, reaching a cell without flow, or falling into
// a sink (abrupt reversal or excessive accumulated turning).
function calcularStreamline(semilla, vectores, g, magRef) {
  const path = [semilla];
  const tiempos = [0];
  let lon = semilla[0], lat = semilla[1], t = 0;
  let dirPrev = null;
  let giroAcumulado = 0;
  for (let s = 0; s < STREAMLINE_MAX_PASOS; s++) {
    const v = vectorEnPunto(lon, lat, vectores, g);
    if (!v) break;
    const mag = Math.hypot(v[0], v[1]);
    if (mag === 0) break;
    const dir = [v[0] / mag, v[1] / mag];
    if (dirPrev) {
      const punto = dir[0] * dirPrev[0] + dir[1] * dirPrev[1];
      if (punto < STREAMLINE_REVERSA_COS) break;
      const cruz = dirPrev[0] * dir[1] - dirPrev[1] * dir[0];
      giroAcumulado += Math.atan2(cruz, punto);
      if (Math.abs(giroAcumulado) > STREAMLINE_GIRO_MAX) break;
    }
    dirPrev = dir;
    lon += dir[0] * STREAMLINE_PASO;
    lat += dir[1] * STREAMLINE_PASO;
    const factor = Math.min(Math.max(mag / magRef, 1 / STREAMLINE_DT_MAX),
                            STREAMLINE_DT_MAX);
    t += 0.5 / factor;
    path.push([lon, lat]);
    tiempos.push(t);
  }
  return { path, tiempos };
}

// --- Streamlets over bus routes (experimental) ---------------------------------
// Instead of advecting freely through the interpolated field, the bus trail
// follows the geometry of the route closest to its seed; the field provides
// the travel direction and the speed. Enabled in Config or with ?rutas=1.
const COS_LAT_GRILLA = Math.cos(((hexGridData.minLat + hexGridData.maxLat) / 2) * Math.PI / 180);

// Index hexagon -> bus routes crossing it (polylines sampled at ~1 streamline
// step). Built only once.
function construirIndiceRutas(g) {
  // Plain object (not a native Map: the react-map-gl Map component shadows it).
  const indice = Object.create(null);
  RECORRIDOS_BUSES.forEach((camino, r) => {
    for (let seg = 0; seg < camino.length - 1; seg++) {
      const [lon1, lat1] = camino[seg];
      const [lon2, lat2] = camino[seg + 1];
      const largo = Math.hypot((lon2 - lon1) * COS_LAT_GRILLA, lat2 - lat1);
      const muestras = Math.max(1, Math.ceil(largo / STREAMLINE_PASO));
      for (let m = 0; m < muestras; m++) {
        const f = m / muestras;
        const hexId = posicionAHexId(lon1 + (lon2 - lon1) * f, lat1 + (lat2 - lat1) * f, g);
        if (hexId < 0) continue;
        let lista = indice[hexId];
        if (!lista) { lista = []; indice[hexId] = lista; }
        if (lista.length < 6 && !lista.some((e) => e.r === r)) {
          lista.push({ r, seg, f });
        }
      }
    }
  });
  return indice;
}

// Advances a position (seg, f) a given distance along the route, in the
// indicated direction. Returns the new position and whether the path ended.
function avanzarEnRecorrido(camino, seg, f, sentido, distancia) {
  let restante = distancia;
  while (restante > 0) {
    const [lon1, lat1] = camino[seg];
    const [lon2, lat2] = camino[seg + 1];
    const largo = Math.hypot((lon2 - lon1) * COS_LAT_GRILLA, lat2 - lat1);
    if (largo === 0) {
      if (sentido > 0 ? seg + 2 >= camino.length : seg - 1 < 0) return { seg, f, fin: true };
      seg += sentido; f = sentido > 0 ? 0 : 1;
      continue;
    }
    const disponible = (sentido > 0 ? (1 - f) : f) * largo;
    if (disponible > restante) {
      f += sentido * (restante / largo);
      restante = 0;
    } else {
      restante -= disponible;
      if (sentido > 0 ? seg + 2 >= camino.length : seg - 1 < 0) return { seg, f: sentido > 0 ? 1 : 0, fin: true };
      seg += sentido;
      f = sentido > 0 ? 0 : 1;
    }
  }
  return { seg, f, fin: false };
}

function puntoEnRecorrido(camino, seg, f) {
  const [lon1, lat1] = camino[seg];
  const [lon2, lat2] = camino[seg + 1];
  return [lon1 + (lon2 - lon1) * f, lat1 + (lat2 - lat1) * f];
}

// Trail that follows a bus route: the initial direction is decided by the
// field at the seed, the speed follows the local magnitude, and the trail
// ends if the local flow clearly opposes the travel direction.
function calcularStreamlineRuta(entrada, vectores, g, magRef) {
  const camino = RECORRIDOS_BUSES[entrada.r];
  let seg = entrada.seg, f = entrada.f;
  let [lon, lat] = puntoEnRecorrido(camino, seg, f);
  const v0 = vectorEnPunto(lon, lat, vectores, g);
  if (!v0) return { path: [], tiempos: [] };
  const [alon, alat] = camino[seg];
  const [blon, blat] = camino[seg + 1];
  const alineado = (blon - alon) * COS_LAT_GRILLA * v0[0] * COS_LAT_GRILLA + (blat - alat) * v0[1];
  const sentido = alineado >= 0 ? 1 : -1;
  const path = [[lon, lat]];
  const tiempos = [0];
  let t = 0;
  for (let paso = 0; paso < STREAMLINE_MAX_PASOS; paso++) {
    const previoLon = lon, previoLat = lat;
    const avance = avanzarEnRecorrido(camino, seg, f, sentido, STREAMLINE_PASO);
    seg = avance.seg; f = avance.f;
    [lon, lat] = puntoEnRecorrido(camino, seg, f);
    const v = vectorEnPunto(lon, lat, vectores, g);
    if (!v) break;
    const mag = Math.hypot(v[0] * COS_LAT_GRILLA, v[1]);
    if (mag === 0) break;
    const dLon = (lon - previoLon) * COS_LAT_GRILLA;
    const dLat = lat - previoLat;
    const nAvance = Math.hypot(dLon, dLat);
    if (nAvance === 0) break;
    const alineacion = (dLon * v[0] * COS_LAT_GRILLA + dLat * v[1]) / (nAvance * mag);
    if (alineacion < -0.4) break;
    const factor = Math.min(Math.max(Math.hypot(v[0], v[1]) / magRef, 1 / STREAMLINE_DT_MAX),
                            STREAMLINE_DT_MAX);
    t += 0.5 / factor;
    path.push([lon, lat]);
    tiempos.push(t);
    if (avance.fin) break;
  }
  return { path, tiempos };
}

// Trajectories of one mode (buses/metro) for the given hour, seeded on the
// precomputed hexagons. Each trajectory carries timestamps (with a random
// offset to stagger the flow), color by weight, and width ~sqrt(weight).
function construirStreamlinesModo(tipo, cantidad, vectores, pesos, colorStops, hora, hexagonos, g, indiceRutas) {
  const seeds = particulasPrecalculadas.particulas[tipo] || [];
  const n = Math.min(cantidad, seeds.length);
  const magRef = magnitudMediana(vectores, pesos);
  const salida = [];
  for (let i = 0; i < n; i++) {
    // Strided subsampling, not the first n: the seeds are ordered by cell
    // (sorted H3 index, spatially grouped), so the first n would concentrate
    // in one zone. The stride spreads them across the whole city and keeps
    // the density proportional to demand. With n = total it is the identity.
    const hexId = seeds[Math.floor((i * seeds.length) / n)].hexIdIniciales[hora];
    const hex = hexagonos[hexId];
    if (!hex) continue;
    const peso = pesos[hexId] || 0;
    if (peso < PESO_MINIMO_VISIBLE) continue;   // small weights: invisible particle
    // With the route index active, the trail follows a real route crossing
    // the seed hexagon; if none crosses it, it advects through the field.
    const candidatos = indiceRutas ? indiceRutas[hexId] : null;
    const { path, tiempos } = (candidatos && candidatos.length > 0)
      ? calcularStreamlineRuta(candidatos[Math.floor(Math.random() * candidatos.length)], vectores, g, magRef)
      : calcularStreamline(muestrearEnHex(hex), vectores, g, magRef);
    if (path.length < 2) continue;
    const color = interpolarColorStops(peso, colorStops);
    // Per-mode divisor: bus weights are much smaller than Metro's, and with
    // a shared divisor they were stuck at the minimum width.
    const width = 0.4 + Math.sqrt(peso) / (tipo === 'metro' ? 3 : 1.2);
    // Continuous respawn: the trail reappears every duration + random pause,
    // with a uniform initial phase. Appearances whose window crosses the end
    // of the cycle are duplicated offset by -LOOP, so when the clock wraps
    // the trail continues where it was instead of being cut.
    const duracion = tiempos[tiempos.length - 1] + STREAMLINE_ESTELA;
    const pausa = STREAMLINE_PAUSA_MIN +
      Math.random() * (STREAMLINE_PAUSA_MAX - STREAMLINE_PAUSA_MIN);
    const periodo = duracion + pausa;
    for (let fase = Math.random() * periodo; fase < STREAMLINE_LOOP; fase += periodo) {
      salida.push({ path, timestamps: tiempos.map((t) => t + fase), color, width });
      if (fase + duracion > STREAMLINE_LOOP) {
        const faseWrap = fase - STREAMLINE_LOOP;
        salida.push({ path, timestamps: tiempos.map((t) => t + faseWrap), color, width });
      }
    }
  }
  return salida;
}


// --- Mini markdown for the "Acerca de" popup -----------------------------------
// The content lives in public/acerca-de.md (editable without rebuilding, also
// on the published site). Supported subset: title (# ), paragraphs, lists
// (- ), **bold**, and [links](url). React elements are built, with no
// injected HTML.
function renderizarInline(texto) {
  const partes = texto.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return partes.map((parte, i) => {
    const negrita = parte.match(/^\*\*([^*]+)\*\*$/);
    if (negrita) return <strong key={i}>{negrita[1]}</strong>;
    const enlace = parte.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (enlace) {
      return (
        <a key={i} href={enlace[2]} target="_blank" rel="noreferrer" style={{ color: '#67e8f9' }}>
          {enlace[1]}
        </a>
      );
    }
    return parte;
  });
}

function MarkdownMini({ texto }) {
  const bloques = texto.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return bloques.map((bloque, i) => {
    if (bloque.startsWith('# ')) return null; // the header already shows the title
    const lineas = bloque.split('\n');
    if (lineas.every((l) => l.startsWith('- '))) {
      return (
        <ul key={i} style={{ margin: '0 0 10px', paddingLeft: '18px' }}>
          {lineas.map((l, j) => <li key={j}>{renderizarInline(l.slice(2))}</li>)}
        </ul>
      );
    }
    return <p key={i} style={{ margin: '0 0 10px' }}>{renderizarInline(lineas.join(' '))}</p>;
  });
}

function tituloMarkdown(texto) {
  const linea = texto.split('\n').find((l) => l.startsWith('# '));
  return linea ? linea.slice(2).trim() : 'Acerca de';
}

function App() {

  const [selectorMapaAbierto, setSelectorMapaAbierto] = useState(false);
  const [mostrarPanelConfiguraciones, setMostrarPanelConfiguraciones] = useState(paramBool('panel', false));
  // Compact layout on narrow screens: the map rules, the time box drops to a
  // bottom bar, and layers/style/about fold into Config.
  const [esMovil, setEsMovil] = useState(
    window.matchMedia(CONSULTA_MOVIL).matches);
  useEffect(() => {
    const mq = window.matchMedia(CONSULTA_MOVIL);
    const alCambiar = (e) => setEsMovil(e.matches);
    mq.addEventListener('change', alCambiar);
    return () => mq.removeEventListener('change', alCambiar);
  }, []);

  // System info and credits popup (?creditos=1 opens it right away).
  // The text is loaded from public/acerca-de.md the first time it opens.
  const [mostrarInfo, setMostrarInfo] = useState(paramBool('creditos', false));
  const [textoAcerca, setTextoAcerca] = useState(null);
  useEffect(() => {
    if (!mostrarInfo || textoAcerca !== null) return;
    fetch(`${process.env.PUBLIC_URL}/acerca-de.md`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
      .then(setTextoAcerca)
      .catch(() => setTextoAcerca('# Acerca de\n\nNo se pudo cargar acerca-de.md.'));
  }, [mostrarInfo, textoAcerca]);





  // Values that depend on the initial view configuration (the URL can fix an
  // exact camera for captures and links).
  const vistaBase = valoresVisualizacion.GranSantiago.Vista;
  const vistaMapa = {
    ...vistaBase,
    latitude: paramNum('lat', vistaBase.latitude),
    longitude: paramNum('lon', vistaBase.longitude),
    // On mobile it zooms out one level so the whole city fits the narrow screen.
    zoom: paramNum('zoom', vistaBase.zoom - (esMovil ? 1 : 0)),
  };
  const [viewState, setViewState] = useState(vistaMapa);
  const [zoomLevel, setZoomLevel] = useState(1); // 1=far, 2=medium, 3=near
  const [datosVersion, setDatosVersion] = useState(0);
  const [cantidadParticulas, setCantidadParticulas] = useState(
    esMovil
      ? Math.min(CANTIDAD_PARTICULAS_MOVIL, particulasPrecalculadas.cantidadParticulas)
      : particulasPrecalculadas.cantidadParticulas);
  // Particle animation interval (ms). Higher = less work per second = less CPU.
  const [intervaloActualizacion, setIntervaloActualizacion] = useState(valoresVisualizacion.GranSantiago.tiempoActualizacion);
  // Visible tab: used to stop the animation when the user switches tabs.
  const [pestanaVisible, setPestanaVisible] = useState(true);
  const [horaSeleccionada, setHoraSeleccionada] = useState(8);
  const [datosError, setDatosError] = useState(null);
  const [cargandoDatos, setCargandoDatos] = useState(false);

  const horaSeleccionadaRef = useRef(horaSeleccionada);
  const [horaVisual, setHoraVisual] = useState(8); // Shown in the UI

  // Visible transport mode (total, buses, or metro)
  const [modo, setModo] = useState(PARAMS_URL.get('modo') || 'total');

  const actualizarHora = useCallback((nuevaHora) => {
    horaSeleccionadaRef.current = nuevaHora;
    setHoraSeleccionada(nuevaHora);
  }, []);

 

  // Effect to close the panel on an outside click
  useEffect(() => {
    const manejarClicExterno = (evento) => {
      const esClicEnBotonConfiguracion = evento.target.closest('.boton-configuracion');
      const esClicEnPanelConfiguracion = evento.target.closest('.panel-configuraciones');
      
      // Close the settings panel only if the click was outside it
      if (mostrarPanelConfiguraciones && !esClicEnBotonConfiguracion && !esClicEnPanelConfiguracion) {
        setMostrarPanelConfiguraciones(false);
      }
    };

    document.addEventListener('pointerdown', manejarClicExterno);
    return () => document.removeEventListener('pointerdown', manejarClicExterno);
  }, [mostrarPanelConfiguraciones]);

  // Detects tab visibility to pause the animation when nobody is watching.
  useEffect(() => {
    const manejarVisibilidad = () => setPestanaVisible(!document.hidden);
    document.addEventListener('visibilitychange', manejarVisibilidad);
    return () => document.removeEventListener('visibilitychange', manejarVisibilidad);
  }, []);

  const [estiloMapa, setEstiloMapa] = useState(
    PARAMS_URL.get('estilo') === 'raster' ? EstiloMapaRaster
    : PARAMS_URL.get('estilo') === 'raster-oscuro' ? EstiloMapaRasterOscuro
    : PARAMS_URL.get('estilo') === 'claro' ? EstiloMapaClaro
    : EstiloMapaOscuro);
  const [mostrarParticulas, setMostrarParticulas] = useState(paramBool('particulas', true));
  // Flow-specific toggle: animates (moves) the particles. Independent of the hour changes.
  const [animarParticulas, setAnimarParticulas] = useState(paramBool('animar', true));
  // The heatmap is the heaviest layer on low-end GPUs: off by default on
  // mobile (the toggle or ?heatmap=1 re-enables it).
  const [mostrarHeatmap, setMostrarHeatmap] = useState(paramBool('heatmap', !esMovil));
  const [nivelHeatmap, setNivelHeatmap] = useState(paramNum('nivelheatmap', NIVEL_HEATMAP_INICIAL));
  const [mostrarHexagonos, setMostrarHexagonos] = useState(paramBool('hexagonos', false));
  // The Metro trace and the name labels are independent toggles.
  const [mostrarTrazadoMetro, setMostrarTrazadoMetro] = useState(paramBool('trazado', true));
  const [mostrarNombresMetro, setMostrarNombresMetro] = useState(paramBool('nombres', true));
  // Physical structure of the bus network (context layer).
  const [mostrarRedBuses, setMostrarRedBuses] = useState(paramBool('redbuses', false));
  // Visibility of the extra layers (see capasExtra.js), per their porDefecto.
  const [capasExtraVisibles, setCapasExtraVisibles] = useState(
    () => Object.fromEntries(CAPAS_EXTRA.map((c) => [c.id, c.porDefecto])));

  // Comparison of two hour slots (split map). The view splits into two
  // MapViews with a linked camera: left the main hour, right horaComparacion.
  // Hour-dependent layers are duplicated with the '-der' suffix and routed by
  // view (see filtrarCapaPorVista and the views in the render).
  const [comparar, setComparar] = useState(paramBool('comparar', false));
  const [horaComparacion, setHoraComparacion] = useState(clampHora(paramNum('horab', 18)));
  // Pending value of the right slider: applied (loads datosB) on release.
  const [horaComparacionVisual, setHoraComparacionVisual] = useState(clampHora(paramNum('horab', 18)));
  const [datosB, setDatosB] = useState(null);
  // Loads the hour-B data while the comparison is active.
  useEffect(() => {
    if (!comparar) return;
    let vivo = true;
    setCargandoDatos(true);
    cargarDatos(`${horaComparacion}:00`).then((r) => {
      if (!vivo) return;
      if (r.status === 'success') {
        setDatosB({
          vectoresBuses: r.MatrizVectoresBuses,
          pesosBuses: r.MatrizPesosBuses.MatrizPesos,
          vectoresMetro: r.MatrizVectoresMetro,
          pesosMetro: r.MatrizPesosMetro.MatrizPesos,
        });
      }
      setCargandoDatos(false);
    });
    return () => { vivo = false; setCargandoDatos(false); };
  }, [comparar, horaComparacion]);
  // No comparison on mobile: arriving in comparison mode (URL or a resize
  // from desktop) falls back to the single view.
  useEffect(() => {
    if (esMovil && comparar) setComparar(false);
  }, [esMovil, comparar]);

  //
  // Data for the modes: bus, metro, or combined.
  //
  // Initialized empty; the initial hour loads lazily on mount
  // (aplicarInicial), like any hour change. No per-hour matrix is bundled.
  const cargaTotalBusesRef = useRef(0);
  const cargaTotalMetroRef = useRef(0);
  const cargaTotalRef = useRef(0);
  const matrizVectoresBusesRef = useRef([]);
  const matrizPesosBusesRef = useRef([]);
  const matrizVectoresMetroRef = useRef([]);
  const matrizPesosMetroRef = useRef([]);
  
  // State that controls the vector display
  const [mostrarVectoresBuses, setMostrarVectoresBuses] = useState(false);
  const [mostrarVectoresMetro, setMostrarVectoresMetro] = useState(false);
  // Scale factor of the vector length. Magnitudes are ~0.001, so without
  // amplification the arrows are sub-pixel. The user adjusts it with a slider.
  const [escalaVectores, setEscalaVectores] = useState(paramNum('vectescala', 4));

  // Per-frame particle generation was replaced by precomputed streamlines
  // plus TripsLayer (see the module helpers above and the flow layer below).


  // Applies the pending parameters
  const aplicarParametros = async (horaAAplicar = horaVisual) => {
    setCargandoDatos(true);
    try {
      setDatosError(null);

      const formattedHour = horaAAplicar.toString().padStart(2, '0') + ':00';

      // Load the new data (hour only)
      const resultado = await cargarDatos(formattedHour);

      if (resultado.status === 'error') {
        setDatosError(resultado.message);
        setHoraVisual(horaSeleccionada); // the label returns to the hour already loaded
        return;
      }

      // Update the references
      matrizVectoresBusesRef.current = resultado.MatrizVectoresBuses;
      matrizPesosBusesRef.current = resultado.MatrizPesosBuses.MatrizPesos;
      matrizVectoresMetroRef.current = resultado.MatrizVectoresMetro;
      matrizPesosMetroRef.current = resultado.MatrizPesosMetro.MatrizPesos;

      // Update the total loads
      cargaTotalBusesRef.current = resultado.MatrizPesosBuses.CargaTotal;
      cargaTotalMetroRef.current = resultado.MatrizPesosMetro.CargaTotal;
      cargaTotalRef.current = resultado.MatrizPesosBuses.CargaTotal + resultado.MatrizPesosMetro.CargaTotal;

      // Update the hour and force the per-hour layers to recompute
      actualizarHora(horaAAplicar);
      setDatosVersion(v => v + 1);

    } catch (error) {
      console.error("Error applying parameters:", error);
      setDatosError("Error inesperado al cargar los datos");
      setHoraVisual(horaSeleccionada);
    } finally {
      setCargandoDatos(false);
    }
  };

  // Two-hour comparison (split map): direct task, entered from the time bar.
  // On entry, both sliders start at the hours already loaded.
  const entrarComparacion = () => {
    setHoraVisual(horaSeleccionada);
    setHoraComparacionVisual(horaComparacion);
    setComparar(true);
  };
  const salirComparacion = () => {
    setComparar(false);
    setHoraVisual(horaSeleccionada);
  };

  // Initial hour: the URL takes precedence over the localStorage value.
  useEffect(() => {
    const savedHora = localStorage.getItem("horaSeleccionada");
    let horaInicial;
    if (PARAMS_URL.has('hora')) {
      horaInicial = clampHora(paramNum('hora', 8));
    } else {
      const guardada = parseInt(savedHora, 10);
      horaInicial = Number.isFinite(guardada) ? clampHora(guardada) : 8;
    }

    actualizarHora(horaInicial);
    setHoraVisual(horaInicial);
    const aplicarInicial = async () => {
      setCargandoDatos(true);
      const formattedHour = horaInicial.toString().padStart(2, '0') + ':00';
      const resultado = await cargarDatos(formattedHour);
      
      if (resultado.status === 'success') {
        matrizVectoresBusesRef.current = resultado.MatrizVectoresBuses;
        matrizPesosBusesRef.current = resultado.MatrizPesosBuses.MatrizPesos;
        matrizVectoresMetroRef.current = resultado.MatrizVectoresMetro;
        matrizPesosMetroRef.current = resultado.MatrizPesosMetro.MatrizPesos;
        cargaTotalBusesRef.current = resultado.MatrizPesosBuses.CargaTotal;
        cargaTotalMetroRef.current = resultado.MatrizPesosMetro.CargaTotal;
        cargaTotalRef.current = resultado.MatrizPesosBuses.CargaTotal + resultado.MatrizPesosMetro.CargaTotal;
        // Vector data memoizes by datosVersion; the ref change must be
        // signaled so they recompute with the hour actually loaded.
        setDatosVersion(v => v + 1);
      } else {
        setDatosError(resultado.message);
      }
      setCargandoDatos(false);
    };

    aplicarInicial();
  }, []);



 // Bus palette: viridis (perceptually uniform), blue-teal -> green -> yellow.
  // Stops calibrated to average-working-day weights (maximum ~1030 per
  // hexagon at the peak hour): buses then span the full palette.
  const colorStopsBuses = [
    { limite: 10, color: [59, 82, 139], opacity: 0.7 },    // Blue-purple
    { limite: 150, color: [33, 144, 141], opacity: 0.8 },  // Teal
    { limite: 450, color: [92, 200, 99], opacity: 0.9 },   // Green
    { limite: 1000, color: [253, 231, 37], opacity: 1.0 }  // Yellow
  ];

  // Metro palette: magma (perceptually uniform), purple -> magenta -> orange
  const colorStopsMetro = [
    { limite: 10, color: [81, 18, 124], opacity: 0.7 },     // Purple
    { limite: 1000, color: [183, 55, 121], opacity: 0.8 },  // Magenta
    { limite: 10000, color: [240, 96, 93], opacity: 0.9 },  // Red-orange
    { limite: 30000, color: [254, 176, 120], opacity: 1.0 } // Light orange
  ];


  // Speeds per zoom level (slower when zooming in)
  const velocidadesPorNivel = {
    1: 0.001,   // Original speed
    2: 0.0005,  // 
    3: 0.0002   // 
  };
  
  // Streamline animation clock. A requestAnimationFrame advances this value;
  // TripsLayer uses it as currentTime (a GPU uniform). The animation thus does
  // NOT go through React state rebuilding geometry frame by frame.
  const [tiempoAnim, setTiempoAnim] = useState(STREAMLINE_MAX_PASOS);
  const tiempoAnimRef = useRef(STREAMLINE_MAX_PASOS);

  // H3 grid for the position -> cell mapping (stable reference): resolution,
  // the H3 index -> local id map, and the centers/neighbors per cell.
  const paramsGrilla = useMemo(
    () => ({
      resolucion: hexGridData.resolucion,
      h3ToId,
      hexagonos: hexagonosData,
    }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Streamlets over real bus routes (experimental). The hexagon -> routes
  // index is built only once.
  const [streamletsPorRuta, setStreamletsPorRuta] = useState(paramBool('rutas', false));
  const indiceRutas = useMemo(() => construirIndiceRutas(paramsGrilla), [paramsGrilla]);

  // Flow trajectories, precomputed once per hour/mode/count. Stable reference
  // across frames: TripsLayer does not recompute geometry while animating.
  const streamlines = useMemo(() => {
    const hora = horaSeleccionadaRef.current;
    const construir = (tipo) => construirStreamlinesModo(
      tipo, cantidadParticulas,
      tipo === 'metro' ? matrizVectoresMetroRef.current : matrizVectoresBusesRef.current,
      tipo === 'metro' ? matrizPesosMetroRef.current : matrizPesosBusesRef.current,
      tipo === 'metro' ? colorStopsMetro : colorStopsBuses,
      hora, hexagonosData, paramsGrilla,
      tipo === 'buses' && streamletsPorRuta ? indiceRutas : null
    );
    return modo === 'total' ? [...construir('buses'), ...construir('metro')] : construir(modo);
  }, [datosVersion, modo, cantidadParticulas, paramsGrilla, streamletsPorRuta, indiceRutas]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hour-B trajectories (split map). Same computation as hour A, but from
  // datosB and the comparison hour. They share the animation clock (tiempoAnim).
  const streamlinesB = useMemo(() => {
    if (!comparar || !datosB) return [];
    const construir = (tipo) => construirStreamlinesModo(
      tipo, cantidadParticulas,
      tipo === 'metro' ? datosB.vectoresMetro : datosB.vectoresBuses,
      tipo === 'metro' ? datosB.pesosMetro : datosB.pesosBuses,
      tipo === 'metro' ? colorStopsMetro : colorStopsBuses,
      horaComparacion, hexagonosData, paramsGrilla,
      tipo === 'buses' && streamletsPorRuta ? indiceRutas : null
    );
    return modo === 'total' ? [...construir('buses'), ...construir('metro')] : construir(modo);
  }, [comparar, datosB, horaComparacion, modo, cantidadParticulas, paramsGrilla, streamletsPorRuta, indiceRutas]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animation loop: advances the clock while the particles are visible, the
  // animation toggle is on, and the tab is visible. The speed depends on the
  // base interval and softens when zooming in. When paused, the clock stays
  // still and the trails freeze.
  useEffect(() => {
    if (!mostrarParticulas || !animarParticulas || !pestanaVisible) return;
    const pasosPorSeg = 1000 / intervaloActualizacion;
    const factorZoom = velocidadesPorNivel[zoomLevel] / velocidadesPorNivel[1];
    let raf, ultimo = null;
    const bucle = (ts) => {
      if (ultimo != null) {
        tiempoAnimRef.current += ((ts - ultimo) / 1000) * pasosPorSeg * factorZoom;
        setTiempoAnim(tiempoAnimRef.current);
      }
      ultimo = ts;
      raf = requestAnimationFrame(bucle);
    };
    raf = requestAnimationFrame(bucle);
    return () => cancelAnimationFrame(raf);
  }, [mostrarParticulas, animarParticulas, pestanaVisible, intervaloActualizacion, zoomLevel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flow layer: GPU-animated streamlets (TripsLayer). currentTime cycles in
  // [0, STREAMLINE_LOOP); trailLength sets the visible length of each trail.
  // Props shared between the hour-A and hour-B flow layers (split map): both
  // sets of trails use the same clock and the same style.
  const propsCapaFlujo = {
    getPath: d => d.path,
    getTimestamps: d => d.timestamps,
    getColor: d => d.color,
    getWidth: d => d.width,
    widthMinPixels: 1.2,
    widthMaxPixels: 5,
    capRounded: true,
    jointRounded: true,
    currentTime: tiempoAnim % STREAMLINE_LOOP,
    trailLength: STREAMLINE_ESTELA,
    fadeTrail: true,
    opacity: 0.85,
    parameters: {
      depthTest: false,
      blend: true,
      blendEquation: GL.FUNC_ADD,
      blendFunc: [GL.SRC_ALPHA, GL.ONE],
      blendColor: [0, 0, 0, 0]
    }
  };
  const particulasLayer = mostrarParticulas && new TripsLayer({
    id: 'trailing-layer', data: streamlines, ...propsCapaFlujo
  });
  const particulasLayerB = comparar && mostrarParticulas && new TripsLayer({
    id: 'trailing-layer-der', data: streamlinesB, ...propsCapaFlujo
  });

  
  // Vector layer data, memoized: rebuilt only when the hour data
  // (datosVersion) or the scale changes, NOT on every particle frame. deck.gl
  // then receives a stable `data` reference and does not re-upload the
  // geometry to the GPU on every render.
  const datosVectoresBuses = useMemo(
    () => construirDatosVectores(matrizVectoresBusesRef.current, matrizPesosBusesRef.current,
      hexagonosData, colorStopsBuses, escalaVectores),
    [datosVersion, escalaVectores] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const datosVectoresMetro = useMemo(
    () => construirDatosVectores(matrizVectoresMetroRef.current, matrizPesosMetroRef.current,
      hexagonosData, colorStopsMetro, escalaVectores),
    [datosVersion, escalaVectores] // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Hour-B vectors (split map).
  const datosVectoresBusesB = useMemo(
    () => (comparar && datosB)
      ? construirDatosVectores(datosB.vectoresBuses, datosB.pesosBuses, hexagonosData, colorStopsBuses, escalaVectores)
      : [],
    [comparar, datosB, escalaVectores] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const datosVectoresMetroB = useMemo(
    () => (comparar && datosB)
      ? construirDatosVectores(datosB.vectoresMetro, datosB.pesosMetro, hexagonosData, colorStopsMetro, escalaVectores)
      : [],
    [comparar, datosB, escalaVectores] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Shared props of the vector layers (hour A and hour B).
  const propsVectores = {
    getPath: d => d.path,
    getColor: d => d.color, // Color from the data
    getWidth: 2,
    widthUnits: 'pixels',
    widthMinPixels: 1.5,
  };
  // Layer that draws the mean bus vectors, per cell
  const vectorLayerBuses  = mostrarVectoresBuses && new PathLayer({
    id: 'vector-layer-buses', data: datosVectoresBuses, ...propsVectores
  });
  const vectorLayerBusesB = comparar && mostrarVectoresBuses && new PathLayer({
    id: 'vector-layer-buses-der', data: datosVectoresBusesB, ...propsVectores
  });



  // Layer that draws the mean Metro vectors, per cell
  const vectorLayerMetro  = mostrarVectoresMetro && new PathLayer({
    id: 'vector-layer-metro', data: datosVectoresMetro, ...propsVectores
  });
  const vectorLayerMetroB = comparar && mostrarVectoresMetro && new PathLayer({
    id: 'vector-layer-metro-der', data: datosVectoresMetroB, ...propsVectores
  });


  // Grid diagnostic layer (off by default). Vertices are computed with
  // cellToBoundary only when enabled, so they are not stored.
  const datosHexagonos = useMemo(
    () => mostrarHexagonos
      ? hexagonosData.map((hex) => h3.cellToBoundary(hex.h3).map(([lat, lon]) => [lon, lat]))
      : [],
    [mostrarHexagonos] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const hexagonosLayer = mostrarHexagonos && new PolygonLayer({
    id: 'hex-grid-layer',
    data: datosHexagonos,
    getPolygon: d => d,
    getFillColor: [0, 0, 0, 0], // Transparent fill
    getLineColor: [100, 150, 255, 150], // Blue line color
    getLineWidth: 1,
    lineWidthMinPixels: 1,
    pickable: false,
  });


  // Schematic trace of the Metro lines, each in its official color. It is the
  // network structure, independent of the name labels and the flow.
  // LINEAS_METRO is constant: the array is built once and the layer receives
  // a stable reference instead of rebuilding it on every animation frame.
  const datosTrazadoMetro = useMemo(
    () => LINEAS_METRO.flatMap(l => l.polilineas.map(path => ({ path, color: l.color }))),
    []
  );
  const trazadoMetroLayer = mostrarTrazadoMetro && new PathLayer({
    id: 'trazado-metro',
    data: datosTrazadoMetro,
    getPath: d => d.path,
    getColor: d => d.color,
    // Width in meters with pixel bounds: the trace scales with the zoom
    // (like the streamlets) instead of staying fixed and looking thin when
    // zooming in.
    getWidth: 45,
    widthUnits: 'meters',
    widthMinPixels: 2,
    widthMaxPixels: 12,
    capRounded: true,
    jointRounded: true,
    parameters: { depthTest: false },
  });

  // Station markers over the trace: white circle with a dark outline, as in
  // transit maps. They share the Metro trace toggle.
  const estacionesMetroLayer = mostrarTrazadoMetro && new ScatterplotLayer({
    id: 'estaciones-metro',
    data: ESTACIONES_METRO,
    getPosition: d => [d.longitud, d.latitud],
    // Radius in meters, like the trace width, so the station circles follow
    // the line when zooming in.
    getRadius: 55,
    radiusUnits: 'meters',
    radiusMinPixels: 2.5,
    radiusMaxPixels: 9,
    filled: true,
    getFillColor: [255, 255, 255, 255],
    stroked: true,
    getLineColor: [40, 40, 50, 255],
    lineWidthUnits: 'pixels',
    getLineWidth: 1.5,
    lineWidthMinPixels: 1,
    parameters: { depthTest: false },
    pickable: false,
  });

  // Physical structure of the bus network (Red): faint context layer. It
  // shows where the lines run, with or without demand, unlike the vector
  // field.
  const redBusesLayer = mostrarRedBuses && new PathLayer({
    id: 'red-buses',
    data: RECORRIDOS_BUSES,
    getPath: d => d,
    getColor: [110, 115, 130, 90],
    getWidth: 1,
    widthUnits: 'pixels',
    widthMinPixels: 0.5,
    capRounded: true,
    parameters: { depthTest: false },
  });



  //
  //     HEATMAP LAYER
  //

  // Lower the opacity while the particles are visible
  const [opacidadHeatmap, setOpacidadHeatmap] = useState(1);
  useEffect(() => {
    setOpacidadHeatmap(mostrarParticulas ? 0.5 : 1);
  }, [mostrarParticulas]);


  // Chooses the weight matrix for the heatmap
  function obtenerMatrizPesos() {
      switch (modo) {
      case 'buses': 
        return matrizPesosBusesRef.current;
      case 'metro': 
        return matrizPesosMetroRef.current;
      case 'total': 
        // Add the bus and Metro weights
        const total = [];
        for (let i = 0; i < matrizPesosBusesRef.current.length; i++) {
          total[i] = matrizPesosBusesRef.current[i] + matrizPesosMetroRef.current[i];
        }
        return total;
      default: 
        return [];
    }
  }

  // Converts the matrix into heatmap data
  function generarDatosHeatmap() {
    const matrizPesos = obtenerMatrizPesos();
    const datos = [];
    
    // Every mode uses hexagons now
    for (let hexId = 0; hexId < matrizPesos.length; hexId++) {
      const peso = matrizPesos[hexId];
      if (peso > 0) {
        datos.push({
          position: hexagonosData[hexId].c,
          weight: peso
        });
      }
    }
    
    return datos;
  }

  // Heatmap palette: plasma (perceptually uniform), blue -> magenta -> orange
  // -> yellow. The alpha grows with density so low zones stay faint.
  const heatmapColors = [
    [13, 8, 135, 70],      // Deep blue
    [126, 3, 168, 120],    // Purple
    [203, 70, 121, 160],   // Magenta
    [248, 149, 64, 190],   // Orange
    [253, 195, 40, 225],   // Amber
    [240, 249, 33, 255]    // Yellow
  ];

  const datosHeatmap = useMemo(() => generarDatosHeatmap(), [modo, mostrarHeatmap, datosVersion]);

  // Hour-B heatmap data (split map): same per-mode aggregation, from datosB.
  const datosHeatmapB = useMemo(() => {
    if (!comparar || !datosB) return [];
    const pesos = modo === 'buses' ? datosB.pesosBuses
      : modo === 'metro' ? datosB.pesosMetro
      : datosB.pesosBuses.map((p, i) => p + datosB.pesosMetro[i]);
    const datos = [];
    for (let hexId = 0; hexId < pesos.length; hexId++) {
      if (pesos[hexId] > 0) datos.push({ position: hexagonosData[hexId].c, weight: pesos[hexId] });
    }
    return datos;
  }, [comparar, datosB, modo]); // eslint-disable-line react-hooks/exhaustive-deps

  // The heatmap is pinned to the chosen level (nivelHeatmap), not the camera:
  // the pixel radius adjusts by 2^(cameraZoom - level) so the geographic
  // footprint is always that of the level. The rendered radius is bounded to
  // avoid degrading performance in extreme combinations.
  const radioHeatmapPx = Math.min(1200, Math.max(2,
    RADIO_BASE_HEATMAP * Math.pow(2, viewState.zoom - nivelHeatmap)));
  const propsHeatmap = {
    getPosition: d => d.position,
    getWeight: d => d.weight,
    radiusPixels: radioHeatmapPx,
    intensity: 1,
    threshold: 0.05,
    opacity: opacidadHeatmap,
    colorRange: heatmapColors,
  };
  const heatmapLayer = mostrarHeatmap && new HeatmapLayer({
    id: 'heatmap-layer', data: datosHeatmap, ...propsHeatmap
  });
  const heatmapLayerB = comparar && mostrarHeatmap && new HeatmapLayer({
    id: 'heatmap-layer-der', data: datosHeatmapB, ...propsHeatmap
  });






  // Labels with the name of each Metro station. Only when zoomed in, to avoid
  // clutter, and only if the names toggle is on (independent of the trace).
  const etiquetasMetroLayer = mostrarNombresMetro && viewState.zoom >= ZOOM_MIN_ETIQUETAS_METRO && new TextLayer({
    id: 'etiquetas-metro',
    data: ESTACIONES_METRO,
    getPosition: d => [d.longitud, d.latitud],
    getText: d => d.nombre,
    getSize: 12,
    sizeUnits: 'pixels',
    // The TextLayer does not inherit CSS: the font is declared here so the
    // labels use the same typography as the rest of the interface.
    fontFamily: '"Space Grotesk", sans-serif',
    getColor: [20, 20, 30, 255],
    getTextAnchor: 'middle',
    getAlignmentBaseline: 'bottom',
    getPixelOffset: [0, -6],
    background: true,
    getBackgroundColor: [255, 255, 255, 200],
    backgroundPadding: [3, 1],
    fontWeight: 'bold',
    pickable: false,
  });

  // Draw order (bottom -> top): network structure as the base, then flow,
  // vectors, and labels on top.
  // Extra layers (capasExtra.js): built with the current context and appended
  // at the end of the stack. An error in one does not break the rest.
  const capasExtraLayers = CAPAS_EXTRA
    .filter((c) => capasExtraVisibles[c.id])
    .map((c) => {
      try {
        return c.crearCapa({
          hora: horaSeleccionada, modo, esMovil, viewState,
          hexagonosData, h3ToId,
          matrices: {
            vectoresBuses: matrizVectoresBusesRef.current,
            pesosBuses: matrizPesosBusesRef.current,
            vectoresMetro: matrizVectoresMetroRef.current,
            pesosMetro: matrizPesosMetroRef.current,
          },
          deck: { PolygonLayer, PathLayer, ScatterplotLayer, TextLayer, HeatmapLayer, TripsLayer },
        });
      } catch (e) {
        console.error(`Extra layer "${c.id}" failed:`, e);
        return null;
      }
    });

  const layers = [
    heatmapLayer,
    heatmapLayerB,
    redBusesLayer,
    trazadoMetroLayer,
    estacionesMetroLayer,
    hexagonosLayer,
    particulasLayer,
    particulasLayerB,
    vectorLayerBuses,
    vectorLayerBusesB,
    vectorLayerMetro,
    vectorLayerMetroB,
    etiquetasMetroLayer,
    ...capasExtraLayers,
  ].filter(Boolean);

  // Split map: two side-by-side MapViews with a linked camera (they share the
  // same viewState because it is not indexed by view id). The filter routes
  // each layer to its side; context layers go in both.
  const vistasComparacion = useMemo(() => ([
    new MapView({ id: 'izq', x: 0, width: '50%', controller: true }),
    new MapView({ id: 'der', x: '50%', width: '50%', controller: true }),
  ]), []);
  const filtrarCapaPorVista = ({ layer, viewport }) => {
    if (!comparar) return true;
    if (CAPAS_CONTEXTO_COMPARACION.has(layer.id)) return true;
    const esDer = layer.id.endsWith('-der');
    return viewport.id === 'der' ? esDer : !esDer;
  };


  // Legend of the three palettes (heatmap, buses, metro). Static content:
  // built once so it is not rebuilt on every animation frame.
  const leyendasAgrupadas = useMemo(() => (
      <div style={{
        ...CAJA_UI,
        position: 'absolute',
        bottom: 16,
        right: 16,
        color: UI_TEXTO,
        padding: '8px 10px',
        zIndex: 10,
        display: 'flex',
        gap: '12px'
      }}>
          {/* Heatmap legend */}
          <div style={{ minWidth: '80px' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '3px', fontSize: '11px' }}>Heatmap</div>
            <div style={{ display: 'flex', height: '12px', borderRadius: '2px', overflow: 'hidden' }}>
              {heatmapColors.map((color, index) => (
                <div key={`heatmap-${index}`} style={{
                  flex: 1,
                  backgroundColor: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
                }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginTop: '3px' }}>
              <span>Baja</span>
              <span>Alta</span>
            </div>
          </div>
          
          {/* Bus legend */}
          <div style={{ minWidth: '80px' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '3px', fontSize: '11px' }}>Buses</div>
            <div style={{ display: 'flex', height: '12px', borderRadius: '2px', overflow: 'hidden' }}>
              {colorStopsBuses.map((stop, index) => (
                <div key={`bus-${index}`} style={{
                  flex: 1,
                  backgroundColor: `rgba(${stop.color.join(',')}, ${stop.opacity})`,
                }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginTop: '3px' }}>
              <span>Suave</span>
              <span>Intenso</span>
            </div>
          </div>
        
        {/* Metro legend */}
        <div style={{ minWidth: '80px'}}>
          <div style={{ fontWeight: 'bold', marginBottom: '3px', fontSize: '11px' }}>Metro</div>
          <div style={{ display: 'flex', height: '12px', borderRadius: '2px', overflow: 'hidden' }}>
            {colorStopsMetro.map((stop, index) => (
              <div key={`metro-${index}`} style={{
                flex: 1,
                backgroundColor: `rgba(${stop.color.join(',')}, ${stop.opacity})`,
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginTop: '3px' }}>
            <span>Suave</span>
            <span>Intenso</span>
          </div>
        </div>
      </div>
  ), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      // Fallback background while the split basemap tiles load.
      background: comparar ? (estiloMapa === EstiloMapaClaro ? '#f2f2f4' : '#0b0e14') : undefined,
    }}>
      {/* Split map: two half-screen basemaps under the deck canvas. Both are
          driven by the same viewState (linked camera) and capture no events
          (interactive=false); the deck controller handles the camera. */}
      {comparar && [
        { key: 'izq', left: 0, atrib: false },
        { key: 'der', left: '50%', atrib: true },
      ].map(({ key, left, atrib }) => (
        <div key={key} style={{ position: 'absolute', top: 0, bottom: 0, left, width: '50%', zIndex: 0 }}>
          <Map
            longitude={viewState.longitude}
            latitude={viewState.latitude}
            zoom={viewState.zoom}
            bearing={viewState.bearing || 0}
            pitch={viewState.pitch || 0}
            interactive={false}
            mapStyle={estiloMapa}
            attributionControl={false}
          >
            {atrib && <AttributionControl compact position="bottom-right" />}
          </Map>
        </div>
      ))}
      <DeckGL
        // viewState always controlled: avoids the controlled -> uncontrolled
        // jump when leaving the comparison, which left the camera unresponsive.
        viewState={viewState}
        {...(comparar ? { views: vistasComparacion, layerFilter: filtrarCapaPorVista } : {})}
        controller={true}
        layers={layers}
        // On mobile it rasterizes at 1 pixel per CSS pixel (no retina
        // supersampling): the largest fragment-shader saving on low-end screens.
        useDevicePixels={esMovil ? 1 : true}
        style={{ width: '100%', height: '100%', ...(comparar ? { position: 'absolute', top: 0, left: 0, zIndex: 1 } : {}) }}
        onViewStateChange={({viewState}) => {
          // Enforce the zoom limits
          if (viewState.zoom < 10) viewState.zoom = 10;
          if (viewState.zoom > 16) viewState.zoom = 16;
          
          // Determine the zoom level
          let newZoomLevel;
          if (viewState.zoom < 11) newZoomLevel = 1;
          else if (viewState.zoom >= 11 && viewState.zoom < 12) newZoomLevel = 2;
          else newZoomLevel = 3;

          // Get the limits for the current zoom level
          const limites = limitesPorZoomLevel[newZoomLevel];
          
          // Enforce the geographic limits
          if (viewState.longitude < limites.minLon) viewState.longitude = limites.minLon;
          if (viewState.longitude > limites.maxLon) viewState.longitude = limites.maxLon;
          if (viewState.latitude < limites.minLat) viewState.latitude = limites.minLat;
          if (viewState.latitude > limites.maxLat) viewState.latitude = limites.maxLat;

          setViewState(viewState);
          
          // Update only on change
          if (zoomLevel !== newZoomLevel) {
            setZoomLevel(newZoomLevel);
          }
        }}
      >
        {/* Single view: the basemap goes as a child of deck (deck drives the
            camera). The comparison uses two sibling basemaps, above in the return. */}
        {!comparar && <Map
          mapStyle={estiloMapa}
          attributionControl={false}
        >
          {/* OSM/Carto attribution in compact mode: a license requirement of
              the basemaps, relevant when publishing the demo. */}
          <AttributionControl compact position="bottom-right" />
          {/* Map scale, shifted toward the center so it is not under the palette. */}
          <ScaleControl
            position="bottom-right"
            maxWidth={90}
            unit="metric"
          />
        </Map>}
      </DeckGL>

      {/* Split map: central divider and an hour label over each half. */}
      {comparar && (
        <>
          <div style={{
            position: 'absolute', top: 0, bottom: 0, left: '50%', width: '2px',
            transform: 'translateX(-1px)', background: 'rgba(255,255,255,0.55)',
            zIndex: 11, pointerEvents: 'none',
          }} />
          {[[horaSeleccionada, '25%'], [horaComparacion, '75%']].map(([h, izq]) => (
            <div key={izq} style={{
              ...CAJA_UI, position: 'absolute', top: esMovil ? 12 : 16, left: izq,
              transform: 'translateX(-50%)', zIndex: 11, pointerEvents: 'none',
              padding: '4px 10px', color: 'white', fontWeight: 700, fontSize: '13px',
            }}>
              {`${String(h).padStart(2, '0')}:00`}
            </div>
          ))}
        </>
      )}


      {/* Floating chrome: every box shares CAJA_UI / BOTON_UI. */}

      {/* App and project name (top left) */}
      {MOSTRAR_UI && <div style={{
        ...CAJA_UI,
        position: 'absolute', top: esMovil ? 12 : 16, left: esMovil ? 12 : 16, zIndex: 11,
        padding: esMovil ? '6px 10px' : '8px 12px', color: 'white'
      }}>
        <div style={{ fontSize: esMovil ? '12px' : '14px', fontWeight: '700', letterSpacing: '0.07em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <img
            src={`${process.env.PUBLIC_URL}/loica.png`}
            alt="Loica, ilustración de Sarai Collilef"
            style={{ height: esMovil ? 22 : 30, width: 'auto', display: 'block' }}
          />
          Mapocho - Flujos en SCL
        </div>
        {!esMovil && <div style={{ fontSize: '10px', color: '#9aa1ad', letterSpacing: '0.05em', marginTop: '2px' }}>
          Proyecto LOICA · ANID Fondecyt Regular 1261835
        </div>}
      </div>}

      {/* Mode selector. Hidden on mobile to leave room for the map: it stays
          on the default mode (total). */}
      {MOSTRAR_UI && !esMovil && <div style={{
        ...CAJA_UI,
        position: 'absolute', top: 78, left: 16, zIndex: 11,
        display: 'flex', padding: '3px', gap: '2px'
      }}>
        {[
          { value: 'total', label: 'Total' },
          { value: 'buses', label: 'Buses' },
          { value: 'metro', label: 'Metro' }
        ].map(option => (
          <button
            key={option.value}
            onClick={() => setModo(option.value)}
            style={{
              ...BOTON_PLANO,
              background: modo === option.value ? UI_ACENTO_SUAVE : 'transparent',
              fontWeight: modo === option.value ? '700' : '500'
            }}
          >
            {option.label}
          </button>
        ))}
      </div>}

      {/* Time box: top center on desktop, full-width bottom bar on mobile.
          In comparison mode it splits into two sliders (left/right), each
          loading its hour when the thumb is released. */}
      {MOSTRAR_UI && <div style={{
        ...CAJA_UI,
        position: 'absolute', zIndex: 11,
        display: 'flex',
        flexDirection: comparar ? 'column' : 'row',
        alignItems: comparar ? 'stretch' : 'center',
        gap: comparar ? '7px' : (esMovil ? '8px' : '12px'),
        padding: esMovil ? '8px 10px' : '7px 14px',
        ...(esMovil
          ? { bottom: 12, left: 12, right: 12 }
          : { top: 16, left: '50%', transform: 'translateX(-50%)', width: comparar ? 'min(440px, 82vw)' : undefined })
      }}>
        {comparar ? (
          <>
            {[
              { etq: 'Izquierda', val: horaVisual, setVis: setHoraVisual, commit: (h) => aplicarParametros(h) },
              { etq: 'Derecha', val: horaComparacionVisual, setVis: setHoraComparacionVisual, commit: (h) => setHoraComparacion(h) },
            ].map(({ etq, val, setVis, commit }) => (
              <div key={etq} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ width: '62px', flexShrink: 0, fontSize: '11px', color: '#9aa1ad' }}>{etq}</span>
                <input
                  type="range"
                  min="0"
                  max="23"
                  value={val}
                  onChange={(e) => setVis(parseInt(e.target.value))}
                  onPointerUp={(e) => commit(parseInt(e.target.value, 10))}
                  onKeyUp={(e) => commit(parseInt(e.target.value, 10))}
                  className="custom-slider"
                  style={{ flex: 1, display: 'block' }}
                />
                <span style={{ width: '48px', flexShrink: 0, color: 'white', fontWeight: '700', fontSize: '13px', textAlign: 'right' }}>
                  {String(val).padStart(2, '0')}:00
                </span>
              </div>
            ))}
            <button
              onClick={salirComparacion}
              style={{ ...BOTON_PLANO, alignSelf: 'flex-end', background: UI_ACENTO_SUAVE, fontWeight: '600' }}
            >
              {'×'} Salir
            </button>
          </>
        ) : (
          <>
            <div style={esMovil ? { flex: 1, minWidth: 0 } : { width: 'min(320px, 30vw)' }}>
              <input
                type="range"
                min="0"
                max="23"
                value={horaVisual}
                onChange={(e) => setHoraVisual(parseInt(e.target.value))}
                onPointerUp={(e) => aplicarParametros(parseInt(e.target.value, 10))}
                onKeyUp={(e) => aplicarParametros(parseInt(e.target.value, 10))}
                className="custom-slider"
                style={{ width: '100%', display: 'block' }}
              />
              {!esMovil && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px', fontSize: '10px', color: '#9aa1ad' }}>
                {[0, 6, 12, 18, 23].map(hour => (
                  <span key={hour}>{hour}:00</span>
                ))}
              </div>}
            </div>
            <span style={{ color: 'white', fontWeight: '700', fontSize: esMovil ? '12px' : '13px', minWidth: esMovil ? '64px' : '92px', textAlign: 'center' }}>
              {String(horaVisual).padStart(2, '0')}:00-{String((horaVisual + 1) % 24).padStart(2, '0')}:00
            </span>
            {/* Compare only on desktop: the split map is hardly usable on mobile. */}
            {!esMovil && <button
              onClick={entrarComparacion}
              style={{ ...BOTON_PLANO, background: CAJA_UI.background, fontWeight: '600' }}
            >
              Comparar
            </button>}
          </>
        )}
      </div>}

      {/* Loading or error notice when changing the hour. Shown only while
          data loads or when loading fails; hidden otherwise. */}
      {MOSTRAR_UI && (cargandoDatos || datosError) && <div style={{
        ...CAJA_UI,
        position: 'absolute', zIndex: 13, left: '50%', transform: 'translateX(-50%)',
        ...(esMovil ? { bottom: 66 } : { top: 62 }),
        padding: '5px 12px', fontSize: '12px', fontWeight: 600,
        color: datosError ? '#fca5a5' : UI_TEXTO, pointerEvents: 'none',
        display: 'flex', alignItems: 'center', gap: '7px',
      }}>
        {datosError ? datosError : <><span className="spinner-carga" />Cargando datos...</>}
      </div>}

      {/* Config (top right) */}
      {MOSTRAR_UI && <button
        className="boton-configuracion"
        onClick={() => setMostrarPanelConfiguraciones(!mostrarPanelConfiguraciones)}
        style={{
          ...BOTON_UI,
          position: 'absolute', top: esMovil ? 12 : 16, right: esMovil ? 12 : 16, zIndex: 12,
          background: mostrarPanelConfiguraciones ? UI_ACENTO : CAJA_UI.background
        }}
      >
        Config
      </button>}

      {/* Visible layers (always shown, under the mode selector). Desktop
          only: omitted on mobile to leave room for the map. */}
      {MOSTRAR_UI && !esMovil && <div style={{
        ...CAJA_UI,
        position: 'absolute', top: 124, left: 16, zIndex: 10,
        width: '158px', padding: '10px 12px', color: UI_TEXTO,
        display: 'flex', flexDirection: 'column', gap: '7px', fontSize: '12px'
      }}>
        <span style={{ fontSize: '11px', fontWeight: '700', letterSpacing: '0.07em', textTransform: 'uppercase', color: 'white' }}>
          Capas
        </span>
        {[
          { label: "Partículas", state: mostrarParticulas, setter: setMostrarParticulas },
          { label: "Heatmap", state: mostrarHeatmap, setter: setMostrarHeatmap },
          { label: "Trazado Metro", state: mostrarTrazadoMetro, setter: setMostrarTrazadoMetro },
          { label: "Nombres Metro", state: mostrarNombresMetro, setter: setMostrarNombresMetro },
          { label: "Red de Buses", state: mostrarRedBuses, setter: setMostrarRedBuses }
        ].map((item, index) => (
          <label key={index} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={item.state}
              onChange={(e) => item.setter(e.target.checked)}
              style={{ marginRight: '7px' }}
            />
            {item.label}
          </label>
        ))}
        {CAPAS_EXTRA.map((c) => (
          <label key={c.id} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={!!capasExtraVisibles[c.id]}
              onChange={(e) => setCapasExtraVisibles((prev) => ({ ...prev, [c.id]: e.target.checked }))}
              style={{ marginRight: '7px' }}
            />
            {c.etiqueta}
          </label>
        ))}
      </div>}

      {/* Settings panel (animation and scale adjustments) */}
      {MOSTRAR_UI && mostrarPanelConfiguraciones && (
        <div className="panel-configuraciones" style={{
          ...CAJA_UI,
          position: 'absolute', top: esMovil ? 52 : 56, right: esMovil ? 12 : 16, zIndex: 12,
          ...(esMovil ? { left: 12, maxHeight: '62vh', overflowY: 'auto' } : { width: '216px' }),
          padding: '12px', color: UI_TEXTO,
          display: 'flex', flexDirection: 'column', gap: '9px', fontSize: '13px'
        }}>
          {esMovil && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {/* The layers menu is omitted on mobile: the map keeps the
                  defaults (animated flow, Metro trace). Only style and about. */}
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                {[
                  { value: EstiloMapaClaro, name: 'Claro' },
                  { value: EstiloMapaOscuro, name: 'Oscuro' }
                ].map(option => (
                  <button
                    key={option.name}
                    onClick={() => setEstiloMapa(option.value)}
                    style={{ ...BOTON_PLANO, border: '1px solid rgba(255, 255, 255, 0.18)', background: estiloMapa === option.value ? UI_ACENTO : 'transparent' }}
                  >
                    {option.name}
                  </button>
                ))}
                <button
                  onClick={() => { setMostrarPanelConfiguraciones(false); setMostrarInfo(true); }}
                  style={{ ...BOTON_PLANO, border: '1px solid rgba(255, 255, 255, 0.18)' }}
                >
                  Acerca de
                </button>
              </div>
            </div>
          )}
          <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={animarParticulas}
              onChange={(e) => setAnimarParticulas(e.target.checked)}
              style={{ marginRight: '8px' }}
            />
            Animar partículas
          </label>
          <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={streamletsPorRuta}
              onChange={(e) => setStreamletsPorRuta(e.target.checked)}
              style={{ marginRight: '8px' }}
            />
            Seguir recorridos (buses)
          </label>

          {/* Low-level layers (field diagnostics) */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: '7px',
            borderTop: '1px solid rgba(255, 255, 255, 0.12)', paddingTop: '8px'
          }}>
            {[
              { label: "Hexágonos", state: mostrarHexagonos, setter: setMostrarHexagonos },
              { label: "Vectores Buses", state: mostrarVectoresBuses, setter: setMostrarVectoresBuses },
              { label: "Vectores Metro", state: mostrarVectoresMetro, setter: setMostrarVectoresMetro }
            ].map((item, index) => (
              <label key={index} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={item.state}
                  onChange={(e) => item.setter(e.target.checked)}
                  style={{ marginRight: '8px' }}
                />
                {item.label}
              </label>
            ))}
          </div>

          <div style={{
            display: 'flex', flexDirection: 'column', gap: '4px',
            borderTop: '1px solid rgba(255, 255, 255, 0.12)', paddingTop: '8px'
          }}>
            <label style={{ fontSize: '12px' }}>Cantidad de partículas: {cantidadParticulas}</label>
            <input
              type="range"
              min={25}
              max={particulasPrecalculadas.cantidadParticulas}
              step={25}
              value={cantidadParticulas}
              onChange={(e) => setCantidadParticulas(parseInt(e.target.value, 10))}
            />
            <label style={{ fontSize: '12px', marginTop: '4px' }}>Ritmo de animación: {intervaloActualizacion} ms/paso</label>
            <input
              type="range"
              min={50}
              max={500}
              step={25}
              value={intervaloActualizacion}
              onChange={(e) => setIntervaloActualizacion(parseInt(e.target.value, 10))}
            />
            <span style={{ fontSize: '11px', color: '#9aa1ad' }}>
              La animación corre en GPU; menor valor = flujo más rápido.
            </span>
          </div>

          {(mostrarVectoresBuses || mostrarVectoresMetro) && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: '4px',
              borderTop: '1px solid rgba(255, 255, 255, 0.12)', paddingTop: '8px'
            }}>
              <label style={{ fontSize: '12px' }}>Escala de vectores: {escalaVectores}x</label>
              <input
                type="range"
                min={1}
                max={15}
                step={1}
                value={escalaVectores}
                onChange={(e) => setEscalaVectores(parseInt(e.target.value, 10))}
              />
              <span style={{ fontSize: '11px', color: '#9aa1ad' }}>
                Alarga las flechas del campo vectorial.
              </span>
            </div>
          )}

          {mostrarHeatmap && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: '4px',
              borderTop: '1px solid rgba(255, 255, 255, 0.12)', paddingTop: '8px'
            }}>
              <label style={{ fontSize: '12px' }}>Resolución heatmap</label>
              <input
                type="range"
                min={10}
                max={16}
                step={0.5}
                value={nivelHeatmap}
                onChange={(e) => setNivelHeatmap(parseFloat(e.target.value))}
              />
              <span style={{ fontSize: '11px', color: '#9aa1ad' }}>
                Nivel {nivelHeatmap} - radio de {
                  radioHeatmapMetros(nivelHeatmap) >= 1000
                    ? (radioHeatmapMetros(nivelHeatmap) / 1000).toFixed(1) + ' km'
                    : Math.round(radioHeatmapMetros(nivelHeatmap)) + ' m'
                }
              </span>
            </div>
          )}
        </div>
      )}

      {/* Trip counter (above the color palette; desktop only) */}
      {MOSTRAR_UI && !esMovil && <div style={{
        ...CAJA_UI,
        position: 'absolute', bottom: 92, right: 16, zIndex: 10,
        padding: '7px 12px', color: 'white'
      }}>
        <span style={{ fontSize: '13px', fontWeight: '700' }}>
          {(modo === 'buses' ? cantidadViajesData.BUSES[horaVisual]
            : modo === 'metro' ? cantidadViajesData.METRO[horaVisual]
            : cantidadViajesData.BUSES[horaVisual] + cantidadViajesData.METRO[horaVisual]
          ).toLocaleString('de-DE')} viajes
        </span>
      </div>}

      {MOSTRAR_UI && !esMovil && leyendasAgrupadas}

      {/* Map style and credits (bottom left; desktop only) */}
      {MOSTRAR_UI && !esMovil && <div style={{
        position: 'absolute', left: 16, bottom: 16, zIndex: 10,
        display: 'flex', alignItems: 'stretch', gap: '8px'
      }}>
        <button
          onClick={() => setSelectorMapaAbierto(!selectorMapaAbierto)}
          style={{ ...BOTON_UI, background: selectorMapaAbierto ? UI_ACENTO : CAJA_UI.background }}
        >
          Estilo mapa
        </button>
        {selectorMapaAbierto && [
          { value: EstiloMapaClaro, name: 'Claro' },
          { value: EstiloMapaOscuro, name: 'Oscuro' }
        ].map(option => (
          <button
            key={option.name}
            onClick={() => {
              setEstiloMapa(option.value);
              setSelectorMapaAbierto(false);
            }}
            style={{ ...BOTON_UI, background: estiloMapa === option.value ? UI_ACENTO : CAJA_UI.background }}
          >
            {option.name}
          </button>
        ))}
        <button onClick={() => setMostrarInfo(true)} style={BOTON_UI}>
          Acerca de
        </button>
      </div>}

      {/* System info and credits popup */}
      {MOSTRAR_UI && mostrarInfo && (
        <div
          onClick={() => setMostrarInfo(false)}
          style={{
            position: 'absolute', inset: 0, zIndex: 30,
            background: 'rgba(8, 10, 16, 0.65)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              ...CAJA_UI,
              background: 'rgba(22, 24, 32, 0.97)',
              width: 'min(560px, 92vw)', maxHeight: '82vh', overflowY: 'auto',
              color: UI_TEXTO, padding: '18px 22px', fontSize: '13px', lineHeight: 1.55
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
              <span style={{ fontSize: '15px', fontWeight: '700', letterSpacing: '0.07em', textTransform: 'uppercase', color: 'white' }}>
                {textoAcerca ? tituloMarkdown(textoAcerca) : 'Acerca de'}
              </span>
              <button
                onClick={() => setMostrarInfo(false)}
                style={{ background: 'transparent', color: UI_TEXTO, border: 'none', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}
              >
                ×
              </button>
            </div>

            {textoAcerca ? <MarkdownMini texto={textoAcerca} /> : <p style={{ margin: 0 }}>Cargando...</p>}
          </div>
        </div>
      )}

    </div>
  );
}

export default App;