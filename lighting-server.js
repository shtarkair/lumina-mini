const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');
const WebSocket = require('ws');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const PORT = 3457;
const ARTNET_PORT = 6454;
const SACN_PORT = 5568;
const MAX_UNIVERSES = 64;
const filePath = path.join(__dirname, 'lighting-app.html');

// --- Software Update ---
const UPDATE_FILES = [
  'lighting-app.html',
  'lighting-server.js',
  'fixture-library.json',
  'package.json',
  'package-lock.json'
];

// --- Gather local IP addresses (for feedback loop prevention) ---
const localAddresses = new Set(['127.0.0.1', '::1', '0.0.0.0']);
for (const ifaces of Object.values(os.networkInterfaces())) {
  for (const iface of ifaces) localAddresses.add(iface.address);
}

// --- DMX Buffers ---
// inputBuffer: latest DMX from console (ArtNet IN)
// clientBuffer: sparse overrides from Lumina client (only active cue channels)
// outputBuffer: merged result sent to fixtures
const inputBuffer = [];
const clientOverrides = []; // sparse: clientOverrides[uni] = { ch: val, ch: val, ... }
const outputBuffer = [];
for (let u = 0; u <= MAX_UNIVERSES; u++) {
  inputBuffer[u] = new Uint8Array(512);
  clientOverrides[u] = null; // null = no overrides for this universe
  outputBuffer[u] = new Uint8Array(512);
}
const activeUniverses = new Set();

// --- Per-Universe State (for smart output scheduling) ---
const universeState = [];
for (let u = 0; u <= MAX_UNIVERSES; u++) {
  universeState[u] = {
    lastChanged: 0,   // Date.now() when data last changed
    lastSent: 0,      // Date.now() when last packet was sent
    idle: false,       // true = heartbeat mode (1Hz)
    dirty: false       // true = data changed since last send, needs immediate burst
  };
}
const IDLE_THRESHOLD = 1000;   // ms with no change before entering heartbeat mode
const HEARTBEAT_INTERVAL = 1000; // 1Hz heartbeat for idle universes

// --- Input Configuration ---
let inputConfig = {
  enabled: false,
  sourceIP: null,        // null = accept from any, or specific IP string
  forwardToClient: false // send dmx_input to client for monitoring
};

// --- MVR (My Virtual Rig) Parser ---
function parseMvrMatrix(matrixStr) {
  // MVR matrix format: {1,0,0,0}{0,1,0,0}{0,0,1,0}{x,y,z,1}
  if (!matrixStr) return { x: 0, y: 0, z: 0 };
  const rows = matrixStr.match(/\{([^}]+)\}/g);
  if (!rows || rows.length < 4) return { x: 0, y: 0, z: 0 };
  const vals = rows[3].replace(/[{}]/g, '').split(',').map(Number);
  return { x: vals[0] || 0, y: vals[1] || 0, z: vals[2] || 0 };
}

function mapPositionFrom3D(pos) {
  // pos = { x, y, z } in mm (MVR coords: X=left/right, Y=depth, Z=height)
  const z = pos.z;
  const y = pos.y;
  const absX = Math.abs(pos.x);

  // Side: extreme left/right at any height
  if (absX > 6000) return 'SIDE';
  // Floor: very low
  if (z < 500) return 'FLOOR';
  // High positions (above 3m)
  if (z >= 3000) {
    if (y < -2000) return 'FRONT 1';   // high + far downstage
    if (y < 0) return 'FRONT 2';        // high + somewhat front
    if (y > 4000) return 'BACK';        // high + far upstage
    if (y > 2000) return 'TOP BACK';    // high + mid upstage
    return 'TOP';                        // high + center
  }
  // Mid height
  if (y < 0) return 'FRONT 1';          // mid height, front of house
  if (y > 4000) return 'BACK';          // mid height, far upstage
  return 'CUSTOM';
}

function getXmlTagContent(xml, tag) {
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function getXmlAttr(tag, attr) {
  const re = new RegExp(attr + '\\s*=\\s*"([^"]*)"', 'i');
  const m = tag.match(re);
  return m ? m[1] : '';
}

function parseMvrXml(xmlStr) {
  const fixtures = [];
  const seenUuids = new Set();

  function parseFixtureTag(attrs, inner, layer, group) {
    const name = getXmlAttr(attrs, 'name');
    const uuid = getXmlAttr(attrs, 'uuid') || `mvr-${fixtures.length}`;
    if (seenUuids.has(uuid)) return; // skip duplicates
    seenUuids.add(uuid);

    const gdtfSpec = getXmlTagContent(inner, 'GDTFSpec');
    const gdtfMode = getXmlTagContent(inner, 'GDTFMode');
    const fixtureId = getXmlTagContent(inner, 'FixtureID');
    const customId = getXmlTagContent(inner, 'CustomId') || getXmlTagContent(inner, 'CustomID');

    // Parse address: format "Universe.Address" (1-indexed) or just number
    let universe = 1, address = 1;
    const addrMatch = inner.match(/<Address[^>]*>([^<]+)<\/Address>/i);
    if (addrMatch) {
      const addrStr = addrMatch[1].trim();
      if (addrStr.includes('.')) {
        const parts = addrStr.split('.');
        universe = parseInt(parts[0]) || 1;
        address = parseInt(parts[1]) || 1;
      } else {
        address = parseInt(addrStr) || 1;
      }
    }

    // Parse matrix for position
    const matrixStr = getXmlTagContent(inner, 'Matrix');
    const pos3d = parseMvrMatrix(matrixStr);
    const mappedPosition = mapPositionFrom3D(pos3d);

    // Parse manufacturer/model from GDTFSpec (format: Manufacturer@Model@Version)
    const specParts = gdtfSpec.split('@');
    const manufacturer = (specParts[0] || '').replace(/_/g, ' ');
    const model = (specParts[1] || '').replace(/_/g, ' ');

    fixtures.push({
      name: name || model || 'Fixture',
      uuid,
      gdtfSpec, gdtfMode, manufacturer, model,
      universe, address, fixtureId, customId,
      position: pos3d, mappedPosition,
      layer: layer || '', group: group || ''
    });
  }

  // Recursive: extract fixtures, then recurse into GroupObjects
  function extractFromNode(xml, layer, group) {
    // First, find all GroupObject blocks and their ranges to exclude from top-level fixture search
    const groupBlocks = [];
    const groupRe = /<GroupObject\b([^>]*)>([\s\S]*?)<\/GroupObject>/gi;
    let gm;
    while ((gm = groupRe.exec(xml)) !== null) {
      groupBlocks.push({ start: gm.index, end: gm.index + gm[0].length, attrs: gm[1], inner: gm[2] });
    }

    // Find fixtures NOT inside a GroupObject (top-level in this node)
    const fixtureRe = /<Fixture\b([^>]*)>([\s\S]*?)<\/Fixture>/gi;
    let fm;
    while ((fm = fixtureRe.exec(xml)) !== null) {
      // Check if this fixture is inside a GroupObject
      const pos = fm.index;
      const insideGroup = groupBlocks.some(g => pos > g.start && pos < g.end);
      if (!insideGroup) {
        parseFixtureTag(fm[1], fm[2], layer, group);
      }
    }

    // Recurse into GroupObjects
    for (const g of groupBlocks) {
      const gName = getXmlAttr(g.attrs, 'name');
      extractFromNode(g.inner, layer, gName || group);
    }
  }

  // Find all layers
  const layerRe = /<Layer\b([^>]*)>([\s\S]*?)<\/Layer>/gi;
  let lm;
  while ((lm = layerRe.exec(xmlStr)) !== null) {
    const layerName = getXmlAttr(lm[1], 'name');
    extractFromNode(lm[2], layerName, '');
  }

  // If no layers found, try parsing from root
  if (fixtures.length === 0) {
    extractFromNode(xmlStr, '', '');
  }

  return fixtures;
}

// --- Network Interface Discovery ---
function getNetworkInterfaces() {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({
          name,
          ip: addr.address,
          netmask: addr.netmask,
          mac: addr.mac,
          // Calculate broadcast address from IP + netmask
          broadcast: addr.address.split('.').map((octet, i) =>
            (parseInt(octet) | (~parseInt(addr.netmask.split('.')[i]) & 255)).toString()
          ).join('.')
        });
      }
    }
  }
  return result;
}

