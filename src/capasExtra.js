// Extension point for additional layers.
//
// Each entry of CAPAS_EXTRA adds a deck.gl layer to the map, with its own
// toggle in the layers panel, WITHOUT touching App.js. It serves to cross the
// flow with other data (for example points of interest, zones, model outputs)
// or to draw glyphs over the cells.
//
// Shape of each entry:
//   id:        unique string (also used as the deck.gl layer id)
//   etiqueta:  toggle text in the "Capas" panel
//   porDefecto: bool, whether the layer starts visible
//   crearCapa(ctx): returns ONE deck.gl layer (or null to draw nothing this
//                   time). Called on every layer render; the context brings:
//     {
//       hora, modo, esMovil,       // current view state
//       viewState,                 // camera (latitude, longitude, zoom)
//       hexagonosData,             // grid cells: { id, h3, c:[lon,lat], vecinos }
//       h3ToId,                    // H3 index -> local id object
//       matrices: {                // field of the current hour/mode (by cell id)
//         vectoresBuses, pesosBuses, vectoresMetro, pesosMetro,
//       },
//       deck,                      // deck.gl layer classes (do not re-import)
//     }
//   The `deck` object exposes: PolygonLayer, PathLayer, ScatterplotLayer,
//   TextLayer, HeatmapLayer, TripsLayer.
//
// Example (uncomment and adapt):
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
