// Live updates to the dashboard using Server-Sent Events (SSE).
// The browser keeps one connection open to /api/stream and the server pushes events down it.
// No extra library needed - it's plain HTTP.

const clients = new Set();

// Express handler for GET /api/stream
function streamHandler(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');

  clients.add(res);
  // Ping every 25 s so proxies don't close an idle connection
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

// Send an event to every open dashboard. type: 'reading' | 'alert' | 'patient'
function broadcast(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(message);
}

module.exports = { streamHandler, broadcast };
