package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port              string
	AllowedOrigins    []string
	MaxRooms          int
	MaxClientsPerRoom int
	RateLimitPerSec   int
	AuthToken         string
	ReadLimitBytes    int64
	PingInterval      time.Duration
	PongWait          time.Duration
}

func LoadConfig() *Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if !strings.HasPrefix(port, ":") {
		port = ":" + port
	}

	originsEnv := os.Getenv("ALLOWED_ORIGIN")
	var allowedOrigins []string
	if originsEnv != "" {
		for _, o := range strings.Split(originsEnv, ",") {
			trimmed := strings.TrimSpace(o)
			if trimmed != "" {
				allowedOrigins = append(allowedOrigins, trimmed)
			}
		}
	}

	maxRooms := getEnvInt("MAX_ROOMS", 1000)
	maxClientsPerRoom := getEnvInt("MAX_CLIENTS_PER_ROOM", 100)
	rateLimit := getEnvInt("RATE_LIMIT_PER_SEC", 50)
	authToken := os.Getenv("AUTH_TOKEN")
	readLimit := int64(getEnvInt("READ_LIMIT_BYTES", 64*1024)) // 64 KB default

	return &Config{
		Port:              port,
		AllowedOrigins:    allowedOrigins,
		MaxRooms:          maxRooms,
		MaxClientsPerRoom: maxClientsPerRoom,
		RateLimitPerSec:   rateLimit,
		AuthToken:         authToken,
		ReadLimitBytes:    readLimit,
		PingInterval:      30 * time.Second,
		PongWait:          60 * time.Second,
	}
}

func getEnvInt(key string, defaultVal int) int {
	valStr := os.Getenv(key)
	if valStr == "" {
		return defaultVal
	}
	val, err := strconv.Atoi(valStr)
	if err != nil {
		return defaultVal
	}
	return val
}
