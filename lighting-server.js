const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');
const WebSocket = require('ws');

const PORT = 3457;
const ARTNET_PORT = 6454;
const SACN_PORT = 5568;
const MAX_UNIVERSES = 64;
const filePath = path.join(__dirname, 'lighting-app.html');

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

// --- Input Configuration ---
let inputConfig = {
  enabled: false,
  sourceIP: null,        // null = accept from any, or specific IP string
  forwardToClient: false // send dmx_input to client for monitoring
};

// --- Per-client protocol config ---
let clientConfig = { artnet: true, sacn: false, artnetHost: '255.255.255.255' };

// --- Output loop config ---
let outputRate = 25; // ms between frames (40Hz)
let outputInterval = null;
let outputEnabled = false;

// --- Monitor config ---
let monitorEnabled = false;
let monitorTick = 0;
const MONITOR_EVERY = 4; // send monitor data every N merge ticks (~10Hz at 40Hz output)

// --- HTTP Server ---
const server = http.createServer((req, res) => {
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
const artnetSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let outputSocketPort = null;
artnetSocket.bind(() => {
  artnetSocket.setBroadcast(true);
  outputSocketPort = artnetSocket.address().port;
});

const sacnSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sacnSocket.bind(() => {
  try { sacnSocket.setBroadcast(true); } catch(e) {}
});

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
  buf.writeUInt16LE(Math.max(0, universe - 1), 14);
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
const artnetInputSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let inputSocketBound = false;

// Throttle forwarding to client (max 10Hz per universe)
const forwardTimers = {};
const FORWARD_INTERVAL = 100;

artnetInputSocket.on('message', (buf, rinfo) => {
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
});

artnetInputSocket.on('error', (err) => {
  console.error('[ArtNet INPUT] Socket error:', err.message);
});

function startInputSocket() {
  if (inputSocketBound) return;
  artnetInputSocket.bind(ARTNET_PORT, '0.0.0.0', () => {
    inputSocketBound = true;
    console.log(`[ArtNet INPUT] Listening on UDP ${ARTNET_PORT}`);
  });
}

function broadcastToClients(msg) {
  const json = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

// --- Merge & Output Loop ---
function sendUniverse(universe, data) {
  if (clientConfig.artnet) {
    const packet = buildArtNetPacket(universe, data);
    artnetSocket.send(packet, 0, packet.length, ARTNET_PORT, clientConfig.artnetHost);
  }
  if (clientConfig.sacn) {
    const packet = buildSACNPacket(universe, data);
    const multicastAddr = `239.255.${(universe >> 8) & 0xFF}.${universe & 0xFF}`;
    sacnSocket.send(packet, 0, packet.length, SACN_PORT, multicastAddr);
  }
}

function mergeAndSend() {
  const sendMonitor = monitorEnabled && (++monitorTick % MONITOR_EVERY === 0);
  const monitorUniverses = sendMonitor ? {} : null;

  for (const universe of activeUniverses) {
    const inp = inputBuffer[universe];
    const overrides = clientOverrides[universe];
    const out = outputBuffer[universe];

    if (inputConfig.enabled) {
      // Input mode: start with console input, overlay Lumina overrides
      out.set(inp);
      if (overrides) {
        for (const chStr in overrides) {
          const ch = parseInt(chStr);
          if (ch >= 0 && ch < 512) {
            out[ch] = overrides[chStr];
          }
        }
      }
      sendUniverse(universe, out);
    }
    // Legacy mode: outputBuffer already populated by dmx_frame handler, no extra send needed

    // Collect monitor data
    if (sendMonitor) {
      // Build override mask: which channels Lumina is controlling
      const ovChans = overrides ? Object.keys(overrides).map(Number) : [];
      monitorUniverses[universe] = {
        input: Array.from(inp),
        output: Array.from(out),
        overrides: ovChans
      };
    }
  }

  if (sendMonitor && Object.keys(monitorUniverses).length > 0) {
    broadcastToClients({ type: 'dmx_monitor', universes: monitorUniverses });
  }
}

function startOutputLoop() {
  if (outputInterval) return;
  outputInterval = setInterval(mergeAndSend, outputRate);
  console.log(`[OUTPUT] Merge loop started at ${Math.round(1000 / outputRate)}Hz`);
}

function stopOutputLoop() {
  if (outputInterval) {
    clearInterval(outputInterval);
    outputInterval = null;
    console.log('[OUTPUT] Merge loop stopped');
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

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // --- Protocol config ---
      if (msg.type === 'config') {
        if (msg.artnet !== undefined) clientConfig.artnet = msg.artnet;
        if (msg.sacn !== undefined) clientConfig.sacn = msg.sacn;
        if (msg.artnetHost) clientConfig.artnetHost = msg.artnetHost;
        if (msg.dmxRate) {
          outputRate = msg.dmxRate;
          if (outputEnabled) restartOutputLoop();
        }
        console.log('[CONFIG]', clientConfig, 'rate:', outputRate + 'ms');
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
            // Also send immediately (merge loop will re-send, but keeps latency low)
            sendUniverse(uni, data);
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
