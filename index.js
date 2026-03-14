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
    const url = new URL(request.url);

    if (url.pathname === "/messages" && request.method === "GET") {
      const messages = await this.getMessages();
      return Response.json(messages, {
        headers: {
          "cache-control": "no-store"
        }
      });
    }

    if (url.pathname === "/chat") {
      const upgradeHeader = request.headers.get("Upgrade");

      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 400 });
      }

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      this.sessions.push(server);

      server.addEventListener("message", (event) => {
        this.handleMessage(event, server);
      });

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

    return new Response("Not found", { status: 404 });
  }

  async getMessages() {
    const stored = await this.state.storage.get("messages");
    return Array.isArray(stored) ? stored : [];
  }

  async saveMessages(messages) {
    await this.state.storage.put("messages", messages.slice(-100));
  }

  async handleMessage(event, sender) {
    const raw = String(event.data ?? "");

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        author: "Неизвестно",
        text: raw
      };
    }

    if (!payload.id) payload.id = crypto.randomUUID();
    if (!payload.ts) payload.ts = new Date().toISOString();
    if (!payload.author) payload.author = "Неизвестно";
    if (!payload.text) payload.text = "";

    const messages = await this.getMessages();
    messages.push(payload);
    await this.saveMessages(messages);

    const outgoing = JSON.stringify(payload);

    for (const session of this.sessions) {
      try {
        session.send(outgoing);
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

  const id = env.CHAT_ROOM.idFromName("family-chat");
  const room = env.CHAT_ROOM.get(id);

  if (url.pathname === "/chat") {
    return room.fetch(new Request("https://room/chat", request));
  }

  if (url.pathname === "/messages") {
    return room.fetch(new Request("https://room/messages", request));
  }

  return new Response("Not found", { status: 404 });
}

export { ChatRoom };