// --- Network binding config ---
let networkConfig = {
  inputIP: '0.0.0.0',    // NIC IP to receive ArtNet on (0.0.0.0 = all)
  outputIP: '0.0.0.0',   // NIC IP to send ArtNet from (0.0.0.0 = default)
  outputBroadcast: '255.255.255.255' // broadcast address for output NIC
};

// --- Per-client protocol config ---
let clientConfig = { artnet: true, sacn: false, artnetHost: '255.255.255.255', dmxMode: 'insert' };

// --- Per-universe routing config (sparse: only custom-routed universes listed) ---
// Format: { "1": { artnet: { ip, universe }, sacn: { universe } }, ... }
// Missing entries use global defaults (artnetHost, uni-1 for ArtNet, uni for sACN)
let universeRoutingConfig = {};

// --- Output loop config ---
let outputRate = 25; // ms between frames (40Hz)
let outputInterval = null;
let outputEnabled = false;

// --- Monitor config ---
let monitorEnabled = false;
let monitorTick = 0;
const MONITOR_EVERY = 4; // send monitor data every N merge ticks (~10Hz at 40Hz output)

// --- HTTP Server ---
const fixtureLibraryPath = path.join(__dirname, 'fixture-library.json');

// Shows folder on Desktop
const SHOWS_DIR = path.join(os.homedir(), 'Desktop', 'Lumina Shows');
if (!fs.existsSync(SHOWS_DIR)) {
  fs.mkdirSync(SHOWS_DIR, { recursive: true });
  console.log('[SHOWS] Created folder:', SHOWS_DIR);
}

