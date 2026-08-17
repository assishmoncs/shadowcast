package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"time"
)

type ServerMetrics struct {
	startTime          time.Time
	totalConnections   uint64
	activeConnections  int64
	totalMessagesIn    uint64
	totalMessagesOut   uint64
	totalRateLimitHits uint64
}

var metrics = &ServerMetrics{
	startTime: time.Now(),
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

func handleReady(w http.ResponseWriter, r *http.Request) {
	globalMu.RLock()
	roomCount := len(rooms)
	clientCount := len(clientsById)
	globalMu.RUnlock()

	status := map[string]interface{}{
		"status":            "ready",
		"uptime_seconds":    time.Since(metrics.startTime).Seconds(),
		"active_rooms":      roomCount,
		"active_clients":    clientCount,
		"total_connections": atomic.LoadUint64(&metrics.totalConnections),
		"messages_in":       atomic.LoadUint64(&metrics.totalMessagesIn),
		"messages_out":      atomic.LoadUint64(&metrics.totalMessagesOut),
		"rate_limit_drops":  atomic.LoadUint64(&metrics.totalRateLimitHits),
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(status)
}

func handleMetrics(w http.ResponseWriter, r *http.Request) {
	globalMu.RLock()
	roomCount := len(rooms)
	clientCount := len(clientsById)
	globalMu.RUnlock()

	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "# HELP shadowcast_active_clients Current number of connected clients\n")
	fmt.Fprintf(w, "# TYPE shadowcast_active_clients gauge\n")
	fmt.Fprintf(w, "shadowcast_active_clients %d\n", clientCount)

	fmt.Fprintf(w, "# HELP shadowcast_active_rooms Current number of active rooms\n")
	fmt.Fprintf(w, "# TYPE shadowcast_active_rooms gauge\n")
	fmt.Fprintf(w, "shadowcast_active_rooms %d\n", roomCount)

	fmt.Fprintf(w, "# HELP shadowcast_messages_in_total Total incoming signaling messages\n")
	fmt.Fprintf(w, "# TYPE shadowcast_messages_in_total counter\n")
	fmt.Fprintf(w, "shadowcast_messages_in_total %d\n", atomic.LoadUint64(&metrics.totalMessagesIn))

	fmt.Fprintf(w, "# HELP shadowcast_messages_out_total Total outgoing signaling messages\n")
	fmt.Fprintf(w, "# TYPE shadowcast_messages_out_total counter\n")
	fmt.Fprintf(w, "shadowcast_messages_out_total %d\n", atomic.LoadUint64(&metrics.totalMessagesOut))

	fmt.Fprintf(w, "# HELP shadowcast_rate_limit_drops_total Total messages dropped by rate limiter\n")
	fmt.Fprintf(w, "# TYPE shadowcast_rate_limit_drops_total counter\n")
	fmt.Fprintf(w, "shadowcast_rate_limit_drops_total %d\n", atomic.LoadUint64(&metrics.totalRateLimitHits))
}
