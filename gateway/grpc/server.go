package grpc

import (
	"context"
	"log"
	"net"
	"sync"

	pb "tinytelegram/gateway/proto"

	"google.golang.org/grpc"
)

// ConnRegistry tracks active WebSocket connections
var (
	connMu    sync.RWMutex
	connMap   = make(map[string]chan *pb.RouteMessageRequest)
)

func RegisterConn(userID string, ch chan *pb.RouteMessageRequest) {
	connMu.Lock()
	defer connMu.Unlock()
	connMap[userID] = ch
}

func UnregisterConn(userID string) {
	connMu.Lock()
	defer connMu.Unlock()
	delete(connMap, userID)
}

type gatewayServer struct {
	pb.UnimplementedGatewayServiceServer
}

func (s *gatewayServer) RouteMessage(ctx context.Context, req *pb.RouteMessageRequest) (*pb.RouteMessageResponse, error) {
	connMu.RLock()
	ch, ok := connMap[req.ReceiverId]
	connMu.RUnlock()

	if !ok {
		return &pb.RouteMessageResponse{Delivered: false}, nil
	}

	ch <- req
	return &pb.RouteMessageResponse{Delivered: true}, nil
}

func StartGRPCServer(port string) {
	lis, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatalf("gRPC listen error: %v", err)
	}

	s := grpc.NewServer()
	pb.RegisterGatewayServiceServer(s, &gatewayServer{})

	log.Printf("gRPC server starting on port %s", port)
	if err := s.Serve(lis); err != nil {
		log.Fatalf("gRPC serve error: %v", err)
	}
}
