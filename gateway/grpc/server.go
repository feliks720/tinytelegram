package grpc

import (
	"context"
	"log"
	"net"
	"sync"

	pb "tinytelegram/gateway/proto"

	"google.golang.org/grpc"
)

var (
	connMu  sync.RWMutex
	connMap = make(map[string]chan *pb.PersistedMessage)
)

func RegisterConn(userID string, ch chan *pb.PersistedMessage) {
	connMu.Lock()
	defer connMu.Unlock()
	connMap[userID] = ch
}

func UnregisterConn(userID string) {
	connMu.Lock()
	defer connMu.Unlock()
	if ch, ok := connMap[userID]; ok {
		close(ch)
		delete(connMap, userID)
	}
}

func ConnCount() int {
	connMu.RLock()
	defer connMu.RUnlock()
	return len(connMap)
}

func DeliverLocal(receiverID string, msg *pb.PersistedMessage) bool {
	connMu.RLock()
	ch, ok := connMap[receiverID]
	connMu.RUnlock()
	if !ok {
		return false
	}

	select {
	case ch <- msg:
		return true
	default:
		return false
	}
}

type gatewayServer struct {
	pb.UnimplementedGatewayServiceServer
}

func (s *gatewayServer) DeliverMessage(ctx context.Context, msg *pb.PersistedMessage) (*pb.DeliveryAck, error) {
	if msg.GetMessage() == nil {
		return &pb.DeliveryAck{Delivered: false}, nil
	}

	if DeliverLocal(msg.Message.ReceiverId, msg) {
		return &pb.DeliveryAck{Delivered: true}, nil
	}

	log.Printf("No active connection for user %s", msg.Message.ReceiverId)
	return &pb.DeliveryAck{Delivered: false}, nil
}

func StartGRPCServer(port string) {
	lis, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatalf("Gateway gRPC listen error: %v", err)
	}

	server := grpc.NewServer()
	pb.RegisterGatewayServiceServer(server, &gatewayServer{})

	log.Printf("Gateway gRPC server starting on port %s", port)
	if err := server.Serve(lis); err != nil {
		log.Fatalf("Gateway gRPC serve error: %v", err)
	}
}
