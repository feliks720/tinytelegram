package main

import (
	"log"
	"net/http"
	"os"

	ggrpc "tinytelegram/gateway/grpc"
	"tinytelegram/gateway/handler"
	"tinytelegram/gateway/msgclient"
	"tinytelegram/gateway/store"
)

func main() {
	store.InitRedis()

	gatewayAddr := os.Getenv("GATEWAY_ADDR")
	grpcAddr := os.Getenv("GATEWAY_GRPC_ADDR")
	if grpcAddr == "" {
		grpcAddr = gatewayAddr
	}
	if gatewayAddr != "" && grpcAddr != "" {
		if err := store.RegisterGateway(gatewayAddr, grpcAddr); err != nil {
			log.Printf("Failed to register gateway %s: %v", gatewayAddr, err)
		}
		stopGatewayHeartbeat := store.StartGatewayHeartbeat(gatewayAddr, grpcAddr)
		defer func() {
			stopGatewayHeartbeat()
			store.UnregisterGateway(gatewayAddr)
		}()
	}

	msgSvcAddr := os.Getenv("MSG_SERVICE_ADDR")
	if msgSvcAddr == "" {
		msgSvcAddr = "message-service:5050"
	}
	msgclient.Init(msgSvcAddr)

	grpcPort := os.Getenv("GRPC_PORT")
	if grpcPort == "" {
		grpcPort = "9000"
	}
	go ggrpc.StartGRPCServer(grpcPort)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/ws", handler.WebSocketHandler)
	http.HandleFunc("/health", handler.HealthHandler)
	http.HandleFunc("/metrics", handler.MetricsHandler)

	log.Printf("Gateway starting on HTTP :%s, gRPC :%s", port, grpcPort)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
