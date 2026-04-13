# TinyTelegram Web Client

A lightweight web client for the TinyTelegram distributed messaging system.

## Features

- Real-time WebSocket communication with gateways
- PTS (Progressive Total Sequence) tracking for message ordering
- Multi-tab support for testing multi-device sync
- Automatic reconnection with backoff
- Local state persistence (localStorage)
- Gap detection for triggering getDiff

## Quick Start

1. **Start the web server:**
   ```bash
   cd web-client
   node server.js
   ```

2. **Make sure your backend is running:**
   ```bash
   cd ..
   docker-compose up
   ```

3. **Open in browser:**
   - Navigate to `http://localhost:3000`
   - Enter a user ID (e.g., "alice")
   - Gateway URL defaults to `ws://localhost:8080/ws`
   - Click "Connect"

## Testing Multi-Device Sync

1. Open multiple browser tabs to `http://localhost:3000`
2. Connect each tab with the same user ID (e.g., "alice")
3. Send a message from one tab
4. Observe it appearing in all tabs with consistent PTS values

## Testing Cross-Gateway Routing

1. Start system with multiple gateways (use `docker-compose.yml`)
2. Open two tabs with different users:
   - Tab 1: User "alice"
   - Tab 2: User "bob"
3. Send message from alice to bob
4. Check logs to see cross-gateway routing via gRPC

## Testing Failover

1. Connect a user (e.g., "alice")
2. While connected, kill the gateway:
   ```bash
   docker-compose stop gateway1
   ```
3. Observe the client automatically reconnecting to another gateway
4. All missed messages should sync via getDiff (when implemented)

## Architecture

- **index.html** - UI layout and styling
- **app.js** - WebSocket client logic and PTS management
- **server.js** - Simple Node.js static file server

## PTS (Progressive Total Sequence) Explained

Each user has an independent PTS counter that increments for every message they send or receive:

- **sender_pts**: Sender's message counter (increases when you send)
- **receiver_pts**: Receiver's message counter (increases when you receive)

When reconnecting, clients call `getDiff(local_pts)` to fetch all messages with `pts > local_pts`, ensuring no gaps in the message stream.

## Current Limitations

- getDiff is currently only available via gRPC (not exposed to web client)
- No authentication system (uses simple user_id)
- Messages not persisted in browser beyond localStorage
- No read receipts or typing indicators

## Future Enhancements

- IndexedDB for better offline storage
- Service Worker for background sync
- E2E encryption
- Group chats
- File sharing
