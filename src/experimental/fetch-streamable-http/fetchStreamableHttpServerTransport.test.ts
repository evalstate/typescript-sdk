/**
 * Tests for FetchStreamableHTTPServerTransport
 *
 * These tests mirror the structure of src/server/streamableHttp.test.ts
 * but test the Web Standards based implementation.
 */

import { createServer, type Server, IncomingMessage, ServerResponse } from 'node:http';
import { createServer as netCreateServer, AddressInfo } from 'node:net';
import {
    FetchStreamableHTTPServerTransport,
    EventStore,
    EventId,
    StreamId,
    AuthenticatedRequest,
    SessionStore,
    SessionState
} from './fetchStreamableHttpServerTransport.js';
import { McpServer } from '../../server/mcp.js';
import { CallToolResult, JSONRPCMessage } from '../../types.js';
import { AuthInfo } from '../../server/auth/types.js';
import { zodTestMatrix, type ZodMatrixEntry } from '../../__fixtures__/zodTestMatrix.js';

async function getFreePort() {
    return new Promise<number>(res => {
        const srv = netCreateServer();
        srv.listen(0, () => {
            const address = srv.address()!;
            if (typeof address === 'string') {
                throw new Error('Unexpected address type: ' + typeof address);
            }
            const port = (address as AddressInfo).port;
            srv.close(_err => res(port));
        });
    });
}

/**
 * Adapter function to convert Node.js IncomingMessage to Web Standard Request
 * This is used for testing purposes to bridge Node.js HTTP server with web standards transport
 */
async function nodeRequestToWebRequest(req: IncomingMessage, baseUrl: string): Promise<Request> {
    const url = new URL(req.url || '/', baseUrl);

    // Collect headers
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
            if (Array.isArray(value)) {
                value.forEach(v => headers.append(key, v));
            } else {
                headers.set(key, value);
            }
        }
    }

    // For methods that can have a body
    let body: string | null = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        body = Buffer.concat(chunks).toString('utf-8');
    }

    return new Request(url.toString(), {
        method: req.method,
        headers,
        body: body || undefined
    });
}

/**
 * Adapter function to write Web Standard Response to Node.js ServerResponse
 * This function streams data as it arrives - it does NOT wait for stream completion.
 * For SSE responses that are long-running, this returns immediately after setting up streaming.
 */
function webResponseToNodeResponse(webResponse: Response, nodeRes: ServerResponse): void {
    // Set status
    nodeRes.statusCode = webResponse.status;

    // Set headers
    webResponse.headers.forEach((value, key) => {
        nodeRes.setHeader(key, value);
    });

    // For SSE responses, we need to flush headers immediately so the client
    // can receive them before any body data is sent. This is critical for
    // Server-Sent Events to work properly with fetch().
    const contentType = webResponse.headers.get('content-type');
    if (contentType === 'text/event-stream') {
        nodeRes.flushHeaders();
    }

    // Stream body - this runs asynchronously for SSE streams
    if (webResponse.body) {
        const reader = webResponse.body.getReader();

        // Process stream chunks as they arrive
        const processStream = async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        nodeRes.end();
                        break;
                    }
                    nodeRes.write(value);
                }
            } catch {
                // Stream was cancelled or closed, just end the response
                if (!nodeRes.writableEnded) {
                    nodeRes.end();
                }
            } finally {
                reader.releaseLock();
            }
        };

        // Start processing without waiting - for SSE this allows us to return immediately
        processStream();
    } else {
        nodeRes.end();
    }
}

/**
 * Test server configuration for FetchStreamableHTTPServerTransport tests
 */
interface TestServerConfig {
    sessionIdGenerator: (() => string) | undefined;
    enableJsonResponse?: boolean;
    eventStore?: EventStore;
    sessionStore?: SessionStore;
    onsessioninitialized?: (sessionId: string) => void | Promise<void>;
    onsessionclosed?: (sessionId: string) => void | Promise<void>;
    retryInterval?: number;
    allowedHosts?: string[];
    allowedOrigins?: string[];
    enableDnsRebindingProtection?: boolean;
    /** Optional port to listen on. If not specified, a random port is used. */
    port?: number;
}

/**
 * Helper to stop test server
 */
async function stopTestServer({ server, transport }: { server: Server; transport: FetchStreamableHTTPServerTransport }): Promise<void> {
    // First close the transport to ensure all SSE streams are closed
    await transport.close();

    // Close the server without waiting indefinitely
    server.close();
}

/**
 * Common test messages
 */
const TEST_MESSAGES = {
    initialize: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
            clientInfo: { name: 'test-client', version: '1.0' },
            protocolVersion: '2025-03-26',
            capabilities: {}
        },

        id: 'init-1'
    } as JSONRPCMessage,

    toolsList: {
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 'tools-1'
    } as JSONRPCMessage
};

/**
 * Helper to extract text from SSE response
 * Note: Can only be called once per response stream. For multiple reads,
 * get the reader manually and read multiple times.
 */
async function readSSEEvent(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    const { value } = await reader!.read();
    return new TextDecoder().decode(value);
}

/**
 * Helper to send JSON-RPC request
 */
async function sendPostRequest(
    baseUrl: URL,
    message: JSONRPCMessage | JSONRPCMessage[],
    sessionId?: string,
    extraHeaders?: Record<string, string>
): Promise<Response> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...extraHeaders
    };

    if (sessionId) {
        headers['mcp-session-id'] = sessionId;
        // After initialization, include the protocol version header
        headers['mcp-protocol-version'] = '2025-03-26';
    }

    return fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(message)
    });
}

function expectErrorResponse(data: unknown, expectedCode: number, expectedMessagePattern: RegExp): void {
    expect(data).toMatchObject({
        jsonrpc: '2.0',
        error: expect.objectContaining({
            code: expectedCode,
            message: expect.stringMatching(expectedMessagePattern)
        })
    });
}

