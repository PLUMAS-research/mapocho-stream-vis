// App.css va después del CSS de MapLibre para poder sobreescribir la posición
// de sus controles (escala y atribución) en la cascada.
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';
// Tipografía autoalojada (sin CDN, coherente con la app sin dependencias
// externas en runtime).
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

// Grilla H3 y capas de contexto (independientes de la hora). Las matrices por
// hora, incluida la inicial, se cargan de forma diferida (no se empaquetan).
import hexGridData from './json/Hexagon_r10.json';
import metroParaderosData from './json/MetroParaderos.json';
import lineasMetroData from './json/LineasMetro.json';
import lineasBusesData from './json/LineasBuses.json';
import { CAPAS_EXTRA } from './capasExtra';

// La grilla H3 se guarda mínima (solo los índices en `celdas`). Aquí, una vez al
// cargar, derivamos la geometría que usa el resto: por celda su centro y sus
// vecinos (por id local), y el mapa índice H3 -> id local. Son ~0.4 s para 105k
// celdas a res 10, cubiertos por el splash de carga.
const hexagonosData = hexGridData.celdas.map((idx, id) => {
  const [lat, lon] = h3.cellToLatLng(idx);
  return { id, h3: idx, c: [lon, lat] };
});
// Objeto plano, no Map nativo: el componente Map de react-map-gl tapa el
// constructor global Map en este módulo.
const h3ToId = Object.create(null);
hexGridData.celdas.forEach((idx, id) => { h3ToId[idx] = id; });
hexagonosData.forEach((hex) => {
  hex.vecinos = h3.gridDisk(hex.h3, 1)
    .filter((c) => c !== hex.h3 && c in h3ToId)
    .map((c) => h3ToId[c]);
});



// Parámetros para el mapa
// Estilos de Carto servidos como style.json: los renderiza MapLibre sin token.
// Variantes con etiquetas para mostrar nombres de calles y lugares.
const EstiloMapaClaro = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const EstiloMapaOscuro = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
// Estilos raster de Carto: mismos mapas, en tiles de imagen. Renderizan bajo
// Chromium headless (SwiftShader), donde el estilo vectorial no, así que son
// la base de las capturas reproducibles del paper. Se activan con
// ?estilo=raster (claro) y ?estilo=raster-oscuro.
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

// Parámetros de URL para reproducir una vista exacta (capturas del paper y
// enlaces compartibles). Ejemplo:
//   ?hora=7&modo=buses&lat=-33.527&lon=-70.696&zoom=12.6
//   &particulas=1&heatmap=1&trazado=0&redbuses=0&nombres=0
//   &vectbuses=0&vectmetro=0&panel=0&ui=0&estilo=raster
// Sin parámetros, la app se comporta igual que siempre.
// Sufijo de resolución H3 de las matrices por hora. Debe coincidir con el de los
// imports estáticos de arriba y con RESOLUCION_H3 del pipeline. Al cambiar de
// resolución hay que regenerar los datos y actualizar ambos.
const SUFIJO_RES = 'r10';

const PARAMS_URL = new URLSearchParams(window.location.search);
const paramBool = (clave, porDefecto) =>
  PARAMS_URL.has(clave) ? PARAMS_URL.get(clave) === '1' : porDefecto;
const paramNum = (clave, porDefecto) => {
  const v = parseFloat(PARAMS_URL.get(clave));
  return Number.isFinite(v) ? v : porDefecto;
};
// Hora válida (entero 0-23). Clampa y redondea; se usa para la URL y para el
// valor guardado en localStorage, que puede venir corrupto.
const clampHora = (v) => Math.max(0, Math.min(23, Math.round(v)));
// ui=0 oculta todo el chrome (barra, paneles, leyendas) para capturas limpias.
const MOSTRAR_UI = paramBool('ui', true);

// Estilo compartido del chrome flotante: una sola fuente de fondos, bordes y
// tamaños de control, para que cajas y botones queden consistentes entre sí.
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
// Botón independiente (con caja propia).
const BOTON_UI = {
  ...CAJA_UI,
  color: 'white',
  cursor: 'pointer',
  padding: '6px 12px',
  fontSize: '12px',
  fontWeight: '600',
};
// Botón dentro de una caja (hereda el fondo del contenedor).
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

// Estaciones de metro (id, nombre, latitud, longitud) para las etiquetas.
const ESTACIONES_METRO = metroParaderosData.metros || [];
// Trazado de las líneas de metro: por línea, polilíneas [lon, lat] y color oficial.
const LINEAS_METRO = lineasMetroData.lineas || [];
// Estructura física de la red de buses: recorridos [[lon, lat], ...] de contexto.
const RECORRIDOS_BUSES = lineasBusesData.recorridos || [];
// Nivel de zoom inicial del heatmap. La resolución se fija con un slider, independiente de la
// cámara, para que la huella geográfica del heatmap no cambie al navegar el mapa.
const NIVEL_HEATMAP_INICIAL = 13;
// Radio base del kernel del heatmap, en píxeles, medido al nivel elegido.
const RADIO_BASE_HEATMAP = 120;
// Latitud de referencia (Santiago) para convertir el nivel de zoom a un radio en metros.
const LAT_REF_HEATMAP = -33.45;
// Radio geográfico (m) del kernel para un nivel de zoom dado, según la escala Web Mercator.
const radioHeatmapMetros = (nivel) =>
  RADIO_BASE_HEATMAP * 156543.03392 * Math.cos(LAT_REF_HEATMAP * Math.PI / 180) / Math.pow(2, nivel);
