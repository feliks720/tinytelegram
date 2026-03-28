package handler

import (
	"log"
	"net/http"
	"os"

	ggrpc "tinytelegram/gateway/grpc"
	pb "tinytelegram/gateway/proto"
	"tinytelegram/gateway/store"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
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
	if err := store.RegisterUser(userID, gatewayAddr); err != nil {
		log.Printf("Failed to register user %s: %v", userID, err)
	}
	log.Printf("User %s connected to gateway %s", userID, gatewayAddr)

	// channel for incoming routed messages
	msgCh := make(chan *pb.RouteMessageRequest, 16)
	ggrpc.RegisterConn(userID, msgCh)

	defer func() {
		ggrpc.UnregisterConn(userID)
		store.UnregisterUser(userID)
		log.Printf("User %s disconnected", userID)
	}()

	// goroutine to push incoming routed messages to WebSocket
	go func() {
		for msg := range msgCh {
			if err := conn.WriteJSON(msg); err != nil {
				log.Printf("Write error for user %s: %v", userID, err)
				return
			}
		}
	}()

	// read loop
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}
}
