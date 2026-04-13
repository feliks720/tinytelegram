// TinyTelegram Web Client
// Demonstrates distributed messaging with PTS-based sync

class TinyTelegramClient {
    constructor() {
        this.ws = null;
        this.userId = null;
        this.gatewayUrl = null;
        this.localPts = 0;
        this.messages = new Map(); // msgId -> message
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;

        this.initializeUI();
    }

    initializeUI() {
        // Login form
        document.getElementById('login-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const userId = document.getElementById('user-id').value.trim();
            const gatewayUrl = document.getElementById('gateway-url').value.trim();
            this.connect(userId, gatewayUrl);
        });

        // Message form
        document.getElementById('message-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const receiverId = document.getElementById('receiver-id').value.trim();
            const content = document.getElementById('message-input').value.trim();
            if (receiverId && content) {
                this.sendMessage(receiverId, content);
                document.getElementById('message-input').value = '';
            }
        });

        // Load saved state from localStorage
        this.loadState();
    }

    connect(userId, gatewayUrl) {
        this.userId = userId;
        this.gatewayUrl = gatewayUrl;

        // Build WebSocket URL with user_id parameter
        const wsUrl = `${gatewayUrl}?user_id=${encodeURIComponent(userId)}`;

        console.log(`Connecting to ${wsUrl}...`);
        this.updateStatus('connecting', 'Connecting...');

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => this.onOpen();
            this.ws.onmessage = (event) => this.onMessage(event);
            this.ws.onerror = (error) => this.onError(error);
            this.ws.onclose = () => this.onClose();
        } catch (error) {
            console.error('WebSocket connection error:', error);
            this.updateStatus('disconnected', 'Connection failed');
            alert('Failed to connect. Please check the gateway URL.');
        }
    }

    onOpen() {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.updateStatus('connected', 'Connected');

        // Show chat screen
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('chat-screen').classList.add('active');

        // Update info bar
        document.getElementById('info-user').textContent = this.userId;
        document.getElementById('info-gateway').textContent = this.gatewayUrl.replace('ws://', '');
        document.getElementById('info-pts').textContent = this.localPts;

        // Add system message
        this.addSystemMessage(`Connected as ${this.userId}`);

        // Call getDiff to sync missed messages
        // Note: getDiff is only available via gRPC in current implementation
        // For demo purposes, we'll show this would be called
        console.log(`Would call getDiff(${this.localPts}) here to sync missed messages`);

        this.saveState();
    }

    onMessage(event) {
        try {
            const data = JSON.parse(event.data);
            console.log('Received:', data);

            if (data.type === 'ack') {
                // Acknowledgment for sent message
                this.handleAck(data);
            } else if (data.message) {
                // Incoming message (PersistedMessage from proto)
                this.handleIncomingMessage(data);
            } else {
                console.warn('Unknown message format:', data);
            }
        } catch (error) {
            console.error('Error parsing message:', error, event.data);
        }
    }

    handleAck(ack) {
        // Update local PTS for sent message
        if (ack.sender_pts) {
            this.updatePts(ack.sender_pts);
        }
        console.log(`Message ${ack.message_id} acknowledged, pts=${ack.sender_pts}`);
    }

    handleIncomingMessage(persistedMsg) {
        // Extract message data
        const msgId = persistedMsg.id;
        const msg = persistedMsg.message;
        const senderId = msg.sender_id;
        const receiverId = msg.receiver_id;
        const content = msg.content;

        // Determine which PTS applies to us
        let pts;
        if (receiverId === this.userId) {
            pts = persistedMsg.receiver_pts;
        } else if (senderId === this.userId) {
            pts = persistedMsg.sender_pts;
        }

        // Check for PTS gap (would trigger getDiff in production)
        if (pts && pts > this.localPts + 1) {
            console.warn(`PTS gap detected! Local: ${this.localPts}, Received: ${pts}`);
            this.addSystemMessage(`⚠️ Gap detected (${this.localPts} → ${pts}). Would call getDiff here.`);
        }

        // Update PTS
        if (pts) {
            this.updatePts(pts);
        }

        // Store and display message
        this.messages.set(msgId, {
            id: msgId,
            senderId,
            receiverId,
            content,
            pts,
            timestamp: persistedMsg.server_timestamp || Date.now()
        });

        this.displayMessage(msgId);
        this.saveState();
    }

    sendMessage(receiverId, content) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            alert('Not connected to gateway');
            return;
        }

        const message = {
            receiver_id: receiverId,
            content: content
        };

        console.log('Sending:', message);
        this.ws.send(JSON.stringify(message));

        // Optimistically display sent message
        const tempId = `temp_${Date.now()}`;
        this.messages.set(tempId, {
            id: tempId,
            senderId: this.userId,
            receiverId: receiverId,
            content: content,
            pts: null,
            timestamp: Date.now(),
            pending: true
        });
        this.displayMessage(tempId);
    }

    displayMessage(msgId) {
        const msg = this.messages.get(msgId);
        if (!msg) return;

        const messagesContainer = document.getElementById('messages');
        const isSent = msg.senderId === this.userId;

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isSent ? 'sent' : 'received'}`;
        messageDiv.id = `msg-${msgId}`;

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';

        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = msg.content;

        const meta = document.createElement('div');
        meta.className = 'message-meta';

        if (isSent) {
            meta.textContent = `You → ${msg.receiverId}`;
        } else {
            meta.textContent = `${msg.senderId} → You`;
        }

        if (msg.pts) {
            meta.textContent += ` | pts: ${msg.pts}`;
        }

        if (msg.pending) {
            meta.textContent += ' | Sending...';
        }

        bubble.appendChild(content);
        bubble.appendChild(meta);
        messageDiv.appendChild(bubble);
        messagesContainer.appendChild(messageDiv);

        // Scroll to bottom
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    addSystemMessage(text) {
        const messagesContainer = document.getElementById('messages');
        const div = document.createElement('div');
        div.className = 'system-message';
        div.textContent = text;
        messagesContainer.appendChild(div);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    updatePts(newPts) {
        if (newPts > this.localPts) {
            this.localPts = newPts;
            document.getElementById('info-pts').textContent = this.localPts;
            this.saveState();
        }
    }

    updateStatus(status, text) {
        const dot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');

        dot.className = 'status-dot';
        if (status === 'connected') {
            dot.classList.add('connected');
        }

        statusText.textContent = text;
    }

    onError(error) {
        console.error('WebSocket error:', error);
    }

    onClose() {
        console.log('WebSocket closed');
        this.updateStatus('disconnected', 'Disconnected');

        // Attempt to reconnect
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * this.reconnectAttempts;

            console.log(`Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);
            this.addSystemMessage(`Connection lost. Reconnecting in ${delay/1000}s...`);

            document.getElementById('reconnecting-overlay').classList.add('active');

            setTimeout(() => {
                document.getElementById('reconnecting-overlay').classList.remove('active');
                this.connect(this.userId, this.gatewayUrl);
            }, delay);
        } else {
            this.addSystemMessage('Connection lost. Please refresh the page to reconnect.');
        }
    }

    saveState() {
        const state = {
            userId: this.userId,
            gatewayUrl: this.gatewayUrl,
            localPts: this.localPts,
            messages: Array.from(this.messages.entries())
        };
        localStorage.setItem('tinytelegram_state', JSON.stringify(state));
    }

    loadState() {
        const saved = localStorage.getItem('tinytelegram_state');
        if (saved) {
            try {
                const state = JSON.parse(saved);
                this.localPts = state.localPts || 0;
                this.messages = new Map(state.messages || []);

                // Pre-fill form
                if (state.userId) {
                    document.getElementById('user-id').value = state.userId;
                }
                if (state.gatewayUrl) {
                    document.getElementById('gateway-url').value = state.gatewayUrl;
                }
            } catch (error) {
                console.error('Error loading state:', error);
            }
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

// Initialize client
const client = new TinyTelegramClient();

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    client.disconnect();
});
