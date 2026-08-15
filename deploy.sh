#!/bin/bash
# Publica la demo estática en el hosting del DCC.
#
# Uso:
#   bash deploy.sh              # compila y sube
#   SOLO_SUBIR=1 bash deploy.sh # sube el build existente sin recompilar
#
# Configurable por entorno:
#   DESTINO_HOST (default dichato.dcc.uchile.cl)
#   NOMBRE       (default scl-flow-vectors)
#   DESTINO_RUTA (default public_www/loica/$NOMBRE)
#   URL_PUBLICA  (default https://dcc.uchile.cl/~egraells/loica/$NOMBRE)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

DESTINO_HOST="${DESTINO_HOST:-dichato.dcc.uchile.cl}"
NOMBRE="${NOMBRE:-scl-flow-vectors}"
DESTINO_RUTA="${DESTINO_RUTA:-public_www/loica/$NOMBRE}"
URL_PUBLICA="${URL_PUBLICA:-https://dcc.uchile.cl/~egraells/loica/$NOMBRE}"

if [ "${SOLO_SUBIR:-0}" != "1" ]; then
  echo ">>> Compilando (npm run build)"
  npm run build
fi

echo ">>> Subiendo build/ a $DESTINO_HOST:$DESTINO_RUTA"
ssh "$DESTINO_HOST" "mkdir -p '$DESTINO_RUTA'"
rsync -av --delete build/ "$DESTINO_HOST:$DESTINO_RUTA/"

echo ">>> Publicado: $URL_PUBLICA"
