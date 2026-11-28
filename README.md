# aregu-imgs

Repo de imágenes de AreguPOS: espejo de las fotos de los productos y publicación
de los catálogos JSON que consume el portal público.

## Estructura

- `{stage}/t/{tenant_id}/productos/...` — imágenes y thumbs de los productos (los baja `sync.js`).
- `{stage}/tenants.json` — tenants publicados (ficha pública).
- `{stage}/tenant_{id}.json` — ficha + catálogo completo de ese tenant.

`{stage}` es `dev` o `prod`, según `STAGE` en el `.env` correspondiente. Los JSON
van directos en la carpeta del stage, **sin** subcarpeta `catalogo/`.

jsDelivr sirve ambos archivos desde la rama `main`:

```
https://cdn.jsdelivr.net/gh/hacobotdev/aregu-imgs@main/{stage}/tenants.json
https://cdn.jsdelivr.net/gh/hacobotdev/aregu-imgs@main/{stage}/tenant_{id}.json
```

## `sync.js` — imágenes + catálogo (todo en uno)

Una sola corrida hace las dos cosas: baja las fotos/thumbs y genera los JSON que
consume el portal público (menú). Un solo `git pull` al inicio y un solo
commit/push al final, así los JSON publicados nunca apuntan a fotos que aún no
están en el repo.

```bash
node sync.js .env-prod              # descarga, escribe y publica (git)
node sync.js .env-prod --dry-run    # solo reporta; no descarga, no escribe, no hace git
node sync.js .env-prod --no-git     # escribe archivos, sin pull/commit/push
```

Orden de la corrida:

1. `git pull` (se omite con `--no-git` / `--dry-run`).
2. Catálogo a memoria: `GET /api/publico/tenants` + `/tenants/:id`.
3. Imágenes: `GET /api/publico/productos`, solo las que faltan en disco.
4. JSON: `tenants.json` y `tenant_{id}.json`, solo los que cambiaron.
5. `git add {stage}` → un solo commit → push.
6. Purga en jsDelivr los JSON publicados.

Variables en el `.env`:

| Variable | Ejemplo | Para qué |
|---|---|---|
| `API_BASE` | `https://demo.aregupos.com/api/publico` | Base de los endpoints públicos |
| `API_KEY` | *(la misma `PRODUCTS_ENDPOINT_API_KEY` de la API)* | Header `x-api-key` (también para las imágenes) |
| `STAGE` | `prod` / `dev` | Carpeta destino |
| `URL_PREFIX_TO_STRIP` | `https://imgs.aregupos.com/` | Prefijo de R2 a quitar para dejar rutas del repo |

Opcionales:

| Variable | Default | Para qué |
|---|---|---|
| `API_ENDPOINT` | `{API_BASE}/productos` | Solo si el endpoint de imágenes vive en otro host |
| `INCLUIR_INACTIVOS` | `false` | `true` para no filtrar inactivos en los JSON |
| `PURGAR_CDN` | `true` | `false` para no purgar jsDelivr tras publicar |

Comportamiento:

- `tenants.json`: `{ generado_en, tenants: [...] }` con los tenants activos y `publicar_habilitado = true`.
- `tenant_{id}.json`: `{ generado_en, tenant, productos, categorias, modificadores, modificadores_opciones, productos_modificadores, descuentos, descuentos_productos }`.
- `productos.imagen` / `productos.imagen_thumb` quedan como **ruta relativa al repo** (`t/1/productos/foto.jpg`); el portal les antepone la URL base del repo. Las imágenes en base64 se omiten (`null`) y se avisan en el resumen.
- Si un tenant deja de estar publicado, su `tenant_{id}.json` se elimina.
- Si la API falla (401/403/503/red) en las fases 2 o 3, el script **aborta antes de escribir nada**; el repo queda como estaba.
- Una imagen cuyo `url` no empieza con `URL_PREFIX_TO_STRIP` no se puede mapear a una ruta del repo: se avisa y en el JSON queda como URL absoluta.
- `git add` y el commit se limitan a `{stage}`; commit y push solo si hay cambios reales.

Cron sugerido (cada 2 horas):

```cron
0 */2 * * * cd /home/hacobot/Projects/aregu-imgs && node sync.js .env-prod >> sync.log 2>&1
```

## Caché del CDN

jsDelivr cachea las rutas por rama 12 h en el borde y 7 días en el navegador. El
portal público pide siempre la URL de la rama (`{stage}/tenants.json`), **sin**
`?v=` ni versiones con fecha.

Para que una publicación se vea al instante, `sync.js` **purga** en
jsDelivr cada archivo que cambió, justo después del `git push`:

```
https://purge.jsdelivr.net/gh/hacobotdev/aregu-imgs@main/{stage}/tenants.json
https://purge.jsdelivr.net/gh/hacobotdev/aregu-imgs@main/{stage}/tenant_{id}.json
```

- La purga corre solo si hubo push real; con `--no-git` no se purga (los
  archivos todavía no están en GitHub).
- `PURGAR_CDN=false` la desactiva; si falla, el script avisa y deja la URL para
  purgarla a mano.
- Las imágenes no necesitan purga: su nombre lleva el hash del contenido.

