package peer

import (
	"context"
	"log"
	"sync"
	"time"

	pb "tinytelegram/gateway/proto"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

var (
	clientMu sync.RWMutex
	clients  = make(map[string]pb.GatewayServiceClient)
)

func GetOrConnect(addr string) (pb.GatewayServiceClient, error) {
	clientMu.RLock()
	client, ok := clients[addr]
	clientMu.RUnlock()
	if ok {
		return client, nil
	}

	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}

	client = pb.NewGatewayServiceClient(conn)
	clientMu.Lock()
	clients[addr] = client
	clientMu.Unlock()
	log.Printf("Connected to peer gateway %s", addr)
	return client, nil
}

func DeliverMessage(gatewayAddr string, msg *pb.PersistedMessage) (bool, error) {
	client, err := GetOrConnect(gatewayAddr)
	if err != nil {
		return false, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	ack, err := client.DeliverMessage(ctx, msg)
	if err != nil {
		return false, err
	}
	return ack.Delivered, nil
}