// Bajo este zoom las 126 etiquetas de metro saturan la vista, por eso solo aparecen al acercar.
const ZOOM_MIN_ETIQUETAS_METRO = 12.5;
// Perfil móvil: viewport angosto O dispositivo de puntero grueso. Un teléfono en
// horizontal supera los 700px pero sigue siendo de gama baja, así que se combinan
// ambas señales para no dejarlo fuera del perfil liviano.
const CONSULTA_MOVIL = '(max-width: 700px), (pointer: coarse)';


//Definir valores importantes
const valoresVisualizacion = {
  GranSantiago: {
    CantidadParticulas: 49, // Cantidad de partículas a mostrar
    VidaParticulasMinima: 1500,
    VidaParticulasMaxima: 4000, // La vide varia entre 1000 y 3000 ms
    DuracionMuerteParticula: 500, // Duración de la transparencia de la partícula muerta
    tiempoActualizacion: 100,    // Intervalo de actualización en de valores
    transparenciaInicial: 235,   //factor de transparencia de particulas, sobre 255. Mientras mayor => más color
    Vista: {                     // Vista por defecto: Metro Universidad de Chile (centro)
      latitude: -33.4439,
      longitude: -70.6507,
      zoom: 11,
      bearing: 0,
      pitch: 0,
    },
  },
};
// Definir límites por nivel de zoom
const limitesPorZoomLevel = {
  1: { // Zoom lejano: el centro puede recorrer casi todo el bbox de la ciudad.
    minLon: -70.80, maxLon: -70.57, minLat: -33.60, maxLat: -33.39
  },
  2: { // Zoom medio
    minLon: -70.83, maxLon: -70.54, minLat: -33.63, maxLat: -33.36
  },
  3: { // Zoom cercano: se explora de cerca, así que el paneo es el más amplio.
    minLon: -70.87, maxLon: -70.50, minLat: -33.67, maxLat: -33.33
  }
};

// Función para cargar datos dinámicamente
const cargarDatos = async (hora) => {
  try {
    // Extraer solo el número de la hora (ej: "8" de "08:00")
    const horaNum = parseInt(hora.split(':')[0], 10);
    
    // Importar usando el número de hora directamente
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
    console.error("Error cargando datos:", error);
    return {
      status: 'error',
      message: `No se encontraron datos para las ${hora}`
    };
  }
};




// Interpola un color dentro de una paleta de stops {limite, color, opacity}. Clampa
// fuera de rango (igual que la capa de partículas). Devuelve [r, g, b].
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

// Construye los datos (path + color) de la capa de vectores. Solo incluye hexágonos
// con vector no nulo, para no dibujar miles de flechas de largo cero. El resultado se
// memoiza aguas arriba (useMemo) para no reconstruirlo en cada frame de la animación.
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


// --- Streamlines (trayectorias del flujo, precalculadas) ---------------------
// El flujo se anima en la GPU con TripsLayer sobre trayectorias fijas. Cada
// trayectoria se calcula una vez por hora advectando una semilla por el campo de
// vectores; animar solo mueve un reloj (currentTime), sin recomputar geometría en
// JavaScript por frame.
const STREAMLINE_MAX_PASOS = 100;    // vértices máximos por trayectoria
const STREAMLINE_PASO = 0.00045;     // avance por paso, en grados (~medio radio de hex)
const STREAMLINE_ESTELA = 24;        // largo visible de la estela (trailLength)
// La animación avanza proporcional a la magnitud local del campo: cada paso
// dura dt = 0.5/factor con factor acotado a [1/DT_MAX, DT_MAX]. Así las
// estelas corren rápido en corredores de flujo fuerte y lento en zonas débiles.
const STREAMLINE_DT_MAX = 2;
// Periodo fijo del reloj. Cada estela reaparece varias veces por ciclo con
// fase y pausa aleatorias (respawn continuo), y las apariciones que cruzan el
// borde del ciclo se duplican desfasadas: la densidad en pantalla es
// estacionaria y el wrap del reloj no corta estelas a medio camino.
const STREAMLINE_LOOP = 240;
const STREAMLINE_PAUSA_MIN = 20;     // pausa mínima entre reapariciones
const STREAMLINE_PAUSA_MAX = 60;     // pausa máxima entre reapariciones
// Guardas contra órbitas alrededor de sumideros: la trayectoria se detiene si
// la dirección se invierte de golpe o si el giro acumulado CON SIGNO supera
// ~0.85 vueltas (las curvas en S se cancelan; un círculo no alcanza a cerrarse).
const STREAMLINE_REVERSA_COS = -0.6;
const STREAMLINE_GIRO_MAX = 1.7 * Math.PI;
// En móvil se siembra menos flujo. El precálculo de trayectorias es síncrono
// (hasta 100 pasos por semilla en el hilo principal) y la geometría del
// TripsLayer es lo que revienta en equipos de gama baja.
const CANTIDAD_PARTICULAS_MOVIL = 1500;
// Peso mínimo para que un hexágono aporte flujo o color (bajo esto la partícula
// sería invisible). Debe coincidir con el umbral usado en CalcularParticulas.js.
const PESO_MINIMO_VISIBLE = 10;

