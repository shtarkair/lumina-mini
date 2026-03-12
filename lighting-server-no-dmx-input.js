const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const WebSocket = require('ws');

const PORT = 3457;
const ARTNET_PORT = 6454;
const SACN_PORT = 5568;
const filePath = path.join(__dirname, 'lighting-app.html');

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

// --- UDP Sockets ---
const artnetSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
artnetSocket.bind(() => { artnetSocket.setBroadcast(true); });

const sacnSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sacnSocket.bind(() => {
  try { sacnSocket.setBroadcast(true); } catch(e) {}
});

// --- ArtNet Packet Builder ---
let artnetSequence = 0;
function buildArtNetPacket(universe, dmxData) {
  const buf = Buffer.alloc(18 + 512);
  buf.write('Art-Net\0', 0, 8, 'ascii');   // ID
  buf.writeUInt16LE(0x5000, 8);             // OpCode: OpDmx
  buf.writeUInt16BE(14, 10);                // Protocol version 14
  buf[12] = artnetSequence & 0xFF;          // Sequence
  artnetSequence = (artnetSequence + 1) & 0xFF;
  buf[13] = 0;                               // Physical port
  buf.writeUInt16LE(Math.max(0, universe - 1), 14); // Universe (0-indexed)
  buf.writeUInt16BE(512, 16);               // Length
  for (let i = 0; i < 512; i++) buf[18 + i] = dmxData[i] || 0;
  return buf;
}

// --- sACN / E1.31 Packet Builder ---
let sacnSequence = 0;
const SACN_CID = Buffer.from([
  0x4c, 0x55, 0x4d, 0x49, 0x4e, 0x41, 0x2d, 0x46,
  0x58, 0x2d, 0x30, 0x30, 0x30, 0x31, 0x00, 0x00
]); // "LUMINA-FX-0001"

function buildSACNPacket(universe, dmxData) {
  const dmxLen = 512;
  const buf = Buffer.alloc(126 + dmxLen);

  // --- Root Layer (preamble + header) ---
  buf.writeUInt16BE(0x0010, 0);             // Preamble Size
  buf.writeUInt16BE(0x0000, 2);             // Post-amble Size
  buf.write('ASC-E1.17\0\0\0', 4, 12, 'ascii'); // ACN Packet Identifier
  const rootFlagsLen = 0x7000 | (buf.length - 16);
  buf.writeUInt16BE(rootFlagsLen, 16);      // Flags + Length
  buf.writeUInt32BE(0x00000004, 18);        // Vector: VECTOR_ROOT_E131_DATA
  SACN_CID.copy(buf, 22);                   // CID (16 bytes)

  // --- Framing Layer ---
  const framingFlagsLen = 0x7000 | (buf.length - 38);
  buf.writeUInt16BE(framingFlagsLen, 38);   // Flags + Length
  buf.writeUInt32BE(0x00000002, 40);        // Vector: VECTOR_E131_DATA_PACKET
  const srcName = 'LUMINA FX';
  buf.write(srcName, 44, 64, 'utf8');       // Source Name (64 bytes)
  buf[108] = 100;                            // Priority (100)
  buf.writeUInt16BE(0, 109);                // Sync Address
  buf[111] = sacnSequence & 0xFF;           // Sequence Number
  sacnSequence = (sacnSequence + 1) & 0xFF;
  buf[112] = 0;                              // Options
  buf.writeUInt16BE(universe, 113);         // Universe

  // --- DMP Layer ---
  const dmpFlagsLen = 0x7000 | (dmxLen + 11);
  buf.writeUInt16BE(dmpFlagsLen, 115);      // Flags + Length
  buf[117] = 0x02;                           // Vector: VECTOR_DMP_SET_PROPERTY
  buf[118] = 0xA1;                           // Address Type & Data Type
  buf.writeUInt16BE(0x0000, 119);           // First Property Address
  buf.writeUInt16BE(0x0001, 121);           // Address Increment
  buf.writeUInt16BE(dmxLen + 1, 123);       // Property value count (DMX + START code)
  buf[125] = 0x00;                           // DMX START Code
  for (let i = 0; i < dmxLen; i++) buf[126 + i] = dmxData[i] || 0;

  return buf;
}

// --- Per-client protocol config ---
let clientConfig = { artnet: true, sacn: false, artnetHost: '255.255.255.255' };

// --- WebSocket Server ---
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'config') {
        if (msg.artnet !== undefined) clientConfig.artnet = msg.artnet;
        if (msg.sacn !== undefined) clientConfig.sacn = msg.sacn;
        if (msg.artnetHost) clientConfig.artnetHost = msg.artnetHost;
        console.log('[CONFIG]', clientConfig);
      }

      if (msg.type === 'dmx_frame' && msg.universes) {
        for (const [uniStr, data] of Object.entries(msg.universes)) {
          const uni = parseInt(uniStr);

          // ArtNet output
          if (clientConfig.artnet) {
            const packet = buildArtNetPacket(uni, data);
            artnetSocket.send(packet, 0, packet.length, ARTNET_PORT, clientConfig.artnetHost);
          }

          // sACN output
          if (clientConfig.sacn) {
            const packet = buildSACNPacket(uni, data);
            const multicastAddr = `239.255.${(uni >> 8) & 0xFF}.${uni & 0xFF}`;
            sacnSocket.send(packet, 0, packet.length, SACN_PORT, multicastAddr);
          }
        }
      }
    } catch (e) {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`LUMINA FX server at http://localhost:${PORT}`);
  console.log(`WebSocket bridge active on ws://localhost:${PORT}`);
  console.log(`DMX output: 64 universes × 512 channels (32,768 ch)`);
  console.log(`ArtNet output → UDP ${ARTNET_PORT} | sACN output → UDP ${SACN_PORT}`);
});