describe.each(zodTestMatrix)('$zodVersionLabel', (entry: ZodMatrixEntry) => {
    /**
     * Helper to create and start test HTTP server with MCP setup
     * This wraps the Web Standards transport in a Node.js HTTP server for testing
     */
    async function createTestServer(config: TestServerConfig = { sessionIdGenerator: () => crypto.randomUUID() }): Promise<{
        server: Server;
        transport: FetchStreamableHTTPServerTransport;
        mcpServer: McpServer;
        baseUrl: URL;
    }> {
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

        mcpServer.tool(
            'greet',
            'A simple greeting tool',
            { name: z.string().describe('Name to greet') },
            async ({ name }): Promise<CallToolResult> => {
                return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
            }
        );

        const transport = new FetchStreamableHTTPServerTransport({
            sessionIdGenerator: config.sessionIdGenerator,
            enableJsonResponse: config.enableJsonResponse ?? false,
            eventStore: config.eventStore,
            sessionStore: config.sessionStore,
            onsessioninitialized: config.onsessioninitialized,
            onsessionclosed: config.onsessionclosed,
            retryInterval: config.retryInterval,
            allowedHosts: config.allowedHosts,
            allowedOrigins: config.allowedOrigins,
            enableDnsRebindingProtection: config.enableDnsRebindingProtection
        });

        await mcpServer.connect(transport);

        const server = createServer(async (req, res) => {
            try {
                // Convert Node.js request to Web Standard Request
                const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                const webRequest = await nodeRequestToWebRequest(req, baseUrl);

                // Handle with transport
                const webResponse = await transport.handleRequest(webRequest as AuthenticatedRequest);

                // Convert Web Standard Response to Node.js response
                webResponseToNodeResponse(webResponse, res);
            } catch (error) {
                console.error('Error handling request:', error);
                if (!res.headersSent) res.writeHead(500).end();
            }
        });

        const baseUrl = await new Promise<URL>(resolve => {
            // Use specified port or 0 for random port
            server.listen(config.port ?? 0, '127.0.0.1', () => {
                const addr = server.address() as AddressInfo;
                resolve(new URL(`http://127.0.0.1:${addr.port}`));
            });
        });

        return { server, transport, mcpServer, baseUrl };
    }

    /**
     * Helper to create and start authenticated test HTTP server with MCP setup
     */
    async function createTestAuthServer(config: TestServerConfig = { sessionIdGenerator: () => crypto.randomUUID() }): Promise<{
        server: Server;
        transport: FetchStreamableHTTPServerTransport;
        mcpServer: McpServer;
        baseUrl: URL;
    }> {
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

        mcpServer.tool(
            'profile',
            'A user profile data tool',
            { active: z.boolean().describe('Profile status') },
            async ({ active }, { authInfo }): Promise<CallToolResult> => {
                return { content: [{ type: 'text', text: `${active ? 'Active' : 'Inactive'} profile from token: ${authInfo?.token}!` }] };
            }
        );

        const transport = new FetchStreamableHTTPServerTransport({
            sessionIdGenerator: config.sessionIdGenerator,
            enableJsonResponse: config.enableJsonResponse ?? false,
            eventStore: config.eventStore,
            onsessioninitialized: config.onsessioninitialized,
            onsessionclosed: config.onsessionclosed
        });

        await mcpServer.connect(transport);

        const server = createServer(async (req, res) => {
            try {
                // Convert Node.js request to Web Standard Request
                const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                const webRequest = (await nodeRequestToWebRequest(req, baseUrl)) as AuthenticatedRequest;

                // Add auth info from Authorization header
                const authHeader = req.headers['authorization'];
                if (authHeader?.startsWith('Bearer ')) {
                    webRequest.auth = { token: authHeader.split(' ')[1] } as AuthInfo;
                }

                // Handle with transport
                const webResponse = await transport.handleRequest(webRequest);

                // Convert Web Standard Response to Node.js response
                webResponseToNodeResponse(webResponse, res);
            } catch (error) {
                console.error('Error handling request:', error);
                if (!res.headersSent) res.writeHead(500).end();
            }
        });

        const baseUrl = await new Promise<URL>(resolve => {
            // Use specified port or 0 for random port
            server.listen(config.port ?? 0, '127.0.0.1', () => {
                const addr = server.address() as AddressInfo;
                resolve(new URL(`http://127.0.0.1:${addr.port}`));
            });
        });

        return { server, transport, mcpServer, baseUrl };
    }

    const { z } = entry;

    describe('FetchStreamableHTTPServerTransport', () => {
        let server: Server;
        let mcpServer: McpServer;
        let transport: FetchStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;

        beforeEach(async () => {
            const result = await createTestServer();
            server = result.server;
            transport = result.transport;
            mcpServer = result.mcpServer;
            baseUrl = result.baseUrl;
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
        });

        async function initializeServer(): Promise<string> {
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            expect(response.status).toBe(200);
            const newSessionId = response.headers.get('mcp-session-id');
            expect(newSessionId).toBeDefined();
            return newSessionId as string;
        }

        it('should initialize server and generate session ID', async () => {
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');
            expect(response.headers.get('mcp-session-id')).toBeDefined();
        });

        it('should reject second initialization request', async () => {
            // First initialize
            const sessionId = await initializeServer();
            expect(sessionId).toBeDefined();

            // Try second initialize
            const secondInitMessage = {
                ...TEST_MESSAGES.initialize,
                id: 'second-init'
            };

            const response = await sendPostRequest(baseUrl, secondInitMessage);

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32600, /Server already initialized/);
        });

        it('should reject batch initialize request', async () => {
            const batchInitMessages: JSONRPCMessage[] = [
                TEST_MESSAGES.initialize,
                {
                    jsonrpc: '2.0',
                    method: 'initialize',
                    params: {
                        clientInfo: { name: 'test-client-2', version: '1.0' },
                        protocolVersion: '2025-03-26'
                    },
                    id: 'init-2'
                }
            ];

            const response = await sendPostRequest(baseUrl, batchInitMessages);

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32600, /Only one initialization request is allowed/);
        });

        it('should handle post requests via sse response correctly', async () => {
            sessionId = await initializeServer();

            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList, sessionId);

            expect(response.status).toBe(200);

            // Read the SSE stream for the response
            const text = await readSSEEvent(response);

            // Parse the SSE event
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.substring(5));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: expect.objectContaining({
                    tools: expect.arrayContaining([
                        expect.objectContaining({
                            name: 'greet',
                            description: 'A simple greeting tool'
                        })
                    ])
                }),
                id: 'tools-1'
            });
        });

        it('should call a tool and return the result', async () => {
            sessionId = await initializeServer();

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: {
                        name: 'Test User'
                    }
                },
                id: 'call-1'
            };

            const response = await sendPostRequest(baseUrl, toolCallMessage, sessionId);
            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.substring(5));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: {
                    content: [
                        {
                            type: 'text',
                            text: 'Hello, Test User!'
                        }
                    ]
                },
                id: 'call-1'
            });
        });

        it('should pass request info to tool callback', async () => {
            sessionId = await initializeServer();

            mcpServer.tool(
                'test-request-info',
                'A simple test tool with request info',
                { name: z.string().describe('Name to greet') },
                async ({ name }, { requestInfo }): Promise<CallToolResult> => {
                    return {
                        content: [
                            { type: 'text', text: `Hello, ${name}!` },
                            { type: 'text', text: `${JSON.stringify(requestInfo)}` }
                        ]
                    };
                }
            );

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'test-request-info',
                    arguments: {
                        name: 'Test User'
                    }
                },
                id: 'call-1'
            };

            const response = await sendPostRequest(baseUrl, toolCallMessage, sessionId);
            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.substring(5));

            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: {
                    content: [
                        { type: 'text', text: 'Hello, Test User!' },
                        { type: 'text', text: expect.any(String) }
                    ]
                },
                id: 'call-1'
            });

            const requestInfo = JSON.parse(eventData.result.content[1].text);
            expect(requestInfo).toMatchObject({
                headers: expect.objectContaining({
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                })
            });
        });

        it('should reject requests without a valid session ID', async () => {
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList);

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32000, /Bad Request/);
            expect(errorData.id).toBeNull();
        });

        it('should reject invalid session ID', async () => {
            // First initialize to be in valid state
            await initializeServer();

            // Now try with invalid session ID
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList, 'invalid-session-id');

            expect(response.status).toBe(404);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32001, /Session not found/);
        });

        it('should establish standalone SSE stream and receive server-initiated messages', async () => {
            // First initialize to get a session ID
            sessionId = await initializeServer();

            // Open a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(sseResponse.status).toBe(200);
            expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');

            // Send a notification (server-initiated message) that should appear on SSE stream
            const notification: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'Test notification' }
            };

            // Send the notification via transport
            await transport.send(notification);

            // Read from the stream and verify we got the notification
            const text = await readSSEEvent(sseResponse);

            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.substring(5));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'Test notification' }
            });
        });

        it('should not close GET SSE stream after sending multiple server notifications', async () => {
            sessionId = await initializeServer();

            // Open a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(sseResponse.status).toBe(200);
            const reader = sseResponse.body?.getReader();

            // Send multiple notifications
            const notification1: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'First notification' }
            };

            // Just send one and verify it comes through - then the stream should stay open
            await transport.send(notification1);

            const { value, done } = await reader!.read();
            const text = new TextDecoder().decode(value);
            expect(text).toContain('First notification');
            expect(done).toBe(false); // Stream should still be open
        });

        it('should reject second SSE stream for the same session', async () => {
            sessionId = await initializeServer();

            // Open first SSE stream
            const firstStream = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(firstStream.status).toBe(200);

            // Try to open a second SSE stream with the same session ID
            const secondStream = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            // Should be rejected
            expect(secondStream.status).toBe(409); // Conflict
            const errorData = await secondStream.json();
            expectErrorResponse(errorData, -32000, /Only one SSE stream is allowed per session/);
        });

        it('should reject GET requests without Accept: text/event-stream header', async () => {
            sessionId = await initializeServer();

            // Try GET without proper Accept header
            const response = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(response.status).toBe(406);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32000, /Client must accept text\/event-stream/);
        });

        it('should reject POST requests without proper Accept header', async () => {
            sessionId = await initializeServer();

            // Try POST without Accept: text/event-stream
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json', // Missing text/event-stream
                    'mcp-session-id': sessionId
                },
                body: JSON.stringify(TEST_MESSAGES.toolsList)
            });

            expect(response.status).toBe(406);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32000, /Client must accept both application\/json and text\/event-stream/);
        });

        it('should reject unsupported Content-Type', async () => {
            sessionId = await initializeServer();

            // Try POST with text/plain Content-Type
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId
                },
                body: 'This is plain text'
            });

            expect(response.status).toBe(415);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32000, /Content-Type must be application\/json/);
        });

        it('should handle JSON-RPC batch notification messages with 202 response', async () => {
            sessionId = await initializeServer();

            // Send batch of notifications (no IDs)
            const batchNotifications: JSONRPCMessage[] = [
                { jsonrpc: '2.0', method: 'someNotification1', params: {} },
                { jsonrpc: '2.0', method: 'someNotification2', params: {} }
            ];
            const response = await sendPostRequest(baseUrl, batchNotifications, sessionId);

            expect(response.status).toBe(202);
        });

        it('should handle batch request messages with SSE stream for responses', async () => {
            sessionId = await initializeServer();

            // Send batch of requests
            const batchRequests: JSONRPCMessage[] = [
                { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'req-1' },
                { jsonrpc: '2.0', method: 'tools/call', params: { name: 'greet', arguments: { name: 'BatchUser' } }, id: 'req-2' }
            ];
            const response = await sendPostRequest(baseUrl, batchRequests, sessionId);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/event-stream');

            const reader = response.body?.getReader();

            // The responses may come in any order or together in one chunk
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Check that both responses were sent on the same stream
            expect(text).toContain('"id":"req-1"');
            expect(text).toContain('"tools"'); // tools/list result
            expect(text).toContain('"id":"req-2"');
            expect(text).toContain('Hello, BatchUser'); // tools/call result
        });

        it('should properly handle invalid JSON data', async () => {
            sessionId = await initializeServer();

            // Send invalid JSON
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId
                },
                body: 'This is not valid JSON'
            });

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32700, /Parse error/);
        });

        it('should return 400 error for invalid JSON-RPC messages', async () => {
            sessionId = await initializeServer();

            // Invalid JSON-RPC (missing required jsonrpc version)
            const invalidMessage = { method: 'tools/list', params: {}, id: 1 }; // missing jsonrpc version
            const response = await sendPostRequest(baseUrl, invalidMessage as JSONRPCMessage, sessionId);

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expect(errorData).toMatchObject({
                jsonrpc: '2.0',
                error: expect.anything()
            });
        });

        it('should reject requests to uninitialized server', async () => {
            // Create a new HTTP server and transport without initializing
            const { server: uninitializedServer, transport: uninitializedTransport, baseUrl: uninitializedUrl } = await createTestServer();

            // No initialization, just send a request directly
            const uninitializedMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'uninitialized-test'
            };

            // Send a request to uninitialized server
            const response = await sendPostRequest(uninitializedUrl, uninitializedMessage, 'any-session-id');

            expect(response.status).toBe(400);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32000, /Server not initialized/);

            // Cleanup
            await stopTestServer({ server: uninitializedServer, transport: uninitializedTransport });
        });

        it('should send response messages to the connection that sent the request', async () => {
            sessionId = await initializeServer();

            const message1: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'req-1'
            };

            const message2: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'Connection2' }
                },
                id: 'req-2'
            };

            // Make two concurrent fetch connections for different requests
            const req1 = sendPostRequest(baseUrl, message1, sessionId);
            const req2 = sendPostRequest(baseUrl, message2, sessionId);

            // Get both responses
            const [response1, response2] = await Promise.all([req1, req2]);
            const reader1 = response1.body?.getReader();
            const reader2 = response2.body?.getReader();

            // Read responses from each stream (requires each receives its specific response)
            const { value: value1 } = await reader1!.read();
            const text1 = new TextDecoder().decode(value1);
            expect(text1).toContain('"id":"req-1"');
            expect(text1).toContain('"tools"'); // tools/list result

            const { value: value2 } = await reader2!.read();
            const text2 = new TextDecoder().decode(value2);
            expect(text2).toContain('"id":"req-2"');
            expect(text2).toContain('Hello, Connection2'); // tools/call result
        });

        it('should keep stream open after sending server notifications', async () => {
            sessionId = await initializeServer();

            // Open a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            // Send several server-initiated notifications
            await transport.send({
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'First notification' }
            });

            await transport.send({
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'Second notification' }
            });

            // Stream should still be open - it should not close after sending notifications
            expect(sseResponse.bodyUsed).toBe(false);
        });

        // The current implementation will close the entire transport for DELETE
        // Creating a temporary transport/server where we don't care if it gets closed
        it('should properly handle DELETE requests and close session', async () => {
            // Setup a temporary server for this test
            const tempResult = await createTestServer();
            const tempServer = tempResult.server;
            const tempUrl = tempResult.baseUrl;

            // Initialize to get a session ID
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            // Now DELETE the session
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(deleteResponse.status).toBe(200);

            // Clean up - don't wait indefinitely for server close
            tempServer.close();
        });

        it('should reject DELETE requests with invalid session ID', async () => {
            // Initialize the server first to activate it
            sessionId = await initializeServer();

            // Try to delete with invalid session ID
            const response = await fetch(baseUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': 'invalid-session-id',
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(response.status).toBe(404);
            const errorData = await response.json();
            expectErrorResponse(errorData, -32001, /Session not found/);
        });

        describe('protocol version header validation', () => {
            it('should accept requests with matching protocol version', async () => {
                sessionId = await initializeServer();

                // Send request with matching protocol version
                const response = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList, sessionId);

                expect(response.status).toBe(200);
            });

            it('should accept requests without protocol version header', async () => {
                sessionId = await initializeServer();

                // Send request without protocol version header
                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'mcp-session-id': sessionId
                        // No mcp-protocol-version header
                    },
                    body: JSON.stringify(TEST_MESSAGES.toolsList)
                });

                expect(response.status).toBe(200);
            });

            it('should reject requests with unsupported protocol version', async () => {
                sessionId = await initializeServer();

                // Send request with unsupported protocol version
                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': '1999-01-01' // Unsupported version
                    },
                    body: JSON.stringify(TEST_MESSAGES.toolsList)
                });

                expect(response.status).toBe(400);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32000, /Bad Request: Unsupported protocol version \(supported versions: .+\)/);
            });

            it('should accept when protocol version differs from negotiated version', async () => {
                sessionId = await initializeServer();

                // Send request with different but supported protocol version
                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': '2024-11-05' // Different but supported version
                    },
                    body: JSON.stringify(TEST_MESSAGES.toolsList)
                });

                // Request should still succeed
                expect(response.status).toBe(200);
            });

            it('should handle protocol version validation for GET requests', async () => {
                sessionId = await initializeServer();

                // GET request with unsupported protocol version
                const response = await fetch(baseUrl, {
                    method: 'GET',
                    headers: {
                        Accept: 'text/event-stream',
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': 'invalid-version'
                    }
                });

                expect(response.status).toBe(400);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32000, /Bad Request: Unsupported protocol version \(supported versions: .+\)/);
            });

            it('should handle protocol version validation for DELETE requests', async () => {
                sessionId = await initializeServer();

                // DELETE request with unsupported protocol version
                const response = await fetch(baseUrl, {
                    method: 'DELETE',
                    headers: {
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': 'invalid-version'
                    }
                });

                expect(response.status).toBe(400);
                const errorData = await response.json();
                expectErrorResponse(errorData, -32000, /Bad Request: Unsupported protocol version \(supported versions: .+\)/);
            });
        });
    });

    describe('FetchStreamableHTTPServerTransport with AuthInfo', () => {
        let server: Server;
        let transport: FetchStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;

        beforeEach(async () => {
            const result = await createTestAuthServer();
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
        });

        async function initializeServer(): Promise<string> {
            const response = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            expect(response.status).toBe(200);
            const newSessionId = response.headers.get('mcp-session-id');
            expect(newSessionId).toBeDefined();
            return newSessionId as string;
        }

        it('should call a tool with authInfo', async () => {
            sessionId = await initializeServer();

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'profile',
                    arguments: { active: true }
                },
                id: 'call-1'
            };

            const response = await sendPostRequest(baseUrl, toolCallMessage, sessionId, { authorization: 'Bearer test-token' });
            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.substring(5));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: {
                    content: [
                        {
                            type: 'text',
                            text: 'Active profile from token: test-token!'
                        }
                    ]
                },
                id: 'call-1'
            });
        });

        it('should calls tool without authInfo when it is optional', async () => {
            sessionId = await initializeServer();

            const toolCallMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: 'profile',
                    arguments: { active: false }
                },
                id: 'call-1'
            };

            const response = await sendPostRequest(baseUrl, toolCallMessage, sessionId);
            expect(response.status).toBe(200);

            const text = await readSSEEvent(response);
            const eventLines = text.split('\n');
            const dataLine = eventLines.find(line => line.startsWith('data:'));
            expect(dataLine).toBeDefined();

            const eventData = JSON.parse(dataLine!.substring(5));
            expect(eventData).toMatchObject({
                jsonrpc: '2.0',
                result: {
                    content: [
                        {
                            type: 'text',
                            text: 'Inactive profile from token: undefined!'
                        }
                    ]
                },
                id: 'call-1'
            });
        });
    });

    // Test JSON Response Mode
    describe('FetchStreamableHTTPServerTransport with JSON Response Mode', () => {
        let server: Server;
        let transport: FetchStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;

        beforeEach(async () => {
            const result = await createTestServer({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;

            // Initialize and get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            sessionId = initResponse.headers.get('mcp-session-id') as string;
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
        });

        it('should return JSON response for a single request', async () => {
            const toolsListMessage: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'json-req-1'
            };

            const response = await sendPostRequest(baseUrl, toolsListMessage, sessionId);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/json');

            const result = await response.json();
            expect(result).toMatchObject({
                jsonrpc: '2.0',
                result: expect.objectContaining({
                    tools: expect.arrayContaining([expect.objectContaining({ name: 'greet' })])
                }),
                id: 'json-req-1'
            });
        });

        it('should return JSON response for batch requests', async () => {
            const batchMessages: JSONRPCMessage[] = [
                { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'batch-1' },
                { jsonrpc: '2.0', method: 'tools/call', params: { name: 'greet', arguments: { name: 'JSON' } }, id: 'batch-2' }
            ];

            const response = await sendPostRequest(baseUrl, batchMessages, sessionId);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/json');

            const results = await response.json();
            expect(Array.isArray(results)).toBe(true);
            expect(results).toHaveLength(2);

            // Batch responses can come in any order
            const listResponse = results.find((r: { id?: string }) => r.id === 'batch-1');
            const callResponse = results.find((r: { id?: string }) => r.id === 'batch-2');

            expect(listResponse).toEqual(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    id: 'batch-1',
                    result: expect.objectContaining({
                        tools: expect.arrayContaining([expect.objectContaining({ name: 'greet' })])
                    })
                })
            );

            expect(callResponse).toEqual(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    id: 'batch-2',
                    result: expect.objectContaining({
                        content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Hello, JSON!' })])
                    })
                })
            );
        });
    });

    // Test stateless mode
    describe('FetchStreamableHTTPServerTransport in stateless mode', () => {
        let server: Server;
        let transport: FetchStreamableHTTPServerTransport;
        let baseUrl: URL;

        beforeEach(async () => {
            const result = await createTestServer({ sessionIdGenerator: undefined });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
        });

        it('should operate without session ID validation', async () => {
            // Initialize the server first
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            expect(initResponse.status).toBe(200);
            // Should NOT have session ID header in stateless mode
            expect(initResponse.headers.get('mcp-session-id')).toBeNull();

            // Try request without session ID - should work in stateless mode
            const toolsResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.toolsList);

            expect(toolsResponse.status).toBe(200);
        });

        it('should handle POST requests with various session IDs in stateless mode', async () => {
            await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            // Try with a random session ID - should be accepted
            const response1 = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': 'random-id-1'
                },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 't1' })
            });
            expect(response1.status).toBe(200);

            // Try with another random session ID - should also be accepted
            const response2 = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': 'different-id-2'
                },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 't2' })
            });
            expect(response2.status).toBe(200);
        });

        it('should reject second SSE stream even in stateless mode', async () => {
            // Despite no session ID requirement, the transport still only allows
            // one standalone SSE stream at a time

            // Initialize the server first
            await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);

            // Open first SSE stream
            const stream1 = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-protocol-version': '2025-03-26'
                }
            });
            expect(stream1.status).toBe(200);

            // Open second SSE stream - should still be rejected, stateless mode still only allows one
            const stream2 = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-protocol-version': '2025-03-26'
                }
            });
            expect(stream2.status).toBe(409); // Conflict - only one stream allowed
        });
    });

    // Test resumability support
    describe('FetchStreamableHTTPServerTransport with resumability', () => {
        let server: Server;
        let transport: FetchStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;
        let mcpServer: McpServer;
        const storedEvents: Map<string, { eventId: string; message: JSONRPCMessage }> = new Map();

        // Simple implementation of EventStore
        const eventStore: EventStore = {
            async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
                const eventId = `${streamId}_${crypto.randomUUID()}`;
                storedEvents.set(eventId, { eventId, message });
                return eventId;
            },

            async replayEventsAfter(
                lastEventId: EventId,
                {
                    send
                }: {
                    send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
                }
            ): Promise<StreamId> {
                const streamId = lastEventId.split('_')[0];
                // Extract stream ID from the event ID
                // For test simplicity, just return all events with matching streamId that aren't the lastEventId
                for (const [eventId, { message }] of storedEvents.entries()) {
                    if (eventId.startsWith(streamId) && eventId !== lastEventId) {
                        await send(eventId, message);
                    }
                }
                return streamId;
            }
        };

        beforeEach(async () => {
            storedEvents.clear();
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                eventStore
            });

            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Initialize the server
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();
        });

        afterEach(async () => {
            await stopTestServer({ server, transport });
            storedEvents.clear();
        });

        it('should store and include event IDs in server SSE messages', async () => {
            // Open a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(sseResponse.status).toBe(200);
            expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');

            // Send a notification that should be stored with an event ID
            const notification: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'notifications/message',
                params: { level: 'info', data: 'Test notification with event ID' }
            };

            // Send the notification via transport
            await transport.send(notification);

            // Read from the stream and verify we got the notification with an event ID
            const reader = sseResponse.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // The response should contain an event ID
            expect(text).toContain('id: ');
            expect(text).toContain('"method":"notifications/message"');

            // Extract the event ID
            const idMatch = text.match(/id: ([^\n]+)/);
            expect(idMatch).toBeTruthy();

            // Verify the event was stored
            const eventId = idMatch![1];
            expect(storedEvents.has(eventId)).toBe(true);
            const storedEvent = storedEvents.get(eventId);
            expect(eventId.startsWith('_GET_stream')).toBe(true);
            expect(storedEvent?.message).toMatchObject(notification);
        });

        it('should store and replay MCP server tool notifications', async () => {
            // Establish a standalone SSE stream
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                }
            });
            expect(sseResponse.status).toBe(200);

            // Send a server notification through the MCP server
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'First notification from MCP server' });

            // Read the notification from the SSE stream
            const reader = sseResponse.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Verify the notification was sent with an event ID
            expect(text).toContain('id: ');
            expect(text).toContain('First notification from MCP server');

            // Extract the event ID
            const idMatch = text.match(/id: ([^\n]+)/);
            expect(idMatch).toBeTruthy();
            const firstEventId = idMatch![1];

            // Send a second notification
            await mcpServer.server.sendLoggingMessage({ level: 'info', data: 'Second notification from MCP server' });

            // Close the first SSE stream to simulate a disconnect
            await reader!.cancel();

            // Reconnect with the Last-Event-ID to get missed messages
            const reconnectResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26',
                    'last-event-id': firstEventId
                }
            });

            expect(reconnectResponse.status).toBe(200);

            // Read the replayed notification
            const reconnectReader = reconnectResponse.body?.getReader();
            const reconnectData = await reconnectReader!.read();
            const reconnectText = new TextDecoder().decode(reconnectData.value);

            // Verify we received the second notification that was sent after our stored eventId
            expect(reconnectText).toContain('Second notification from MCP server');
            expect(reconnectText).toContain('id: ');
        });
    });

    // Test SSE priming events for POST streams
    describe('FetchStreamableHTTPServerTransport POST SSE priming events', () => {
        let server: Server;
        let transport: FetchStreamableHTTPServerTransport;
        let baseUrl: URL;
        let sessionId: string;
        let mcpServer: McpServer;

        // Simple eventStore for priming event tests
        const createEventStore = (): EventStore => {
            const storedEvents = new Map<string, { eventId: string; message: JSONRPCMessage; streamId: string }>();
            return {
                async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
                    const eventId = `${streamId}::${Date.now()}_${crypto.randomUUID()}`;
                    storedEvents.set(eventId, { eventId, message, streamId });
                    return eventId;
                },
                async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
                    const event = storedEvents.get(eventId);
                    return event?.streamId;
                },
                async replayEventsAfter(
                    lastEventId: EventId,
                    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
                ): Promise<StreamId> {
                    const event = storedEvents.get(lastEventId);
                    const streamId = event?.streamId || lastEventId.split('::')[0];
                    const eventsToReplay: Array<[string, { message: JSONRPCMessage }]> = [];
                    for (const [eventId, data] of storedEvents.entries()) {
                        if (data.streamId === streamId && eventId > lastEventId) {
                            eventsToReplay.push([eventId, data]);
                        }
                    }
                    eventsToReplay.sort(([a], [b]) => a.localeCompare(b));
                    for (const [eventId, { message }] of eventsToReplay) {
                        if (Object.keys(message).length > 0) {
                            await send(eventId, message);
                        }
                    }
                    return streamId;
                }
            };
        };

        afterEach(async () => {
            if (server && transport) {
                await stopTestServer({ server, transport });
            }
        });

        it('should send priming event with retry field on POST SSE stream', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 5000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Send a tool call request
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 100,
                method: 'tools/call',
                params: { name: 'greet', arguments: { name: 'Test' } }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);
            expect(postResponse.headers.get('content-type')).toBe('text/event-stream');

            // Read the priming event
            const reader = postResponse.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Verify priming event has id and retry field
            expect(text).toContain('id: ');
            expect(text).toContain('retry: 5000');
            expect(text).toContain('data: ');
        });

        it('should send priming event without retry field when retryInterval is not configured', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                eventStore: createEventStore()
                // No retryInterval
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Send a tool call request
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 100,
                method: 'tools/call',
                params: { name: 'greet', arguments: { name: 'Test' } }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            // Read the priming event
            const reader = postResponse.body?.getReader();
            const { value } = await reader!.read();
            const text = new TextDecoder().decode(value);

            // Priming event should have id field but NOT retry field
            expect(text).toContain('id: ');
            expect(text).toContain('data: ');
            expect(text).not.toContain('retry:');
        });

        it('should close POST SSE stream when extra.closeSSEStream is called', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 1000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Track when stream close is called and tool completes
            let streamCloseCalled = false;
            let toolResolve: () => void;
            const toolCompletePromise = new Promise<void>(resolve => {
                toolResolve = resolve;
            });

            // Register a tool that closes its own SSE stream via extra callback
            mcpServer.tool('close-stream-tool', 'Closes its own stream', {}, async (_args, extra) => {
                // Close the SSE stream for this request
                extra.closeSSEStream?.();
                streamCloseCalled = true;

                // Wait before returning so we can observe the stream closure
                await toolCompletePromise;
                return { content: [{ type: 'text', text: 'Done' }] };
            });

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Send a tool call request
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 100,
                method: 'tools/call',
                params: { name: 'close-stream-tool', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            const reader = postResponse.body?.getReader();

            // Read the priming event
            await reader!.read();

            // Wait a moment for the tool to call closeSSEStream
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(streamCloseCalled).toBe(true);

            // Stream should now be closed
            const { done } = await reader!.read();
            expect(done).toBe(true);

            // Clean up - resolve the tool promise
            toolResolve!();
        });

        it('should provide closeSSEStream callback in extra when eventStore is configured', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 1000
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Track whether closeSSEStream callback was provided
            let receivedCloseSSEStream: (() => void) | undefined;

            // Register a tool that captures the extra.closeSSEStream callback
            mcpServer.tool('test-callback-tool', 'Test tool', {}, async (_args, extra) => {
                receivedCloseSSEStream = extra.closeSSEStream;
                return { content: [{ type: 'text', text: 'Done' }] };
            });

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Call the tool
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 200,
                method: 'tools/call',
                params: { name: 'test-callback-tool', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            // Read all events to completion
            const reader = postResponse.body?.getReader();
            while (true) {
                const { done } = await reader!.read();
                if (done) break;
            }

            // Verify closeSSEStream callback was provided
            expect(receivedCloseSSEStream).toBeDefined();
            expect(typeof receivedCloseSSEStream).toBe('function');
        });

        it('should NOT provide closeSSEStream callback when eventStore is NOT configured', async () => {
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID()
                // No eventStore
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;
            mcpServer = result.mcpServer;

            // Track whether closeSSEStream callback was provided
            let receivedCloseSSEStream: (() => void) | undefined;

            // Register a tool that captures the extra.closeSSEStream callback
            mcpServer.tool('test-no-callback-tool', 'Test tool', {}, async (_args, extra) => {
                receivedCloseSSEStream = extra.closeSSEStream;
                return { content: [{ type: 'text', text: 'Done' }] };
            });

            // Initialize to get session ID
            const initResponse = await sendPostRequest(baseUrl, TEST_MESSAGES.initialize);
            sessionId = initResponse.headers.get('mcp-session-id') as string;
            expect(sessionId).toBeDefined();

            // Call the tool
            const toolCallRequest: JSONRPCMessage = {
                jsonrpc: '2.0',
                id: 201,
                method: 'tools/call',
                params: { name: 'test-no-callback-tool', arguments: {} }
            };

            const postResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                    'mcp-session-id': sessionId,
                    'mcp-protocol-version': '2025-03-26'
                },
                body: JSON.stringify(toolCallRequest)
            });

            expect(postResponse.status).toBe(200);

            // Read all events to completion
            const reader = postResponse.body?.getReader();
            while (true) {
                const { done } = await reader!.read();
                if (done) break;
            }

            // Verify closeSSEStream callback was NOT provided
            expect(receivedCloseSSEStream).toBeUndefined();
        });
    });

    // Test onsessionclosed callback
    describe('FetchStreamableHTTPServerTransport onsessionclosed callback', () => {
        it('should call onsessionclosed callback when session is closed via DELETE', async () => {
            const mockCallback = vi.fn();

            // Create server with onsessionclosed callback
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessionclosed: mockCallback
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to get a session ID
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');
            expect(tempSessionId).toBeDefined();

            // DELETE the session
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(deleteResponse.status).toBe(200);
            expect(mockCallback).toHaveBeenCalledWith(tempSessionId);
            expect(mockCallback).toHaveBeenCalledTimes(1);

            // Clean up
            tempServer.close();
        });

        it('should not call onsessionclosed callback when not provided', async () => {
            // Create server without onsessionclosed callback
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID()
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to get a session ID
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            // DELETE the session - should not throw error
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(deleteResponse.status).toBe(200);

            // Clean up
            tempServer.close();
        });

        it('should not call onsessionclosed callback for invalid session DELETE', async () => {
            const mockCallback = vi.fn();

            // Create server with onsessionclosed callback
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessionclosed: mockCallback
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to get a valid session
            await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);

            // Try to DELETE with invalid session ID
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': 'invalid-session-id',
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(deleteResponse.status).toBe(404);
            expect(mockCallback).not.toHaveBeenCalled();

            // Clean up
            tempServer.close();
        });
    });

    // Test async callbacks for onsessioninitialized and onsessionclosed
    describe('FetchStreamableHTTPServerTransport async callbacks', () => {
        it('should support async onsessioninitialized callback', async () => {
            const initializationOrder: string[] = [];

            // Create server with async onsessioninitialized callback
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: async (sessionId: string) => {
                    initializationOrder.push('async-start');
                    // Simulate async operation
                    await new Promise(resolve => setTimeout(resolve, 10));
                    initializationOrder.push('async-end');
                    initializationOrder.push(sessionId);
                }
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to trigger the callback
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            // Give time for async callback to complete
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(initializationOrder).toEqual(['async-start', 'async-end', tempSessionId]);

            // Clean up
            tempServer.close();
        });

        it('should support sync onsessioninitialized callback (backwards compatibility)', async () => {
            const capturedSessionId: string[] = [];

            // Create server with sync onsessioninitialized callback
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: (sessionId: string) => {
                    capturedSessionId.push(sessionId);
                }
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to trigger the callback
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');

            expect(capturedSessionId).toEqual([tempSessionId]);

            // Clean up
            tempServer.close();
        });

        it('should support async onsessionclosed callback', async () => {
            const closureOrder: string[] = [];

            // Create server with async onsessionclosed callback
            const result = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessionclosed: async (sessionId: string) => {
                    closureOrder.push('async-close-start');
                    // Simulate async operation
                    await new Promise(resolve => setTimeout(resolve, 10));
                    closureOrder.push('async-close-end');
                    closureOrder.push(sessionId);
                }
            });

            const tempServer = result.server;
            const tempUrl = result.baseUrl;

            // Initialize to get a session ID
            const initResponse = await sendPostRequest(tempUrl, TEST_MESSAGES.initialize);
            const tempSessionId = initResponse.headers.get('mcp-session-id');
            expect(tempSessionId).toBeDefined();

            // DELETE the session
            const deleteResponse = await fetch(tempUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': tempSessionId || '',
                    'mcp-protocol-version': '2025-03-26'
                }
            });

            expect(deleteResponse.status).toBe(200);

            // Give time for async callback to complete
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(closureOrder).toEqual(['async-close-start', 'async-close-end', tempSessionId]);

            // Clean up
            tempServer.close();
        });
    });

    // Test DNS rebinding protection
    describe('FetchStreamableHTTPServerTransport DNS rebinding protection', () => {
        let server: Server;
        let transport: FetchStreamableHTTPServerTransport;
        let baseUrl: URL;

        afterEach(async () => {
            if (server && transport) {
                await stopTestServer({ server, transport });
            }
        });

        describe('Host header validation', () => {
            it('should accept requests with allowed host headers', async () => {
                // Get a free port first, then create server on that specific port
                const port = await getFreePort();

                const result = await createTestServer({
                    sessionIdGenerator: undefined,
                    allowedHosts: [`127.0.0.1:${port}`],
                    enableDnsRebindingProtection: true,
                    port
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                // Note: fetch() automatically sets Host header to match the URL
                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response.status).toBe(200);
            });

            it('should reject requests with disallowed host headers', async () => {
                // Test DNS rebinding protection by creating a server that only allows example.com
                // but we're connecting via localhost, so it should be rejected
                const result = await createTestServer({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['example.com:3001'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response.status).toBe(403);
                const body = await response.json();
                expect(body.error.message).toContain('Invalid Host header:');
            });

            it('should reject GET requests with disallowed host headers', async () => {
                const result = await createTestServer({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['example.com:3001'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'GET',
                    headers: {
                        Accept: 'text/event-stream'
                    }
                });

                expect(response.status).toBe(403);
            });
        });

        describe('Origin header validation', () => {
            it('should accept requests with allowed origin headers', async () => {
                const result = await createTestServer({
                    sessionIdGenerator: undefined,
                    allowedOrigins: ['http://localhost:3000', 'https://example.com'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Origin: 'http://localhost:3000'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response.status).toBe(200);
            });

            it('should reject requests with disallowed origin headers', async () => {
                const result = await createTestServer({
                    sessionIdGenerator: undefined,
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: true
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Origin: 'http://evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response.status).toBe(403);
                const body = await response.json();
                expect(body.error.message).toBe('Invalid Origin header: http://evil.com');
            });
        });

        describe('enableDnsRebindingProtection option', () => {
            it('should skip all validations when enableDnsRebindingProtection is false', async () => {
                const result = await createTestServer({
                    sessionIdGenerator: undefined,
                    allowedHosts: ['localhost'],
                    allowedOrigins: ['http://localhost:3000'],
                    enableDnsRebindingProtection: false
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                const response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Origin: 'http://evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                // Should pass even with invalid headers because protection is disabled
                expect(response.status).toBe(200);
            });
        });

        describe('Combined validations', () => {
            it('should validate both host and origin when both are configured', async () => {
                const port = await getFreePort();
                const result = await createTestServer({
                    sessionIdGenerator: undefined,
                    allowedHosts: [`127.0.0.1:${port}`],
                    allowedOrigins: [`http://127.0.0.1:${port}`],
                    enableDnsRebindingProtection: true,
                    port
                });
                server = result.server;
                transport = result.transport;
                baseUrl = result.baseUrl;

                // Test with invalid origin (host will be automatically correct via fetch)
                const response1 = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Origin: 'http://evil.com'
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response1.status).toBe(403);
                const body1 = await response1.json();
                expect(body1.error.message).toBe('Invalid Origin header: http://evil.com');

                // Test with valid origin
                const response2 = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        Origin: `http://127.0.0.1:${port}`
                    },
                    body: JSON.stringify(TEST_MESSAGES.initialize)
                });

                expect(response2.status).toBe(200);
            });
        });
    });

    /**
     * Tests for SessionStore functionality (distributed/serverless mode)
     */
    describe('FetchStreamableHTTPServerTransport with SessionStore', () => {
        let server: Server;
        let transport: FetchStreamableHTTPServerTransport;
        let baseUrl: URL;

        afterEach(async () => {
            if (server && transport) {
                await stopTestServer({ server, transport });
            }
        });

        /**
         * Creates an in-memory session store for testing
         */
        function createInMemorySessionStore(): SessionStore & { sessions: Map<string, SessionState> } {
            const sessions = new Map<string, SessionState>();
            return {
                sessions,
                get: async (sessionId: string) => sessions.get(sessionId),
                save: async (sessionId: string, state: SessionState) => {
                    sessions.set(sessionId, state);
                },
                delete: async (sessionId: string) => {
                    sessions.delete(sessionId);
                }
            };
        }

        it('should save session state to store on initialization', async () => {
            const sessionStore = createInMemorySessionStore();
            const result = await createTestServer({
                sessionIdGenerator: () => 'test-session-123',
                sessionStore
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;

            // Initialize the session
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify(TEST_MESSAGES.initialize)
            });

            expect(response.status).toBe(200);

            // Verify session was saved to store
            const savedSession = await sessionStore.get('test-session-123');
            expect(savedSession).toBeDefined();
            expect(savedSession?.initialized).toBe(true);
            expect(savedSession?.protocolVersion).toBeDefined();
            expect(savedSession?.createdAt).toBeGreaterThan(0);
        });

        it('should validate session from store for subsequent requests', async () => {
            const sessionStore = createInMemorySessionStore();
            const result = await createTestServer({
                sessionIdGenerator: () => 'test-session-456',
                sessionStore
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;

            // Initialize the session
            const initResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify(TEST_MESSAGES.initialize)
            });
            expect(initResponse.status).toBe(200);
            const sessionId = initResponse.headers.get('mcp-session-id');

            // Make a subsequent request with valid session ID
            const listResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId!
                },
                body: JSON.stringify(TEST_MESSAGES.toolsList)
            });
            expect(listResponse.status).toBe(200);
        });

        it('should reject requests with invalid session ID when using session store', async () => {
            const sessionStore = createInMemorySessionStore();
            const result = await createTestServer({
                sessionIdGenerator: () => 'test-session-789',
                sessionStore
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;

            // Initialize the session first
            const initResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify(TEST_MESSAGES.initialize)
            });
            expect(initResponse.status).toBe(200);

            // Try to make a request with invalid session ID
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': 'invalid-session-id'
                },
                body: JSON.stringify(TEST_MESSAGES.toolsList)
            });

            expect(response.status).toBe(404);
            const body = await response.json();
            expect(body.error.message).toBe('Session not found');
        });

        it('should delete session from store on DELETE request', async () => {
            const sessionStore = createInMemorySessionStore();
            const result = await createTestServer({
                sessionIdGenerator: () => 'test-session-delete',
                sessionStore
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;

            // Initialize the session
            const initResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify(TEST_MESSAGES.initialize)
            });
            expect(initResponse.status).toBe(200);
            const sessionId = initResponse.headers.get('mcp-session-id');

            // Verify session exists in store
            expect(await sessionStore.get(sessionId!)).toBeDefined();

            // Delete the session
            const deleteResponse = await fetch(baseUrl, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': sessionId!
                }
            });
            expect(deleteResponse.status).toBe(200);

            // Verify session was deleted from store
            expect(await sessionStore.get(sessionId!)).toBeUndefined();
        });

        it('should allow new transport instances to validate existing sessions (serverless mode)', async () => {
            // This test simulates serverless behavior where each request
            // is handled by a fresh transport instance
            const sessionStore = createInMemorySessionStore();

            // First, initialize using one transport instance
            const result1 = await createTestServer({
                sessionIdGenerator: () => 'serverless-session-123',
                sessionStore
            });
            server = result1.server;
            transport = result1.transport;
            baseUrl = result1.baseUrl;

            const initResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify(TEST_MESSAGES.initialize)
            });
            expect(initResponse.status).toBe(200);
            const sessionId = initResponse.headers.get('mcp-session-id');

            // Stop the first server
            await stopTestServer({ server, transport });

            // Create a NEW transport instance with same sessionStore (simulates new serverless invocation)
            const result2 = await createTestServer({
                sessionIdGenerator: () => crypto.randomUUID(), // Different generator, doesn't matter
                sessionStore // Same session store
            });
            server = result2.server;
            transport = result2.transport;
            baseUrl = result2.baseUrl;

            // The new transport should be able to validate the existing session from the store
            const listResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'mcp-session-id': sessionId!
                },
                body: JSON.stringify(TEST_MESSAGES.toolsList)
            });

            expect(listResponse.status).toBe(200);
        });

        it('should work with GET SSE stream when session is hydrated from store', async () => {
            const sessionStore = createInMemorySessionStore();
            const result = await createTestServer({
                sessionIdGenerator: () => 'sse-session-123',
                sessionStore
            });
            server = result.server;
            transport = result.transport;
            baseUrl = result.baseUrl;

            // Initialize session
            const initResponse = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify(TEST_MESSAGES.initialize)
            });
            expect(initResponse.status).toBe(200);
            const sessionId = initResponse.headers.get('mcp-session-id');

            // Open SSE stream with session ID
            const sseResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'mcp-session-id': sessionId!
                }
            });

            expect(sseResponse.status).toBe(200);
            expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');
        });
    });
});
