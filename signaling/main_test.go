package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func newTestConfig() *Config {
	return &Config{
		Port:              ":0",
		AllowedOrigins:    []string{"*"},
		MaxRooms:          5,
		MaxClientsPerRoom: 3,
		RateLimitPerSec:   50,
		AuthToken:         "",
		ReadLimitBytes:    65536,
		PingInterval:      5 * time.Second,
		PongWait:          10 * time.Second,
	}
}

func dialWS(t *testing.T, serverURL string, headers http.Header) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(serverURL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("failed to dial websocket: %v", err)
	}
	return conn
}

func readJSONMsg(t *testing.T, conn *websocket.Conn) map[string]interface{} {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("failed to read websocket message: %v", err)
	}
	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("failed to unmarshal message: %v", err)
	}
	return msg
}

func TestHealthAndMetricsEndpoints(t *testing.T) {
	handler := initServerState(newTestConfig())
	ts := httptest.NewServer(handler)
	defer ts.Close()

	// 1. /healthz
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from /healthz, got %v, err=%v", resp, err)
	}

	// 2. /ready
	resp, err = http.Get(ts.URL + "/ready")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from /ready, got %v, err=%v", resp, err)
	}
	var readyPayload map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&readyPayload); err != nil {
		t.Fatalf("failed to decode /ready JSON: %v", err)
	}
	if readyPayload["status"] != "ready" {
		t.Fatalf("expected status=ready, got %v", readyPayload["status"])
	}

	// 3. /metrics
	resp, err = http.Get(ts.URL + "/metrics")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from /metrics, got %v, err=%v", resp, err)
	}
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(resp.Body)
	if !strings.Contains(buf.String(), "shadowcast_active_clients") {
		t.Fatalf("expected prometheus metrics output, got: %s", buf.String())
	}
}

func TestWebSocketJoinAndSignalingRelay(t *testing.T) {
	handler := initServerState(newTestConfig())
	ts := httptest.NewServer(handler)
	defer ts.Close()

	c1 := dialWS(t, ts.URL, nil)
	defer c1.Close()
	c2 := dialWS(t, ts.URL, nil)
	defer c2.Close()

	// Consume initial self-id messages
	msg1 := readJSONMsg(t, c1)
	if msg1["type"] != "self-id" {
		t.Fatalf("expected self-id, got %v", msg1)
	}
	msg2 := readJSONMsg(t, c2)
	if msg2["type"] != "self-id" {
		t.Fatalf("expected self-id, got %v", msg2)
	}

	// Peer 1 joins room with explicit client ID
	_ = c1.WriteJSON(map[string]interface{}{
		"type": "join",
		"room": "test-room",
		"from": "peer-alpha",
	})
	roomPeers1 := readJSONMsg(t, c1)
	if roomPeers1["type"] != "room-peers" {
		t.Fatalf("expected room-peers for peer-alpha, got %v", roomPeers1)
	}

	// Peer 2 joins same room with explicit client ID
	_ = c2.WriteJSON(map[string]interface{}{
		"type": "join",
		"room": "test-room",
		"from": "peer-beta",
	})
	roomPeers2 := readJSONMsg(t, c2)
	if roomPeers2["type"] != "room-peers" {
		t.Fatalf("expected room-peers for peer-beta, got %v", roomPeers2)
	}
	peersSlice, ok := roomPeers2["peers"].([]interface{})
	if !ok || len(peersSlice) != 1 || peersSlice[0] != "peer-alpha" {
		t.Fatalf("expected peers=[peer-alpha], got %v", roomPeers2["peers"])
	}

	// Peer 1 receives peer-joined for peer-beta
	joinedNotification := readJSONMsg(t, c1)
	if joinedNotification["type"] != "peer-joined" || joinedNotification["id"] != "peer-beta" {
		t.Fatalf("expected peer-joined for peer-beta, got %v", joinedNotification)
	}

	// Peer 1 sends WebRTC offer to peer-beta
	_ = c1.WriteJSON(map[string]interface{}{
		"type":   "offer",
		"target": "peer-beta",
		"sdp":    map[string]interface{}{"type": "offer", "sdp": "v=0..."},
	})

	offerMsg := readJSONMsg(t, c2)
	if offerMsg["type"] != "offer" || offerMsg["from"] != "peer-alpha" {
		t.Fatalf("expected offer from peer-alpha, got %v", offerMsg)
	}
}

func TestRateLimiter(t *testing.T) {
	rl := NewRateLimiter(2) // 2 per sec, burst capacity 4
	if !rl.Allow() || !rl.Allow() {
		t.Fatalf("expected initial tokens to allow requests")
	}
	if rl.Allow() {
		t.Fatalf("expected 3rd immediate request to be rate-limited")
	}
}
