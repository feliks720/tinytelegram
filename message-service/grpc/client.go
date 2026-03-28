package grpc

import (
	"context"
	"log"
	"sync"

	pb "tinytelegram/message-service/proto"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

var (
	clientMu sync.RWMutex
	clients  = make(map[string]pb.GatewayServiceClient)
)

func RegisterGateway(addr string) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Printf("Failed to connect to gateway %s: %v", addr, err)
		return
	}
	clientMu.Lock()
	clients[addr] = pb.NewGatewayServiceClient(conn)
	clientMu.Unlock()
	log.Printf("gRPC client connected to gateway %s", addr)
}

func RouteMessage(gatewayAddr string, req *pb.RouteMessageRequest) (bool, error) {
	clientMu.RLock()
	client, ok := clients[gatewayAddr]
	clientMu.RUnlock()

	if !ok {
		return false, nil
	}

	resp, err := client.RouteMessage(context.Background(), req)
	if err != nil {
		return false, err
	}
	return resp.Delivered, nil
}
