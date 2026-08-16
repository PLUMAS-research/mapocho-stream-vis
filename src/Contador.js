class ContadorPesos {
    constructor() {
        this.datos = {
            'buses': Array.from({length: 24}, () => []),
            'metro': Array.from({length: 24}, () => [])
        };
        this.completo = {
            'buses': Array(24).fill(false),
            'metro': Array(24).fill(false)
        };
        this.todosCompletos = false;
    }

    agregarPeso(tipo, hora, peso) {
        // Discard zero weights
        if (peso === 0) {
            return false;
        }

        // Validate parameters
        if (!['buses', 'metro'].includes(tipo)) {
            console.error(`Invalid type ${tipo}. Must be 'buses' or 'metro'.`);
            return false;
        }

        if (hora < 0 || hora > 23) {
            console.error(`Invalid hour ${hora}. Must be between 0 and 23.`);
            return false;
        }

        // Skip if this bucket is already complete
        if (this.completo[tipo][hora]) {
            return false;
        }

        // Add the weight
        this.datos[tipo][hora].push(peso);

        // Check whether this hour is now complete
        if (this.datos[tipo][hora].length >= 1000) {
            this.completo[tipo][hora] = true;
            console.log(`Complete: ${tipo} - hour ${hora}: 1000 samples collected`);

            // Check whether every bucket is complete
            this.verificarCompletitud();
        }

        return true;
    }

    verificarCompletitud() {
        // Check buses (all hours)
        const busesCompleto = this.completo['buses'].every(completo => completo);

        // Check metro (hours 6-23 only)
        const metroCompleto = this.completo['metro'].slice(6, 24).every(completo => completo);

        if (busesCompleto && metroCompleto) {
            this.todosCompletos = true;
            console.log('All samples collected. Generating the report...');
            this.guardarDatos();
        }
    }

    calcularDesviacionEstandar(datos) {
        const n = datos.length;
        const media = datos.reduce((a, b) => a + b, 0) / n;
        return Math.sqrt(datos.map(x => Math.pow(x - media, 2)).reduce((a, b) => a + b, 0) / n);
    }

    generarReporte() {
        const reporte = {
            'buses': {},
            'metro': {}
        };

        ['buses', 'metro'].forEach(tipo => {
            for (let hora = 0; hora < 24; hora++) {
                const pesos = this.datos[tipo][hora];

                // Only report buckets with data
                if (pesos.length > 0) {
                    const sorted = [...pesos].sort((a, b) => a - b);
                    const suma = pesos.reduce((a, b) => a + b, 0);
                    const media = suma / pesos.length;
                    const desviacion = this.calcularDesviacionEstandar(pesos);

                    reporte[tipo][hora] = {
                        'cantidad': pesos.length,
                        'minimo': Math.min(...pesos),
                        'maximo': Math.max(...pesos),
                        'suma': suma,
                        'media': media,
                        'mediana': this.calcularPercentil(sorted, 50),
                        'desviacionEstandar': desviacion,
                        'coeficienteVariacion': (desviacion / media) * 100,
                        'percentiles': {
                            '5': this.calcularPercentil(sorted, 5),
                            '10': this.calcularPercentil(sorted, 10),
                            '25': this.calcularPercentil(sorted, 25),
                            '50': this.calcularPercentil(sorted, 50),
                            '75': this.calcularPercentil(sorted, 75),
                            '90': this.calcularPercentil(sorted, 90),
                            '95': this.calcularPercentil(sorted, 95)
                        },
                        'rangoIntercuartil': this.calcularPercentil(sorted, 75) - this.calcularPercentil(sorted, 25)
                    };
                }
            }
        });

        return reporte;
    }

    calcularPercentil(datosOrdenados, percentil) {
        const index = Math.ceil((percentil / 100) * datosOrdenados.length) - 1;
        return datosOrdenados[Math.max(0, index)];
    }

    guardarDatos() {
        // Only generate and download the report, not the raw samples
        const reporte = JSON.stringify(this.generarReporte(), null, 2);

        // Blob for the download
        const blobReporte = new Blob([reporte], { type: 'application/json' });

        // Download link
        this.descargarArchivo(blobReporte, 'reporte_estadisticas_pesos.json');

        console.log('Statistics report generated and available for download');
    }

    descargarArchivo(blob, nombreArchivo) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombreArchivo;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// Global counter instance
const contadorPesos = new ContadorPesos();
export default contadorPesos;
