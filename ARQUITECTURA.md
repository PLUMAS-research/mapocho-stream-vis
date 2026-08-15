# Propuesta de arquitectura para capas adicionales y usabilidad

Estado: propuesta para discusión, julio 2026. La propuesta completa (registro de capas, manifiesto de datos y descomposición de la interfaz) no está implementada. Sí existe una versión mínima del punto (1): el módulo `src/capasExtra.js` es un punto de extensión donde se agrega una capa deck.gl nueva, con su toggle en el panel "Capas", sin tocar `App.js`. Cada entrada recibe el contexto de la vista (hora, modo, cámara, la grilla H3 y el campo de la hora/modo actuales) y las clases de capa de deck.gl. Sirve para cruzar el flujo con otros datos o dibujar glifos. Lo descrito abajo es el diseño más completo, aún pendiente.

## Resumen

La aplicación hoy concentra toda la interfaz, las capas y la carga de datos en `App.js`. Agregar una capa nueva (por ejemplo, indicadores por unidad vecinal) exige tocar ese archivo en cuatro lugares distintos y recompilar el bundle con los datos adentro. La propuesta consiste en tres cambios: (1) un registro de capas donde cada capa es un módulo autocontenido, (2) datos servidos como archivos estáticos fuera del bundle, descritos por un manifiesto, y (3) una descomposición de la interfaz en componentes. Con eso, una capa nueva se agrega escribiendo un módulo y un archivo de datos, sin tocar el resto de la aplicación.

## Diagnóstico

`App.js` (~1400 líneas) mezcla cinco responsabilidades:

- **Construcción de capas deck.gl.** Nueve capas construidas inline (streamlets, vectores por modo, hexágonos, trazado de Metro, estaciones, red de buses, heatmap, etiquetas). Cada una tiene su `useState` de visibilidad, su bloque de construcción y su entrada manual en el panel de configuración.
- **Carga de datos.** Import estático de la hora 8 más `import()` dinámico por hora, con el sufijo de diámetro `02` incrustado en el template literal. Webpack empaqueta los 24 × 4 JSON de matrices en el bundle: cambiar datos obliga a recompilar, y el bundle crece con cada dataset.
- **Animación.** Reloj de streamlets (requestAnimationFrame), advección de semillas, visibilidad de pestaña.
- **Interfaz.** Barra superior, panel de configuración, leyendas, selector de estilo, contador de viajes, todo con estilos inline.
- **Estado global.** Mezcla de `useState`, `useRef` y un contador `datosVersion` para forzar recomputaciones.

Consecuencias concretas: la leyenda no sabe qué capas están activas (muestra siempre las tres fijas), el panel de configuración es una lista plana de checkboxes, y no hay forma de agregar datos por área (coropletas) sin duplicar el patrón completo.

## Principios

- **Cambios incrementales.** Cada etapa deja la aplicación funcionando; no hay reescritura total.
- **Mínimas dependencias nuevas.** React y deck.gl bastan. No se agrega Redux ni ninguna librería de estado; el estado global cabe en un contexto con reducer.
- **El pipeline Python no cambia.** Los generadores actuales siguen produciendo los mismos JSON; solo cambia dónde se colocan y cómo los lee el frontend.

## Arquitectura propuesta

### Módulos

```
src/
├── App.js                  # composición: mapa + capas del registro + paneles
├── capas/
│   ├── registro.js         # lista de descriptores de capa
│   ├── flujo.js            # streamlets (TripsLayer) + su reloj
│   ├── vectores.js         # glifos de vector por modo
│   ├── heatmap.js
│   ├── redMetro.js         # trazado + estaciones + etiquetas
│   ├── redBuses.js
│   ├── grilla.js           # contorno de hexágonos
│   └── areas.js            # coropletas por polígono (unidades vecinales, comunas)
├── datos/
│   ├── manifiesto.js       # lee y valida public/datos/manifiesto.json
│   ├── matrices.js         # fetch de matrices por hora/modo, con caché
│   └── geometrias.js       # fetch de grilla, trazados, GeoJSON de áreas
├── ui/
│   ├── BarraSuperior.js    # modo, slider de hora, autoplay
│   ├── PanelCapas.js       # generado desde el registro, con grupos
│   ├── Leyenda.js          # generada desde las capas activas
│   └── Tooltip.js          # contenido de picking por capa
└── estado/
    └── contexto.js         # hora, modo, visibilidad por capa, configuración
```

### Registro de capas

Cada capa es un descriptor con un contrato uniforme. `App.js` deja de conocer capas individuales: recorre el registro, construye las capas visibles y arma el panel y la leyenda a partir de los mismos descriptores.

```js
// capas/registro.js
export const CAPAS = [flujo, heatmap, vectoresBuses, vectoresMetro,
                      redMetro, redBuses, grilla, unidadesVecinales];

// contrato de un descriptor
{
  id: 'unidades-vecinales',
  etiqueta: 'Unidades vecinales',
  grupo: 'contexto',            // flujo | contexto | analisis
  visiblePorDefecto: false,
  datos: { tipo: 'geojson', url: 'datos/areas/unidades_vecinales.json' },
  construir(datos, estado, config) { return new GeoJsonLayer({...}); },
  leyenda(config) { return {titulo, stops}; },      // opcional
  tooltip(objeto) { return {titulo, filas}; },      // opcional, activa picking
  controles: [{tipo: 'select', id: 'indicador', opciones: [...]}]  // opcional
}
```

