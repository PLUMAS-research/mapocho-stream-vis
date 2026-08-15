// Punto de extensión para capas adicionales.
//
// Cada entrada de CAPAS_EXTRA agrega una capa deck.gl al mapa, con su propio
// toggle en el panel de capas, SIN tocar App.js. Sirve para cruzar el flujo con
// otros datos (por ejemplo puntos de interés, zonas, resultados de un modelo) o
// para dibujar glifos sobre las celdas.
//
// Forma de cada entrada:
//   id:        string único (se usa también como id de la capa deck.gl)
//   etiqueta:  texto del toggle en el panel "Capas"
//   porDefecto: bool, si la capa arranca visible
//   crearCapa(ctx): devuelve UNA capa deck.gl (o null para no dibujar nada esta
//                   vez). Se llama en cada render de la capa; el contexto trae:
//     {
//       hora, modo, esMovil,       // estado actual de la vista
//       viewState,                 // cámara (latitude, longitude, zoom)
//       hexagonosData,             // celdas de la grilla: { id, h3, c:[lon,lat], vecinos }
//       h3ToId,                    // objeto índice H3 -> id local
//       matrices: {                // campo de la hora/modo actuales (por id de celda)
//         vectoresBuses, pesosBuses, vectoresMetro, pesosMetro,
//       },
//       deck,                      // clases de capa de deck.gl (no re-importar)
//     }
//   El objeto `deck` expone: PolygonLayer, PathLayer, ScatterplotLayer,
//   TextLayer, HeatmapLayer, TripsLayer.
//
// Ejemplo (descomentar y adaptar):
//
//   import misPuntos from './json/mis-puntos.json'; // [{ lon, lat, valor }, ...]
//   export const CAPAS_EXTRA = [
//     {
//       id: 'mis-puntos',
//       etiqueta: 'Mis puntos',
//       porDefecto: false,
//       crearCapa: ({ deck }) => new deck.ScatterplotLayer({
//         id: 'mis-puntos',
//         data: misPuntos,
//         getPosition: (d) => [d.lon, d.lat],
//         getRadius: 60,
//         radiusUnits: 'meters',
//         radiusMinPixels: 2,
//         getFillColor: [255, 140, 0, 200],
//         pickable: false,
//       }),
//     },
//   ];

export const CAPAS_EXTRA = [];
