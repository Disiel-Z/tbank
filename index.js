export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");

    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();
    this.sessions.push(server);

    server.addEventListener("message", (event) => this.handleMessage(event, server));

    server.addEventListener("close", () => {
      this.sessions = this.sessions.filter((s) => s !== server);
    });

    server.addEventListener("error", () => {
      this.sessions = this.sessions.filter((s) => s !== server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  handleMessage(event, sender) {
    const msg = String(event.data ?? "");

    for (const session of this.sessions) {
      try {
        session.send(msg);
      } catch {
        this.sessions = this.sessions.filter((s) => s !== session);
      }
    }
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return new Response("ok", {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=UTF-8"
      }
    });
  }

  if (url.pathname === "/chat") {
    const id = env.CHAT_ROOM.idFromName("family-chat");
    const room = env.CHAT_ROOM.get(id);
    return room.fetch(request);
  }

  return new Response("Not found", { status: 404 });
}

export { ChatRoom };