El panel de capas se genera agrupando descriptores por `grupo`, la leyenda consulta `leyenda()` de las capas visibles, y el tooltip global despacha al `tooltip()` de la capa que capturó el hover. Agregar una capa es agregar un archivo a `capas/` y una línea al registro.

### Datos fuera del bundle

Los JSON generados se mueven de `src/json/` a `public/datos/` y se cargan con `fetch`. Un manifiesto describe qué hay disponible:

```json
{
  "grilla": {"diametroKm": 0.2, "archivo": "grilla/Hexagon02.json"},
  "matrices": {"horas": 24, "modos": ["buses", "metro"],
               "patron": "matrices/{modo}/{hora}/Matriz{tipo}{Modo}_02_{hora}.json"},
  "areas": [
    {"id": "unidades-vecinales", "archivo": "areas/unidades_vecinales.json",
     "indicadores": ["poblacion", "viajes_generados", "viajes_atraidos"]}
  ]
}
```

Ventajas directas: regenerar datos no recompila la aplicación, el bundle deja de contener 96 matrices, el sufijo de diámetro queda en un solo lugar (el manifiesto), y un dataset nuevo es un archivo más una entrada en el manifiesto. `preparar_datos/generar_todo.sh` escribe en `public/datos/` y actualiza el manifiesto al final.

Nota de seguridad: los datos se sirven del mismo origen que la aplicación y el manifiesto se valida contra un esquema al cargar. Si en el futuro se cargan datos de origen externo, hay que validar estructura y tipos antes de pasarlos a las capas, y no interpolar contenido de los datos en HTML (los tooltips se construyen con React, no con `innerHTML`).

### Tipos de capa que el contrato debe soportar

1. **Campo por hora** (las actuales): matrices de vectores y pesos indexadas por hexágono, dependientes de `(modo, hora)`.
2. **Contexto estático**: geometrías fijas (trazado de Metro, red de buses, grilla).
3. **Áreas con indicadores** (lo nuevo): polígonos con propiedades numéricas, renderizados como coropleta con picking. Pueden ser estáticos (población) o por hora (viajes generados por unidad vecinal y hora).
4. **Puntos**: estaciones, paraderos, puntos de interés.

## Caso concreto: capa de unidades vecinales

- **Fuente**: polígonos de unidades vecinales (IDE Chile o los shapefiles municipales). Se agrega un script `preparar_datos/areas_a_geojson.py` que recorta al bounding box de la grilla, simplifica la geometría (tolerancia ~10 m) y escribe GeoJSON con las propiedades elegidas.
- **Indicadores derivados del propio pipeline**: con los segmentos ya calculados se puede agregar demanda por área y hora (viajes que se originan o terminan en cada unidad vecinal), lo que conecta la capa nueva con los datos existentes sin fuentes adicionales.
- **Render**: `GeoJsonLayer` con relleno por indicador (escala de color secuencial), contorno tenue, `pickable: true`. Un control en el descriptor elige el indicador activo.
- **Interacción**: hover muestra nombre y valores; click podría fijar el área y atenuar el resto (etapa posterior).

## Usabilidad

Cambios independientes del registro de capas, ordenados por razón costo/beneficio:

1. **Aplicar hora al mover el slider** (con debounce de ~300 ms) y eliminar el botón "APLICAR HORA". La carga por hora ya es asíncrona y con caché es casi instantánea.
2. **Tooltips por picking** en hexágonos y estaciones: carga, dirección y magnitud del vector, nombre de estación. Hoy no hay ninguna interrogación puntual, aunque la tarea T4 del paper la requiere.
3. **Estado en la URL** (hora, modo, capas visibles, vista): permite compartir un fenómeno específico con un enlace, útil para los casos de estudio del paper. La mitad de lectura ya está implementada (`PARAMS_URL` en `App.js`, julio 2026): la URL inicial fija cámara, hora, modo, capas y modo captura (`ui=0`); falta la escritura (actualizar la URL al navegar).
4. **Panel de capas agrupado** (flujo / contexto / análisis) en reemplazo de la lista plana de checkboxes, generado desde el registro.
5. **Leyenda dinámica**: solo las capas visibles, con unidades explícitas (pasajeros equivalentes por hexágono).
6. **Precarga de la hora siguiente** durante el autoplay para eliminar el salto visual.
7. **Indicador de carga** mientras se traen matrices (hoy el cambio de hora falla en silencio si el JSON no existe).
8. Menores: reemplazar los emoji de la interfaz por iconos SVG, atajos de teclado (flechas para la hora, espacio para autoplay), textos de ayuda en los controles del panel.

## Plan incremental

Cada etapa se puede probar y detener sin dejar la aplicación rota:

1. **Extraer sin cambiar comportamiento**: mover las capas actuales a `capas/` con el contrato de descriptor y generar panel y leyenda desde el registro. `App.js` baja a ~300 líneas.
2. **Datos por fetch**: mover los JSON a `public/datos/`, agregar manifiesto y caché de matrices. Ajustar `generar_todo.sh`.
3. **Usabilidad base**: slider sin botón, tooltips, leyenda dinámica.
4. **Primera capa nueva**: unidades vecinales con un indicador estático (población), para validar el contrato de áreas.
5. **Indicadores por hora** sobre áreas y estado en la URL.

## Qué no cambia

- El pipeline Python y sus salidas (mismas matrices, misma grilla, mismas convenciones de nombre).
- deck.gl + MapLibre + Carto sin token como plataforma de render.
- La convención de indexación de hexágonos (`id = fila * numColumnas + columna`).
- Create React App como toolchain de build, al menos mientras no sea un estorbo (si se vuelve uno, la migración natural es Vite y es ortogonal a esta propuesta).
