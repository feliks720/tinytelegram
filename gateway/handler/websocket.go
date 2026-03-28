package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	ggrpc "tinytelegram/gateway/grpc"
	"tinytelegram/gateway/msgclient"
	"tinytelegram/gateway/peer"
	pb "tinytelegram/gateway/proto"
	"tinytelegram/gateway/store"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type IncomingMessage struct {
	ReceiverID string `json:"receiver_id"`
	Content    string `json:"content"`
}

func WebSocketHandler(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("user_id")
	if userID == "" {
		http.Error(w, "user_id required", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	gatewayAddr := os.Getenv("GATEWAY_ADDR")
	gatewayGRPCAddr := os.Getenv("GATEWAY_GRPC_ADDR")
	presenceAddr := gatewayGRPCAddr
	if presenceAddr == "" {
		presenceAddr = gatewayAddr
	}

	if err := store.RegisterUser(userID, presenceAddr); err != nil {
		log.Printf("Failed to register user %s: %v", userID, err)
	}
	stopHeartbeat := store.StartHeartbeat(userID, presenceAddr)
	log.Printf("User %s connected to gateway %s", userID, gatewayAddr)

	msgCh := make(chan *pb.PersistedMessage, 64)
	ggrpc.RegisterConn(userID, msgCh)

	defer func() {
		stopHeartbeat()
		ggrpc.UnregisterConn(userID)
		if err := store.UnregisterUser(userID); err != nil {
			log.Printf("Failed to unregister user %s: %v", userID, err)
		}
		log.Printf("User %s disconnected", userID)
	}()

	go func() {
		for msg := range msgCh {
			if err := conn.WriteJSON(msg); err != nil {
				log.Printf("Write error for user %s: %v", userID, err)
				return
			}
		}
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var incoming IncomingMessage
		if err := json.Unmarshal(raw, &incoming); err != nil {
			log.Printf("Invalid message from user %s: %v", userID, err)
			continue
		}
		if incoming.ReceiverID == "" || incoming.Content == "" {
			log.Printf("Ignoring incomplete message from user %s", userID)
			continue
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		persisted, err := msgclient.PersistMessage(ctx, &pb.ChatMessage{
			SenderId:        userID,
			ReceiverId:      incoming.ReceiverID,
			Content:         incoming.Content,
			ClientTimestamp: time.Now().UnixMilli(),
		})
		cancel()
		if err != nil {
			log.Printf("PersistMessage error for user %s: %v", userID, err)
			continue
		}

		if err := conn.WriteJSON(map[string]any{
			"type":       "ack",
			"sender_pts": persisted.SenderPts,
			"message_id": persisted.Id,
		}); err != nil {
			log.Printf("Ack write error for user %s: %v", userID, err)
			continue
		}

		targetGateway, err := store.GetUserGateway(incoming.ReceiverID)
		if err != nil || targetGateway == "" {
			continue
		}

		if targetGateway == presenceAddr {
			ggrpc.DeliverLocal(incoming.ReceiverID, persisted)
			continue
		}

		go func(target string, msg *pb.PersistedMessage) {
			if _, err := peer.DeliverMessage(target, msg); err != nil {
				log.Printf("Peer delivery to %s failed: %v", target, err)
			}
		}(targetGateway, persisted)
	}
}
