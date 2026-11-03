import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

// 1. Leer el archivo .env pasado como argumento (ej. node sync.js .env.prod)
const envFile = process.argv[2] || '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const API_ENDPOINT = process.env.API_ENDPOINT;
const STAGE = process.env.STAGE;
const URL_PREFIX = process.env.URL_PREFIX_TO_STRIP;

if (!API_ENDPOINT) {
  console.error('❌ Error: Falta definir API_ENDPOINT en el archivo de configuración.');
  process.exit(1);
}

function getThumbUrl(originalUrl) {
  const ext = path.extname(originalUrl);
  if (!ext) return originalUrl + '_thumb'; // fallback por si no tiene extensión
  return originalUrl.slice(0, -ext.length) + '_thumb' + ext;
}

async function run() {
  try {
    console.log('🔄 1. Actualizando repositorio (git pull)...');
    execSync('git pull origin main', { stdio: 'inherit' });

    console.log(`📡 2. Consultando endpoint: ${API_ENDPOINT}...`);
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) throw new Error(`Error HTTP en el endpoint: ${response.status}`);
    
    const data = await response.json();
    const productos = data.productos || [];
    console.log(`📦 Se encontraron ${productos.length} registros en el JSON.`);

    let downloadedCount = 0;

    for (const prod of productos) {
      const originalUrl = prod.url;
      if (!originalUrl) continue;

      const thumbUrl = getThumbUrl(originalUrl);

      // Preparamos las rutas para ambos archivos (Original y Thumb)
      const relativePath = originalUrl.replace(URL_PREFIX, '').replace(/^\/+/, '');
      const relativeThumbPath = thumbUrl.replace(URL_PREFIX, '').replace(/^\/+/, '');

      const targetOriginalPath = path.join(process.cwd(), STAGE, relativePath);
      const targetThumbPath = path.join(process.cwd(), STAGE, relativeThumbPath);

      // Verificamos si ambos archivos ya existen para saltarlos y ahorrar llamadas
      const originalExists = fs.existsSync(targetOriginalPath);
      const thumbExists = fs.existsSync(targetThumbPath);

      if (originalExists && thumbExists) {
        continue; // Ambos ya existen, pasamos al siguiente
      }

      // 1. Procesar archivo original si no existe
      if (!originalExists) {
        console.log(`⬇️ Descargando Original: ${originalUrl}`);
        fs.mkdirSync(path.dirname(targetOriginalPath), { recursive: true });
        
        const imgRes = await fetch(originalUrl);
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          fs.writeFileSync(targetOriginalPath, buffer);
          downloadedCount++;
        } else {
          console.error(`❌ Fallo al descargar original ${originalUrl}: ${imgRes.statusText}`);
        }
      }

      // 2. Procesar archivo thumb si no existe
      if (!thumbExists) {
        console.log(`⬇️ Descargando Thumb: ${thumbUrl}`);
        fs.mkdirSync(path.dirname(targetThumbPath), { recursive: true });
        
        const thumbRes = await fetch(thumbUrl);
        if (thumbRes.ok) {
          const buffer = Buffer.from(await thumbRes.arrayBuffer());
          fs.writeFileSync(targetThumbPath, buffer);
          downloadedCount++;
        } else {
          console.error(`⚠️ No se pudo descargar el thumb (puede que no exista en el servidor): ${thumbUrl}`);
        }
      }
    }

    console.log(`✨ Descarga finalizada. Nuevos archivos guardados: ${downloadedCount}`);

    /*if (downloadedCount > 0) {
      console.log('📌 3. Agregando cambios a Git (git add)...');
      execSync('git add .', { stdio: 'inherit' });

      const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const commitMsg = `sincronización de imagenes y thumbs ${timestamp}`;
      
      console.log(`commit: "${commitMsg}"`);
      execSync(`git commit -m "${commitMsg}"`, { stdio: 'inherit' });

      console.log('🚀 4. Subiendo cambios (git push)...');
      execSync('git push origin main', { stdio: 'inherit' });
      
      console.log('✅ ¡Sincronización y push completados con éxito!');
    } else {
      console.log('ℹ️ No hay archivos nuevos para sincronizar. No se requiere commit.');
    }*/

  } catch (error) {
    console.error('❌ Error durante el proceso de sincronización:', error);
    process.exit(1);
  }
}

run();