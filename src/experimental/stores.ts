/**
 * Experimental store interfaces for serverless deployments.
 *
 * @experimental
 */

/**
 * Session state that can be persisted externally for serverless deployments.
 */
export interface SessionState {
    /** Whether the session has completed initialization */
    initialized: boolean;
}

/**
 * Interface for session storage in distributed/serverless deployments.
 *
 * In serverless environments (Lambda, Vercel, Cloudflare Workers), each request
 * may be handled by a different instance with no shared memory. The SessionStore
 * allows session state to be persisted externally (e.g., Redis, DynamoDB, KV).
 *
 * @experimental
 * @example
 * ```typescript
 * // Cloudflare KV implementation
 * class KVSessionStore implements SessionStore {
 *   constructor(private kv: KVNamespace) {}
 *
 *   async get(sessionId: string) {
 *     return this.kv.get(`session:${sessionId}`, 'json');
 *   }
 *   async save(sessionId: string, state: SessionState) {
 *     await this.kv.put(`session:${sessionId}`, JSON.stringify(state), { expirationTtl: 3600 });
 *   }
 *   async delete(sessionId: string) {
 *     await this.kv.delete(`session:${sessionId}`);
 *   }
 * }
 * ```
 */
export interface SessionStore {
    /**
     * Retrieve session state by ID.
     * @param sessionId The session ID to look up
     * @returns The session state, or undefined if not found
     */
    get(sessionId: string): Promise<SessionState | undefined>;

    /**
     * Save session state.
     * Called when a session is initialized or updated.
     * @param sessionId The session ID
     * @param state The session state to persist
     */
    save(sessionId: string, state: SessionState): Promise<void>;

    /**
     * Delete session state.
     * Called when a session is explicitly closed via DELETE request.
     * @param sessionId The session ID to delete
     */
    delete(sessionId: string): Promise<void>;
}