// Helper to read full request body
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // --- Save show to Desktop/Lumina Shows/<name> — <date>/ ---
  if (req.url === '/api/save-show' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const name = (data.showName || 'my-show').replace(/[^a-zA-Z0-9_\- ]/g, '_');
      const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const folderName = name + ' — ' + dateStr;
      const folderPath = path.join(SHOWS_DIR, folderName);
      if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
      const filename = name + '.lumina';
      const filepath = path.join(folderPath, filename);
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
      // Save sequences and MIDI map as separate files in the sub-folder
      if (data.sequenceStorage) {
        fs.writeFileSync(path.join(folderPath, 'sequences.json'), JSON.stringify(data.sequenceStorage, null, 2));
      }
      if (data.midiMap && Object.keys(data.midiMap).length > 0) {
        fs.writeFileSync(path.join(folderPath, 'midi-map.json'), JSON.stringify(data.midiMap, null, 2));
      }
      console.log('[SHOWS] Saved:', filepath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, folder: folderName, filename, path: filepath }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // --- List shows from Desktop/Lumina Shows/ (scan sub-folders) ---
  if (req.url === '/api/list-shows' && req.method === 'GET') {
    try {
      const shows = [];
      const entries = fs.readdirSync(SHOWS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Scan sub-folder for .lumina files
          const subPath = path.join(SHOWS_DIR, entry.name);
          const subFiles = fs.readdirSync(subPath).filter(f => f.endsWith('.lumina'));
          for (const f of subFiles) {
            const fp = path.join(subPath, f);
            const stat = fs.statSync(fp);
            let showName = f.replace('.lumina', '');
            try {
              const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
              if (raw.showName) showName = raw.showName;
            } catch(e) {}
            shows.push({ folder: entry.name, filename: f, showName, size: stat.size, modified: stat.mtime.toISOString() });
          }
        } else if (entry.name.endsWith('.lumina')) {
          // Legacy: .lumina file at root level
          const fp = path.join(SHOWS_DIR, entry.name);
          const stat = fs.statSync(fp);
          let showName = entry.name.replace('.lumina', '');
          try {
            const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
            if (raw.showName) showName = raw.showName;
          } catch(e) {}
          shows.push({ folder: null, filename: entry.name, showName, size: stat.size, modified: stat.mtime.toISOString() });
        }
      }
      shows.sort((a, b) => new Date(b.modified) - new Date(a.modified));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shows, dir: SHOWS_DIR }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shows: [], dir: SHOWS_DIR }));
    }
    return;
  }

  // --- Load a specific show (supports folder/filename or legacy root filename) ---
  if (req.url.startsWith('/api/load-show/') && req.method === 'GET') {
    const rawPath = decodeURIComponent(req.url.replace('/api/load-show/', ''));
    // rawPath can be "folder/filename.lumina" or just "filename.lumina" (legacy)
    const filepath = path.join(SHOWS_DIR, rawPath);
    try {
      if (!fs.existsSync(filepath)) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'File not found' })); return; }
      const data = fs.readFileSync(filepath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // --- MVR Import ---
  if (req.url === '/api/parse-mvr' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();

        // Find GeneralSceneDescription.xml
        const xmlEntry = entries.find(e =>
          e.entryName === 'GeneralSceneDescription.xml' ||
          e.entryName.endsWith('/GeneralSceneDescription.xml')
        );
        if (!xmlEntry) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No GeneralSceneDescription.xml found in MVR file' }));
          return;
        }

        const xmlStr = xmlEntry.getData().toString('utf8');
        const fixtures = parseMvrXml(xmlStr);

        // List GDTF files present
        const gdtfFiles = entries
          .filter(e => e.entryName.toLowerCase().endsWith('.gdtf'))
          .map(e => e.entryName);

        console.log(`[MVR] Parsed ${fixtures.length} fixture(s), ${gdtfFiles.length} GDTF file(s)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, fixtures, gdtfFiles }));
      } catch (e) {
        console.error('[MVR] Parse error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Failed to parse MVR: ' + e.message }));
      }
    });
    return;
  }

  // --- Software Update: check GitHub for new commits ---
  if (req.url === '/api/update-check' && req.method === 'GET') {
    try {
      // Fetch latest from GitHub
      execSync('git fetch origin', { cwd: __dirname, timeout: 15000, stdio: 'pipe' });

      // Get local and remote commit info
      const localCommit = execSync('git rev-parse HEAD', { cwd: __dirname, stdio: 'pipe' }).toString().trim();
      const remoteCommit = execSync('git rev-parse origin/master', { cwd: __dirname, stdio: 'pipe' }).toString().trim();
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname, stdio: 'pipe' }).toString().trim();

      // Count commits behind
      const behindStr = execSync('git rev-list --count HEAD..origin/master', { cwd: __dirname, stdio: 'pipe' }).toString().trim();
      const behind = parseInt(behindStr) || 0;

      // Get list of changed files (only tracked files between HEAD and origin/master)
      let changedFiles = [];
      let commitMessages = [];
      if (behind > 0) {
        const diffOutput = execSync('git diff --name-only HEAD..origin/master', { cwd: __dirname, stdio: 'pipe' }).toString().trim();
        changedFiles = diffOutput ? diffOutput.split('\n').filter(f => f.trim()) : [];
        const logOutput = execSync('git log --oneline HEAD..origin/master', { cwd: __dirname, stdio: 'pipe' }).toString().trim();
        commitMessages = logOutput ? logOutput.split('\n').filter(l => l.trim()) : [];
      }

      // Get file sizes for display
      const fileDetails = {};
      for (const fname of changedFiles) {
        const fpath = path.join(__dirname, fname);
        const localSize = fs.existsSync(fpath) ? fs.statSync(fpath).size : 0;
        // Get remote file size from git
        let remoteSize = 0;
        try {
          const blob = execSync(`git cat-file -s origin/master:${fname}`, { cwd: __dirname, stdio: 'pipe' }).toString().trim();
          remoteSize = parseInt(blob) || 0;
        } catch(e) { /* new file, no local version */ }
        fileDetails[fname] = { localSize, remoteSize };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        branch,
        localCommit: localCommit.substring(0, 7),
        remoteCommit: remoteCommit.substring(0, 7),
        behind,
        changedFiles,
        fileDetails,
        commitMessages
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Git fetch failed: ' + e.message }));
    }
    return;
  }

  // --- Software Update: pull from GitHub + restart ---
  if (req.url === '/api/apply-update' && req.method === 'POST') {
    try {
      // 1. Create backup of core files before pulling
      const backupDir = path.join(__dirname, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(backupDir, { recursive: true });
      for (const fname of UPDATE_FILES) {
        const src = path.join(__dirname, fname);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(backupDir, fname));
        }
      }
      console.log('[UPDATE] Backup created:', backupDir);

      // 2. Check if package.json will change
      let packageWillChange = false;
      try {
        const diff = execSync('git diff --name-only HEAD..origin/master', { cwd: __dirname, stdio: 'pipe' }).toString();
        packageWillChange = diff.includes('package.json');
      } catch(e) {}

      // 3. Git pull from origin
      const pullOutput = execSync('git pull origin master', { cwd: __dirname, timeout: 30000, stdio: 'pipe' }).toString().trim();
      console.log('[UPDATE] Git pull:', pullOutput);

      // 4. npm install if package.json changed
      if (packageWillChange) {
        try {
          console.log('[UPDATE] Running npm install...');
          execSync('npm install', { cwd: __dirname, timeout: 30000, stdio: 'pipe' });
          console.log('[UPDATE] npm install complete');
        } catch (e) {
          console.error('[UPDATE] npm install failed:', e.message);
        }
      }

      // 5. Send success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pullOutput, backup: backupDir }));

      // 6. Broadcast restart warning then restart
      setTimeout(() => {
        broadcastToClients({ type: 'server_restarting' });

        // Write a tiny helper script that waits for port to free, then starts new server
        const helperPath = path.join(__dirname, '.restart-helper.js');
        const helperCode = `
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

function waitForPortFree(port, cb) {
  const s = net.createServer();
  s.once('error', () => setTimeout(() => waitForPortFree(port, cb), 500));
  s.once('listening', () => { s.close(() => cb()); });
  s.listen(port);
}

setTimeout(() => {
  waitForPortFree(${PORT}, () => {
    const nodePath = process.argv[0] || 'node';
    const serverPath = path.join(__dirname, 'lighting-server.js');
    const child = spawn(nodePath, [serverPath], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });
    child.unref();
    console.log('[RESTART HELPER] New server spawned, PID:', child.pid);
    process.exit(0);
  });
}, 1000);
`;
        fs.writeFileSync(helperPath, helperCode);

        const child = spawn(process.argv[0], [helperPath], {
          cwd: __dirname,
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        console.log('[UPDATE] Restart helper spawned, exiting...');

        setTimeout(() => process.exit(0), 500);
      }, 300);

    } catch (e) {
      console.error('[UPDATE] Apply error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Serve fixture library JSON
  if (req.url === '/fixture-library.json') {
    fs.readFile(fixtureLibraryPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Fixture library not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(data);
    });
    return;
  }
  // Default: serve the app
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Error loading file');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// --- UDP Output Sockets ---
let artnetSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let outputSocketPort = null;
artnetSocket.bind(() => {
  artnetSocket.setBroadcast(true);
  outputSocketPort = artnetSocket.address().port;
});

let sacnSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sacnSocket.bind(() => {
  try { sacnSocket.setBroadcast(true); } catch(e) {}
});

// Rebind output socket to a specific NIC IP
function rebindOutputSocket(ip) {
  try { artnetSocket.close(); } catch(e) {}
  artnetSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const bindAddr = (ip && ip !== '0.0.0.0') ? ip : undefined;
  artnetSocket.bind({ address: bindAddr }, () => {
    artnetSocket.setBroadcast(true);
    outputSocketPort = artnetSocket.address().port;
    console.log(`[OUTPUT SOCKET] Bound to ${artnetSocket.address().address}:${outputSocketPort}`);
  });
}

// --- ArtNet Packet Builder ---
let artnetSequence = 0;
function buildArtNetPacket(universe, dmxData) {
  const buf = Buffer.alloc(18 + 512);
  buf.write('Art-Net\0', 0, 8, 'ascii');
  buf.writeUInt16LE(0x5000, 8);
  buf.writeUInt16BE(14, 10);
  buf[12] = artnetSequence & 0xFF;
  artnetSequence = (artnetSequence + 1) & 0xFF;
  buf[13] = 0;
  buf.writeUInt16LE(Math.max(0, universe), 14); // caller provides 0-indexed ArtNet universe
  buf.writeUInt16BE(512, 16);
  for (let i = 0; i < 512; i++) buf[18 + i] = dmxData[i] || 0;
  return buf;
}

// --- sACN / E1.31 Packet Builder ---
let sacnSequence = 0;
const SACN_CID = Buffer.from([
  0x4c, 0x55, 0x4d, 0x49, 0x4e, 0x41, 0x2d, 0x46,
  0x58, 0x2d, 0x30, 0x30, 0x30, 0x31, 0x00, 0x00
]);

function buildSACNPacket(universe, dmxData) {
  const dmxLen = 512;
  const buf = Buffer.alloc(126 + dmxLen);
  buf.writeUInt16BE(0x0010, 0);
  buf.writeUInt16BE(0x0000, 2);
  buf.write('ASC-E1.17\0\0\0', 4, 12, 'ascii');
  buf.writeUInt16BE(0x7000 | (buf.length - 16), 16);
  buf.writeUInt32BE(0x00000004, 18);
  SACN_CID.copy(buf, 22);
  buf.writeUInt16BE(0x7000 | (buf.length - 38), 38);
  buf.writeUInt32BE(0x00000002, 40);
  buf.write('LUMINA FX', 44, 64, 'utf8');
  buf[108] = 100;
  buf.writeUInt16BE(0, 109);
  buf[111] = sacnSequence & 0xFF;
  sacnSequence = (sacnSequence + 1) & 0xFF;
  buf[112] = 0;
  buf.writeUInt16BE(universe, 113);
  buf.writeUInt16BE(0x7000 | (dmxLen + 11), 115);
  buf[117] = 0x02;
  buf[118] = 0xA1;
  buf.writeUInt16BE(0x0000, 119);
  buf.writeUInt16BE(0x0001, 121);
  buf.writeUInt16BE(dmxLen + 1, 123);
  buf[125] = 0x00;
  for (let i = 0; i < dmxLen; i++) buf[126 + i] = dmxData[i] || 0;
  return buf;
}

// --- ArtPoll / ArtPollReply ---
const OP_POLL       = 0x2000;
const OP_POLL_REPLY = 0x2100;

function buildArtPoll() {
  const buf = Buffer.alloc(14);
  buf.write('Art-Net\0', 0, 8, 'ascii');
  buf.writeUInt16LE(OP_POLL, 8);
  buf[10] = 0x00; buf[11] = 0x0E; // protocol version 14
  buf[12] = 0x00; // TalkToMe: no diagnostics
  buf[13] = 0x00; // Priority
  return buf;
}

function parseArtPollReply(buf) {
  if (buf.length < 207) return null;
  try {
    const ip = `${buf[10]}.${buf[11]}.${buf[12]}.${buf[13]}`;
    const port = buf.readUInt16LE(14);
    const versionH = buf[16]; const versionL = buf[17];
    const netSwitch = buf[18];
    const subSwitch = buf[19];
    const shortName = buf.toString('ascii', 26, 44).replace(/\0+$/, '');
    const longName = buf.toString('ascii', 44, 108).replace(/\0+$/, '');
    const numPorts = buf.readUInt16BE(172);
    // Port types at 174-177, goodInput at 178-181, goodOutput at 182-185
    // SwOut (universe per port) at 190-193
    const universes = [];
    for (let p = 0; p < Math.min(numPorts, 4); p++) {
      const portType = buf[174 + p];
      const isOutput = (portType & 0x80) !== 0; // can output DMX
      if (isOutput) {
        const swOut = buf[190 + p];
        const uni = (netSwitch << 8) | (subSwitch << 4) | swOut;
        universes.push(uni + 1); // convert to 1-indexed
      }
    }
    return { ip, port, shortName, longName, numPorts, universes, version: `${versionH}.${versionL}` };
  } catch(e) { return null; }
}

// --- RDM over ArtNet ---
// ArtNet RDM opcodes (little-endian in packet)
const OP_TOD_REQUEST = 0x8000;
const OP_TOD_DATA    = 0x8100;
const OP_TOD_CONTROL = 0x8200;
const OP_RDM         = 0x8300;

// RDM command classes
const CC_GET_COMMAND = 0x20;
const CC_GET_COMMAND_RESPONSE = 0x21;

// RDM PIDs
const PID_DEVICE_INFO                = 0x0060;
const PID_DEVICE_MODEL_DESCRIPTION   = 0x0080;
const PID_MANUFACTURER_LABEL         = 0x0081;
const PID_DEVICE_LABEL               = 0x0082;
const PID_DMX_PERSONALITY            = 0x00E0;
const PID_DMX_PERSONALITY_DESCRIPTION = 0x00E1;
const PID_DMX_START_ADDRESS          = 0x00F0;

// Controller UID (Lumina FX — manufacturer 0x7FFF + device 0x00000001)
const LUMINA_UID = Buffer.from([0x7F, 0xFF, 0x00, 0x00, 0x00, 0x01]);

let rdmDiscovering = false;
let rdmTransactionNum = 0;
let rdmPendingResolve = null;
let rdmPendingTimeout = null;
let rdmArtPollNodes = [];  // ArtPollReply nodes found during discovery

// Build ArtTodRequest — request Table of Devices for a universe
function buildArtTodRequest(universe) {
  // universe is 1-indexed (Lumina), ArtNet uses 0-indexed
  const artUni = universe - 1;
  const net = (artUni >> 8) & 0x7F;
  const subUni = artUni & 0xFF;
  const buf = Buffer.alloc(25);
  buf.write('Art-Net\0', 0, 8, 'ascii');
  buf.writeUInt16LE(OP_TOD_REQUEST, 8);
  buf[10] = 0x00; buf[11] = 0x0E; // protocol version 14
  // bytes 12-20: filler/spare (zeros)
  buf[21] = net;
  buf[22] = 0x00; // Command: TodFull
  buf[23] = 1;    // AdCount: 1 address
  buf[24] = subUni;
  return buf;
}

// Build ArtTodControl — flush and force full re-discovery
function buildArtTodControl(universe) {
  const artUni = universe - 1;
  const net = (artUni >> 8) & 0x7F;
  const subUni = artUni & 0xFF;
  const buf = Buffer.alloc(24);
  buf.write('Art-Net\0', 0, 8, 'ascii');
  buf.writeUInt16LE(OP_TOD_CONTROL, 8);
  buf[10] = 0x00; buf[11] = 0x0E;
  buf[21] = net;
  buf[22] = 0x01; // Command: AtcFlush
  buf[23] = subUni;
  return buf;
}

// Build an RDM GET message (without DMX start code 0xCC)
function buildRdmGetMessage(destUID, transNum, pid, paramData) {
  const pdl = paramData ? paramData.length : 0;
  const msgLen = 24 + pdl; // SubStartCode through Checksum (inclusive)
  const buf = Buffer.alloc(msgLen);
  buf[0] = 0x01;    // SubStartCode (RDM)
  buf[1] = msgLen;  // MessageLength
  destUID.copy(buf, 2);    // Destination UID (6 bytes)
  LUMINA_UID.copy(buf, 8); // Source UID (6 bytes)
  buf[14] = transNum & 0xFF; // TransactionNumber
  buf[15] = 0x01;  // PortID
  buf[16] = 0x00;  // MessageCount
  buf.writeUInt16BE(0x0000, 17); // SubDevice (root)
  buf[19] = CC_GET_COMMAND;
  buf.writeUInt16BE(pid, 20);
  buf[22] = pdl;
  if (paramData && pdl > 0) paramData.copy(buf, 23);
  // Checksum: sum of all bytes from offset 0 to msgLen-3
  let checksum = 0;
  for (let i = 0; i < msgLen - 2; i++) checksum += buf[i];
  buf.writeUInt16BE(checksum & 0xFFFF, msgLen - 2);
  return buf;
}

// Wrap an RDM message inside an ArtRdm packet
function buildArtRdm(universe, rdmMessage) {
  const artUni = universe - 1;
  const net = (artUni >> 8) & 0x7F;
  const subUni = artUni & 0xFF;
  const headerLen = 24;
  const buf = Buffer.alloc(headerLen + rdmMessage.length);
  buf.write('Art-Net\0', 0, 8, 'ascii');
  buf.writeUInt16LE(OP_RDM, 8);
  buf[10] = 0x00; buf[11] = 0x0E;
  buf[12] = 0x01; // RdmVer: Standard V1.0
  // bytes 13-20: filler/spare
  buf[21] = 0x00; // Command: ArProcess
  buf[22] = subUni;
  buf[23] = net;
  rdmMessage.copy(buf, 24);
  return buf;
}

// Parse ArtTodData — extract RDM UIDs
function parseArtTodData(buf) {
  if (buf.length < 28) return null;
  if (buf.toString('ascii', 0, 7) !== 'Art-Net') return null;
  const opCode = buf.readUInt16LE(8);
  if (opCode !== OP_TOD_DATA) return null;
  const net = buf[21];
  const subUni = buf[23];
  const universe = ((net << 8) | subUni) + 1; // back to 1-indexed
  const uidTotal = (buf[24] << 8) | buf[25];
  const blockCount = buf[26];
  const uidCount = buf[27];
  const uids = [];
  for (let i = 0; i < uidCount; i++) {
    const offset = 28 + (i * 6);
    if (offset + 6 > buf.length) break;
    const uid = Buffer.from(buf.slice(offset, offset + 6));
    const mfr = uid.readUInt16BE(0);
    const dev = uid.readUInt32BE(2);
    uids.push({
      raw: uid,
      manufacturer: mfr,
      device: dev,
      text: mfr.toString(16).toUpperCase().padStart(4, '0') + ':' + dev.toString(16).toUpperCase().padStart(8, '0')
    });
  }
  return { universe, uidTotal, blockCount, uidCount, uids };
}

// Parse ArtRdm response — extract RDM parameter data
function parseArtRdmResponse(buf) {
  if (buf.length < 25) return null;
  if (buf.toString('ascii', 0, 7) !== 'Art-Net') return null;
  const opCode = buf.readUInt16LE(8);
  if (opCode !== OP_RDM) return null;
  // RDM data starts at offset 24
  const rdm = buf.slice(24);
  if (rdm.length < 23) return null;
  if (rdm[0] !== 0x01) return null; // SubStartCode
  const sourceUID = rdm.slice(8, 14);
  const commandClass = rdm[19];
  const pid = rdm.readUInt16BE(20);
  const pdl = rdm[22];
  const paramData = pdl > 0 && rdm.length >= 23 + pdl ? rdm.slice(23, 23 + pdl) : null;
  return { commandClass, pid, pdl, paramData, sourceUID };
}

// Parse DEVICE_INFO response (19 bytes)
function parseDeviceInfo(pd) {
  if (!pd || pd.length < 19) return null;
  return {
    deviceModel: pd.readUInt16BE(2),
    productCategory: pd.readUInt16BE(4),
    softwareVersion: pd.readUInt32BE(6),
    dmxFootprint: pd.readUInt16BE(10),
    currentPersonality: pd[12],
    personalityCount: pd[13],
    dmxStartAddress: pd.readUInt16BE(14),
    subDeviceCount: pd.readUInt16BE(16),
    sensorCount: pd[18]
  };
}

// Parse DMX_PERSONALITY_DESCRIPTION response
function parsePersonalityDesc(pd) {
  if (!pd || pd.length < 3) return null;
  return {
    personality: pd[0],
    dmxSlots: pd.readUInt16BE(1),
    description: pd.slice(3).toString('ascii').replace(/\0+$/, '').trim()
  };
}

// Send-and-wait helper: send a UDP packet and wait for a matching response
function rdmSendAndWait(packet, destIP, timeoutMs) {
  return new Promise((resolve) => {
    if (rdmPendingTimeout) clearTimeout(rdmPendingTimeout);
    rdmPendingResolve = resolve;
    artnetSocket.send(packet, 0, packet.length, ARTNET_PORT, destIP);
    rdmPendingTimeout = setTimeout(() => {
      rdmPendingResolve = null;
      resolve(null); // timeout — no response
    }, timeoutMs);
  });
}

// Handle incoming RDM packets (called from onArtNetInput or dedicated listener)
function handleRdmPacket(buf, rinfo) {
  if (buf.length < 12) return;
  if (buf.toString('ascii', 0, 7) !== 'Art-Net') return;
  const opCode = buf.readUInt16LE(8);

  if (opCode === OP_TOD_DATA) {
    const tod = parseArtTodData(buf);
    if (tod && rdmPendingResolve) {
      const resolve = rdmPendingResolve;
      rdmPendingResolve = null;
      if (rdmPendingTimeout) clearTimeout(rdmPendingTimeout);
      resolve({ type: 'tod', data: tod, ip: rinfo.address });
    }
  } else if (opCode === OP_RDM) {
    const rdmResp = parseArtRdmResponse(buf);
    if (rdmResp && rdmResp.commandClass === CC_GET_COMMAND_RESPONSE && rdmPendingResolve) {
      const resolve = rdmPendingResolve;
      rdmPendingResolve = null;
      if (rdmPendingTimeout) clearTimeout(rdmPendingTimeout);
      resolve({ type: 'rdm', data: rdmResp, ip: rinfo.address });
    }
  }
}

// Query a single RDM PID from a device
async function rdmGetPID(universe, destUID, gatewayIP, pid, paramData) {
  rdmTransactionNum = (rdmTransactionNum + 1) & 0xFF;
  const rdmMsg = buildRdmGetMessage(destUID, rdmTransactionNum, pid, paramData || null);
  const artRdm = buildArtRdm(universe, rdmMsg);
  const resp = await rdmSendAndWait(artRdm, gatewayIP, 500);
  if (resp && resp.type === 'rdm' && resp.data.pid === pid) return resp.data.paramData;
  // Retry once
  rdmTransactionNum = (rdmTransactionNum + 1) & 0xFF;
  const rdmMsg2 = buildRdmGetMessage(destUID, rdmTransactionNum, pid, paramData || null);
  const artRdm2 = buildArtRdm(universe, rdmMsg2);
  const resp2 = await rdmSendAndWait(artRdm2, gatewayIP, 500);
  if (resp2 && resp2.type === 'rdm' && resp2.data.pid === pid) return resp2.data.paramData;
  return null;
}

// Full RDM discovery across specified universes
async function rdmDiscover(universes) {
  if (rdmDiscovering) return [];
  rdmDiscovering = true;
  rdmArtPollNodes = []; // reset discovered nodes
  console.log('[RDM] Starting discovery on universes:', universes);

  // Ensure input socket is active to receive RDM responses
  startInputSocket();

  const allDevices = [];
  // RDM discovery MUST broadcast — don't use artnetHost which may be unicast/localhost
  // Use the broadcast address for the output NIC, or global broadcast as fallback
  let destIP = '255.255.255.255';
  const nics = getNetworkInterfaces();
  if (networkConfig.outputIP && networkConfig.outputIP !== '0.0.0.0') {
    // Use broadcast for the configured output NIC
    const outNic = nics.find(n => n.ip === networkConfig.outputIP);
    if (outNic && outNic.broadcast) destIP = outNic.broadcast;
  } else {
    // No specific output NIC — try to find the 2.x.x.x NIC broadcast
    const ethNic = nics.find(n => n.ip.startsWith('2.'));
    if (ethNic && ethNic.broadcast) destIP = ethNic.broadcast;
  }
  console.log('[RDM] Broadcasting discovery to:', destIP, '(artnetHost:', clientConfig.artnetHost, ')');

  // Phase 0: Send ArtPoll to discover all ArtNet nodes on the network
  broadcastToClients({ type: 'rdm_progress', universe: 0, phase: 'polling', found: 0, total: universes.length });
  const pollPkt = buildArtPoll();
  artnetSocket.send(pollPkt, 0, pollPkt.length, ARTNET_PORT, destIP);
  await new Promise(r => setTimeout(r, 1500)); // wait for ArtPollReply responses
  console.log(`[RDM] ArtPoll: found ${rdmArtPollNodes.length} node(s) on network`);
  rdmArtPollNodes.forEach(n => console.log(`[RDM]   Node: ${n.ip} "${n.shortName}" "${n.longName}" ports=${n.numPorts} uni=[${n.universes}]`));

  for (const uni of universes) {
    broadcastToClients({ type: 'rdm_progress', universe: uni, phase: 'discovering', found: 0, total: universes.length });

    // Step 1: Send ArtTodControl to flush and force re-discovery
    const flushPkt = buildArtTodControl(uni);
    artnetSocket.send(flushPkt, 0, flushPkt.length, ARTNET_PORT, destIP);
    await new Promise(r => setTimeout(r, 200)); // brief pause for gateways to start discovery

    // Step 2: Send ArtTodRequest and collect UIDs
    const todPkt = buildArtTodRequest(uni);
    const todResp = await rdmSendAndWait(todPkt, destIP, 3000);

    if (!todResp || todResp.type !== 'tod' || !todResp.data.uids.length) {
      console.log(`[RDM] Universe ${uni}: no devices found`);
      continue;
    }

    const { uids } = todResp.data;
    const gatewayIP = todResp.ip; // remember which gateway responded
    console.log(`[RDM] Universe ${uni}: found ${uids.length} device(s) via ${gatewayIP}`);

    // Step 3: Query each device for details
    for (let i = 0; i < uids.length; i++) {
      const uid = uids[i];
      broadcastToClients({ type: 'rdm_progress', universe: uni, phase: 'querying', found: i + 1, total: uids.length, uid: uid.text });

      const device = {
        uid: uid.text,
        universe: uni,
        manufacturer: '',
        model: '',
        label: '',
        dmxAddress: 0,
        dmxFootprint: 0,
        personality: 0,
        personalityCount: 0,
        personalityName: '',
        productCategory: 0,
        gatewayIP
      };

      // GET DEVICE_INFO
      const diPD = await rdmGetPID(uni, uid.raw, gatewayIP, PID_DEVICE_INFO);
      if (diPD) {
        const info = parseDeviceInfo(diPD);
        if (info) {
          device.dmxAddress = info.dmxStartAddress;
          device.dmxFootprint = info.dmxFootprint;
          device.personality = info.currentPersonality;
          device.personalityCount = info.personalityCount;
          device.productCategory = info.productCategory;
        }
      }

      // GET MANUFACTURER_LABEL
      const mfPD = await rdmGetPID(uni, uid.raw, gatewayIP, PID_MANUFACTURER_LABEL);
      if (mfPD) device.manufacturer = mfPD.toString('ascii').replace(/\0+$/, '').trim();

      // GET DEVICE_MODEL_DESCRIPTION
      const mdPD = await rdmGetPID(uni, uid.raw, gatewayIP, PID_DEVICE_MODEL_DESCRIPTION);
      if (mdPD) device.model = mdPD.toString('ascii').replace(/\0+$/, '').trim();

      // GET DEVICE_LABEL
      const dlPD = await rdmGetPID(uni, uid.raw, gatewayIP, PID_DEVICE_LABEL);
      if (dlPD) device.label = dlPD.toString('ascii').replace(/\0+$/, '').trim();

      // GET DMX_PERSONALITY_DESCRIPTION for current personality
      if (device.personality > 0) {
        const pdBuf = Buffer.alloc(1);
        pdBuf[0] = device.personality;
        const ppPD = await rdmGetPID(uni, uid.raw, gatewayIP, PID_DMX_PERSONALITY_DESCRIPTION, pdBuf);
        if (ppPD) {
          const desc = parsePersonalityDesc(ppPD);
          if (desc) device.personalityName = desc.description;
        }
      }

      console.log(`[RDM]   ${uid.text}: ${device.manufacturer} ${device.model} @ ${uni}.${device.dmxAddress} (${device.dmxFootprint}ch)`);
      allDevices.push(device);
    }
  }

  rdmDiscovering = false;
  console.log(`[RDM] Discovery complete: ${allDevices.length} device(s) found, ${rdmArtPollNodes.length} node(s) on network`);
  return { devices: allDevices, nodes: rdmArtPollNodes };
}

// --- ArtNet Input Parser ---
function parseArtNetDMX(buf) {
  if (buf.length < 20) return null;
  if (buf.toString('ascii', 0, 7) !== 'Art-Net') return null;
  const opCode = buf.readUInt16LE(8);
  if (opCode !== 0x5000) return null;
  const universe = buf.readUInt16LE(14) + 1; // 0-indexed → 1-indexed
  if (universe < 1 || universe > MAX_UNIVERSES) return null;
  const dmxLength = buf.readUInt16BE(16);
  if (dmxLength < 2 || dmxLength > 512 || buf.length < 18 + dmxLength) return null;
  return { universe, dmxData: buf.slice(18, 18 + dmxLength), dmxLength };
}

// --- ArtNet Input Socket ---
let artnetInputSocket = null;
let inputSocketBound = false;

// Throttle forwarding to client (max 10Hz per universe)
const forwardTimers = {};
const FORWARD_INTERVAL = 100;

function onArtNetInput(buf, rinfo) {
  // Route RDM / ArtPollReply packets regardless of input config (discovery is independent)
  if (buf.length >= 12 && buf.toString('ascii', 0, 7) === 'Art-Net') {
    const op = buf.readUInt16LE(8);
    if (rdmDiscovering && op !== 0x5000) {
      // During discovery, log non-DMX ArtNet opcodes for debugging
      console.log(`[RDM DEBUG] Received opcode 0x${op.toString(16).padStart(4,'0')} from ${rinfo.address}:${rinfo.port} (${buf.length} bytes)`);
    }
    if (op === OP_TOD_DATA || op === OP_RDM) {
      console.log(`[RDM] Got RDM response (0x${op.toString(16)}) from ${rinfo.address}`);
      handleRdmPacket(buf, rinfo);
      return;
    }
    if (op === OP_POLL_REPLY) {
      // Collect ArtPollReply during discovery
      const nodeInfo = parseArtPollReply(buf);
      if (nodeInfo && rdmDiscovering) {
        // Don't log our own reply
        if (!localAddresses.has(rinfo.address)) {
          console.log(`[RDM] ArtPollReply from ${rinfo.address}: "${nodeInfo.shortName}" / "${nodeInfo.longName}" ports=${nodeInfo.numPorts} uni=[${nodeInfo.universes}]`);
          if (!rdmArtPollNodes.find(n => n.ip === rinfo.address)) {
            rdmArtPollNodes.push({ ...nodeInfo, ip: rinfo.address });
          }
        }
      }
      return;
    }
  }

  if (!inputConfig.enabled) return;

  // Feedback loop prevention: ignore our own packets
  if (localAddresses.has(rinfo.address) && rinfo.port === outputSocketPort) return;

  // Source IP filtering
  if (inputConfig.sourceIP && rinfo.address !== inputConfig.sourceIP) return;

  const parsed = parseArtNetDMX(buf);
  if (!parsed) return;

  const { universe, dmxData, dmxLength } = parsed;

  // Copy into input buffer
  inputBuffer[universe].set(dmxData.slice(0, Math.min(dmxLength, 512)));
  activeUniverses.add(universe);
  markUniverseDirty(universe);

  // Throttled forwarding to client for monitoring
  if (inputConfig.forwardToClient && !forwardTimers[universe]) {
    forwardTimers[universe] = true;
    setTimeout(() => { forwardTimers[universe] = false; }, FORWARD_INTERVAL);
    broadcastToClients({
      type: 'dmx_input',
      universe,
      data: Array.from(inputBuffer[universe])
    });
  }
}

function startInputSocket() {
  if (inputSocketBound) return;
  artnetInputSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  artnetInputSocket.on('message', onArtNetInput);
  artnetInputSocket.on('error', (err) => console.error('[ArtNet INPUT] Socket error:', err.message));
  const bindAddr = networkConfig.inputIP || '0.0.0.0';
  artnetInputSocket.bind(ARTNET_PORT, bindAddr, () => {
    inputSocketBound = true;
    console.log(`[ArtNet INPUT] Listening on ${bindAddr}:${ARTNET_PORT}`);
  });
}

// Rebind input socket to a specific NIC IP
function rebindInputSocket(ip) {
  if (artnetInputSocket) {
    try { artnetInputSocket.close(); } catch(e) {}
    artnetInputSocket = null;
  }
  inputSocketBound = false;
  if (inputConfig.enabled) startInputSocket();
}

function broadcastToClients(msg) {
  const json = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

// --- Merge & Output Loop ---
function isValidIP(ip) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

function sendUniverse(universe, data) {
  const route = universeRoutingConfig[String(universe)];

  // --- ArtNet output ---
  if (clientConfig.artnet) {
    const destIP = route?.artnet?.ip || clientConfig.artnetHost;
    const destUni = route?.artnet?.universe ?? (universe - 1); // default: 0-indexed
    if (isValidIP(destIP)) {
      const packet = buildArtNetPacket(destUni, data);
      artnetSocket.send(packet, 0, packet.length, ARTNET_PORT, destIP);
    }
  }

  // --- sACN output ---
  if (clientConfig.sacn) {
    const sacnUni = route?.sacn?.universe ?? universe; // default: same as Lumina universe
    const packet = buildSACNPacket(sacnUni, data);
    const multicastAddr = `239.255.${(sacnUni >> 8) & 0xFF}.${sacnUni & 0xFF}`;
    sacnSocket.send(packet, 0, packet.length, SACN_PORT, multicastAddr);
  }
}

// --- Smart Output Scheduler ---
// Runs at 1ms resolution. Each tick, checks which universes need sending:
// - Active (dirty or within outputRate): send at configured rate, staggered
// - Idle (no change for 1s, all zeros): send at 1Hz heartbeat
// - Dirty: send immediately on next tick (wake-up)

function mergeUniverse(universe) {
  const inp = inputBuffer[universe];
  const overrides = clientOverrides[universe];
  const out = outputBuffer[universe];

  if (clientConfig.dmxMode === 'source') {
    // Source mode: send ONLY Lumina's effect data to the console
    // No merge with input — console handles its own merge
    out.fill(0);
    if (overrides) {
      for (const chStr in overrides) {
        const ch = parseInt(chStr);
        if (ch >= 0 && ch < 512) {
          out[ch] = overrides[chStr];
        }
      }
    }
  } else if (inputConfig.enabled) {
    // Insert mode: start with console input, overlay Lumina overrides
    out.set(inp);
    if (overrides) {
      for (const chStr in overrides) {
        const ch = parseInt(chStr);
        if (ch >= 0 && ch < 512) {
          out[ch] = overrides[chStr];
        }
      }
    }
  }
  // Legacy mode: outputBuffer already populated by dmx_frame handler
}

function isUniverseZero(universe) {
  const out = outputBuffer[universe];
  for (let i = 0; i < 512; i++) {
    if (out[i] !== 0) return false;
  }
  return true;
}

function outputTick() {
  const now = Date.now();
  const sendMonitor = monitorEnabled && (++monitorTick % MONITOR_EVERY === 0);
  const monitorUniverses = sendMonitor ? {} : null;

  // Build ordered list of universes to send this tick
  const toSend = [];

  for (const universe of activeUniverses) {
    const state = universeState[universe];

    // Merge data (input mode builds output, legacy already has it)
    mergeUniverse(universe);

    // Check idle transition: no change for IDLE_THRESHOLD and all zeros
    if (!state.idle && !state.dirty && (now - state.lastChanged) > IDLE_THRESHOLD && isUniverseZero(universe)) {
      state.idle = true;
    }

    // Determine if this universe should send this tick
    let shouldSend = false;

    if (state.dirty) {
      // Immediate wake-up: data changed, send now
      shouldSend = true;
      state.dirty = false;
      state.idle = false;
    } else if (state.idle) {
      // Heartbeat mode: send at 1Hz
      shouldSend = (now - state.lastSent) >= HEARTBEAT_INTERVAL;
    } else {
      // Active mode: send at configured rate
      shouldSend = (now - state.lastSent) >= outputRate;
    }

    if (shouldSend) {
      toSend.push(universe);
    }

    // Collect monitor data (every tick, not just send ticks)
    if (sendMonitor) {
      const overrides = clientOverrides[universe];
      const ovChans = overrides ? Object.keys(overrides).map(Number) : [];
      monitorUniverses[universe] = {
        input: Array.from(inputBuffer[universe]),
        output: Array.from(outputBuffer[universe]),
        overrides: ovChans
      };
    }
  }

  // Staggered send: spread packets across the tick with 1ms gaps
  for (let i = 0; i < toSend.length; i++) {
    const universe = toSend[i];
    if (i === 0) {
      // First universe: send immediately
      sendUniverse(universe, outputBuffer[universe]);
      universeState[universe].lastSent = now;
    } else {
      // Stagger subsequent universes by 1ms each
      const u = universe;
      setTimeout(() => {
        sendUniverse(u, outputBuffer[u]);
        universeState[u].lastSent = Date.now();
      }, i);
    }
  }

  if (sendMonitor && Object.keys(monitorUniverses).length > 0) {
    broadcastToClients({ type: 'dmx_monitor', universes: monitorUniverses });
  }
}

// Mark a universe as having changed data
function markUniverseDirty(universe) {
  const state = universeState[universe];
  state.lastChanged = Date.now();
  state.dirty = true;
  state.idle = false;
}

const OUTPUT_TICK_RATE = 5; // 5ms tick resolution (200Hz scheduler)

function startOutputLoop() {
  if (outputInterval) return;
  outputInterval = setInterval(outputTick, OUTPUT_TICK_RATE);
  console.log(`[OUTPUT] Smart scheduler started (${OUTPUT_TICK_RATE}ms tick, ${Math.round(1000 / outputRate)}Hz active, 1Hz heartbeat)`);
}

function stopOutputLoop() {
  if (outputInterval) {
    clearInterval(outputInterval);
    outputInterval = null;
    console.log('[OUTPUT] Scheduler stopped');
  }
}

function restartOutputLoop() {
  stopOutputLoop();
  if (outputEnabled) startOutputLoop();
}

// --- WebSocket Server ---
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  // Send available NICs to client
  const nics = getNetworkInterfaces();
  ws.send(JSON.stringify({ type: 'nic_list', interfaces: nics, current: networkConfig }));
  console.log('[NICS]', nics.map(n => `${n.name}:${n.ip}`).join(', ') || 'none');

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // --- Protocol config ---
      if (msg.type === 'config') {
        if (msg.artnet !== undefined) clientConfig.artnet = msg.artnet;
        if (msg.sacn !== undefined) clientConfig.sacn = msg.sacn;
        if (msg.artnetHost) clientConfig.artnetHost = msg.artnetHost;
        if (msg.dmxMode) clientConfig.dmxMode = msg.dmxMode;
        if (msg.dmxRate) {
          outputRate = msg.dmxRate;
          if (outputEnabled) restartOutputLoop();
        }
        console.log('[CONFIG]', clientConfig, 'rate:', outputRate + 'ms');
      }

      // --- Universe routing config ---
      if (msg.type === 'universe_routing') {
        universeRoutingConfig = msg.routing || {};
        console.log('[ROUTING]', Object.keys(universeRoutingConfig).length, 'custom universe routes');
      }

      // --- Input config ---
      if (msg.type === 'input_config') {
        if (msg.enabled !== undefined) {
          inputConfig.enabled = msg.enabled;
          if (msg.enabled) startInputSocket();
        }
        if (msg.sourceIP !== undefined) inputConfig.sourceIP = msg.sourceIP || null;
        if (msg.forwardToClient !== undefined) inputConfig.forwardToClient = msg.forwardToClient;
        console.log('[INPUT CONFIG]', inputConfig);
      }

      // --- Monitor control ---
      if (msg.type === 'monitor') {
        monitorEnabled = !!msg.enabled;
        console.log('[MONITOR]', monitorEnabled ? 'ON' : 'OFF');
      }

      // --- RDM Discovery ---
      if (msg.type === 'rdm_discover') {
        if (rdmDiscovering) {
          ws.send(JSON.stringify({ type: 'rdm_progress', universe: 0, phase: 'busy', found: 0, total: 0 }));
        } else {
          const universes = msg.universes || [1];
          console.log('[RDM] Discovery requested for universes:', universes);
          rdmDiscover(universes).then(result => {
            broadcastToClients({ type: 'rdm_results', devices: result.devices, nodes: result.nodes });
          }).catch(err => {
            console.error('[RDM] Discovery error:', err.message);
            rdmDiscovering = false;
            broadcastToClients({ type: 'rdm_results', devices: [], nodes: [], error: err.message });
          });
        }
      }

      // --- Network config (2-NIC setup) ---
      if (msg.type === 'network_config') {
        const oldInputIP = networkConfig.inputIP;
        const oldOutputIP = networkConfig.outputIP;

        if (msg.inputIP !== undefined) networkConfig.inputIP = msg.inputIP || '0.0.0.0';
        if (msg.outputIP !== undefined) {
          networkConfig.outputIP = msg.outputIP || '0.0.0.0';
          // Find broadcast address for the selected output NIC
          const nics = getNetworkInterfaces();
          const outNic = nics.find(n => n.ip === msg.outputIP);
          if (outNic) {
            networkConfig.outputBroadcast = outNic.broadcast;
            clientConfig.artnetHost = outNic.broadcast;
          } else {
            networkConfig.outputBroadcast = '255.255.255.255';
            clientConfig.artnetHost = '255.255.255.255';
          }
        }

        // Rebind input socket if input NIC changed
        if (oldInputIP !== networkConfig.inputIP) {
          rebindInputSocket(networkConfig.inputIP);
        }

        // Rebind output socket if output NIC changed
        if (oldOutputIP !== networkConfig.outputIP) {
          rebindOutputSocket(networkConfig.outputIP);
        }

        console.log('[NETWORK]', `IN: ${networkConfig.inputIP} | OUT: ${networkConfig.outputIP} → broadcast: ${networkConfig.outputBroadcast}`);
        // Send updated config back to client
        ws.send(JSON.stringify({ type: 'nic_list', interfaces: getNetworkInterfaces(), current: networkConfig }));
      }

      // --- Output control ---
      if (msg.type === 'output_control') {
        outputEnabled = !!msg.enabled;
        if (outputEnabled) startOutputLoop();
        else stopOutputLoop();
      }

      // --- DMX frame (sparse overrides from client) ---
      if (msg.type === 'dmx_frame') {
        if (inputConfig.enabled && msg.overrides) {
          // Input mode: sparse overrides — only active cue channels
          for (const [uniStr, channels] of Object.entries(msg.overrides)) {
            const uni = parseInt(uniStr);
            if (uni < 1 || uni > MAX_UNIVERSES) continue;
            clientOverrides[uni] = channels; // { "ch_index": value, ... }
            activeUniverses.add(uni);
            markUniverseDirty(uni);
          }
          // Clear overrides for universes not in this frame
          for (let u = 1; u <= MAX_UNIVERSES; u++) {
            if (!msg.overrides[String(u)]) clientOverrides[u] = null;
          }
        } else if (msg.universes) {
          // Legacy mode (no input): store in outputBuffer for merge loop + monitor
          for (const [uniStr, data] of Object.entries(msg.universes)) {
            const uni = parseInt(uniStr);
            if (uni < 1 || uni > MAX_UNIVERSES) continue;
            // Copy data into outputBuffer so mergeAndSend can read it
            for (let i = 0; i < 512 && i < data.length; i++) {
              outputBuffer[uni][i] = data[i] || 0;
            }
            activeUniverses.add(uni);
            markUniverseDirty(uni);
          }
        }
      }
    } catch (e) {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    // Clear client overrides so pass-through continues clean
    for (let u = 0; u <= MAX_UNIVERSES; u++) clientOverrides[u] = null;
    // Keep output loop running if input is active (show safety)
    if (!inputConfig.enabled && wss.clients.size === 0) {
      outputEnabled = false;
      stopOutputLoop();
    }
  });
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`LUMINA FX server at http://localhost:${PORT}`);
  console.log(`WebSocket bridge active on ws://localhost:${PORT}`);
  console.log(`DMX: 64 universes x 512 channels (32,768 ch)`);
  console.log(`ArtNet output -> UDP ${ARTNET_PORT} | sACN output -> UDP ${SACN_PORT}`);
  console.log(`ArtNet input -> UDP ${ARTNET_PORT} (enabled via client)`);
});
