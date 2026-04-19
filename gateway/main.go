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

	grpcPort := os.Getenv("GRPC_PORT")
	if grpcPort == "" {
		grpcPort = "9000"
	}

	gatewayAddr := os.Getenv("GATEWAY_ADDR")
	grpcAddr := os.Getenv("GATEWAY_GRPC_ADDR")
	if metaURI := os.Getenv("ECS_CONTAINER_METADATA_URI_V4"); metaURI != "" {
		id, addr, err := ResolveSelfAddr(metaURI, grpcPort)
		if err != nil {
			log.Fatalf("ECS metadata resolution failed: %v", err)
		}
		gatewayAddr, grpcAddr = id, addr
		// Downstream code (handler/websocket.go) reads these via os.Getenv,
		// so publish the resolved values back into the process env.
		os.Setenv("GATEWAY_ADDR", gatewayAddr)
		os.Setenv("GATEWAY_GRPC_ADDR", grpcAddr)
		log.Printf("ECS self-identity: id=%s grpc=%s", gatewayAddr, grpcAddr)
	} else if grpcAddr == "" {
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
