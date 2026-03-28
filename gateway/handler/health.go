package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"runtime"

	ggrpc "tinytelegram/gateway/grpc"
)

type Metrics struct {
	ActiveConnections int     `json:"active_connections"`
	Goroutines        int     `json:"goroutines"`
	HeapAllocMB       float64 `json:"heap_alloc_mb"`
	HeapSysMB         float64 `json:"heap_sys_mb"`
	GatewayAddr       string  `json:"gateway_addr"`
}

func HealthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func MetricsHandler(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	metrics := Metrics{
		ActiveConnections: ggrpc.ConnCount(),
		Goroutines:        runtime.NumGoroutine(),
		HeapAllocMB:       float64(m.HeapAlloc) / 1024 / 1024,
		HeapSysMB:         float64(m.HeapSys) / 1024 / 1024,
		GatewayAddr:       os.Getenv("GATEWAY_ADDR"),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(metrics)
}
