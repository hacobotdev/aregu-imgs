import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import dotenv from 'dotenv';

// ============================================================
// sync.js — sincroniza imágenes + catálogo público (todo en uno)
// ============================================================
// Hace las dos cosas que este repo publica en GitHub/jsDelivr, en una corrida:
//
//   1. Imágenes: baja las fotos y thumbs que lista GET /api/publico/productos
//      y las deja en {STAGE}/t/{tenant_id}/productos/...   (antes sync.js)
//   2. Catálogo: baja GET /api/publico/tenants y /tenants/:id y deja
//      {STAGE}/tenants.json + {STAGE}/tenant_{id}.json
//      (antes sync-catalogo.js)
//
// Un solo `git pull` al inicio y un solo commit/push al final, así los JSON
// publicados nunca apuntan a fotos que todavía no están en el repo.
//
// Orden de las fases (importa):
//   1. git pull
//   2. Catálogo a memoria    — si la API falla, aborta sin tocar el disco
//   3. Imágenes a disco      — un thumb ausente solo se avisa
//   4. JSON a disco          — solo los archivos cuyo contenido cambió
//   5. git add {STAGE} → commit → push
//   6. Purga en jsDelivr los JSON publicados (las imágenes no: su nombre
//      lleva el hash del contenido, así que una imagen nueva es una URL nueva)
//
// Uso:
//   node sync.js .env-prod
//   node sync.js .env-prod --dry-run    # solo reporta; no escribe ni hace git
//   node sync.js .env-prod --no-git     # escribe archivos; sin pull/commit/push
//
// Variables requeridas en el .env:
//   API_BASE              http://demo.localhost:42020/api/publico
//   API_KEY               la PRODUCTS_ENDPOINT_API_KEY de la API (x-api-key)
//   STAGE                 dev | prod   (carpeta destino)
//   URL_PREFIX_TO_STRIP   prefijo de R2/imgs a quitar para dejar rutas del repo
// Opcionales:
//   API_ENDPOINT          endpoint de imágenes si NO es {API_BASE}/productos
//   INCLUIR_INACTIVOS     "true" para no filtrar inactivos en los JSON
//   PURGAR_CDN            "false" para NO purgar jsDelivr tras publicar
// ============================================================

const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const envFile = args.find(a => !a.startsWith('--')) || '.env';

const DRY_RUN = flags.includes('--dry-run');
const NO_GIT = flags.includes('--no-git') || DRY_RUN;

dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const API_BASE = (process.env.API_BASE || '').replace(/\/+$/, '');
const API_KEY = process.env.API_KEY;
const API_PRODUCTOS = (process.env.API_ENDPOINT || (API_BASE ? `${API_BASE}/productos` : '')).trim();
const STAGE = process.env.STAGE;
const URL_PREFIX = process.env.URL_PREFIX_TO_STRIP || '';
const SOLO_ACTIVOS = process.env.INCLUIR_INACTIVOS !== 'true';
const PURGAR_CDN = process.env.PURGAR_CDN !== 'false';

// jsDelivr sirve la rama `main` de este repo; purgar una ruta puntual hace que
// el borde vuelva a leer de GitHub.
const CDN_REPO = 'hacobotdev/aregu-imgs';
const PURGE_BASE = 'https://purge.jsdelivr.net/gh';

const OUT_DIR = path.join(process.cwd(), STAGE || '');
const GENERAL_FILE = path.join(OUT_DIR, 'tenants.json');

const faltantes = [
  ['API_BASE', API_BASE],
  ['API_KEY', API_KEY],
  ['STAGE', STAGE],
  ['URL_PREFIX_TO_STRIP', URL_PREFIX],
].filter(([, valor]) => !valor).map(([nombre]) => nombre);

if (faltantes.length) {
  console.error(`❌ Error: falta definir ${faltantes.join(', ')} en ${envFile}.`);
  process.exit(1);
}

// ── Utilidades ────────────────────────────────────────────────────────────────

/**
 * GET contra la API pública con la API key y reintentos.
 * Un 401/403 es credencial inválida: no se reintenta, se aborta.
 */
