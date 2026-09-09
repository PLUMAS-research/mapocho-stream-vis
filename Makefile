# Build and publish the Mapocho application.
#
# Run `make` (or `make ayuda`) to list the targets. The usual flow is:
#   make datos       generate src/json and the particles from the DTPM data
#   make compilar    static site in build/ (installs node_modules and
#                    generates the data first if they are missing)
#   make publicar    compile and upload build/ to the hosting (deploy.sh)
#   make subir       upload the existing build/ without recompiling
#
# Variables given on the command line reach the scripts as environment
# variables, so the knobs of generar_todo.sh and deploy.sh work as usual:
#   make datos MUESTRA=2
#   make publicar NOMBRE=mapocho DESTINO_HOST=otro.host

SHELL := bash
.DEFAULT_GOAL := ayuda

PORT ?= 3000

# npm writes this file at the end of every install: it works as a stamp.
NODE_MODULES := node_modules/.package-lock.json
# Last output of generar_todo.sh: if it exists, the whole pipeline ran.
DATOS := src/particulasPrecalculadas.json
BUILD := build/index.html

.PHONY: ayuda instalar datos compilar publicar subir dev limpiar

ayuda: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{ printf "  %-10s %s\n", $$1, $$2 }'

instalar: $(NODE_MODULES) ## Install the Node dependencies

$(NODE_MODULES): package.json package-lock.json
	npm install
	@touch $@

datos: ## Generate all the data from DTPM + GTFS (MUESTRA=2 for a quick test)
	bash preparar_datos/generar_todo.sh

$(DATOS):
	bash preparar_datos/generar_todo.sh

compilar: $(NODE_MODULES) $(DATOS) ## Build the static site in build/
	npm run build

publicar: compilar ## Build and upload build/ to the hosting (see deploy.sh)
	SOLO_SUBIR=1 ./deploy.sh

subir: ## Upload the existing build/ without recompiling
	@test -f $(BUILD) || { echo "No build/ found: run 'make compilar' first" >&2; exit 1; }
	SOLO_SUBIR=1 ./deploy.sh

dev: $(NODE_MODULES) $(DATOS) ## Dev server (make dev PORT=3001)
	PORT=$(PORT) npm start

limpiar: ## Remove build/
	rm -rf build
