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
	totalConnections   atomic.Uint64
	totalMessagesIn    atomic.Uint64
	totalMessagesOut   atomic.Uint64
	totalRateLimitHits atomic.Uint64
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

func (s *SignalingServer) handleReady(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	roomCount := len(s.rooms)
	clientCount := len(s.clients)
	closing := s.closing
	s.mu.Unlock()

	status := map[string]interface{}{
		"status":            "ready",
		"uptime_seconds":    time.Since(s.metrics.startTime).Seconds(),
		"active_rooms":      roomCount,
		"active_clients":    clientCount,
		"total_connections": s.metrics.totalConnections.Load(),
		"messages_in":       s.metrics.totalMessagesIn.Load(),
		"messages_out":      s.metrics.totalMessagesOut.Load(),
		"rate_limit_drops":  s.metrics.totalRateLimitHits.Load(),
	}

	w.Header().Set("Content-Type", "application/json")
	if closing {
		status["status"] = "draining"
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_ = json.NewEncoder(w).Encode(status)
}

func (s *SignalingServer) handleMetrics(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	roomCount := len(s.rooms)
	clientCount := len(s.clients)
	s.mu.Unlock()

	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "# HELP shadowcast_active_clients Current number of connected clients\n")
	fmt.Fprintf(w, "# TYPE shadowcast_active_clients gauge\n")
	fmt.Fprintf(w, "shadowcast_active_clients %d\n", clientCount)

	fmt.Fprintf(w, "# HELP shadowcast_active_rooms Current number of active rooms\n")
	fmt.Fprintf(w, "# TYPE shadowcast_active_rooms gauge\n")
	fmt.Fprintf(w, "shadowcast_active_rooms %d\n", roomCount)

	fmt.Fprintf(w, "# HELP shadowcast_messages_in_total Total incoming signaling messages\n")
	fmt.Fprintf(w, "# TYPE shadowcast_messages_in_total counter\n")
	fmt.Fprintf(w, "shadowcast_messages_in_total %d\n", s.metrics.totalMessagesIn.Load())

	fmt.Fprintf(w, "# HELP shadowcast_messages_out_total Total outgoing signaling messages\n")
	fmt.Fprintf(w, "# TYPE shadowcast_messages_out_total counter\n")
	fmt.Fprintf(w, "shadowcast_messages_out_total %d\n", s.metrics.totalMessagesOut.Load())

	fmt.Fprintf(w, "# HELP shadowcast_rate_limit_drops_total Total messages dropped by rate limiter\n")
	fmt.Fprintf(w, "# TYPE shadowcast_rate_limit_drops_total counter\n")
	fmt.Fprintf(w, "shadowcast_rate_limit_drops_total %d\n", s.metrics.totalRateLimitHits.Load())
}
