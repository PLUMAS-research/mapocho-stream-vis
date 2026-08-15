# Mapocho: visualización de flujos de transporte público en Santiago

Visualización de la demanda de buses Red y Metro del Gran Santiago como campos
vectoriales por hora sobre una grilla hexagonal H3, animada como streamlets con
deck.gl sobre un mapa. La aplicación se llama Mapocho, por el río que cruza la
ciudad. Parte del proyecto LOICA (ANID Fondecyt Regular 1261835).

**Demo:** https://dcc.uchile.cl/~egraells/loica/scl-flow-vectors/

El repositorio contiene dos piezas encadenadas por archivos JSON en disco, no
por llamadas en vivo:

- **`src/` + `public/`**: la aplicación web (React + deck.gl + MapLibre) y los
  scripts de agregación por hora (Python).
- **`preparar_datos/`**: la conversión de los datos de entrada (viajes + feed
  GTFS) en todo lo que la aplicación consume.

El repositorio no versiona datos. Un clon recién bajado no trae los JSON que la
app importa al compilar: hay que generarlos una vez con
`bash preparar_datos/generar_todo.sh` antes de `npm start` (ver
`preparar_datos/README.md`, incluyendo la especificación de los datos de
entrada y el contrato genérico viajes + GTFS para otras ciudades).

## Ejecutar la aplicación

```sh
npm install        # instala dependencias (una sola vez)
npm start          # dev server en http://localhost:3000
npm run build      # sitio estático autocontenido en build/
```

Requisitos: Node.js 18 o superior. El basemap usa estilos vectoriales de Carto
bajo MapLibre GL, sin token ni variables de entorno. `npm install` muestra
avisos de paquetes deprecados por Create React App; no bloquean la ejecución.

La URL acepta parámetros para compartir vistas exactas (cámara, hora, modo,
capas y modo de comparación; ver `PARAMS_URL` en `src/App.js`), por ejemplo
`?hora=7&modo=buses&lat=-33.527&lon=-70.696&zoom=12.6`.

## Regenerar los datos

```sh
bash preparar_datos/generar_todo.sh              # flujo completo
MUESTRA=2 bash preparar_datos/generar_todo.sh    # prueba rápida con una muestra
```

El flujo produce la grilla H3, los insumos de Metro derivados del GTFS
(topología, coordenadas, ruteo y trazado), la red de buses, los segmentos de
viaje, las matrices por hora y las partículas precalculadas. Python se ejecuta
con `uv` (el entorno vive en `preparar_datos/pyproject.toml`).

Fuentes de entrada para Santiago: las tablas de viajes que publica DTPM
(https://www.dtpm.cl/index.php/documentos/matrices-de-viaje) y el feed GTFS de
DTPM (se descarga por URL). Para otra ciudad, el contrato de entrada es
etapas de viaje referidas a un feed GTFS; los detalles están en
`preparar_datos/README.md`, sección "Contrato de entrada genérico".

## Documentación

- `preparar_datos/README.md`: flujo de conversión, especificación de entradas
  y contrato genérico viajes + GTFS.
- `DATOS.md`: contrato de bajo nivel de los segmentos que lee la agregación.
- `ARQUITECTURA.md`: propuesta de registro de capas del frontend.

## Créditos

Alonso Almendras Troncoso y Eduardo Graells-Garrido, Departamento de Ciencias
de la Computación, Universidad de Chile. Nace de la tesis de Alonso Almendras.
Datos: DTPM (metodología ADATRAP). Basemap © OpenStreetMap contributors, ©
CARTO.