async function apiGet(url) {
  let ultimoError;

  for (let intento = 1; intento <= 3; intento++) {
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });

      if (res.status === 401 || res.status === 403)
        throw Object.assign(new Error(`API key rechazada (HTTP ${res.status}) en ${url}. Revisa API_KEY.`), { fatal: true });

      if (!res.ok) {
        // La API responde { error: { nombre, codigo } } en 400/404/503.
        const cuerpo = await res.json().catch(() => null);
        const motivo = cuerpo?.error?.nombre ? `: ${cuerpo.error.nombre}` : '';
        throw new Error(`HTTP ${res.status}${motivo} en ${url}`);
      }

      return await res.json();
    } catch (error) {
      ultimoError = error;
      if (error.fatal) break;
      if (intento < 3) await new Promise(r => setTimeout(r, 2000 * intento));
    }
  }

  throw ultimoError;
}

/** Ruta del thumb a partir de la ruta/URL del original. */
function rutaThumb(original) {
  const ext = path.extname(original);
  if (!ext) return original + '_thumb';
  return original.slice(0, -ext.length) + '_thumb' + ext;
}

/**
 * URL de R2 → ruta dentro del repo (`t/1/productos/foto.jpg`).
 * Se usa tanto para descargar como para armar los JSON: el portal le antepone
 * la URL base del repo, así que ambos lados deben coincidir.
 */
function rutaRelativa(url) {
  const sinPrefijo = URL_PREFIX ? url.replace(URL_PREFIX, '') : url;
  return sinPrefijo.replace(/^\/+/, '');
}

/**
 * Convierte productos.imagen en algo que sirva a un portal público.
 *
 * - URL de R2/imgs → ruta relativa al repo (`t/1/productos/foo.jpg`), que es
 *   donde este script deja las imágenes.
 * - URL que no coincide con URL_PREFIX_TO_STRIP → se deja absoluta tal cual.
 * - base64 (fila sin migrar) → null: no cabe en un JSON público.
 */
function normalizarImagen(imagen) {
  if (!imagen) return { imagen: null, imagen_thumb: null };
  if (imagen.startsWith('data:')) return { imagen: null, imagen_thumb: null, base64: true };

  const sinPrefijo = URL_PREFIX ? imagen.replace(URL_PREFIX, '') : imagen;

  if (/^https?:\/\//i.test(sinPrefijo))
    return { imagen: sinPrefijo, imagen_thumb: rutaThumb(sinPrefijo) };

  const relativa = sinPrefijo.replace(/^\/+/, '');
  return { imagen: relativa, imagen_thumb: rutaThumb(relativa) };
}

/** true si el archivo ya tiene el mismo contenido (ignorando `generado_en`). */
function sinCambios(archivo, payload) {
  try {
    const actual = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    delete actual.generado_en;
    return JSON.stringify(actual) === JSON.stringify(payload);
  } catch {
    return false;
  }
}

/**
 * Escribe el archivo solo si el contenido cambió. Devuelve true si hubo que
 * escribir. Escritura atómica (tmp + rename) para que nunca se lea a medias.
 */
function escribirSiCambio(archivo, payload) {
  if (sinCambios(archivo, payload)) return false;
  if (DRY_RUN) return true;

  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = archivo + '.tmp';
  const contenido = JSON.stringify({ generado_en: new Date().toISOString(), ...payload }, null, 2) + '\n';
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, archivo);
  return true;
}

// ── Armado del catálogo ───────────────────────────────────────────────────────

let base64Omitidos = 0;        // productos con imagen base64 → null en el JSON
let imagenesAbsolutas = 0;     // productos cuya imagen quedó como URL absoluta
let imagenesSinUrl = 0;        // productos sin `url` en /api/publico/productos
let imagenesFueraDePrefijo = 0;// imágenes que no se pudieron descargar al repo
let imagenesDescargadas = 0;   // archivos (foto o thumb) nuevos en disco
let fallosDescarga = 0;        // fotos/thumbs que la descarga no pudo traer

/**
 * Arma el catálogo de un tenant a partir de la respuesta de /tenants/:id.
 *
 * - Normaliza `productos.imagen` a rutas del repo de imágenes.
 * - Con INCLUIR_INACTIVOS != "true" descarta productos, categorías,
 *   modificadores, opciones y descuentos con `activo = false`.
 * - Poda las tablas puente para que solo queden pares cuyos dos lados siguen
 *   presentes (evita referencias colgadas en el JSON público).
 */
