package grpc

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

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

func DeliverMessage(gatewayAddr string, msg *pb.PersistedMessage) (bool, error) {
	clientMu.RLock()
	client, ok := clients[gatewayAddr]
	clientMu.RUnlock()
	if !ok {
		return false, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	resp, err := client.DeliverMessage(ctx, msg)
	if err != nil {
		return false, err
	}
	return resp.Delivered, nil
}

func DiscoverGateways(rdb *redis.Client) {
	go func() {
		for {
			result, err := rdb.HGetAll(context.Background(), "gateways").Result()
			if err != nil {
				log.Printf("Gateway discovery error: %v", err)
				time.Sleep(3 * time.Second)
				continue
			}

			for _, grpcAddr := range result {
				clientMu.RLock()
				_, exists := clients[grpcAddr]
				clientMu.RUnlock()
				if exists {
					continue
				}
				RegisterGateway(grpcAddr)
			}

			time.Sleep(3 * time.Second)
		}
	}()
}
