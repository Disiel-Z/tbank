export default {
  async fetch(request, env) {
    return await handleRequest(request, env);
  }
};

class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];  // WebSocket sessions
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      server.accept();
      this.sessions.push(server);
      server.addEventListener('message', (event) => this.handleMessage(event));
      server.addEventListener('close', () => this.sessions = this.sessions.filter(s => s !== server));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Expected WebSocket', { status: 400 });
  }

  async handleMessage(event) {
    const msg = event.data;
    this.sessions.forEach(s => s.send(msg));  // Broadcast to all
    // Send push to subscribers (later)
  }
}

// Handle request
async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/chat') {
    const id = env.CHAT_ROOM.idFromName('family-chat');
    const room = env.CHAT_ROOM.get(id);
    return room.fetch(request);
  }
  return new Response('Not found', { status: 404 });
}

export { ChatRoom };