function construirCatalogo(detalle) {
  let productos = (detalle.productos || []).map(producto => {
    const img = normalizarImagen(producto.imagen);
    if (img.base64) base64Omitidos++;
    if (img.imagen && /^https?:\/\//i.test(img.imagen)) imagenesAbsolutas++;
    return { ...producto, imagen: img.imagen, imagen_thumb: img.imagen_thumb };
  });
  let categorias = detalle.categorias || [];
  let modificadores = detalle.modificadores || [];
  let opciones = detalle.modificadores_opciones || [];
  let productosModificadores = detalle.productos_modificadores || [];
  let descuentos = detalle.descuentos || [];
  let descuentosProductos = detalle.descuentos_productos || [];

  if (SOLO_ACTIVOS) {
    const activo = fila => fila.activo !== false;
    productos = productos.filter(activo);
    categorias = categorias.filter(activo);
    modificadores = modificadores.filter(activo);
    opciones = opciones.filter(activo);
    descuentos = descuentos.filter(activo);
  }

  const prodIds = new Set(productos.map(p => p.producto_id));
  const modIds = new Set(modificadores.map(m => m.modifier_id));
  const descIds = new Set(descuentos.map(d => d.descuento_id));

  productosModificadores = productosModificadores.filter(
    r => prodIds.has(r.producto_id) && modIds.has(r.modifier_id)
  );
  descuentosProductos = descuentosProductos.filter(
    r => descIds.has(r.descuento_id) && prodIds.has(r.producto_id)
  );

  return {
    productos,
    categorias,
    modificadores,
    modificadores_opciones: opciones,
    productos_modificadores: productosModificadores,
    descuentos,
    descuentos_productos: descuentosProductos,
  };
}

/** Borra los tenant_{id}.json de tenants que ya no están publicados. */
function limpiarObsoletos(idsVigentes) {
  if (!fs.existsSync(OUT_DIR)) return [];

  const obsoletos = fs.readdirSync(OUT_DIR)
    .filter(archivo => /^tenant_\d+\.json$/.test(archivo))
    .filter(archivo => !idsVigentes.has(Number(archivo.match(/\d+/)[0])));

  for (const archivo of obsoletos) {
    if (!DRY_RUN) fs.unlinkSync(path.join(OUT_DIR, archivo));
    console.log(`🗑️  ${archivo} → eliminado (tenant ya no publicado)`);
  }

  return obsoletos;
}

// ── Publicación ───────────────────────────────────────────────────────────────

/**
 * Purga en jsDelivr los archivos recién publicados.
 *
 * Se purga DESPUÉS del push: si se hiciera antes, jsDelivr releería la versión
 * vieja de GitHub. El portal pide siempre la URL de la rama, sin `?v=` ni
 * fechas, así que esta purga es lo que hace que el catálogo nuevo se vea en la
 * siguiente carga. Las imágenes no se purgan: su nombre lleva el hash del
 * contenido, así que una imagen nueva es una URL nueva.
 */
async function purgarCdn(archivos) {
  if (!archivos.length) return;

  if (!PURGAR_CDN) {
    console.log('ℹ️  PURGAR_CDN=false: no se purgó jsDelivr (los cambios pueden tardar ~12 h en verse).');
    return;
  }

  // Margen para que GitHub exponga el commit recién subido a jsDelivr.
  await new Promise(r => setTimeout(r, 2000));

  let fallidos = 0;

  for (const archivo of archivos) {
    const url = `${PURGE_BASE}/${CDN_REPO}@main/${STAGE}/${archivo}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const cuerpo = await res.json().catch(() => null);

      if (res.ok && cuerpo?.status !== 'failed') {
        console.log(`♻️  ${archivo} → purgado en jsDelivr`);
      } else {
        fallidos++;
        console.warn(`⚠️  ${archivo} → jsDelivr no confirmó la purga (HTTP ${res.status}). Purga a mano: ${url}`);
      }
    } catch (error) {
      fallidos++;
      console.warn(`⚠️  ${archivo} → no se pudo purgar (${error.message}). Purga a mano: ${url}`);
    }
  }

  if (fallidos)
    console.log(`⚠️  ${fallidos} archivo(s) sin purgar: el portal los verá cuando expire la caché (~12 h) o al purgarlos a mano.`);
}

/**
 * git add {STAGE} + un solo commit + push, y purga en jsDelivr los JSON.
 *
 * `git add` y `git commit -- {STAGE}` se limitan a la carpeta del stage para no
 * arrastrar al commit nada que el humano tenga pendiente fuera de ahí.
 */
async function publicar(archivos) {
  if (NO_GIT) {
    console.log('ℹ️  --no-git: archivos escritos sin commit ni push (y sin purga de jsDelivr).');
    return;
  }

  const relativo = path.relative(process.cwd(), OUT_DIR) || '.';

  console.log(`📌 Agregando cambios a Git (git add "${relativo}")...`);
  execSync(`git add "${relativo}"`, { stdio: 'inherit' });

  const diff = spawnSync('git', ['diff', '--cached', '--quiet', '--', relativo], { cwd: process.cwd() });
  if (diff.status === 0) {
    console.log('ℹ️  Git no detecta cambios que subir.');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const commitMsg = `sync imágenes y catálogo ${timestamp}`;

  console.log(`commit: "${commitMsg}"`);
  const commit = spawnSync('git', ['commit', '-m', commitMsg, '--', relativo], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (commit.status !== 0) throw new Error('git commit falló.');

  console.log('🚀 Subiendo cambios (git push)...');
  execSync('git push origin main', { stdio: 'inherit' });

  console.log('✅ Imágenes y catálogo publicados.');

  await purgarCdn(archivos);
}

/**
 * Descarga la ficha de cada tenant publicado y arma en memoria todos los JSON.
 *
 * Se hace ANTES de tocar el disco: si la API falla a mitad (401/403/503/red),
 * el script aborta y el repo queda exactamente como estaba.
 */
async function armarPendientes() {
  console.log(`📡 Consultando ${API_BASE}/tenants ...`);
  const respuesta = await apiGet(`${API_BASE}/tenants`);
  const tenants = Array.isArray(respuesta) ? respuesta : respuesta.tenants;

  if (!Array.isArray(tenants))
    throw new Error('Respuesta inesperada de /tenants: falta el arreglo `tenants`.');

  // Orden estable para que el JSON no cambie solo porque la BD cambió el orden.
  tenants.sort((a, b) => a.id - b.id);
  console.log(`🏪 ${tenants.length} tenant(s) publicados.`);

  const pendientes = [{ archivo: GENERAL_FILE, etiqueta: 'tenants.json', payload: { tenants } }];

  for (const tenant of tenants) {
    const etiqueta = `tenant_${tenant.id}.json`;
    console.log(`  📥 ${etiqueta} (${tenant.nombre || 'sin nombre'})...`);
    const detalle = await apiGet(`${API_BASE}/tenants/${tenant.id}`);
    pendientes.push({
      archivo: path.join(OUT_DIR, etiqueta),
      etiqueta,
      payload: { tenant, ...construirCatalogo(detalle) },
    });
  }

  return { tenants, pendientes };
}

// ── Imágenes ──────────────────────────────────────────────────────────────────

/** Baja un archivo binario de forma atómica (tmp + rename). */
async function descargarArchivo(url, destino) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });

  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('respuesta vacía');

  const tmp = destino + '.tmp';
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, destino);
}

/**
 * Baja las fotos y thumbs que lista GET /api/publico/productos.
 *
 * - Solo pide los archivos que faltan en disco (el nombre lleva el hash, así
 *   que una foto nueva es un archivo nuevo).
 * - Un thumb ausente en R2 no es fatal: se avisa y el portal cae a la foto
 *   completa (ver `imagenes.js`).
 * - Una URL que no empieza con URL_PREFIX_TO_STRIP no se puede mapear a una
 *   ruta del repo: se avisa y se deja para el JSON como URL absoluta.
 */
async function sincronizarImagenes() {
  console.log(`📡 Consultando ${API_PRODUCTOS} ...`);
  const data = await apiGet(API_PRODUCTOS);
  const productos = Array.isArray(data.productos) ? data.productos : [];
  console.log(`📦 ${productos.length} registro(s) con imagen en la API.`);

  for (const prod of productos) {
    const originalUrl = prod.url;

    // `url` es null cuando la fila todavía tiene base64 (ver productos.getPublico).
    if (!originalUrl) {
      imagenesSinUrl++;
      continue;
    }

    if (!originalUrl.startsWith(URL_PREFIX)) {
      imagenesFueraDePrefijo++;
      console.warn(`⚠️  Fuera de URL_PREFIX_TO_STRIP, no se descarga: ${originalUrl}`);
      continue;
    }

    const thumbUrl = rutaThumb(originalUrl);
    const destinoOriginal = path.join(OUT_DIR, rutaRelativa(originalUrl));
    const destinoThumb = path.join(OUT_DIR, rutaRelativa(thumbUrl));

    const faltaOriginal = !fs.existsSync(destinoOriginal);
    const faltaThumb = !fs.existsSync(destinoThumb);

    if (!faltaOriginal && !faltaThumb) continue;

    if (faltaOriginal) {
      if (DRY_RUN) {
        console.log(`🔍 Descargaría original: ${originalUrl}`);
      } else {
        console.log(`⬇️  Original: ${originalUrl}`);
        try {
          await descargarArchivo(originalUrl, destinoOriginal);
          imagenesDescargadas++;
        } catch (error) {
          fallosDescarga++;
          console.error(`❌ No se pudo descargar ${originalUrl}: ${error.message}`);
        }
      }
    }

    if (faltaThumb) {
      if (DRY_RUN) {
        console.log(`🔍 Descargaría thumb: ${thumbUrl}`);
      } else {
        console.log(`⬇️  Thumb: ${thumbUrl}`);
        try {
          await descargarArchivo(thumbUrl, destinoThumb);
          imagenesDescargadas++;
        } catch (error) {
          fallosDescarga++;
          console.warn(`⚠️  Sin thumb (¿no existe en R2?): ${thumbUrl} (${error.message})`);
        }
      }
    }
  }
}

// ── Flujo principal ───────────────────────────────────────────────────────────

async function run() {
  const inicio = Date.now();

  if (!NO_GIT) {
    console.log('🔄 1/4 Actualizando repositorio (git pull)...');
    execSync('git pull origin main', { stdio: 'inherit' });
  }

  // Fase 1: el catálogo se arma en memoria. Si la API falla aquí, aborta antes
  // de descargar o escribir nada.
  console.log('📡 2/4 Catálogo público (a memoria)...');
  const { tenants, pendientes } = await armarPendientes();

  // Fase 2: imágenes. Van antes de escribir los JSON para que el catálogo
  // publicado nunca apunte a fotos que no están en el repo.
  console.log('🖼️  3/4 Imágenes y thumbs...');
  await sincronizarImagenes();

  // Fase 3: JSON. Solo se reescribe lo que cambió, así el portal se sirve
  // estático y la API/BD casi no reciben carga.
  console.log('📝 4/4 JSON del catálogo...');
  const escritos = [];
  for (const { archivo, etiqueta, payload } of pendientes) {
    if (escribirSiCambio(archivo, payload)) {
      escritos.push(etiqueta);
      const cuantos = payload.productos ? ` (${payload.productos.length} productos)` : '';
      console.log(`📝 ${etiqueta} → actualizado${cuantos}`);
    } else {
      console.log(`ℹ️  ${etiqueta} → sin cambios`);
    }
  }

  const obsoletos = limpiarObsoletos(new Set(tenants.map(t => t.id)));
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

  console.log('──────────────────────────────────────────');
  console.log(
    `Resumen: ${escritos.length} JSON actualizado(s), ${obsoletos.length} eliminado(s), ` +
    `${imagenesDescargadas} archivo(s) de imagen descargado(s), ${segundos}s`
  );

  if (fallosDescarga)
    console.log(`⚠️  ${fallosDescarga} imagen(es) no se pudieron descargar (se reintentarán en la próxima corrida).`);
  if (imagenesSinUrl)
    console.log(`ℹ️  ${imagenesSinUrl} producto(s) sin "url" en /productos (imagen base64 o null): no hay nada que descargar.`);
  if (imagenesFueraDePrefijo)
    console.log(`⚠️  ${imagenesFueraDePrefijo} imagen(es) fuera de URL_PREFIX_TO_STRIP: no se descargaron.`);
  if (base64Omitidos)
    console.log(`⚠️  ${base64Omitidos} imagen(es) en base64 omitidas en los JSON (migrar a R2).`);
  if (imagenesAbsolutas)
    console.log(`⚠️  ${imagenesAbsolutas} imagen(es) con URL fuera de URL_PREFIX_TO_STRIP (quedaron absolutas en el JSON).`);

  if (DRY_RUN) {
    console.log('🔍 --dry-run: no se descargó ni escribió ningún archivo.');
    return;
  }

  if (!escritos.length && !obsoletos.length && !imagenesDescargadas) {
    console.log('ℹ️  Nada que publicar.');
    return;
  }

  await publicar([...escritos, ...obsoletos]);
}

run().catch(error => {
  console.error('❌ Error durante la sincronización:', error.message || error);
  console.error('   Si falló la API (fases 2 o 3), se abortó antes de escribir: el repo queda igual.');
  process.exit(1);
});
