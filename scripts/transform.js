'use strict';

/**
 * transform.js — turn the dealer's raw catalog export into the trimmed shape the
 * app loads.
 *
 *   data/raw_parts.json  (partsauto-style raw export, many fields per object)
 *        │   node scripts/transform.js
 *        ▼
 *   parts.json           (array of trimmed parts the app reads at startup)
 *
 * No dependencies (Node built-ins only). Re-runnable: it overwrites parts.json
 * every time. After running, restart the server so it reloads the catalog.
 *
 * Trimmed shape (every field always present; missing -> null):
 *   { id, name, compatible_with, car_name, price, stock, oem, code }
 *
 * Everything else (image, timestamps, description_*, title_en/ru, folder,
 * position, catid, newprice, the nested car object except its name) is dropped.
 */

const fs = require('fs');
const path = require('path');

const RAW_PATH = path.join(__dirname, '..', 'data', 'raw_parts.json');
const OUT_PATH = path.join(__dirname, '..', 'parts.json');

/** Normalize undefined/missing values to null (keeps real falsy values like 0). */
function orNull(v) {
  return v === undefined ? null : v;
}

/** Map one raw part object to the trimmed shape. */
function transformPart(raw) {
  return {
    id: orNull(raw.id),
    name: orNull(raw.title_ka), // primary name; title_en/title_ru are usually null
    compatible_with: orNull(raw.compatible_with), // free-text, e.g. "COROLLA 2019-25"
    car_name: raw.car && raw.car.name != null ? raw.car.name : null, // e.g. "COROLLA 2019-2025"
    price: orNull(raw.price),
    stock: orNull(raw.stock),
    oem: orNull(raw.oem),
    code: orNull(raw.code),
  };
}

function main() {
  let text;
  try {
    text = fs.readFileSync(RAW_PATH, 'utf8');
  } catch (err) {
    console.error(`[transform] Could not read raw data at ${RAW_PATH}`);
    console.error(`[transform] ${err.message}`);
    console.error('[transform] Put the dealer export at data/raw_parts.json and re-run.');
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.error(`[transform] data/raw_parts.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  // Accept a bare array, or a common wrapper like { data: [...] } / { parts: [...] }.
  const items = Array.isArray(raw)
    ? raw
    : Array.isArray(raw && raw.data)
    ? raw.data
    : Array.isArray(raw && raw.parts)
    ? raw.parts
    : null;

  if (!items) {
    console.error('[transform] Expected an array of parts (or a { data: [...] } wrapper).');
    process.exit(1);
  }

  const transformed = items.map(transformPart);

  fs.writeFileSync(OUT_PATH, JSON.stringify(transformed, null, 2) + '\n', 'utf8');

  console.log(`[transform] Read ${items.length} raw item(s) from ${path.relative(process.cwd(), RAW_PATH)}`);
  console.log(`[transform] Transformed ${transformed.length} item(s) -> ${path.relative(process.cwd(), OUT_PATH)}`);
}

main();
