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

## `sync.js` — imágenes

Descarga las imágenes y thumbs que lista el endpoint público de productos.

```bash
node sync.js .env-prod
```

## `sync-catalogo.js` — catálogo público

Genera los JSON que consume el portal público (menú). Consulta la API una vez
por corrida y **solo reescribe los archivos cuyo contenido cambió**, así el
portal se sirve estático y la API/BD casi no reciben carga.

```bash
node sync-catalogo.js .env-prod              # descarga, escribe y publica (git)
node sync-catalogo.js .env-prod --dry-run    # solo reporta; no escribe ni hace git
node sync-catalogo.js .env-prod --no-git     # escribe archivos, sin commit/push
```

Variables en el `.env` (además de `STAGE` y `URL_PREFIX_TO_STRIP`, que ya usa `sync.js`):

| Variable | Ejemplo | Para qué |
|---|---|---|
| `API_BASE` | `https://demo.aregupos.com/api/publico` | Base de los endpoints públicos |
| `API_KEY` | *(la misma `PRODUCTS_ENDPOINT_API_KEY` de la API)* | Header `x-api-key` |
| `INCLUIR_INACTIVOS` | `true` (opcional, default `false`) | Si no se pone, descarta productos/categorías/modificadores/descuentos inactivos |

Comportamiento:

- `tenants.json`: `{ generado_en, tenants: [...] }` con los tenants activos y `publicar_habilitado = true`.
- `tenant_{id}.json`: `{ generado_en, tenant, productos, categorias, modificadores, modificadores_opciones, productos_modificadores, descuentos, descuentos_productos }`.
- `productos.imagen` / `productos.imagen_thumb` quedan como **ruta relativa al repo** (`t/1/productos/foto.jpg`); el portal les antepone la URL base del repo. Las imágenes en base64 se omiten (`null`) y se avisan en el resumen.
- Si un tenant deja de estar publicado, su `tenant_{id}.json` se elimina.
- Si la API falla (401/403/503/red) el script **aborta sin escribir nada**; el repo queda como estaba.
- `git add` se limita a `{stage}`; commit y push solo si hay cambios reales.

Cron sugerido (cada 2 horas):

```cron
0 */2 * * * cd /home/hacobot/Projects/aregu-imgs && node sync-catalogo.js .env-prod >> catalogo.log 2>&1
```

> Las imágenes las sigue publicando `sync.js`; conviene correrlo en la misma
> ventana (o antes) para que los JSON no apunten a fotos que aún no están en el repo.

## Caché del CDN

jsDelivr cachea las rutas por rama (~12 h). El portal público le agrega
`?v=<VITE_CATALOGO_VERSION>` a cada petición, así que tras una publicación
conviene subir esa versión y reconstruir, o purgar la URL en jsDelivr; si no, el
menú puede tardar medio día en ver los cambios.

