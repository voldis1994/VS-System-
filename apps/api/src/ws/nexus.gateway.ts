import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Logger, OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Server, WebSocket } from "ws";
import { EventBusService } from "../events/event-bus.service";
import { MarketDataService } from "../market-data/market-data.service";

interface ClientState {
  organizationId?: string;
  subscriptions: Set<string>;
}

@WebSocketGateway({ path: "/ws" })
export class NexusGateway implements OnGatewayConnection, OnModuleInit {
  private readonly log = new Logger(NexusGateway.name);
  private readonly clients = new Map<WebSocket, ClientState>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly events: EventBusService,
    private readonly market: MarketDataService,
  ) {}

  onModuleInit() {
    this.events.onAny((event) => {
      this.broadcast(event.organizationId, {
        channel: this.channelFor(event.eventType),
        event,
      });
    });
    setInterval(() => {
      const ticks = this.market.listTicks();
      for (const [socket, state] of this.clients.entries()) {
        if (!state.organizationId) continue;
        if (state.subscriptions.has("market.tick") || state.subscriptions.has("*")) {
          this.send(socket, { channel: "market.tick", data: ticks });
        }
      }
    }, 1000);
  }

  handleConnection(client: WebSocket, ...args: unknown[]) {
    this.clients.set(client, { subscriptions: new Set() });
    const req = args[0] as { url?: string } | undefined;
    const url = req?.url ?? "";
    const token = new URL(url, "http://localhost").searchParams.get("token");
    if (token) {
      try {
        const payload = this.jwt.verify<{ organizationId: string }>(token);
        const state = this.clients.get(client)!;
        state.organizationId = payload.organizationId;
      } catch {
        this.log.warn("WS auth failed");
      }
    }
    client.on("close", () => this.clients.delete(client));
  }

  @SubscribeMessage("subscribe")
  onSubscribe(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: { channels?: string[]; token?: string },
  ) {
    const state = this.clients.get(client) ?? { subscriptions: new Set() };
    if (body.token) {
      try {
        const payload = this.jwt.verify<{ organizationId: string }>(body.token);
        state.organizationId = payload.organizationId;
      } catch {
        this.send(client, { error: "unauthorized" });
        return;
      }
    }
    for (const ch of body.channels ?? []) state.subscriptions.add(ch);
    this.clients.set(client, state);
    this.send(client, { ok: true, subscriptions: [...state.subscriptions] });
  }

  @SubscribeMessage("ping")
  onPing(@ConnectedSocket() client: WebSocket) {
    this.send(client, { channel: "system.health", data: { pong: true, ts: Date.now() } });
  }

  private broadcast(organizationId: string, message: unknown) {
    for (const [socket, state] of this.clients.entries()) {
      if (state.organizationId !== organizationId) continue;
      this.send(socket, message);
    }
  }

  private send(client: WebSocket, message: unknown) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }

  private channelFor(eventType: string): string {
    if (eventType.startsWith("Order") || eventType.startsWith("Position") || eventType.includes("Stop") || eventType.includes("Take") || eventType.includes("Trailing") || eventType.includes("BreakEven")) {
      return eventType.startsWith("Order") ? "order.updated" : "position.updated";
    }
    if (eventType.startsWith("Account")) return "account.updated";
    if (eventType.startsWith("Strategy")) return "strategy.updated";
    if (eventType.startsWith("Risk") || eventType.startsWith("Trading")) return "risk.updated";
    if (eventType.startsWith("Copier") || eventType.startsWith("TradeCopy")) return "copier.updated";
    if (eventType.startsWith("Automation")) return "automation.updated";
    if (eventType.startsWith("Alert")) return "alert.created";
    if (eventType.startsWith("Notification")) return "notification.created";
    if (eventType.startsWith("Market")) return "market.tick";
    return "system.health";
  }
}
