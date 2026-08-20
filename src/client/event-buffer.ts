/**
 * Ring Buffer for Trace Events
 *
 * Stores trace events in a fixed-size circular buffer.
 * Oldest events are evicted when the buffer is full.
 */

import type { TraceEventWithId, TraceSearchFilter, TraceEventType } from '../types.js';

export class EventBuffer {
  private buffer: TraceEventWithId[] = [];
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Add an event to the buffer
   */
  push(event: TraceEventWithId): void {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift(); // Remove oldest
    }
    this.buffer.push(event);
  }

  /**
   * Get all events
   */
  getAll(): TraceEventWithId[] {
    return [...this.buffer];
  }

  /**
   * Get recent events with optional limit
   */
  getRecent(limit?: number, types?: TraceEventType[]): TraceEventWithId[] {
    let events = [...this.buffer];

    // Filter by types if specified
    if (types && types.length > 0) {
      events = events.filter((e) => types.includes(e.type));
    }

    // Return most recent first
    events.reverse();

    // Apply limit
    if (limit && limit > 0) {
      events = events.slice(0, limit);
    }

    return events;
  }

  /**
   * Get events by session ID
   */
  getBySession(sessionId: string): TraceEventWithId[] {
    return this.buffer.filter((e) => e.sessionId === sessionId);
  }

  /**
   * Search events with filters
   */
  search(filter: TraceSearchFilter): TraceEventWithId[] {
    let events = [...this.buffer];

    // Filter by types
    if (filter.types && filter.types.length > 0) {
      events = events.filter((e) => filter.types!.includes(e.type));
    }

    // Filter by agent name
    if (filter.agentName) {
      events = events.filter((e) => e.agentName === filter.agentName);
    }

    // Filter by time range
    if (filter.startTime) {
      events = events.filter((e) => new Date(e.timestamp) >= filter.startTime!);
    }
    if (filter.endTime) {
      events = events.filter((e) => new Date(e.timestamp) <= filter.endTime!);
    }

    // Filter by text search in data
    if (filter.text) {
      const searchText = filter.text.toLowerCase();
      events = events.filter((e) => {
        const dataStr = JSON.stringify(e.data).toLowerCase();
        return dataStr.includes(searchText);
      });
    }

    // Filter by error presence
    if (filter.hasError !== undefined) {
      if (filter.hasError) {
        events = events.filter(
          (e) =>
            e.type === 'error' ||
            (e.data && (e.data.error || e.data.errorType || e.data.errorMessage)),
        );
      } else {
        events = events.filter(
          (e) =>
            e.type !== 'error' &&
            !(e.data && (e.data.error || e.data.errorType || e.data.errorMessage)),
        );
      }
    }

    return events;
  }

  /**
   * Get errors and warnings
   */
  getErrors(): TraceEventWithId[] {
    return this.buffer.filter(
      (e) =>
        e.type === 'error' ||
        e.type === 'escalation' ||
        (e.data && (e.data.error || e.data.errorType || e.data.warning)),
    );
  }

  /**
   * Get events by span ID
   */
  getBySpan(spanId: string): TraceEventWithId[] {
    return this.buffer.filter((e) => e.spanId === spanId || e.parentSpanId === spanId);
  }

  /**
   * Get event by ID
   */
  getById(id: string): TraceEventWithId | undefined {
    return this.buffer.find((e) => e.id === id);
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Get buffer size
   */
  size(): number {
    return this.buffer.length;
  }
}
