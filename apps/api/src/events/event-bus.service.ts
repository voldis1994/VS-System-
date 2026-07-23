import { Injectable } from "@nestjs/common";
import { EventEmitter } from "events";
import {
  createDomainEvent,
  type DomainEvent,
  type DomainEventTypeName,
} from "@nexus/domain";
import { newId } from "@nexus/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class EventBusService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly prisma: PrismaService) {
    this.emitter.setMaxListeners(100);
  }

  async publish<T extends Record<string, unknown>>(input: {
    eventType: DomainEventTypeName | string;
    aggregateId: string;
    organizationId: string;
    actorId?: string | null;
    correlationId: string;
    causationId?: string | null;
    payload: T;
  }): Promise<DomainEvent<T>> {
    const event = createDomainEvent<T>({
      eventId: newId(),
      eventType: input.eventType,
      aggregateId: input.aggregateId,
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      payload: input.payload,
    });

    await this.prisma.domainEventRecord.create({
      data: {
        eventId: event.eventId,
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        organizationId: event.organizationId,
        actorId: event.actorId,
        timestamp: new Date(event.timestamp),
        correlationId: event.correlationId,
        causationId: event.causationId,
        payloadJson: event.payload as Prisma.InputJsonValue,
        version: event.version,
      },
    });

    this.emitter.emit(event.eventType, event);
    this.emitter.emit("*", event);
    return event;
  }

  on(eventType: string, handler: (event: DomainEvent) => void): void {
    this.emitter.on(eventType, handler);
  }

  onAny(handler: (event: DomainEvent) => void): void {
    this.emitter.on("*", handler);
  }
}
