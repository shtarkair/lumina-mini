#!/usr/bin/env node
/**
 * build-fixture-library.js
 *
 * Downloads the Open Fixture Library from GitHub and converts all fixtures
 * into Lumina FX profile format → fixture-library.json
 *
 * Usage:  node build-fixture-library.js
 * Output: fixture-library.json (in same directory)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OFL_REPO = 'https://github.com/OpenLightingProject/open-fixture-library.git';
const FIXTURES_DIR = path.join(__dirname, '_ofl_temp', 'fixtures');
const OUTPUT_FILE = path.join(__dirname, 'fixture-library.json');

// ─── OFL Capability Type → Lumina Param ID Mapping ───
const CAPABILITY_MAP = {
  'Intensity':            'dimmer',
  'ShutterStrobe':        'strobe',
  'Pan':                  'pan',
  'Tilt':                 'tilt',
  'Zoom':                 'zoom',
  'Iris':                 'iris',
  'Focus':                'focus',
  'Frost':                'frost',
  'Prism':                'prism',
  'PrismRotation':        'prism_rot',
  'BladeInsertion':       null,       // handled specially (blade_a..d)
  'BladeRotation':        null,       // handled specially (blade_a_rot..d_rot)
  'BladeSystemRotation':  'blade_rot',
};

// ColorIntensity sub-types
const COLOR_MAP = {
  'Red':     'red',
  'Green':   'green',
  'Blue':    'blue',
  'White':   'white',
  'Amber':   'amber',
  'UV':      'uv',
  'Cyan':    'cyan',
  'Magenta': 'magenta',
  'Yellow':  'yellow',
  'Warm White': 'warm_white',
  'Cool White': 'cool_white',
  'Indigo':  'indigo',
  'Lime':    'lime',
};

// OFL categories → Lumina category
const CATEGORY_MAP = {
  'Moving Head':      'Moving Head',
  'Color Changer':    'Color Changer',
  'Dimmer':           'Dimmer',
  'Effect':           'Effect',
  'Fan':              'Other',
  'Flower':           'Effect',
  'Hazer':            'Other',
  'Laser':            'Laser',
  'Matrix':           'Matrix',
  'Pixel Bar':        'LED Bar',
  'Scanner':          'Scanner',
  'Smoke':            'Other',
  'Stand':            'Other',
  'Strobe':           'Strobe',
  'Blinder':          'Blinder',
  'Barrel Scanner':   'Scanner',
};

// ─── Step 1: Clone/update OFL repo ───
function cloneOFL() {
  const tempDir = path.join(__dirname, '_ofl_temp');

  if (fs.existsSync(path.join(tempDir, '.git'))) {
    console.log('OFL repo already cloned, pulling latest...');
    try {
      execSync('git pull', { cwd: tempDir, stdio: 'pipe' });
    } catch (e) {
      console.log('Pull failed, continuing with existing data');
    }
  } else {
    console.log('Cloning Open Fixture Library (depth 1)...');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    // Clone with depth 1 to save space/time
    execSync(`git clone --depth 1 "${OFL_REPO}" "${tempDir}"`, { stdio: 'inherit', timeout: 120000 });
  }

  if (!fs.existsSync(FIXTURES_DIR)) {
    throw new Error('fixtures/ directory not found after clone');
  }
  console.log('OFL fixtures directory ready.');
}

// ─── Step 2: Identify which Lumina param a channel maps to ───
function identifyParam(channelDef, channelName) {
  if (!channelDef || !channelDef.capability && !channelDef.capabilities) return null;

  // Single capability channel
  if (channelDef.capability) {
    return mapCapability(channelDef.capability, channelName);
  }

  // Multi-capability channel: use the most common/dominant type
  if (channelDef.capabilities) {
    const types = {};
    for (const cap of channelDef.capabilities) {
      const t = cap.type;
      if (t && t !== 'NoFunction') {
        types[t] = (types[t] || 0) + 1;
      }
    }
    // Pick the most frequent capability type
    let best = null, bestCount = 0;
    for (const [t, count] of Object.entries(types)) {
      if (count > bestCount) { best = t; bestCount = count; }
    }
    if (best) {
      // For ColorIntensity, find the color from capabilities
      if (best === 'ColorIntensity') {
        for (const cap of channelDef.capabilities) {
          if (cap.type === 'ColorIntensity' && cap.color) {
            return COLOR_MAP[cap.color] || null;
          }
        }
      }
      return mapCapability({ type: best }, channelName);
    }
  }
  return null;
}

function mapCapability(cap, channelName) {
  const type = cap.type;

  // Direct map
  if (CAPABILITY_MAP[type] !== undefined) {
    return CAPABILITY_MAP[type];
  }

  // ColorIntensity → specific color param
  if (type === 'ColorIntensity') {
    const color = cap.color;
    if (color && COLOR_MAP[color]) return COLOR_MAP[color];
    // Try to guess from channel name
    for (const [colorName, paramId] of Object.entries(COLOR_MAP)) {
      if (channelName.toLowerCase().includes(colorName.toLowerCase())) return paramId;
    }
    return null;
  }

  // ColorTemperature → cto
  if (type === 'ColorTemperature') return 'cto';

  // Wheel types for color and gobo
  if (type === 'WheelSlot' || type === 'WheelRotation' || type === 'WheelShake') {
    const nameLower = channelName.toLowerCase();
    if (nameLower.includes('color') || nameLower.includes('colour')) return 'colorwheel';
    if (nameLower.includes('gobo')) return 'gobo_a';
    if (nameLower.includes('animation')) return null; // skip animation wheels
    return null;
  }

  // WheelSlotRotation → gobo rotation
  if (type === 'WheelSlotRotation') {
    const nameLower = channelName.toLowerCase();
    if (nameLower.includes('gobo')) return 'gobo_a_rot';
    return null;
  }

  // Speed, Generic, Maintenance, NoFunction → skip
  if (['Speed', 'Generic', 'Maintenance', 'NoFunction', 'Effect',
       'SoundSensitivity', 'StrobeSpeed', 'Time', 'Fog',
       'FogOutput', 'FogType', 'Rotation', 'EffectSpeed',
       'EffectDuration', 'BeamAngle', 'BeamPosition'].includes(type)) {
    return null;
  }

  return null;
}

// ─── Step 3: Process a single fixture file ───
function processFixture(filePath, manufacturerKey) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return null;
  }

  const availableChannels = raw.availableChannels || {};
  const templateChannels = raw.templateChannels || {};

  // Build fine channel → coarse channel lookup
  const fineToCoarse = {};  // "Pan fine" → "Pan"
  for (const [chName, chDef] of Object.entries(availableChannels)) {
    if (chDef.fineChannelAliases) {
      for (const alias of chDef.fineChannelAliases) {
        fineToCoarse[alias] = chName;
      }
    }
  }
  // Also check template channels
  for (const [chName, chDef] of Object.entries(templateChannels)) {
    if (chDef.fineChannelAliases) {
      for (const alias of chDef.fineChannelAliases) {
        fineToCoarse[alias] = chName;
      }
    }
  }

  // Resolve channel definition (handle template channels with $pixelKey)
  function getChannelDef(chName) {
    if (availableChannels[chName]) return availableChannels[chName];
    // Check if it's a resolved template channel (e.g., "Red 1" from template "Red $pixelKey")
    for (const [tmplName, tmplDef] of Object.entries(templateChannels)) {
      const pattern = tmplName.replace(/\$pixelKey/g, '(.+)');
      const re = new RegExp(`^${pattern}$`);
      if (re.test(chName)) return tmplDef;
    }
    return null;
  }

  // Determine category
  const categories = raw.categories || [];
  let category = 'Other';
  for (const cat of categories) {
    if (CATEGORY_MAP[cat]) { category = CATEGORY_MAP[cat]; break; }
  }
  // Default by name hints
  if (category === 'Other') {
    const nameLower = (raw.name || '').toLowerCase();
    if (nameLower.includes('wash') || nameLower.includes('par')) category = 'Wash';
    else if (nameLower.includes('spot') || nameLower.includes('profile')) category = 'Spot';
    else if (nameLower.includes('beam')) category = 'Beam';
  }

  // Process each mode
  const modes = [];
  for (const mode of (raw.modes || [])) {
    const modeChannels = mode.channels || [];
    const channelCount = modeChannels.length;
    const map = {};
    const usedParams = new Set();
    let bladeCount = 0;

    for (let offset = 0; offset < modeChannels.length; offset++) {
      let chName = modeChannels[offset];

      // Skip null channels (spacers in OFL)
      if (chName === null) continue;

      // Handle channel insert blocks (rare, used for matrix fixtures)
      if (typeof chName === 'object') continue;

      // Is this a fine channel? If so, skip it — we'll mark the coarse as 16-bit
      if (fineToCoarse[chName]) continue;

      // Get channel definition
      const chDef = getChannelDef(chName);

      // Identify the Lumina param
      let paramId = identifyParam(chDef, chName);

      // Handle blade channels specially
      if (chDef) {
        const caps = chDef.capability ? [chDef.capability] : (chDef.capabilities || []);
        const hasBladeInsert = caps.some(c => c.type === 'BladeInsertion');
        const hasBladeRot = caps.some(c => c.type === 'BladeRotation');
        if (hasBladeInsert) {
          bladeCount++;
          const bladeLetters = ['a', 'b', 'c', 'd'];
          const idx = Math.min(bladeCount - 1, 3);
          paramId = `blade_${bladeLetters[idx]}`;
        } else if (hasBladeRot && !caps.some(c => c.type === 'BladeSystemRotation')) {
          // Individual blade rotation
          const bladeLetters = ['a', 'b', 'c', 'd'];
          const idx = Math.min(bladeCount - 1, 3);
          paramId = `blade_${bladeLetters[idx]}_rot`;
        }
      }

      if (!paramId) continue;

      // Avoid duplicate params (e.g., two gobo wheels → gobo_a, gobo_b)
      let finalParam = paramId;
      if (usedParams.has(paramId)) {
        // Try _b suffix
        const altParam = paramId.replace(/_a$/, '_b').replace(/_a_/, '_b_');
        if (altParam !== paramId && !usedParams.has(altParam)) {
          finalParam = altParam;
        } else {
          // Skip duplicate
          continue;
        }
      }
      usedParams.add(finalParam);

      // Check if this channel has a fine alias that's also in this mode
      let bits = 8;
      if (chDef && chDef.fineChannelAliases) {
        for (const alias of chDef.fineChannelAliases) {
          if (modeChannels.includes(alias)) {
            bits = 16;
            break;
          }
        }
      }

      map[finalParam] = { offset, bits };
    }

    // Only include modes that have at least one mappable parameter
    if (Object.keys(map).length > 0) {
      modes.push({
        name: mode.name || `${channelCount}ch`,
        channels: channelCount,
        map
      });
    }
  }

  if (modes.length === 0) return null;

  return {
    manufacturer: manufacturerKey,
    name: raw.name || path.basename(filePath, '.json'),
    shortName: raw.shortName || undefined,
    category,
    modes
  };
}

// ─── Step 4: Build the full library ───
function buildLibrary() {
  const manufacturers = {};
  const fixtures = [];

  // Read manufacturer directories
  const mfrDirs = fs.readdirSync(FIXTURES_DIR).filter(d => {
    return fs.statSync(path.join(FIXTURES_DIR, d)).isDirectory();
  }).sort();

  console.log(`Found ${mfrDirs.length} manufacturers`);

  let totalFixtures = 0;
  let skippedFixtures = 0;

  for (const mfrKey of mfrDirs) {
    const mfrDir = path.join(FIXTURES_DIR, mfrKey);
    const fixtureFiles = fs.readdirSync(mfrDir).filter(f => f.endsWith('.json'));

    if (fixtureFiles.length === 0) continue;

    // Pretty-print manufacturer name from key
    const mfrName = mfrKey
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    let mfrFixtureCount = 0;

    for (const file of fixtureFiles) {
      totalFixtures++;
      const filePath = path.join(mfrDir, file);
      const fixture = processFixture(filePath, mfrKey);

      if (fixture) {
        fixtures.push(fixture);
        mfrFixtureCount++;
      } else {
        skippedFixtures++;
      }
    }

    if (mfrFixtureCount > 0) {
      manufacturers[mfrKey] = { name: mfrName };
    }
  }

  // Sort fixtures by manufacturer, then name
  fixtures.sort((a, b) => {
    if (a.manufacturer !== b.manufacturer) return a.manufacturer.localeCompare(b.manufacturer);
    return a.name.localeCompare(b.name);
  });

  console.log(`\nProcessed ${totalFixtures} fixture files`);
  console.log(`  Converted: ${fixtures.length}`);
  console.log(`  Skipped:   ${skippedFixtures} (no mappable channels)`);
  console.log(`  Manufacturers: ${Object.keys(manufacturers).length}`);

  return { manufacturers, fixtures };
}

// ─── Main ───
async function main() {
  console.log('=== Lumina FX Fixture Library Builder ===\n');

  // Step 1: Get OFL data
  cloneOFL();

  // Step 2: Build library
  console.log('\nParsing fixtures...\n');
  const library = buildLibrary();

  // Step 3: Write output
  const json = JSON.stringify(library, null, 2);
  fs.writeFileSync(OUTPUT_FILE, json);

  const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(`\nWritten ${OUTPUT_FILE}`);
  console.log(`File size: ${sizeMB} MB`);

  // Print some stats
  const paramCounts = {};
  for (const fx of library.fixtures) {
    for (const mode of fx.modes) {
      for (const param of Object.keys(mode.map)) {
        paramCounts[param] = (paramCounts[param] || 0) + 1;
      }
    }
  }
  console.log('\nParam usage across all fixture modes:');
  const sorted = Object.entries(paramCounts).sort((a, b) => b[1] - a[1]);
  for (const [param, count] of sorted) {
    console.log(`  ${param}: ${count}`);
  }

  // Cleanup temp dir
  console.log('\nCleaning up temp directory...');
  const tempDir = path.join(__dirname, '_ofl_temp');
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
