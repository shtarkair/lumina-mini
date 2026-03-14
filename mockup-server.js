const http = require('http');
const fs = require('fs');
const path = require('path');
const server = http.createServer((req, res) => {
  const file = path.join(__dirname, 'f35-mockup.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end('Error'); return; }
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(data);
  });
});
server.listen(3460, () => console.log('Mockup server on 3460'));
