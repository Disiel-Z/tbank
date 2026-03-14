import webpush from "web-push";

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

    if (url.pathname === "/subscribe" && request.method === "POST") {
      return this.handleSubscribe(request);
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

  async getSubscriptions() {
    const stored = await this.state.storage.get("subscriptions");
    return Array.isArray(stored) ? stored : [];
  }

  async saveSubscriptions(subscriptions) {
    await this.state.storage.put("subscriptions", subscriptions.slice(-20));
  }

  async handleSubscribe(request) {
    let body;

    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    const user = String(body?.user || "").trim();
    const subscription = body?.subscription;

    if (!user) {
      return Response.json({ ok: false, error: "User is required" }, { status: 400 });
    }

    if (
      !subscription ||
      !subscription.endpoint ||
      !subscription.keys?.p256dh ||
      !subscription.keys?.auth
    ) {
      return Response.json({ ok: false, error: "Invalid subscription payload" }, { status: 400 });
    }

    const subscriptions = await this.getSubscriptions();
    const endpoint = subscription.endpoint;

    const filtered = subscriptions.filter((item) => {
      if (!item?.subscription?.endpoint) return false;

      // Убираем старую запись этого же endpoint
      if (item.subscription.endpoint === endpoint) return false;

      return true;
    });

    filtered.push({
      user,
      createdAt: new Date().toISOString(),
      subscription
    });

    await this.saveSubscriptions(filtered.slice(-20));

    return Response.json({
      ok: true,
      totalSubscriptions: filtered.length
    });
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

    const author = String(payload.author || "").trim();
    const text = String(payload.text || "").trim();

    if (!author || !text) {
      return;
    }

    const safePayload = {
      id: String(payload.id || crypto.randomUUID()),
      ts: String(payload.ts || new Date().toISOString()),
      author: author.slice(0, 40),
      text: text.slice(0, 2000),
      status: "delivered"
    };

    const messages = await this.getMessages();
    messages.push(safePayload);
    await this.saveMessages(messages);

    const outgoing = JSON.stringify({
      type: "message",
      ...safePayload
    });

    for (const session of this.sessions) {
      try {
        session.send(outgoing);
      } catch {
        this.sessions = this.sessions.filter((s) => s !== session);
      }
    }

    try {
      sender.send(
        JSON.stringify({
          type: "ack",
          id: safePayload.id,
          status: "delivered"
        })
      );
    } catch {}

    await this.sendPushToOtherUsers(safePayload);
  }

  async sendPushToOtherUsers(message) {
    const publicKey = String(this.env.VAPID_PUBLIC_KEY || "").trim();
    const privateKey = String(this.env.VAPID_PRIVATE_KEY || "").trim();

    if (!publicKey || !privateKey) {
      console.log("Push skipped: missing VAPID keys");
      return;
    }

    webpush.setVapidDetails(
      "mailto:admin@example.com",
      publicKey,
      privateKey
    );

    const subscriptions = await this.getSubscriptions();
    if (!subscriptions.length) return;

    const recipients = subscriptions.filter(
      (item) =>
        item?.subscription?.endpoint &&
        item?.user &&
        item.user !== message.author
    );

    if (!recipients.length) return;

    const text = String(message.text || "");
    const body =
      text.length > 120
        ? `${message.author}: ${text.slice(0, 117)}...`
        : `${message.author}: ${text}`;

    const notificationPayload = JSON.stringify({
      title: "Т-банк",
      body,
      url: "/?route=chat",
      author: message.author,
      messageId: message.id
    });

    const staleEndpoints = new Set();

    await Promise.all(
      recipients.map(async (item) => {
        try {
          await webpush.sendNotification(item.subscription, notificationPayload);
        } catch (error) {
          console.log("Push send error:", error?.message || error);

          const statusCode =
            error?.statusCode ??
            error?.status ??
            error?.body?.statusCode ??
            null;

          if (statusCode === 404 || statusCode === 410) {
            staleEndpoints.add(item.subscription.endpoint);
          }
        }
      })
    );

    if (staleEndpoints.size > 0) {
      const cleaned = subscriptions.filter(
        (item) => !staleEndpoints.has(item?.subscription?.endpoint)
      );
      await this.saveSubscriptions(cleaned.slice(-20));
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

  if (url.pathname === "/vapid-public-key") {
    return new Response(env.VAPID_PUBLIC_KEY || "", {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=UTF-8",
        "cache-control": "no-store"
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

  if (url.pathname === "/subscribe") {
    return room.fetch(new Request("https://room/subscribe", request));
  }

  return new Response("Not found", { status: 404 });
}

export { ChatRoom };
