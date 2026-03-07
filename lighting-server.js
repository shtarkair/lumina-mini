const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3457;
const filePath = path.join(__dirname, 'lighting-app.html');

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

server.listen(PORT, () => {
  console.log(`Lighting app running at http://localhost:${PORT}`);
});