// Split map: capas de contexto (independientes de la hora) que se dibujan en
// AMBAS vistas. Las capas dependientes de la hora usan sufijo '-der' para la
// hora B y se enrutan a su vista; ver filtrarCapaPorVista.
const CAPAS_CONTEXTO_COMPARACION = new Set([
  'red-buses', 'trazado-metro', 'estaciones-metro', 'etiquetas-metro',
]);

// ¿El punto está dentro del polígono? (ray casting). Para sembrar dentro del hex.
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

// Un punto aleatorio dentro de la celda (dispersa las semillas de una misma
// celda). Los vértices se obtienen de H3 (cellToBoundary); no se guardan.
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

// id local de la celda H3 que contiene (lon, lat), vía h3-js y el mapa h3ToId.
// Devuelve -1 fuera de la grilla.
function posicionAHexId(lon, lat, g) {
  const celda = h3.latLngToCell(lat, lon, g.resolucion);
  const id = g.h3ToId[celda];
  return id === undefined ? -1 : id;
}

// Magnitud mediana del campo entre las celdas activas: referencia para la
// velocidad de animación relativa de las estelas.
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

// Vector del campo en un punto, interpolado por distancia inversa entre los
// centros de la celda que contiene el punto y sus vecinas H3 (precalculadas en
// la grilla). Suaviza las transiciones de dirección entre celdas.
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

// Advecta una semilla por el campo interpolado y devuelve la polilínea junto
// a los tiempos de paso: dt inversamente proporcional a la magnitud local
// (relativa a la mediana), acotado para evitar estelas estancadas o fugaces.
// Se detiene al salir de la grilla, al llegar a una celda sin flujo, o al
// caer en un sumidero (reversa brusca o giro acumulado excesivo).
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

// --- Streamlets sobre recorridos (experimental) -------------------------------
// En vez de advectar libremente por el campo interpolado, la estela de bus
// sigue la geometria del recorrido mas cercano a su semilla; el campo aporta
// el sentido de avance y la velocidad. Se activa en Config o con ?rutas=1.
const COS_LAT_GRILLA = Math.cos(((hexGridData.minLat + hexGridData.maxLat) / 2) * Math.PI / 180);

