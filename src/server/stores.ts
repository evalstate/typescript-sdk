/**
 * Store interfaces for MCP server transports.
 *
 * These interfaces define contracts for external storage that enables
 * resumability support.
 */

import { JSONRPCMessage } from '../types.js';

export type StreamId = string;
export type EventId = string;

/**
 * Interface for resumability support via event storage.
 *
 * When provided to a transport, enables clients to reconnect and resume
 * receiving messages from where they left off using the Last-Event-ID header.
 */
export interface EventStore {
    /**
     * Stores an event for later retrieval.
     * @param streamId ID of the stream the event belongs to
     * @param message The JSON-RPC message to store
     * @returns The generated event ID for the stored event
     */
    storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;

    /**
     * Get the stream ID associated with a given event ID.
     * @param eventId The event ID to look up
     * @returns The stream ID, or undefined if not found
     *
     * Optional: If not provided, the SDK will use the streamId returned by
     * replayEventsAfter for stream mapping.
     */
    getStreamIdForEventId?(eventId: EventId): Promise<StreamId | undefined>;

    /**
     * Replays events that occurred after the given event ID.
     * @param lastEventId The last event ID the client received
     * @param options.send Callback to send each replayed event
     * @returns The stream ID for the replayed events
     */
    replayEventsAfter(
        lastEventId: EventId,
        {
            send
        }: {
            send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
        }
    ): Promise<StreamId>;
}
