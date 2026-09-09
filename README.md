# Mapocho: public transport flow visualization for Santiago

Visualization of the demand of Santiago's RED buses and Metro as per-hour
vector fields over an H3 hexagonal grid, animated as streamlets with deck.gl
on top of a map. The application is named Mapocho, after the river that
crosses the city. Part of the LOICA project (ANID Fondecyt Regular 1261835).

**Demo:** https://dcc.uchile.cl/~egraells/loica/scl-flow-vectors/

The repository contains two pieces chained by JSON files on disk, not by live
calls:

- **`src/` + `public/`**: the web application (React + deck.gl + MapLibre)
  and the per-hour aggregation scripts (Python).
- **`preparar_datos/`**: the conversion of the input data (trip records +
  GTFS feed) into everything the application consumes.

The repository versions no data. A fresh clone does not have the JSON that the
app imports at build time: generate it once with
`bash preparar_datos/generar_todo.sh` before `npm start` (see
`preparar_datos/README.md`, which includes the input-data specification and
the generic trips + GTFS contract for other cities).

Language note: the documentation is in English; the code comments, the console
output, and the user interface are in Spanish, the working language of the
system's users.

## Running the application

```sh
npm install        # install dependencies (once)
npm start          # dev server at http://localhost:3000
npm run build      # self-contained static site in build/
```

Requirements: Node.js 18 or newer. The basemap uses Carto vector styles under
MapLibre GL, with no token and no environment variables. `npm install` prints
deprecation warnings from Create React App; they do not block execution.

The `Makefile` chains these steps with their prerequisites. `make compilar`
installs the dependencies and generates the data if they are missing, and then
builds the site. `make publicar` builds and uploads `build/` to the hosting
through `deploy.sh`, whose destination is configurable by environment
variables (for example `make publicar NOMBRE=mapocho`). `make` alone lists the
targets.

The URL accepts parameters to share exact views (camera, hour, mode, layers,
and the comparison mode; see `PARAMS_URL` in `src/App.js`), for example
`?hora=7&modo=buses&lat=-33.527&lon=-70.696&zoom=12.6`.

## Regenerating the data

```sh
bash preparar_datos/generar_todo.sh              # full flow
MUESTRA=2 bash preparar_datos/generar_todo.sh    # quick test on a sample
```

The flow produces the H3 grid, the Metro inputs derived from the GTFS
(topology, coordinates, routing, and trace), the bus network, the trip
segments, the per-hour matrices, and the precomputed particles. Python runs
through `uv` (the environment lives in `preparar_datos/pyproject.toml`).

Input sources for Santiago: the trip tables published by DTPM
(https://www.dtpm.cl/index.php/documentos/matrices-de-viaje) and the DTPM GTFS
feed (downloaded by URL). For another city, the input contract is trip stages
referenced to a GTFS feed; the details are in `preparar_datos/README.md`,
section "Generic input contract".

## Documentation

- `preparar_datos/README.md`: conversion flow, input specification, and the
  generic trips + GTFS contract.
- `DATOS.md`: low-level contract of the segments that the aggregation reads.

## License

MIT, see `LICENSE`. The data are distributed by DTPM under its own terms.

## Credits

Alonso Almendras Troncoso and Eduardo Graells-Garrido, Department of Computer
Science, Universidad de Chile. The system grew from Alonso Almendras's thesis.
Data: DTPM (ADATRAP methodology). The loica illustration in the header is by
Sarai Collilef. Basemap © OpenStreetMap contributors,
© CARTO.