// Indice hexagono -> recorridos de bus que lo cruzan (muestreo de las
// polilineas a ~1 paso de streamline). Se construye una sola vez.
function construirIndiceRutas(g) {
  // Objeto plano (no Map nativo: el componente Map de react-map-gl lo tapa).
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

// Avanza una posicion (seg, f) una distancia dada a lo largo del recorrido,
// en el sentido indicado. Devuelve la posicion nueva y si se acabo el camino.
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

// Estela que sigue un recorrido de bus: el sentido inicial lo decide el campo
// en la semilla, la velocidad sigue la magnitud local, y la estela termina si
// el flujo local se opone claramente al sentido de avance.
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

// Trayectorias de un modo (buses/metro) para la hora dada, sembrando en los hexágonos
// precalculados. Cada trayectoria lleva timestamps (con desfase aleatorio para escalonar
// el flujo), color por peso y ancho ~sqrt(peso).
function construirStreamlinesModo(tipo, cantidad, vectores, pesos, colorStops, hora, hexagonos, g, indiceRutas) {
  const seeds = particulasPrecalculadas.particulas[tipo] || [];
  const n = Math.min(cantidad, seeds.length);
  const magRef = magnitudMediana(vectores, pesos);
  const salida = [];
  for (let i = 0; i < n; i++) {
    // Submuestreo espaciado, no las primeras n: las semillas están ordenadas por
    // celda (índice H3 ordenado, agrupado espacialmente), así que las primeras n
    // se concentrarían en una zona. El paso las reparte por toda la ciudad y
    // conserva la densidad proporcional a la demanda. Con n = total es identidad.
    const hexId = seeds[Math.floor((i * seeds.length) / n)].hexIdIniciales[hora];
    const hex = hexagonos[hexId];
    if (!hex) continue;
    const peso = pesos[hexId] || 0;
    if (peso < PESO_MINIMO_VISIBLE) continue;   // pesos chicos: partícula invisible
    // Con el indice de rutas activo, la estela sigue un recorrido real que
    // cruza el hexagono semilla; si ninguno lo cruza, advecta por el campo.
    const candidatos = indiceRutas ? indiceRutas[hexId] : null;
    const { path, tiempos } = (candidatos && candidatos.length > 0)
      ? calcularStreamlineRuta(candidatos[Math.floor(Math.random() * candidatos.length)], vectores, g, magRef)
      : calcularStreamline(muestrearEnHex(hex), vectores, g, magRef);
    if (path.length < 2) continue;
    const color = interpolarColorStops(peso, colorStops);
    // Divisor por modo: los pesos de bus son mucho menores que los de Metro
    // y con un divisor común quedaban clavados en el ancho mínimo.
    const width = 0.4 + Math.sqrt(peso) / (tipo === 'metro' ? 3 : 1.2);
    // Respawn continuo: la estela reaparece cada duración + pausa aleatoria,
    // con fase inicial uniforme. Las apariciones cuya ventana cruza el final
    // del ciclo se duplican desfasadas en -LOOP, para que al dar la vuelta el
    // reloj la estela continúe donde iba en vez de cortarse.
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


// --- Mini markdown para el popup "Acerca de" ---------------------------------
// El contenido vive en public/acerca-de.md (editable sin recompilar, tambien
// en el sitio ya publicado). Subconjunto soportado: titulo (# ), parrafos,
// listas (- ), **negrita** y [enlaces](url). Se construyen elementos de React,
// sin HTML inyectado.
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
    if (bloque.startsWith('# ')) return null; // el titulo lo muestra el encabezado
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
  // Layout compacto en pantallas angostas: el mapa manda, la caja de tiempo
  // baja como barra inferior y capas/estilo/acerca se pliegan dentro de Config.
  const [esMovil, setEsMovil] = useState(
    window.matchMedia(CONSULTA_MOVIL).matches);
  useEffect(() => {
    const mq = window.matchMedia(CONSULTA_MOVIL);
    const alCambiar = (e) => setEsMovil(e.matches);
    mq.addEventListener('change', alCambiar);
    return () => mq.removeEventListener('change', alCambiar);
  }, []);

  // Popup de información del sistema y créditos (?creditos=1 lo abre de entrada).
  // El texto se carga de public/acerca-de.md la primera vez que se abre.
  const [mostrarInfo, setMostrarInfo] = useState(paramBool('creditos', false));
  const [textoAcerca, setTextoAcerca] = useState(null);
  useEffect(() => {
    if (!mostrarInfo || textoAcerca !== null) return;
    fetch(`${process.env.PUBLIC_URL}/acerca-de.md`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
      .then(setTextoAcerca)
      .catch(() => setTextoAcerca('# Acerca de\n\nNo se pudo cargar acerca-de.md.'));
  }, [mostrarInfo, textoAcerca]);





  //Valores que dependen de la configuracion inicial de vista (la URL puede
  //fijar una cámara exacta para capturas y enlaces).
  const vistaBase = valoresVisualizacion.GranSantiago.Vista;
  const vistaMapa = {
    ...vistaBase,
    latitude: paramNum('lat', vistaBase.latitude),
    longitude: paramNum('lon', vistaBase.longitude),
    // En móvil se aleja un nivel para que la ciudad entre completa en la pantalla angosta.
    zoom: paramNum('zoom', vistaBase.zoom - (esMovil ? 1 : 0)),
  };
  const [viewState, setViewState] = useState(vistaMapa);
  const [zoomLevel, setZoomLevel] = useState(1); // 1=lejano, 2=medio, 3=cercano
  const [datosVersion, setDatosVersion] = useState(0);
  const [cantidadParticulas, setCantidadParticulas] = useState(
    esMovil
      ? Math.min(CANTIDAD_PARTICULAS_MOVIL, particulasPrecalculadas.cantidadParticulas)
      : particulasPrecalculadas.cantidadParticulas);
  // Intervalo de la animación de partículas (ms). Mayor = menos trabajo por segundo = menos CPU.
  const [intervaloActualizacion, setIntervaloActualizacion] = useState(valoresVisualizacion.GranSantiago.tiempoActualizacion);
  // Pestaña visible: se usa para detener la animación cuando el usuario cambia de pestaña.
  const [pestanaVisible, setPestanaVisible] = useState(true);
  const [horaSeleccionada, setHoraSeleccionada] = useState(8);
  const [datosError, setDatosError] = useState(null);
  const [cargandoDatos, setCargandoDatos] = useState(false);

  const horaSeleccionadaRef = useRef(horaSeleccionada);
  const [horaVisual, setHoraVisual] = useState(8); // Para mostrar en UI

  // Modo de transporte visible (total, buses o metro)
  const [modo, setModo] = useState(PARAMS_URL.get('modo') || 'total');

  const actualizarHora = useCallback((nuevaHora) => {
    horaSeleccionadaRef.current = nuevaHora;
    setHoraSeleccionada(nuevaHora);
  }, []);

 

  // UseEffect para cerrar el panel al hacer clic fuera
  useEffect(() => {
    const manejarClicExterno = (evento) => {
      const esClicEnBotonConfiguracion = evento.target.closest('.boton-configuracion');
      const esClicEnPanelConfiguracion = evento.target.closest('.panel-configuraciones');
      
      // Cerrar panel de configuraciones solo si el clic fue fuera de él
      if (mostrarPanelConfiguraciones && !esClicEnBotonConfiguracion && !esClicEnPanelConfiguracion) {
        setMostrarPanelConfiguraciones(false);
      }
    };

    document.addEventListener('pointerdown', manejarClicExterno);
    return () => document.removeEventListener('pointerdown', manejarClicExterno);
  }, [mostrarPanelConfiguraciones]);

  // Detecta si la pestaña está visible para pausar la animación cuando no se está mirando.
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
  // Toggle propio del flujo: anima (mueve) las partículas. Independiente del avance de horas.
  const [animarParticulas, setAnimarParticulas] = useState(paramBool('animar', true));
  // El heatmap es la capa más pesada en GPU de gama baja: apagado por omisión en
  // móvil (el toggle o ?heatmap=1 lo reactivan).
  const [mostrarHeatmap, setMostrarHeatmap] = useState(paramBool('heatmap', !esMovil));
  const [nivelHeatmap, setNivelHeatmap] = useState(paramNum('nivelheatmap', NIVEL_HEATMAP_INICIAL));
  const [mostrarHexagonos, setMostrarHexagonos] = useState(paramBool('hexagonos', false));
  // Trazado de metro y etiquetas de nombres son toggles independientes.
  const [mostrarTrazadoMetro, setMostrarTrazadoMetro] = useState(paramBool('trazado', true));
  const [mostrarNombresMetro, setMostrarNombresMetro] = useState(paramBool('nombres', true));
  // Estructura física de la red de buses (capa de contexto).
  const [mostrarRedBuses, setMostrarRedBuses] = useState(paramBool('redbuses', false));
  // Visibilidad de las capas extra (ver capasExtra.js), según su porDefecto.
  const [capasExtraVisibles, setCapasExtraVisibles] = useState(
    () => Object.fromEntries(CAPAS_EXTRA.map((c) => [c.id, c.porDefecto])));

  // Comparación de dos franjas horarias (split map). La vista se parte en dos
  // MapView con cámara enlazada: izquierda la hora principal, derecha horaComparacion.
  // El basemap se omite en este modo; la referencia espacial es la red de buses y
  // el trazado de Metro. Las capas dependientes de la hora se duplican con sufijo
  // '-der' y se enrutan por vista (ver filtrarCapaPorVista y las vistas del render).
  const [comparar, setComparar] = useState(paramBool('comparar', false));
  const [horaComparacion, setHoraComparacion] = useState(clampHora(paramNum('horab', 18)));
  // Valor pendiente del slider derecho: se aplica (carga datosB) al soltar.
  const [horaComparacionVisual, setHoraComparacionVisual] = useState(clampHora(paramNum('horab', 18)));
  const [datosB, setDatosB] = useState(null);
  // Carga los datos de la hora B mientras la comparación está activa.
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
  // En móvil no se compara: si se llega en modo comparación (URL o resize desde
  // escritorio), se vuelve a vista única.
  useEffect(() => {
    if (esMovil && comparar) setComparar(false);
  }, [esMovil, comparar]);

  //
  // Datos para modos: bus, metro o combinado. 
  //
  // Se inicializan vacías; la hora inicial se carga de forma diferida al montar
  // (aplicarInicial), como cualquier cambio de hora. Así ninguna matriz por hora
  // se empaqueta en el bundle.
  const cargaTotalBusesRef = useRef(0);
  const cargaTotalMetroRef = useRef(0);
  const cargaTotalRef = useRef(0);
  const matrizVectoresBusesRef = useRef([]);
  const matrizPesosBusesRef = useRef([]);
  const matrizVectoresMetroRef = useRef([]);
  const matrizPesosMetroRef = useRef([]);
  
  // Estado para controlar visualización de vectores
  const [mostrarVectoresBuses, setMostrarVectoresBuses] = useState(false);
  const [mostrarVectoresMetro, setMostrarVectoresMetro] = useState(false);
  // Factor de escala del largo de los vectores. Las magnitudes son ~0.001, así que
  // sin amplificar las flechas quedan sub-pixel. El usuario lo ajusta con un slider.
  const [escalaVectores, setEscalaVectores] = useState(paramNum('vectescala', 4));

  // La generación de partículas por frame se reemplazó por streamlines precalculadas
  // + TripsLayer (ver helpers de módulo arriba y la capa de flujo más abajo).


  // Función para aplicar parámetros
  const aplicarParametros = async (horaAAplicar = horaVisual) => {
    setCargandoDatos(true);
    try {
      setDatosError(null);

      const formattedHour = horaAAplicar.toString().padStart(2, '0') + ':00';

      // Cargar nuevos datos (solo con hora)
      const resultado = await cargarDatos(formattedHour);

      if (resultado.status === 'error') {
        setDatosError(resultado.message);
        setHoraVisual(horaSeleccionada); // la etiqueta vuelve a la hora ya cargada
        return;
      }

      // Actualizar referencias
      matrizVectoresBusesRef.current = resultado.MatrizVectoresBuses;
      matrizPesosBusesRef.current = resultado.MatrizPesosBuses.MatrizPesos;
      matrizVectoresMetroRef.current = resultado.MatrizVectoresMetro;
      matrizPesosMetroRef.current = resultado.MatrizPesosMetro.MatrizPesos;

      // Actualizar cargas totales
      cargaTotalBusesRef.current = resultado.MatrizPesosBuses.CargaTotal;
      cargaTotalMetroRef.current = resultado.MatrizPesosMetro.CargaTotal;
      cargaTotalRef.current = resultado.MatrizPesosBuses.CargaTotal + resultado.MatrizPesosMetro.CargaTotal;

      // Actualizar hora y forzar el recálculo de las capas por hora
      actualizarHora(horaAAplicar);
      setDatosVersion(v => v + 1);

    } catch (error) {
      console.error("Error al aplicar parámetros:", error);
      setDatosError("Error inesperado al cargar los datos");
      setHoraVisual(horaSeleccionada);
    } finally {
      setCargandoDatos(false);
    }
  };

  // Comparación de dos horas (split map): tarea directa, se activa desde la barra
  // de tiempo. Al entrar, ambos sliders arrancan en las horas ya cargadas.
  const entrarComparacion = () => {
    setHoraVisual(horaSeleccionada);
    setHoraComparacionVisual(horaComparacion);
    setComparar(true);
  };
  const salirComparacion = () => {
    setComparar(false);
    setHoraVisual(horaSeleccionada);
  };

  // Hora inicial: la URL tiene precedencia sobre lo guardado en localStorage.
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
        // Los datos de vectores se memoizan por datosVersion; hay que avisar el cambio
        // de refs para que se recalculen con la hora efectivamente cargada.
        setDatosVersion(v => v + 1);
      } else {
        setDatosError(resultado.message);
      }
      setCargandoDatos(false);
    };

    aplicarInicial();
  }, []);



 // Paleta para buses: viridis (perceptualmente uniforme), azul-teal -> verde -> amarillo
  // Cortes calibrados a pesos por día laboral promedio (máximo ~1030 por
  // hexágono en hora punta): así los buses recorren la paleta completa.
  const colorStopsBuses = [
    { limite: 10, color: [59, 82, 139], opacity: 0.7 },    // Azul-púrpura
    { limite: 150, color: [33, 144, 141], opacity: 0.8 },  // Teal
    { limite: 450, color: [92, 200, 99], opacity: 0.9 },   // Verde
    { limite: 1000, color: [253, 231, 37], opacity: 1.0 }  // Amarillo
  ];

  // Paleta para metro: magma (perceptualmente uniforme), púrpura -> magenta -> naranja
  const colorStopsMetro = [
    { limite: 10, color: [81, 18, 124], opacity: 0.7 },     // Púrpura
    { limite: 1000, color: [183, 55, 121], opacity: 0.8 },  // Magenta
    { limite: 10000, color: [240, 96, 93], opacity: 0.9 },  // Rojo-naranja
    { limite: 30000, color: [254, 176, 120], opacity: 1.0 } // Naranja claro
  ];


  // Velocidades por nivel de zoom (más lento al acercarse)
  const velocidadesPorNivel = {
    1: 0.001,   // Velocidad original
    2: 0.0005,  // 
    3: 0.0002   // 
  };
  
  // Reloj de animación de las streamlines. Un requestAnimationFrame avanza este valor;
  // TripsLayer lo usa como currentTime (un uniform en la GPU). Así la animación NO pasa
  // por el estado de React frame a frame reconstruyendo geometría.
  const [tiempoAnim, setTiempoAnim] = useState(STREAMLINE_MAX_PASOS);
  const tiempoAnimRef = useRef(STREAMLINE_MAX_PASOS);

  // Grilla H3 para el mapeo posición -> celda (referencia estable): resolución,
  // el mapa índice H3 -> id local y los centros/vecinos por celda.
  const paramsGrilla = useMemo(
    () => ({
      resolucion: hexGridData.resolucion,
      h3ToId,
      hexagonos: hexagonosData,
    }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Streamlets sobre recorridos reales de bus (experimental). El índice
  // hexágono -> recorridos se construye una sola vez.
  const [streamletsPorRuta, setStreamletsPorRuta] = useState(paramBool('rutas', false));
  const indiceRutas = useMemo(() => construirIndiceRutas(paramsGrilla), [paramsGrilla]);

  // Trayectorias del flujo, precalculadas una vez por hora/modo/cantidad. Referencia
  // estable entre frames: TripsLayer no recomputa geometría al animar.
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

  // Trayectorias de la hora B (split map). Mismo cálculo que la hora A, pero desde
  // datosB y la hora de comparación. Comparten el reloj de animación (tiempoAnim).
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

  // Bucle de animación: avanza el reloj mientras las partículas están visibles, el toggle
  // de animación está activo y la pestaña visible. La velocidad depende del intervalo base y
  // se atenúa al acercar el zoom. Al pausar, el reloj queda quieto y las estelas se congelan.
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

  // Capa de flujo: streamlets animados en la GPU (TripsLayer). currentTime cicla en
  // [0, STREAMLINE_LOOP); trailLength fija el largo visible de cada estela.
  // Props compartidas entre la capa de flujo de la hora A y la de la hora B
  // (split map): así ambas estelas usan el mismo reloj y el mismo estilo.
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

  
  // Datos de las capas de vectores, memoizados: solo se reconstruyen cuando cambian
  // los datos de la hora (datosVersion) o la escala, NO en cada frame de partículas.
  // Así deck.gl recibe una referencia de `data` estable y no re-sube la geometría a
  // la GPU en cada render.
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
  // Vectores de la hora B (split map).
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

  // Props compartidas de las capas de vectores (hora A y hora B).
  const propsVectores = {
    getPath: d => d.path,
    getColor: d => d.color, // Color según los datos
    getWidth: 2,
    widthUnits: 'pixels',
    widthMinPixels: 1.5,
  };
  // Función que dibuja los vectores promedio de los buses, para cada celda
  const vectorLayerBuses  = mostrarVectoresBuses && new PathLayer({
    id: 'vector-layer-buses', data: datosVectoresBuses, ...propsVectores
  });
  const vectorLayerBusesB = comparar && mostrarVectoresBuses && new PathLayer({
    id: 'vector-layer-buses-der', data: datosVectoresBusesB, ...propsVectores
  });



  // Función que dibuja los vectores promedio del metro, para cada celda
  const vectorLayerMetro  = mostrarVectoresMetro && new PathLayer({
    id: 'vector-layer-metro', data: datosVectoresMetro, ...propsVectores
  });
  const vectorLayerMetroB = comparar && mostrarVectoresMetro && new PathLayer({
    id: 'vector-layer-metro-der', data: datosVectoresMetroB, ...propsVectores
  });


  // Capa de diagnóstico de la grilla (apagada por defecto). Los vértices se
  // calculan con cellToBoundary solo cuando se activa, así no se guardan.
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
    getFillColor: [0, 0, 0, 0], // Relleno transparente
    getLineColor: [100, 150, 255, 150], // Color de línea azul
    getLineWidth: 1,
    lineWidthMinPixels: 1,
    pickable: false,
  });


  // Trazado esquemático de las líneas de metro, con su color oficial. Es la
  // estructura de la red, independiente de las etiquetas de nombres y del flujo.
  // LINEAS_METRO es constante: el arreglo se arma una vez y la capa recibe una
  // referencia estable en vez de reconstruirlo en cada frame de animación.
  const datosTrazadoMetro = useMemo(
    () => LINEAS_METRO.flatMap(l => l.polilineas.map(path => ({ path, color: l.color }))),
    []
  );
  const trazadoMetroLayer = mostrarTrazadoMetro && new PathLayer({
    id: 'trazado-metro',
    data: datosTrazadoMetro,
    getPath: d => d.path,
    getColor: d => d.color,
    // Ancho en metros con topes en píxeles: el trazado escala con el zoom
    // (como los streamlets) en vez de quedar fijo y verse delgado al acercar.
    getWidth: 45,
    widthUnits: 'meters',
    widthMinPixels: 2,
    widthMaxPixels: 12,
    capRounded: true,
    jointRounded: true,
    parameters: { depthTest: false },
  });

  // Marcadores de estación sobre el trazado: círculo blanco con contorno oscuro,
  // como en los mapas de transporte. Van con el mismo toggle del trazado de metro.
  const estacionesMetroLayer = mostrarTrazadoMetro && new ScatterplotLayer({
    id: 'estaciones-metro',
    data: ESTACIONES_METRO,
    getPosition: d => [d.longitud, d.latitud],
    // Radio en metros, igual que el ancho del trazado, para que los círculos
    // de estación acompañen a la línea al acercar el zoom.
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

  // Estructura física de la red de buses (Red): capa de contexto tenue. Muestra
  // por dónde pasan las líneas, con o sin demanda, a diferencia del campo vectorial.
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

  // Reducimos transparencia cuando las partículas están visibles
  const [opacidadHeatmap, setOpacidadHeatmap] = useState(1);
  useEffect(() => {
    setOpacidadHeatmap(mostrarParticulas ? 0.5 : 1);
  }, [mostrarParticulas]);


  // Define que matriz de pesos usar para el HeatMap
  function obtenerMatrizPesos() {
      switch (modo) {
      case 'buses': 
        return matrizPesosBusesRef.current;
      case 'metro': 
        return matrizPesosMetroRef.current;
      case 'total': 
        // Sumar los pesos de buses y metro
        const total = [];
        for (let i = 0; i < matrizPesosBusesRef.current.length; i++) {
          total[i] = matrizPesosBusesRef.current[i] + matrizPesosMetroRef.current[i];
        }
        return total;
      default: 
        return [];
    }
  }

  // Función para convertir la matriz en datos para el HeatMap
  function generarDatosHeatmap() {
    const matrizPesos = obtenerMatrizPesos();
    const datos = [];
    
    // Todos los modos usan hexágonos ahora
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

  // Paleta para heatmap: plasma (perceptualmente uniforme), azul -> magenta -> naranja -> amarillo.
  // El alfa crece con la densidad para que las zonas bajas queden tenues.
  const heatmapColors = [
    [13, 8, 135, 70],      // Azul profundo
    [126, 3, 168, 120],    // Púrpura
    [203, 70, 121, 160],   // Magenta
    [248, 149, 64, 190],   // Naranja
    [253, 195, 40, 225],   // Ámbar
    [240, 249, 33, 255]    // Amarillo
  ];

  const datosHeatmap = useMemo(() => generarDatosHeatmap(), [modo, mostrarHeatmap, datosVersion]);

  // Datos del heatmap de la hora B (split map): misma agregación por modo, desde datosB.
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

  // El heatmap se fija al nivel elegido (nivelHeatmap), no a la cámara: el radio en píxeles se
  // ajusta por 2^(zoomCámara - nivel) para que la huella geográfica sea siempre la del nivel.
  // Se acota el radio renderizado para no degradar el rendimiento en combinaciones extremas.
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






  // Etiquetas con el nombre de cada estación de metro. Solo al acercar, para no saturar,
  // y solo si el toggle de nombres está activo (independiente del trazado).
  const etiquetasMetroLayer = mostrarNombresMetro && viewState.zoom >= ZOOM_MIN_ETIQUETAS_METRO && new TextLayer({
    id: 'etiquetas-metro',
    data: ESTACIONES_METRO,
    getPosition: d => [d.longitud, d.latitud],
    getText: d => d.nombre,
    getSize: 12,
    sizeUnits: 'pixels',
    // El TextLayer no hereda el CSS: la fuente se declara aqui para que las
    // etiquetas usen la misma tipografia que el resto de la interfaz.
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

  // Orden de dibujo (abajo -> arriba): estructura de red como base, luego flujo,
  // vectores y etiquetas encima.
  // Capas extra (capasExtra.js): se construyen con el contexto actual y se
  // agregan al final del stack. Un error en una no rompe el resto.
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
        console.error(`Capa extra "${c.id}" falló:`, e);
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

  // Split map: dos MapView lado a lado con cámara enlazada (comparten el mismo
  // viewState porque no está indexado por id de vista). El filtro enruta cada
  // capa a su lado; las de contexto van en ambos.
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


  // Leyenda de las tres paletas (heatmap, buses, metro). Contenido estático: se
  // arma una sola vez para que no se reconstruya en cada frame de la animación.
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
          {/* Leyenda del Heatmap */}
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
          
          {/* Leyenda de Buses */}
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
        
        {/* Leyenda de Metro */}
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
      // Fondo de respaldo mientras cargan los tiles del basemap del split.
      background: comparar ? (estiloMapa === EstiloMapaClaro ? '#f2f2f4' : '#0b0e14') : undefined,
    }}>
      {/* Split map: dos basemaps de media pantalla bajo el canvas de deck. Cada
          uno se controla con el mismo viewState (cámara enlazada) y no captura
          eventos (interactive=false); el controller de deck maneja la cámara. */}
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
        // viewState siempre controlado: evita el salto controlado -> no controlado
        // al salir de comparación, que dejaba la cámara sin responder a eventos.
        viewState={viewState}
        {...(comparar ? { views: vistasComparacion, layerFilter: filtrarCapaPorVista } : {})}
        controller={true}
        layers={layers}
        // En móvil se rasteriza a 1 píxel por píxel CSS (sin supersampling
        // retina): el mayor ahorro de fragment shader en pantallas de gama baja.
        useDevicePixels={esMovil ? 1 : true}
        style={{ width: '100%', height: '100%', ...(comparar ? { position: 'absolute', top: 0, left: 0, zIndex: 1 } : {}) }}
        onViewStateChange={({viewState}) => {
          // Forzar límites de zoom
          if (viewState.zoom < 10) viewState.zoom = 10;
          if (viewState.zoom > 16) viewState.zoom = 16;
          
          // Determinar nivel de zoom
          let newZoomLevel;
          if (viewState.zoom < 11) newZoomLevel = 1;
          else if (viewState.zoom >= 11 && viewState.zoom < 12) newZoomLevel = 2;
          else newZoomLevel = 3;

          // Obtener límites para el nivel de zoom actual
          const limites = limitesPorZoomLevel[newZoomLevel];
          
          // Forzar límites geográficos
          if (viewState.longitude < limites.minLon) viewState.longitude = limites.minLon;
          if (viewState.longitude > limites.maxLon) viewState.longitude = limites.maxLon;
          if (viewState.latitude < limites.minLat) viewState.latitude = limites.minLat;
          if (viewState.latitude > limites.maxLat) viewState.latitude = limites.maxLat;

          setViewState(viewState);
          
          // Actualizar solo si cambió
          if (zoomLevel !== newZoomLevel) {
            setZoomLevel(newZoomLevel);
          }
        }}
      >
        {/* Vista única: el basemap va como hijo de deck (deck maneja la cámara).
            En comparación se usan dos basemaps hermanos, arriba en el return. */}
        {!comparar && <Map
          mapStyle={estiloMapa}
          attributionControl={false}
        >
          {/* Atribución de OSM/Carto en modo compacto: requisito de licencia
              de los basemaps, relevante al publicar la demo. */}
          <AttributionControl compact position="bottom-right" />
          {/* Escala del mapa, corrida hacia el centro para no quedar bajo la paleta. */}
          <ScaleControl
            position="bottom-right"
            maxWidth={90}
            unit="metric"
          />
        </Map>}
      </DeckGL>

      {/* Split map: divisor central y etiqueta de hora sobre cada mitad. */}
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


      {/* Chrome flotante: todas las cajas comparten CAJA_UI / BOTON_UI. */}

      {/* Nombre de la app y proyecto (arriba a la izquierda) */}
      {MOSTRAR_UI && <div style={{
        ...CAJA_UI,
        position: 'absolute', top: esMovil ? 12 : 16, left: esMovil ? 12 : 16, zIndex: 11,
        padding: esMovil ? '6px 10px' : '8px 12px', color: 'white'
      }}>
        <div style={{ fontSize: esMovil ? '12px' : '14px', fontWeight: '700', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
          {'\u{1F426}'} Mapocho - Flujos en SCL
        </div>
        {!esMovil && <div style={{ fontSize: '10px', color: '#9aa1ad', letterSpacing: '0.05em', marginTop: '2px' }}>
          Proyecto LOICA · ANID Fondecyt Regular 1261835
        </div>}
      </div>}

      {/* Selector de modo. En móvil se oculta para dejar ver el mapa: queda en
          el modo por omisión (total). */}
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

      {/* Caja de tiempo: arriba al centro en escritorio, barra inferior de
          ancho completo en móvil. En comparación se parte en dos sliders
          (izquierda/derecha), cada uno carga su hora al soltar el pulgar. */}
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
            {/* Comparar solo en escritorio: el split map es poco usable en móvil. */}
            {!esMovil && <button
              onClick={entrarComparacion}
              style={{ ...BOTON_PLANO, background: CAJA_UI.background, fontWeight: '600' }}
            >
              Comparar
            </button>}
          </>
        )}
      </div>}

      {/* Aviso de carga o de error al cambiar de hora. Aparece solo mientras se
          cargan datos o si la carga falla; en reposo no se muestra. */}
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

      {/* Config (arriba a la derecha) */}
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

      {/* Capas visibles (siempre a la vista, bajo el selector de modo). Solo
          escritorio: en móvil se omiten para dejar ver el mapa. */}
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

      {/* Panel de configuraciones (ajustes de animación y escalas) */}
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
              {/* En móvil se omite el menú de capas: el mapa queda con los valores
                  por omisión (flujo animado, trazado de Metro). Solo estilo y acerca. */}
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

          {/* Capas de bajo nivel (diagnóstico del campo) */}
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

      {/* Contador de viajes (sobre la paleta de colores; solo escritorio) */}
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

      {/* Estilo de mapa y créditos (abajo a la izquierda; solo escritorio) */}
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

      {/* Popup de información del sistema y créditos */}
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